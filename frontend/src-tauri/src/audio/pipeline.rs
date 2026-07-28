use std::sync::Arc;
use std::collections::VecDeque;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use anyhow::Result;
use log::{debug, error, info, warn};
use crate::{perf_debug, batch_audio_metric};
use super::batch_processor::AudioMetricsBatcher;
use rubato::{Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};

use super::aec::EchoCanceller;
use super::devices::AudioDevice;
use super::raw_track_saver::RawTrackSaver;
use super::recording_state::{AudioChunk, AudioError, RecordingState, DeviceType};
use super::audio_processing::{audio_to_mono, LoudnessNormalizer, NoiseSuppressionProcessor, HighPassFilter};
use super::vad::{ContinuousVadProcessor};
use super::transcription::elevenlabs_realtime::{
    is_realtime_to_batch_flip, should_batch_flush_on_stop,
    should_drain_vad_into_batch_on_stop, should_remark_onset_on_resume,
    ElevenLabsRealtimeSession, Route, FEED_SAMPLE_RATE,
};

/// Provider-aware transcription-flush profile.
///
/// Controls WHEN an accumulated per-stream VAD buffer is flushed to the engine.
/// Local engines (Parakeet, Whisper) transcribe better with a large context
/// window and don't care about latency, so they keep a 12s cap and only flush
/// early on a real silence gap. Cloud engines (ElevenLabs Scribe, Mistral) hit
/// an HTTP API per chunk, so late flushes translate directly into text
/// appearing 12-30s+ after it was spoken. They use a small cap, a tighter
/// silence gap, and an audio-time ceiling (`max_block_secs`) that bounds how
/// long a multi-segment buffer may grow. NOTE: the ceiling is evaluated only
/// when a completed VAD segment arrives — it cannot subdivide a single long
/// in-progress segment, so one unbroken monologue segment still flushes only
/// when silero ends it.
#[derive(Clone, Copy, Debug)]
pub struct FlushProfile {
    /// Flush once the accumulated SPEECH sample count reaches this (16kHz).
    pub min_samples: usize,
    /// Flush a partial buffer after this much wall-clock silence.
    pub silence_gap_secs: f64,
    /// Ceiling on how long (in AUDIO time: newest segment end minus buffer
    /// start) the front of a buffer may wait before being flushed. Checked
    /// only when a completed VAD segment arrives (cannot cut an in-progress
    /// segment). `f64::INFINITY` disables the ceiling (local profile).
    pub max_block_secs: f64,
}

impl FlushProfile {
    /// Local-engine profile (Parakeet / Whisper): unchanged historical behavior.
    /// 12s @ 16k cap, 1.2s silence-gap flush, no hard audio-time ceiling.
    pub const LOCAL: FlushProfile = FlushProfile {
        min_samples: 192_000,
        silence_gap_secs: 1.2,
        max_block_secs: f64::INFINITY,
    };

    /// Cloud-engine profile (ElevenLabs Scribe / Mistral): low latency.
    /// Grid-tuned on held-out clips 11-16 (audio_testing/tune_scribe_flush_loop.py,
    /// 2026-07-11). min 4s is the best-compromise point on the Pareto frontier:
    /// it roughly halves the POOLED median block wait (baseline 12s -> 16.7s;
    /// min 4s -> 7.7s) for a +0.71pp WER cost (5.6% -> 6.3%). No sub-12s config
    /// hit BOTH the <=6.0% WER and <=6s median targets, because the per-chunk
    /// block wait is floored by the VAD SEGMENT length: silero holds a monologue
    /// as one segment until an 800ms+ pause, and neither `min_samples` nor
    /// `max_block_secs` can subdivide a single in-progress segment (a true
    /// mid-speech cut needs VAD-level changes with silero-rs duplication risk,
    /// deferred). `max_block_secs` is a defensive between-segments ceiling: inert
    /// on these dense clips but bounds multi-segment buffers in pausier calls.
    /// The 1.0s left-context overlap (TRANSCRIPTION_OVERLAP_SAMPLES) is prepended
    /// on every flush; iteration-1 timestamp trimming makes the extra boundary
    /// cost near zero. Worst per-clip WER cost was +2.1pp (clip_14) — the
    /// pooled +0.71pp hides some spread; accepted for a live co-pilot where
    /// display latency dominates.
    pub const CLOUD: FlushProfile = FlushProfile {
        min_samples: 64_000,
        silence_gap_secs: 0.8,
        max_block_secs: 6.0,
    };

    /// Select the profile for a configured transcript provider string
    /// (matches the values stored in `transcript_settings.provider`).
    pub fn for_provider(provider: &str) -> FlushProfile {
        // Case-insensitive so casing drift in the stored value can't silently
        // degrade a cloud provider to the high-latency LOCAL profile.
        match provider.trim().to_ascii_lowercase().as_str() {
            // Cloud HTTP providers get the low-latency profile.
            "elevenlabs" | "mistral" | "deepgram" | "groq" | "openai" => FlushProfile::CLOUD,
            // Local engines (parakeet, localWhisper) and any unknown/empty value
            // keep the current large-context behavior.
            _ => FlushProfile::LOCAL,
        }
    }
}

/// Ring buffer for synchronized audio mixing
/// Accumulates samples from mic and system streams until we have aligned windows
struct AudioMixerRingBuffer {
    mic_buffer: VecDeque<f32>,
    system_buffer: VecDeque<f32>,
    window_size_samples: usize,  // Fixed mixing window (600ms for audio stability)
    max_buffer_size: usize,  // Safety limit (4800ms = 8x window)
}

impl AudioMixerRingBuffer {
    fn new(sample_rate: u32) -> Self {
        // Use 600ms windows for mixing (increased from 50ms for system audio stability)
        let window_ms = 600.0;
        let window_size_samples = (sample_rate as f32 * window_ms / 1000.0) as usize;

        // Max buffer = 8x window (4800ms) for system audio stability
        // System audio (especially Core Audio on macOS) can have significant jitter
        // due to sample-by-sample streaming → batching → channel transmission
        // Accounts for: RNNoise buffering + Core Audio jitter + processing delays
        let max_buffer_size = window_size_samples * 8;  // 4800ms (8x 600ms window)

        info!("🔊 Ring buffer initialized: window={}ms ({} samples), max={}ms ({} samples)",
              window_ms, window_size_samples,
              window_ms * 8.0, max_buffer_size);

        Self {
            mic_buffer: VecDeque::with_capacity(max_buffer_size),
            system_buffer: VecDeque::with_capacity(max_buffer_size),
            window_size_samples,
            max_buffer_size,
        }
    }

    fn add_samples(&mut self, device_type: DeviceType, samples: Vec<f32>) {
        // Log buffer health periodically for diagnostics
        use std::sync::atomic::{AtomicU64, Ordering};
        static SAMPLE_COUNTER: AtomicU64 = AtomicU64::new(0);
        let count = SAMPLE_COUNTER.fetch_add(1, Ordering::Relaxed);
        if count % 200 == 0 {
            debug!("📊 Ring buffer status: mic={} samples, sys={} samples (max={})",
                   self.mic_buffer.len(), self.system_buffer.len(), self.max_buffer_size);
        }

        match device_type {
            DeviceType::Microphone => self.mic_buffer.extend(samples),
            DeviceType::System => self.system_buffer.extend(samples),
        }

        // CRITICAL FIX: Add warnings before dropping samples
        // This helps diagnose timing issues in production
        if self.mic_buffer.len() > self.max_buffer_size {
            warn!("⚠️ Microphone buffer overflow: {} > {} samples, dropping oldest {} samples",
                  self.mic_buffer.len(), self.max_buffer_size,
                  self.mic_buffer.len() - self.max_buffer_size);
        }
        if self.system_buffer.len() > self.max_buffer_size {
            error!("🔴 SYSTEM AUDIO BUFFER OVERFLOW: {} > {} samples, dropping {} samples - THIS CAUSES DISTORTION!",
                  self.system_buffer.len(), self.max_buffer_size,
                  self.system_buffer.len() - self.max_buffer_size);
        }

        // Safety: prevent buffer overflow (keep only last 200ms)
        while self.mic_buffer.len() > self.max_buffer_size {
            self.mic_buffer.pop_front();
        }
        while self.system_buffer.len() > self.max_buffer_size {
            self.system_buffer.pop_front();
        }
    }

    fn can_mix(&self) -> bool {
        self.mic_buffer.len() >= self.window_size_samples ||
        self.system_buffer.len() >= self.window_size_samples
    }

    fn extract_window(&mut self) -> Option<(Vec<f32>, Vec<f32>)> {
        if !self.can_mix() {
            return None;
        }

        // Extract mic window with zero-padding for incomplete buffers
        // Zero-padding (silence) is preferred over last-sample-hold to prevent artifacts

        // Extract mic window (or pad with zeros if insufficient data)
        let mic_window = if self.mic_buffer.len() >= self.window_size_samples {
            // Enough mic data - drain window
            self.mic_buffer.drain(0..self.window_size_samples).collect()
        } else if !self.mic_buffer.is_empty() {
            // Some mic data but not enough - consume all + pad with zeros
            let available: Vec<f32> = self.mic_buffer.drain(..).collect();
            let mut padded = Vec::with_capacity(self.window_size_samples);
            padded.extend_from_slice(&available);

            // Use zero-padding (silence) to prevent repetition artifacts
            // Zero-padding is inaudible at 48kHz sample rate
            padded.resize(self.window_size_samples, 0.0);

            padded
        } else {
            // No mic data - return silence
            vec![0.0; self.window_size_samples]
        };

        // Extract system window (or pad with zeros if insufficient data)
        let sys_window = if self.system_buffer.len() >= self.window_size_samples {
            // Enough system data - drain window
            self.system_buffer.drain(0..self.window_size_samples).collect()
        } else if !self.system_buffer.is_empty() {
            // Some system data but not enough - consume all + pad with zeros
            let available: Vec<f32> = self.system_buffer.drain(..).collect();
            let mut padded = Vec::with_capacity(self.window_size_samples);
            padded.extend_from_slice(&available);

            // Use zero-padding (silence) to prevent repetition artifacts
            // Zero-padding is inaudible at 48kHz sample rate
            padded.resize(self.window_size_samples, 0.0);

            padded
        } else {
            // No system data - return silence
            vec![0.0; self.window_size_samples]
        };

        Some((mic_window, sys_window))
    }

}

/// Simple audio mixer without aggressive ducking
/// Combines mic + system audio with basic clipping prevention
struct ProfessionalAudioMixer;

impl ProfessionalAudioMixer {
    fn new(_sample_rate: u32) -> Self {
        Self
    }

    fn mix_window(&mut self, mic_window: &[f32], sys_window: &[f32]) -> Vec<f32> {
        // Handle different lengths (already padded by extract_window, but defensive)
        let max_len = mic_window.len().max(sys_window.len());
        let mut mixed = Vec::with_capacity(max_len);

        // Professional mixing with soft scaling to prevent distortion
        // Uses proportional scaling instead of hard clamping to avoid artifacts
        for i in 0..max_len {
            let mic = mic_window.get(i).copied().unwrap_or(0.0);
            let sys = sys_window.get(i).copied().unwrap_or(0.0);

            // Pre-scale system audio to 70% to leave headroom
            // This prevents constant soft scaling which can cause pumping artifacts
            // Mic is normalized to -16 LUFS (voice/podcast standard), system needs reduction
            let sys_scaled = sys * 0.7;

            // Sum without ducking - mic stays at full volume, system slightly reduced
            let sum = mic + sys_scaled;

            // CRITICAL FIX: Soft scaling prevents distortion artifacts
            // If the sum would exceed ±1.0, scale down PROPORTIONALLY
            // This avoids hard clipping distortion that sounds like "radio breaks"
            let sum_abs = sum.abs();
            let mixed_sample = if sum_abs > 1.0 {
                // Scale down to fit within ±1.0
                sum / sum_abs
            } else {
                sum
            };

            mixed.push(mixed_sample);
        }

        mixed
    }
}

/// Simplified audio capture without broadcast channels
#[derive(Clone)]
pub struct AudioCapture {
    device: Arc<AudioDevice>,
    state: Arc<RecordingState>,
    sample_rate: u32,        // Original device sample rate
    channels: u16,
    chunk_counter: Arc<std::sync::atomic::AtomicU64>,
    device_type: DeviceType,
    recording_sender: Option<mpsc::UnboundedSender<AudioChunk>>,
    needs_resampling: bool,  // Flag if resampling is required
    // CRITICAL FIX: Persistent resampler to preserve energy across chunks
    resampler: Arc<std::sync::Mutex<Option<SincFixedIn<f32>>>>,
    // Buffering for variable-size chunks → fixed-size resampler input
    resampler_input_buffer: Arc<std::sync::Mutex<Vec<f32>>>,
    resampler_chunk_size: usize,  // Fixed chunk size for resampler (512 samples)
    // Audio enhancement processors (microphone only)
    noise_suppressor: Arc<std::sync::Mutex<Option<NoiseSuppressionProcessor>>>,
    high_pass_filter: Arc<std::sync::Mutex<Option<HighPassFilter>>>,
    // EBU R128 normalizer for microphone audio (per-device, stateful)
    normalizer: Arc<std::sync::Mutex<Option<LoudnessNormalizer>>>,
    // Note: Using global recording timestamp for synchronization
}

impl AudioCapture {
    pub fn new(
        device: Arc<AudioDevice>,
        state: Arc<RecordingState>,
        sample_rate: u32,
        channels: u16,
        device_type: DeviceType,
        recording_sender: Option<mpsc::UnboundedSender<AudioChunk>>,
    ) -> Self {
        // CRITICAL FIX: Detect if resampling is needed
        // Pipeline expects 48kHz, but Bluetooth devices often report 8kHz, 16kHz, or 44.1kHz
        const TARGET_SAMPLE_RATE: u32 = 48000;
        let needs_resampling = sample_rate != TARGET_SAMPLE_RATE;

        // Detect device kind (Bluetooth vs Wired) for adaptive processing
        // Use reasonable defaults for buffer size (512 samples is typical)
        let device_kind = super::device_detection::InputDeviceKind::detect(&device.name, 512, sample_rate);

        if needs_resampling {
            warn!(
                "⚠️ SAMPLE RATE MISMATCH DETECTED ⚠️"
            );
            warn!(
                "🔄 [{:?}] Audio device '{}' ({:?}) reports {} Hz (pipeline expects {} Hz)",
                device_type, device.name, device_kind, sample_rate, TARGET_SAMPLE_RATE
            );
            warn!(
                "🔄 Automatic resampling will be applied: {} Hz → {} Hz",
                sample_rate, TARGET_SAMPLE_RATE
            );

            // Log which resampling strategy will be used
            let ratio = TARGET_SAMPLE_RATE as f64 / sample_rate as f64;
            let strategy = if ratio >= 2.0 {
                "High-quality upsampling (sinc_len=512, Cubic interpolation)"
            } else if ratio >= 1.5 {
                "Moderate upsampling (sinc_len=384, Cubic)"
            } else if ratio > 1.0 {
                "Small upsampling (sinc_len=256, Linear)"
            } else if ratio <= 0.5 {
                "Anti-aliased downsampling (sinc_len=512, Cubic)"
            } else {
                "Moderate downsampling (sinc_len=384, Linear)"
            };
            info!("   Resampling strategy: {}", strategy);
        } else {
            info!(
                "✅ [{:?}] Audio device '{}' ({:?}) uses {} Hz (matches pipeline)",
                device_type, device.name, device_kind, sample_rate
            );
        }

        // Initialize audio enhancement processors for MICROPHONE ONLY
        // System audio doesn't need enhancement (already clean)
        let (noise_suppressor, high_pass_filter, normalizer) = if matches!(device_type, DeviceType::Microphone) {
            // Initialize noise suppression (RNNoise) at 48kHz - CONDITIONAL based on flag
            let ns = if super::ffmpeg_mixer::RNNOISE_APPLY_ENABLED {
                match NoiseSuppressionProcessor::new(TARGET_SAMPLE_RATE) {
                    Ok(processor) => {
                        info!("✅ RNNoise noise suppression ENABLED for microphone '{}' (10-15 dB reduction)", device.name);
                        Some(processor)
                    }
                    Err(e) => {
                        warn!("⚠️ Failed to create noise suppressor: {}, continuing without noise suppression", e);
                        None
                    }
                }
            } else {
                info!("ℹ️ RNNoise noise suppression DISABLED for microphone '{}' (flag: RNNOISE_APPLY_ENABLED=false)", device.name);
                info!("   Whisper handles noise well internally - RNNoise is optional");
                None
            };

            // Initialize high-pass filter (removes rumble below 80 Hz)
            let hpf = {
                let filter = HighPassFilter::new(TARGET_SAMPLE_RATE, 80.0);
                info!("✅ High-pass filter initialized for microphone '{}' (cutoff: 80 Hz)", device.name);
                Some(filter)
            };

            // Initialize EBU R128 normalizer (professional loudness standard)
            let norm = match LoudnessNormalizer::new(1, TARGET_SAMPLE_RATE) {
                Ok(normalizer) => {
                    info!("✅ EBU R128 normalizer initialized for microphone '{}' (target: -16 LUFS)", device.name);
                    Some(normalizer)
                }
                Err(e) => {
                    warn!("⚠️ Failed to create normalizer for microphone: {}, normalization disabled", e);
                    None
                }
            };

            (ns, hpf, norm)
        } else {
            // System audio: no enhancement needed
            info!("ℹ️ System audio '{}' captured raw (no enhancement)", device.name);
            (None, None, None)
        };

        // CRITICAL FIX: Initialize persistent resampler to preserve energy across chunks
        // Creating a new resampler per chunk causes energy amplification and incorrect output sizes
        // Use fixed chunk size of 512 samples with buffering for variable-size input
        const RESAMPLER_CHUNK_SIZE: usize = 512;

        let resampler = if needs_resampling {
            let ratio = TARGET_SAMPLE_RATE as f64 / sample_rate as f64;

            // Adaptive parameters based on sample rate ratio (same logic as resample_audio)
            let (sinc_len, interpolation_type, oversampling) = if ratio >= 2.0 {
                (512, SincInterpolationType::Cubic, 512)
            } else if ratio >= 1.5 {
                (384, SincInterpolationType::Cubic, 384)
            } else if ratio > 1.0 {
                (256, SincInterpolationType::Linear, 256)
            } else if ratio <= 0.5 {
                (512, SincInterpolationType::Cubic, 512)
            } else {
                (384, SincInterpolationType::Linear, 384)
            };

            let params = SincInterpolationParameters {
                sinc_len,
                f_cutoff: 0.95,
                interpolation: interpolation_type,
                oversampling_factor: oversampling,
                window: WindowFunction::BlackmanHarris2,
            };

            match SincFixedIn::<f32>::new(
                ratio,
                2.0,  // Maximum relative deviation
                params,
                RESAMPLER_CHUNK_SIZE,
                1,    // Mono
            ) {
                Ok(resampler) => {
                    info!("✅ Persistent resampler initialized for '{}' ({}Hz → {}Hz, chunk_size={})",
                          device.name, sample_rate, TARGET_SAMPLE_RATE, RESAMPLER_CHUNK_SIZE);
                    info!("   Buffering enabled for variable-size chunks (e.g., 320, 512, 1024, etc.)");
                    Some(resampler)
                }
                Err(e) => {
                    warn!("⚠️ Failed to create persistent resampler: {}, will use fallback", e);
                    None
                }
            }
        } else {
            None
        };

        Self {
            device,
            state,
            sample_rate,
            channels,
            chunk_counter: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            device_type,
            recording_sender,
            needs_resampling,
            resampler: Arc::new(std::sync::Mutex::new(resampler)),
            resampler_input_buffer: Arc::new(std::sync::Mutex::new(Vec::with_capacity(RESAMPLER_CHUNK_SIZE * 2))),
            resampler_chunk_size: RESAMPLER_CHUNK_SIZE,
            noise_suppressor: Arc::new(std::sync::Mutex::new(noise_suppressor)),
            high_pass_filter: Arc::new(std::sync::Mutex::new(high_pass_filter)),
            normalizer: Arc::new(std::sync::Mutex::new(normalizer)),
            // Using global recording time for sync
        }
    }

    /// Process audio data directly from callback
    pub fn process_audio_data(&self, data: &[f32]) {
        // Check if still recording
        if !self.state.is_recording() {
            return;
        }

        // Convert to mono if needed
        let mut mono_data = if self.channels > 1 {
            audio_to_mono(data, self.channels)
        } else {
            data.to_vec()
        };

        // CRITICAL FIX: Resample to 48kHz if device uses different sample rate
        // This fixes Bluetooth devices (like Sony WH-1000XM4) that report 16kHz or 44.1kHz
        // Without this, audio is sped up 3x and VAD fails
        //
        // IMPORTANT: Uses PERSISTENT resampler with BUFFERING to preserve energy across chunks
        // Creating a new resampler per chunk causes energy amplification (173.5% RMS)
        // Buffering handles variable chunk sizes (320, 512, 1024, etc.) by accumulating to fixed 512-sample chunks
        const TARGET_SAMPLE_RATE: u32 = 48000;
        if self.needs_resampling {
            let before_len = mono_data.len();
            let before_rms = if !mono_data.is_empty() {
                (mono_data.iter().map(|&x| x * x).sum::<f32>() / mono_data.len() as f32).sqrt()
            } else {
                0.0
            };

            // Use persistent resampler with buffering to handle variable chunk sizes
            let mut resampled_output = Vec::new();
            let mut used_persistent_resampler = false;

            if let Ok(mut buffer_lock) = self.resampler_input_buffer.lock() {
                // Add new samples to buffer
                buffer_lock.extend_from_slice(&mono_data);

                // Process complete chunks through the resampler
                if let Ok(mut resampler_lock) = self.resampler.lock() {
                    if let Some(ref mut resampler) = *resampler_lock {
                        used_persistent_resampler = true;

                        // Process as many complete chunks as we have
                        while buffer_lock.len() >= self.resampler_chunk_size {
                            // Extract exactly chunk_size samples
                            let chunk: Vec<f32> = buffer_lock.drain(0..self.resampler_chunk_size).collect();

                            // Rubato expects input as Vec<Vec<f32>> (one Vec per channel)
                            let waves_in = vec![chunk];

                            match resampler.process(&waves_in, None) {
                                Ok(mut waves_out) => {
                                    if let Some(output) = waves_out.pop() {
                                        resampled_output.extend_from_slice(&output);
                                    }
                                }
                                Err(e) => {
                                    warn!("⚠️ Persistent resampler processing failed: {}", e);
                                    used_persistent_resampler = false;
                                    break;
                                }
                            }
                        }
                        // Remaining samples in buffer will be processed in next iteration
                    }
                }
            }

            // CRITICAL: Only update mono_data if we got output from persistent resampler
            // If buffer is accumulating (< 512 samples), skip this chunk - data is safely buffered
            // and will be processed in next iteration with proper resampling
            let has_resampled_output = !resampled_output.is_empty();

            if has_resampled_output {
                mono_data = resampled_output;
            } else if !used_persistent_resampler {
                // Only fallback if persistent resampler is not available at all
                mono_data = super::audio_processing::resample_audio(
                    &mono_data,
                    self.sample_rate,
                    TARGET_SAMPLE_RATE,
                );
            } else {
                // Buffering: samples are accumulating in buffer, waiting for 512-sample chunk
                // Don't send partial/unprocessed data - return early
                // Audio is NOT lost - it's in the buffer and will be processed next iteration
                return;
            }

            // Log resampling only occasionally to avoid spam
            let chunk_id = self.chunk_counter.load(std::sync::atomic::Ordering::SeqCst);
            if chunk_id % 100 == 0 && has_resampled_output {
                let after_len = mono_data.len();
                let after_rms = if !mono_data.is_empty() {
                    (mono_data.iter().map(|&x| x * x).sum::<f32>() / mono_data.len() as f32).sqrt()
                } else {
                    0.0
                };
                let ratio = TARGET_SAMPLE_RATE as f64 / self.sample_rate as f64;
                let rms_preservation = if before_rms > 0.0 { (after_rms / before_rms) * 100.0 } else { 100.0 };

                let buffer_size = if let Ok(buf) = self.resampler_input_buffer.lock() {
                    buf.len()
                } else {
                    0
                };

                info!(
                    "🔄 [{:?}] Persistent buffered resampler: {}Hz → {}Hz (ratio: {:.2}x)",
                    self.device_type,
                    self.sample_rate,
                    TARGET_SAMPLE_RATE,
                    ratio
                );
                info!(
                    "   Chunk {}: {} → {} samples, RMS preservation: {:.1}%, buffer: {}",
                    chunk_id,
                    before_len,
                    after_len,
                    rms_preservation,
                    buffer_size
                );
            }
        }

        // AUDIO ENHANCEMENT PIPELINE (Microphone Only)
        // Processing order is critical: high-pass → noise suppression → normalization
        // This ensures noise is removed before being amplified by the normalizer
        if matches!(self.device_type, DeviceType::Microphone) {
            // STEP 1: Apply high-pass filter to remove low-frequency rumble (< 80 Hz)
            if let Ok(mut hpf_lock) = self.high_pass_filter.lock() {
                if let Some(ref mut filter) = *hpf_lock {
                    mono_data = filter.process(&mono_data);
                }
            }

            // STEP 2: Apply RNNoise noise suppression (10-15 dB reduction) - CONDITIONAL
            if super::ffmpeg_mixer::RNNOISE_APPLY_ENABLED {
                if let Ok(mut ns_lock) = self.noise_suppressor.lock() {
                    if let Some(ref mut suppressor) = *ns_lock {
                        let before_len = mono_data.len();
                        mono_data = suppressor.process(&mono_data);
                        let after_len = mono_data.len();

                        // CRITICAL MONITORING: Track buffer health
                        let chunk_id = self.chunk_counter.load(std::sync::atomic::Ordering::SeqCst);
                        if chunk_id % 100 == 0 {
                            let buffered = suppressor.buffered_samples();
                            let length_delta = (before_len as i32 - after_len as i32).abs();

                            debug!("🔇 Noise suppression health: in={}, out={}, delta={}, buffered={}, RMS={:.4}",
                                   before_len, after_len, length_delta, buffered,
                                   if !mono_data.is_empty() {
                                       (mono_data.iter().map(|&x| x * x).sum::<f32>() / mono_data.len() as f32).sqrt()
                                   } else { 0.0 });

                            // WARN if accumulating samples (potential latency buildup)
                            if buffered > 1000 {
                                warn!("⚠️ RNNoise accumulating samples: {} buffered (potential latency issue!)",
                                      buffered);
                            }

                            // WARN if significant length mismatch
                            if length_delta > 50 {
                                warn!("⚠️ RNNoise length mismatch: input={} output={} (delta={})",
                                      before_len, after_len, length_delta);
                            }
                        }
                    }
                }
            }

            // STEP 3: Apply EBU R128 normalization (professional loudness standard)
            if let Ok(mut normalizer_lock) = self.normalizer.lock() {
                if let Some(ref mut normalizer) = *normalizer_lock {
                    mono_data = normalizer.normalize_loudness(&mono_data);

                    // Log normalization occasionally for debugging
                    let chunk_id = self.chunk_counter.load(std::sync::atomic::Ordering::SeqCst);
                    if chunk_id % 200 == 0 && !mono_data.is_empty() {
                        let rms = (mono_data.iter().map(|&x| x * x).sum::<f32>() / mono_data.len() as f32).sqrt();
                        let peak = mono_data.iter().map(|&x| x.abs()).fold(0.0f32, f32::max);
                        debug!("🎤 After normalization chunk {}: RMS={:.4}, Peak={:.4}", chunk_id, rms, peak);
                    }
                }
            }
        }

        // Create audio chunk with stream-specific timestamp (get ID first for logging)
        let chunk_id = self.chunk_counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        // RAW AUDIO: No gain applied here - will be applied AFTER mixing
        // This prevents amplifying system audio bleed-through in the microphone

        // DIAGNOSTIC: Log audio levels for debugging (especially mic issues)
        // if chunk_id % 100 == 0 && !mono_data.is_empty() {
        //     let raw_rms = (mono_data.iter().map(|&x| x * x).sum::<f32>() / mono_data.len() as f32).sqrt();
        //     let raw_peak = mono_data.iter().map(|&x| x.abs()).fold(0.0f32, f32::max);

        //         info!("🎙️ [{:?}] Chunk {} - Raw: RMS={:.6}, Peak={:.6}",
        //               self.device_type, chunk_id, raw_rms, raw_peak);

        //     // Warn if microphone is completely silent
        //     if matches!(self.device_type, DeviceType::Microphone) && raw_rms == 0.0 && raw_peak == 0.0 {
        //         warn!("⚠️ Microphone producing ZERO audio - check permissions or hardware!");
        //     }
        // }
        // else if chunk_id % 100 == 0 && matches!(self.device_type, DeviceType::System) {
        //     let raw_rms = (mono_data.iter().map(|&x| x * x).sum::<f32>() / mono_data.len() as f32).sqrt();
        //     let raw_peak = mono_data.iter().map(|&x| x.abs()).fold(0.0f32, f32::max);
        //     info!("🔊 [{:?}] Chunk {} - Raw: RMS={:.6}, Peak={:.6}",
        //       self.device_type, chunk_id, raw_rms, raw_peak);
            
        //     // Warn if system audio is completely silent
        //     if raw_rms == 0.0 && raw_peak == 0.0 {
        //         warn!("⚠️ System audio producing ZERO audio - check permissions or hardware!");
        //     }
        // }

        // Use global recording timestamp for proper synchronization
        let timestamp = self.state.get_recording_duration().unwrap_or(0.0);

        // RAW AUDIO CHUNK: No gain applied - will be mixed and gained downstream
        // Use 48kHz if we resampled, otherwise use original rate
        let audio_chunk = AudioChunk {
            data: mono_data,  // Raw audio (resampled if needed), no gain yet
            sample_rate: if self.needs_resampling { 48000 } else { self.sample_rate },
            timestamp,
            chunk_id,
            device_type: self.device_type.clone(),
            overlap_samples: 0,
        };

        // NOTE: Raw audio is NOT sent to recording saver to prevent echo
        // Only the mixed audio (from AudioPipeline) is saved to file (see pipeline.rs:726-736)
        // This ensures we only record once: mic + system properly mixed
        // Individual raw streams go only to the transcription pipeline below

        // Send to processing pipeline for transcription
        if let Err(e) = self.state.send_audio_chunk(audio_chunk) {
            // Check if this is the "pipeline not ready" error
            if e.to_string().contains("Audio pipeline not ready") {
                // This is expected during initialization, just log it as debug
                debug!("Audio pipeline not ready yet, skipping chunk {}", chunk_id);
                return;
            }

            warn!("Failed to send audio chunk: {}", e);
            // More specific error handling based on failure reason
            let error = if e.to_string().contains("channel closed") {
                AudioError::ChannelClosed
            } else if e.to_string().contains("full") {
                AudioError::BufferOverflow
            } else {
                AudioError::ProcessingFailed
            };
            self.state.report_error(error);
        } else {
            debug!("Sent audio chunk {} ({} samples)", chunk_id, data.len());
        }
    }

    /// Handle stream errors with enhanced disconnect detection
    pub fn handle_stream_error(&self, error: cpal::StreamError) {
        error!("Audio stream error for {}: {}", self.device.name, error);

        let error_str = error.to_string().to_lowercase();

        // Enhanced error detection for device disconnection
        let audio_error = if error_str.contains("device is no longer available")
            || error_str.contains("device not found")
            || error_str.contains("device disconnected")
            || error_str.contains("no such device")
            || error_str.contains("device unavailable")
            || error_str.contains("device removed")
        {
            warn!("🔌 Device disconnect detected for: {}", self.device.name);
            AudioError::DeviceDisconnected
        } else if error_str.contains("permission") || error_str.contains("access denied") {
            AudioError::PermissionDenied
        } else if error_str.contains("channel closed") {
            AudioError::ChannelClosed
        } else if error_str.contains("stream") && error_str.contains("failed") {
            AudioError::StreamFailed
        } else {
            warn!("Unknown audio error: {}", error);
            AudioError::StreamFailed
        };

        self.state.report_error(audio_error);
    }
}

/// VAD-driven audio processing pipeline
/// Uses Voice Activity Detection to segment speech in real-time and send only speech to Whisper
pub struct AudioPipeline {
    receiver: mpsc::UnboundedReceiver<AudioChunk>,
    transcription_sender: mpsc::UnboundedSender<AudioChunk>,
    state: Arc<RecordingState>,
    vad_mic: ContinuousVadProcessor,
    vad_system: ContinuousVadProcessor,
    echo_canceller: EchoCanceller,
    raw_track_saver: Option<RawTrackSaver>,
    sample_rate: u32,
    chunk_id_counter: u64,
    // Performance optimization: reduce logging frequency
    last_summary_time: std::time::Instant,
    processed_chunks: u64,
    // Smart batching for audio metrics
    metrics_batcher: Option<AudioMetricsBatcher>,
    // PROFESSIONAL AUDIO MIXING: Ring buffer + RMS-based mixer
    ring_buffer: AudioMixerRingBuffer,
    mixer: ProfessionalAudioMixer,
    // Recording sender for pre-mixed audio
    recording_sender_for_mixed: Option<mpsc::UnboundedSender<AudioChunk>>,
    // Per-stream transcription buffers: accumulate VAD segments until
    // >= MIN_TRANSCRIPTION_SAMPLES before sending to Whisper. Short chunks
    // (<1.5s) produce poor transcription quality. Mic and system are
    // accumulated independently so a flush on one stream doesn't truncate
    // the other.
    mic_transcription_buffer: Vec<f32>,
    mic_transcription_buffer_start_ts: f64,
    mic_transcription_buffer_last_activity: std::time::Instant,
    system_transcription_buffer: Vec<f32>,
    system_transcription_buffer_start_ts: f64,
    system_transcription_buffer_last_activity: std::time::Instant,
    // Last TRANSCRIPTION_OVERLAP_SAMPLES of the audio sent for each stream's
    // most recent transcription flush. Prepended to the next flush so words
    // straddling buffer boundaries get a second chance. Empty until the first
    // flush; worker.rs dedupes the overlapping prefix in the resulting text.
    mic_overlap_tail: Vec<f32>,
    system_overlap_tail: Vec<f32>,
    // Provider-aware flush thresholds (cloud = low latency, local = large context).
    flush_profile: FlushProfile,
    // ElevenLabs Scribe v2 Realtime streaming session (None unless the realtime
    // model is selected). When active AND the stream's route is Realtime, the VAD
    // path taps ALL of the stream's audio live to the socket (continuous feed,
    // silence included) and BYPASSES the batch transcription-buffer accumulation;
    // when the route is Batch (disconnected or degraded) it falls back to the
    // existing VAD-gated accumulation path so no words are lost (plan D2/D5).
    // The recording_saver path is never affected.
    realtime_session: Option<Arc<ElevenLabsRealtimeSession>>,
    // Per-stream realtime route observed on the PREVIOUS window, for detecting
    // route flips (Realtime<->Batch) to drive shadow-buffer catch-up (MAJOR-1)
    // and mid-open-segment reconnect onset re-marking (MAJOR-2a).
    mic_prev_route: Option<Route>,
    system_prev_route: Option<Route>,
    // Last commit-epoch observed per stream. The realtime session bumps its epoch
    // once per EMITTED committed transcript; the shadow windows that commit
    // covered are dropped when it moves (see `sync_commit_progress`).
    mic_commit_epoch: u64,
    system_commit_epoch: u64,
    // MAJOR-1 shadow, windowed: speech fed to the realtime socket that no emitted
    // transcript covers yet. See [`ShadowBuffer`].
    mic_shadow: ShadowBuffer,
    system_shadow: ShadowBuffer,
    // One-shot guard for the shadow-cap warning (see `shadow_append`).
    shadow_cap_warned: bool,
}

/// One window of realtime-fed speech held for catch-up, in recording time.
/// Windows are speech-only, so consecutive windows are NOT contiguous.
#[derive(Debug, Clone, PartialEq)]
pub struct ShadowWindow {
    pub rec_start: f64,
    pub samples: Vec<f32>,
}

/// Catch-up store for realtime-fed speech that no EMITTED transcript covers yet.
///
/// A queue of windows rather than one flat buffer, for three reasons a flat
/// buffer got wrong:
///   * a confirmed commit must drop only what it COVERED, keeping the speech fed
///     while it was in flight (a flat clear lost 0.3-1.2s of the tail at stop);
///   * the windows are speech-only and therefore NON-CONTIGUOUS, so trimming
///     samples off the front to enforce a cap silently invalidated the start
///     timestamp of everything that remained;
///   * capping by draining a multi-megabyte Vec memmoved the whole buffer on
///     every append once full.
#[derive(Debug, Default)]
pub struct ShadowBuffer {
    windows: VecDeque<ShadowWindow>,
    samples: usize,
}

impl ShadowBuffer {
    /// Cap: 60s of speech at 16kHz. The shadow is normally bounded by the commit
    /// cadence, but only while commits keep arriving; this is the backstop for
    /// when they stop (the engine's stall watchdog is the primary defence).
    pub const CAP_SAMPLES: usize = 60 * 16000;

    pub fn new() -> Self {
        Self {
            windows: VecDeque::new(),
            samples: 0,
        }
    }

    /// Record one speech window. Returns true if the cap forced older windows out.
    pub fn append(&mut self, rec_start: f64, samples: &[f32]) -> bool {
        if samples.is_empty() {
            return false;
        }
        self.windows.push_back(ShadowWindow {
            rec_start,
            samples: samples.to_vec(),
        });
        self.samples += samples.len();
        let mut overflowed = false;
        while self.samples > Self::CAP_SAMPLES && self.windows.len() > 1 {
            if let Some(dropped) = self.windows.pop_front() {
                self.samples -= dropped.samples.len();
                overflowed = true;
            }
        }
        overflowed
    }

    /// Drop every window fully covered by a commit reaching `through_secs` of
    /// recording time. Windows after it are KEPT: nothing has transcribed them.
    /// The tolerance absorbs the one-VAD-window granularity of the mapped end.
    pub fn drop_through(&mut self, through_secs: f64) {
        while let Some(front) = self.windows.front() {
            let end = front.rec_start + front.samples.len() as f64 / 16000.0;
            if end <= through_secs + 0.05 {
                let dropped = self.windows.pop_front().expect("front exists");
                self.samples -= dropped.samples.len();
            } else {
                break;
            }
        }
    }

    /// Take everything as ONE concatenated block plus the first window's
    /// recording start, leaving the buffer empty. `None` when there is nothing.
    pub fn drain_concatenated(&mut self) -> Option<(f64, Vec<f32>)> {
        let first_start = self.windows.front()?.rec_start;
        let mut data: Vec<f32> = Vec::with_capacity(self.samples);
        for w in self.windows.iter() {
            data.extend_from_slice(&w.samples);
        }
        self.windows.clear();
        self.samples = 0;
        Some((first_start, data))
    }

    pub fn clear(&mut self) {
        self.windows.clear();
        self.samples = 0;
    }

    pub fn is_empty(&self) -> bool {
        self.windows.is_empty()
    }

    pub fn len_samples(&self) -> usize {
        self.samples
    }

    pub fn window_count(&self) -> usize {
        self.windows.len()
    }

    /// Recording start of the oldest retained window (diagnostics/tests).
    pub fn first_start(&self) -> Option<f64> {
        self.windows.front().map(|w| w.rec_start)
    }
}

impl AudioPipeline {
    pub fn new(
        receiver: mpsc::UnboundedReceiver<AudioChunk>,
        transcription_sender: mpsc::UnboundedSender<AudioChunk>,
        state: Arc<RecordingState>,
        target_chunk_duration_ms: u32,
        sample_rate: u32,
        mic_device_name: String,
        mic_device_kind: super::device_detection::InputDeviceKind,
        system_device_name: String,
        system_device_kind: super::device_detection::InputDeviceKind,
        raw_track_folder: Option<std::path::PathBuf>,
        flush_profile: FlushProfile,
        realtime_session: Option<Arc<ElevenLabsRealtimeSession>>,
    ) -> Result<Self> {
        if realtime_session.is_some() {
            info!("🎧 Realtime streaming session ACTIVE — continuous live feed + 30s danger-band commit scheduler (batch buffer is degraded-mode fallback)");
        }
        info!(
            "🎛️ Flush profile: min={} samples ({:.1}s) / silence-gap {:.1}s / max-block {}",
            flush_profile.min_samples,
            flush_profile.min_samples as f64 / 16000.0,
            flush_profile.silence_gap_secs,
            if flush_profile.max_block_secs.is_finite() {
                format!("{:.1}s", flush_profile.max_block_secs)
            } else {
                "none".to_string()
            }
        );
        // Log device characteristics for adaptive buffering
        info!("🎛️ AudioPipeline initializing with device characteristics:");
        info!("   Mic: '{}' ({:?}) - Buffer: {:?}",
              mic_device_name, mic_device_kind, mic_device_kind.buffer_timeout());
        info!("   System: '{}' ({:?}) - Buffer: {:?}",
              system_device_name, system_device_kind, system_device_kind.buffer_timeout());

        // Device kind information can be used for adaptive buffering in the future
        // For now, we log it for monitoring and potential optimization
        let _ = (mic_device_name, mic_device_kind, system_device_name, system_device_kind);

        // Create VAD processor with balanced redemption time for speech accumulation
        // The VAD processor now handles 48kHz->16kHz resampling internally
        // This bridges natural pauses without excessive fragmentation
        //
        // Tuning loop winner (audio_testing/tune_parakeet_loop.py, 2026-06-03):
        // 800ms redemption (up from 500ms Windows / 900ms macOS-leaning) keeps
        // brief mid-sentence pauses inside one segment. Must stay > vad.rs
        // post_speech_pad (200ms). macOS stays at 900ms since the existing
        // value was already past the sweep optimum.
        let redemption_time = if cfg!(target_os = "macos") { 900 } else { 800 };

        let vad_mic = ContinuousVadProcessor::new(sample_rate, redemption_time)
            .map_err(|e| anyhow::anyhow!("Failed to create mic VAD processor: {}", e))?;
        let vad_system = ContinuousVadProcessor::new(sample_rate, redemption_time)
            .map_err(|e| anyhow::anyhow!("Failed to create system VAD processor: {}", e))?;
        info!("VAD-driven pipeline: dual VAD instances (mic + system) feed separate transcription streams");

        let echo_canceller = EchoCanceller::new(sample_rate)
            .map_err(|e| anyhow::anyhow!("Failed to create echo canceller: {}", e))?;

        let raw_track_saver = if RawTrackSaver::is_enabled() {
            match raw_track_folder.as_ref() {
                Some(folder) => match RawTrackSaver::new(folder, sample_rate) {
                    Ok(saver) => {
                        info!("TANDEM_SAVE_RAW_TRACKS=1: raw debug WAV tracks → {}",
                              folder.display());
                        Some(saver)
                    }
                    Err(e) => {
                        warn!("TANDEM_SAVE_RAW_TRACKS=1 but RawTrackSaver init failed: {}", e);
                        None
                    }
                },
                None => {
                    warn!("TANDEM_SAVE_RAW_TRACKS=1 but no meeting folder available; raw tracks disabled");
                    None
                }
            }
        } else {
            None
        };

        // Initialize professional audio mixing components
        let ring_buffer = AudioMixerRingBuffer::new(sample_rate);
        let mixer = ProfessionalAudioMixer::new(sample_rate);

        // Note: target_chunk_duration_ms is ignored - VAD controls segmentation now
        let _ = target_chunk_duration_ms;

        Ok(Self {
            receiver,
            transcription_sender,
            state,
            vad_mic,
            vad_system,
            echo_canceller,
            raw_track_saver,
            sample_rate,
            chunk_id_counter: 0,
            // Performance optimization: reduce logging frequency
            last_summary_time: std::time::Instant::now(),
            processed_chunks: 0,
            // Initialize metrics batcher for smart batching
            metrics_batcher: Some(AudioMetricsBatcher::new()),
            // Initialize professional audio mixing
            ring_buffer,
            mixer,
            recording_sender_for_mixed: None,  // Will be set by manager
            // Per-stream transcription buffers (1.5s @ 16kHz pre-allocated)
            mic_transcription_buffer: Vec::with_capacity(48000),
            mic_transcription_buffer_start_ts: 0.0,
            mic_transcription_buffer_last_activity: std::time::Instant::now(),
            system_transcription_buffer: Vec::with_capacity(48000),
            system_transcription_buffer_start_ts: 0.0,
            system_transcription_buffer_last_activity: std::time::Instant::now(),
            mic_overlap_tail: Vec::new(),
            system_overlap_tail: Vec::new(),
            flush_profile,
            realtime_session,
            mic_prev_route: None,
            system_prev_route: None,
            mic_commit_epoch: 0,
            system_commit_epoch: 0,
            mic_shadow: ShadowBuffer::new(),
            system_shadow: ShadowBuffer::new(),
            shadow_cap_warned: false,
        })
    }


    /// Run the VAD-driven audio processing pipeline
    pub async fn run(mut self) -> Result<()> {
        info!("VAD-driven audio pipeline started - segments sent in real-time based on speech detection");

        // CRITICAL FIX: Continue processing until channel is closed, not based on recording state
        // This ensures ALL chunks are processed during shutdown, fixing premature meeting completion
        // Previous bug: Loop checked `while self.state.is_recording()` which caused early exit when
        // stop_recording() was called, losing flush signals and remaining chunks in the pipeline
        loop {
            // Receive audio chunks with timeout
            match tokio::time::timeout(
                std::time::Duration::from_millis(50), // Shorter timeout for responsiveness
                self.receiver.recv()
            ).await {
                Ok(Some(chunk)) => {
                    // PERFORMANCE: Check for flush signal (special chunk with ID >= u64::MAX - 10)
                    // Multiple flush signals may be sent to ensure processing
                    if chunk.chunk_id >= u64::MAX - 10 {
                        info!("📥 Received FLUSH signal #{} - flushing VAD processor", u64::MAX - chunk.chunk_id);
                        self.flush_remaining_audio()?;
                        // Continue processing to handle any remaining chunks
                        continue;
                    }

                    // PERFORMANCE OPTIMIZATION: Eliminate per-chunk logging overhead
                    // Logging in hot paths causes severe performance degradation
                    self.processed_chunks += 1;

                    // Smart batching: collect metrics instead of logging every chunk
                    if let Some(ref batcher) = self.metrics_batcher {
                        let avg_level = chunk.data.iter().map(|&x| x.abs()).sum::<f32>() / chunk.data.len() as f32;
                        let duration_ms = chunk.data.len() as f64 / chunk.sample_rate as f64 * 1000.0;

                        batch_audio_metric!(
                            Some(batcher),
                            chunk.chunk_id,
                            chunk.data.len(),
                            duration_ms,
                            avg_level
                        );
                    }

                    // CRITICAL: Log summary only every 200 chunks OR every 60 seconds (99.5% reduction)
                    // This eliminates I/O overhead in the audio processing hot path
                    // Use performance-optimized debug macro that compiles to nothing in release builds
                    if self.processed_chunks % 200 == 0 || self.last_summary_time.elapsed().as_secs() >= 60 {
                        perf_debug!("Pipeline processed {} chunks, current chunk: {} ({} samples)",
                                   self.processed_chunks, chunk.chunk_id, chunk.data.len());
                        self.last_summary_time = std::time::Instant::now();
                    }

                    // STEP 1: Add raw audio to ring buffer for mixing
                    // Microphone audio is already normalized at capture level (AudioCapture)
                    // System audio remains raw
                    self.ring_buffer.add_samples(chunk.device_type.clone(), chunk.data);

                    // STEP 2: Process aligned windows when both streams have data
                    while self.ring_buffer.can_mix() {
                        if let Some((mut mic_window, sys_window)) = self.ring_buffer.extract_window() {
                            // STEP 2a: Save raw mic / system tracks for offline benchmarking
                            if let Some(ref mut saver) = self.raw_track_saver {
                                saver.write_mic_raw(&mic_window);
                                saver.write_system(&sys_window);
                            }

                            // STEP 2b: AEC — subtract system audio (reference) from mic
                            // mic_window is modified in place; carry-over inside EchoCanceller
                            // handles 10ms frame alignment for arbitrary window lengths.
                            self.echo_canceller.process(&mut mic_window, &sys_window);

                            if let Some(ref mut saver) = self.raw_track_saver {
                                saver.write_mic_clean(&mic_window);
                            }

                            // STEP 3: Per-stream VAD on cleaned mic + raw system
                            let mic_vad_input: Vec<f32> = mic_window.iter()
                                .map(|&s| s.clamp(-1.0, 1.0))
                                .collect();
                            self.process_stream_vad(&mic_vad_input, DeviceType::Microphone);

                            let sys_vad_input: Vec<f32> = sys_window.iter()
                                .map(|&s| s.clamp(-1.0, 1.0))
                                .collect();
                            self.process_stream_vad(&sys_vad_input, DeviceType::System);

                            // Publish audio-elapsed time from mic VAD so screenshot/clipboard
                            // timestamps stay aligned with transcript timestamps. Both VAD
                            // instances share the same input cadence, so either clock works.
                            crate::audio::recording_commands::update_audio_elapsed_secs(
                                self.vad_mic.audio_elapsed_secs(),
                            );

                            // STEP 4: Mix cleaned mic + system for the saved recording file
                            let mixed_clean = self.mixer.mix_window(&mic_window, &sys_window);

                            if let Some(ref sender) = self.recording_sender_for_mixed {
                                let recording_chunk = AudioChunk {
                                    data: mixed_clean,
                                    sample_rate: self.sample_rate,
                                    timestamp: chunk.timestamp,
                                    chunk_id: self.chunk_id_counter,
                                    device_type: DeviceType::Microphone,  // Mixed audio
                                    overlap_samples: 0,
                                };
                                let _ = sender.send(recording_chunk);
                            }
                        }
                    }
                }
                Ok(None) => {
                    info!("Audio pipeline: sender closed after processing {} chunks", self.processed_chunks);
                    break;
                }
                Err(_) => {
                    // Timeout (no audio for 50ms) — check each stream's buffer
                    // independently for silence-gap flush. Without per-stream tracking,
                    // activity on one stream would delay flushing the other.
                    //
                    // MAJOR-1 guard: while a stream is on the Realtime route its
                    // batch buffer is a SHADOW catch-up store, not batch output —
                    // never flush it here or it would double-transcribe. It flushes
                    // only on the flip to Batch (in process_stream_vad).
                    let mic_realtime = self
                        .realtime_session
                        .as_ref()
                        .map(|s| s.route(&DeviceType::Microphone) == Route::Realtime)
                        .unwrap_or(false);
                    let system_realtime = self
                        .realtime_session
                        .as_ref()
                        .map(|s| s.route(&DeviceType::System) == Route::Realtime)
                        .unwrap_or(false);
                    if !mic_realtime
                        && !self.mic_transcription_buffer.is_empty()
                        && self.mic_transcription_buffer_last_activity.elapsed().as_secs_f64()
                            >= self.flush_profile.silence_gap_secs
                    {
                        info!("⏱️ Mic silence gap ({:.1}s) exceeded — flushing partial mic buffer ({} samples, {:.1}s)",
                              self.mic_transcription_buffer_last_activity.elapsed().as_secs_f64(),
                              self.mic_transcription_buffer.len(),
                              self.mic_transcription_buffer.len() as f64 / 16000.0);
                        self.flush_transcription_buffer(DeviceType::Microphone);
                    }
                    if !system_realtime
                        && !self.system_transcription_buffer.is_empty()
                        && self.system_transcription_buffer_last_activity.elapsed().as_secs_f64()
                            >= self.flush_profile.silence_gap_secs
                    {
                        info!("⏱️ System silence gap ({:.1}s) exceeded — flushing partial system buffer ({} samples, {:.1}s)",
                              self.system_transcription_buffer_last_activity.elapsed().as_secs_f64(),
                              self.system_transcription_buffer.len(),
                              self.system_transcription_buffer.len() as f64 / 16000.0);
                        self.flush_transcription_buffer(DeviceType::System);
                    }
                    continue;
                }
            }
        }

        // Flush any remaining VAD segments
        self.flush_remaining_audio()?;

        info!("VAD-driven audio pipeline ended");
        Ok(())
    }

    /// The flush cap (`min_samples`) and silence-gap threshold now live on the
    /// per-recording [`FlushProfile`] (`self.flush_profile`) so cloud providers
    /// can use a low-latency profile while local engines keep the 12s / 1.2s
    /// large-context values. See `FlushProfile::LOCAL` / `FlushProfile::CLOUD`.
    ///
    /// Per-stream left-context overlap, in samples (1.0s at 16kHz).
    /// Tuning loop Phase F: prepending 1.0s of the previous buffer's audio
    /// before the next transcription pass dropped pooled WER 23.95% -> 23.31%
    /// at the winning VAD config. Worker dedups the overlapping prefix words
    /// against the previous emission's suffix. Set to 0 to disable. Applied on
    /// EVERY flush regardless of profile.
    const TRANSCRIPTION_OVERLAP_SAMPLES: usize = 16000;

    /// Run a window through the per-stream VAD and accumulate speech segments
    /// into the matching transcription buffer. Flushes when the buffer reaches
    /// `flush_profile.min_samples` OR when the buffer's audio-time span reaches
    /// `flush_profile.max_block_secs` (cloud low-latency ceiling). Segment
    /// timestamps come from the VAD's internal audio-elapsed clock, so the
    /// chunk wall-clock timestamp is not needed here.
    fn process_stream_vad(
        &mut self,
        vad_input: &[f32],
        device_type: DeviceType,
    ) {
        // Realtime routing decision for THIS stream (Some only when a realtime
        // session is active). Cloned Arc so we don't hold a borrow on self.
        let session = self.realtime_session.clone();
        let realtime_route = session.as_ref().map(|s| s.route(&device_type));
        let prev_route = self.prev_route(&device_type);

        // ---- ROUTE FLIP HANDLING (MAJOR-1) -------------------------------
        // A route change means the shadow/batch buffer must not intermix realtime
        // catch-up audio with batch-accumulated segments.
        if session.is_some() && prev_route != realtime_route {
            if is_realtime_to_batch_flip(prev_route, realtime_route) {
                // Realtime -> Batch (disconnect/degrade, including a stall the
                // engine's watchdog forced): flush the unconfirmed shadow windows
                // through the batch machinery (no words lost), then reset this
                // stream's VAD so the still-open segment is not re-emitted and
                // double-transcribed.
                info!("🎧->📤 {:?} route flipped Realtime->Batch — flushing shadow catch-up windows", device_type);
                self.flush_shadow(&device_type);
                let _ = match &device_type {
                    DeviceType::Microphone => self.vad_mic.flush(),
                    DeviceType::System => self.vad_system.flush(),
                };
            } else if !self.stream_buffer_is_empty(&device_type) {
                // Batch -> Realtime (reconnect): drain any leftover batch buffer
                // so the resumed shadow starts clean.
                self.flush_transcription_buffer(device_type.clone());
            }
        }
        self.set_prev_route(&device_type, realtime_route);

        // Speech state BEFORE processing this window (for onset detection).
        let was_in_speech = match &device_type {
            DeviceType::Microphone => self.vad_mic.is_in_speech(),
            DeviceType::System => self.vad_system.is_in_speech(),
        };

        let vad_result = match device_type {
            DeviceType::Microphone => self.vad_mic.process_audio(vad_input),
            DeviceType::System => self.vad_system.process_audio(vad_input),
        };

        let speech_segments = match vad_result {
            Ok(segments) => segments,
            Err(e) => {
                warn!("⚠️ {:?} VAD error: {}", device_type, e);
                return;
            }
        };

        // ---- REALTIME TAP (continuous feed + danger-band commits) ---------
        // When the socket is up, forward EVERY window of this stream's audio live
        // in ~250ms frames — silence included, no VAD gating and no pre-roll. The
        // server's cross-utterance context is what buys the accuracy (pooled WER
        // 4.68% vs 6.31% for the old VAD-gated per-segment-commit feed). VAD
        // segment ends become GAP SIGNALS; the session's CommitScheduler decides
        // which gap actually commits (>= 30s uncommitted, outside the server's
        // ~36.5s auto-commit danger band).
        //
        // The fed audio is still shadowed for disconnect catch-up (MAJOR-1), but
        // only the SPEECH windows (feeding silence into the batch path would just
        // waste a transcription pass), and windows leave the shadow only once an
        // EMITTED commit covers them. That makes the shadow mean "speech no
        // transcript covers yet", which is exactly what the stop path flushes.
        //
        // When the route is Batch (disconnected/degraded) we fall through to the
        // existing VAD-gated path so the stream keeps transcribing.
        if let (Some(session), Some(Route::Realtime)) = (session.as_ref(), realtime_route) {
            // PRIVACY: never stream to the cloud while the user has paused. The
            // upstream choke point (RecordingState::send_audio_chunk) already
            // drops chunks when paused, so this is defence in depth at the point
            // where the bytes would actually leave the machine. The batch path is
            // unaffected either way.
            if self.state.is_paused() {
                return;
            }
            let now_in_speech = match &device_type {
                DeviceType::Microphone => self.vad_mic.is_in_speech(),
                DeviceType::System => self.vad_system.is_in_speech(),
            };
            // Resample this window to the socket's 16kHz feed format. Stateless
            // per-window resample (consistent with the batch worker path); Phase
            // 3 confirms boundary quality is acceptable.
            let frame16 = super::audio_processing::resample_audio(
                vad_input,
                self.sample_rate,
                FEED_SAMPLE_RATE,
            );
            let frame_secs = frame16.len() as f64 / FEED_SAMPLE_RATE as f64;
            let audio_elapsed = match &device_type {
                DeviceType::Microphone => self.vad_mic.audio_elapsed_secs(),
                DeviceType::System => self.vad_system.audio_elapsed_secs(),
            };
            // Recording-relative time of this window's first sample.
            let window_start = (audio_elapsed - frame_secs).max(0.0);

            // MAJOR-2a: on a Batch->Realtime flip mid-speech there is no
            // was->now edge, so hand the session an explicit timeline anchor.
            // Belt-and-braces only: the feed below carries the same timestamp and
            // the mapper takes whichever anchor lands first on this connection.
            if should_remark_onset_on_resume(
                prev_route,
                realtime_route,
                was_in_speech || now_in_speech,
            ) {
                session.mark_onset(&device_type, window_start);
            }

            // CONTINUOUS FEED: everything goes to the socket.
            session.feed(&device_type, &frame16, window_start);

            // Drop only the shadow windows an EMITTED commit covered. Clearing
            // everything on a commit lost the speech fed while it was in flight;
            // clearing on a commit merely SENT lost the whole round trip if the
            // socket then died.
            self.sync_commit_progress(session, &device_type);

            // MINOR-5: a segment that opened+closed within one window has no live
            // in-speech flag but its audio still belongs in the shadow.
            let has_committable_segment =
                speech_segments.iter().any(|s| s.samples.len() >= 800);
            if now_in_speech || was_in_speech || has_committable_segment {
                // MAJOR-1 shadow: keep the SPEECH audio so a route flip to Batch,
                // or recording stop, can flush the uncovered tail (catch-up).
                self.shadow_append(&device_type, &frame16, window_start);
            }

            // GAP SIGNAL on every SILENT window, matching the validated harness
            // (which commits at the first silent chunk once armed). Firing only at
            // VAD segment completion made armed cycles miss their chance and run
            // on into the server's auto-commit band more often than the harness's
            // 4.68% run did. The scheduler resets at send, so at most one commit
            // fires per armed cycle no matter how many gap signals arrive.
            if !now_in_speech && !has_committable_segment {
                session.segment_gap(&device_type);
            }
            return;
        }

        // ---- BATCH / DEGRADED PATH (unchanged) ---------------------------
        for segment in speech_segments {
            let duration_ms = segment.end_timestamp_ms - segment.start_timestamp_ms;
            if segment.samples.len() < 800 {
                debug!("⏭️ Dropping short {:?} VAD segment: {:.1}ms ({} samples < 800)",
                       device_type, duration_ms, segment.samples.len());
                continue;
            }

            let (buffer, start_ts, last_activity) = self.buffer_for(&device_type);
            if buffer.is_empty() {
                *start_ts = segment.start_timestamp_ms / 1000.0;
            }
            buffer.extend_from_slice(&segment.samples);
            *last_activity = std::time::Instant::now();
            let buffer_samples = buffer.len();
            // Audio-time span from the front of the buffer to the end of the
            // segment just appended. This is the "block wait" the oldest audio
            // in the buffer will incur before dispatch. The cloud profile caps
            // it (max_block_secs) so dense speech with only sub-silence-gap
            // pauses can't accumulate a 30s+ buffer before flushing.
            let block_span_secs = (segment.end_timestamp_ms / 1000.0) - *start_ts;

            perf_debug!("🎤 Buffered {:?} VAD segment: {:.1}ms ({} samples), buffer total: {} samples ({:.1}s), span {:.1}s",
                  device_type, duration_ms, segment.samples.len(),
                  buffer_samples, buffer_samples as f64 / 16000.0, block_span_secs);

            if buffer_samples >= self.flush_profile.min_samples {
                self.flush_transcription_buffer(device_type.clone());
            } else if block_span_secs >= self.flush_profile.max_block_secs {
                info!("⏩ {:?} max-block ceiling ({:.1}s span >= {:.1}s) — flushing {} samples ({:.1}s speech) early for low latency",
                      device_type, block_span_secs, self.flush_profile.max_block_secs,
                      buffer_samples, buffer_samples as f64 / 16000.0);
                self.flush_transcription_buffer(device_type.clone());
            }
        }
    }

    // ---- Realtime tap helpers (short, non-overlapping self borrows) --------

    fn prev_route(&self, device_type: &DeviceType) -> Option<Route> {
        match device_type {
            DeviceType::Microphone => self.mic_prev_route,
            DeviceType::System => self.system_prev_route,
        }
    }

    fn set_prev_route(&mut self, device_type: &DeviceType, route: Option<Route>) {
        match device_type {
            DeviceType::Microphone => self.mic_prev_route = route,
            DeviceType::System => self.system_prev_route = route,
        }
    }

    /// Drop the shadow windows covered by any commit the session has EMITTED
    /// since this stream last looked. Also called once at recording stop, right
    /// before the final flush, so a commit emitted during teardown is not
    /// batch-transcribed a second time.
    fn sync_commit_progress(
        &mut self,
        session: &Arc<ElevenLabsRealtimeSession>,
        device_type: &DeviceType,
    ) {
        // Acquire load; the paired Release bump publishes `committed_through`
        // before the epoch, so a new epoch implies a visible coverage time.
        let epoch = session.commit_epoch(device_type);
        let seen = match device_type {
            DeviceType::Microphone => self.mic_commit_epoch,
            DeviceType::System => self.system_commit_epoch,
        };
        if epoch == seen {
            return;
        }
        let through = session.committed_through_secs(device_type);
        match device_type {
            DeviceType::Microphone => self.mic_commit_epoch = epoch,
            DeviceType::System => self.system_commit_epoch = epoch,
        }
        self.shadow_for(device_type).drop_through(through);
    }

    /// Send a one-off transcription warning to the frontend through the same
    /// channel the batch worker uses (the transcription sender carries audio, so
    /// warnings ride the realtime session's event bridge instead when present).
    fn emit_realtime_warning(&self, message: &str) {
        // The pipeline has no AppHandle; the realtime session owns the warning
        // channel, so route through it when a session exists.
        if let Some(session) = self.realtime_session.as_ref() {
            session.emit_warning(message);
        } else {
            warn!("⚠️ {}", message);
        }
    }

    fn stream_buffer_is_empty(&self, device_type: &DeviceType) -> bool {
        match device_type {
            DeviceType::Microphone => self.mic_transcription_buffer.is_empty(),
            DeviceType::System => self.system_transcription_buffer.is_empty(),
        }
    }

    /// MAJOR-1 shadow: record one realtime-fed SPEECH window as catch-up audio.
    ///
    /// Nothing flushes here: the silence-gap flush in `run` is guarded against
    /// Realtime streams and the min/max checks live only in the batch branch, so a
    /// healthy realtime stream never double-transcribes.
    fn shadow_append(&mut self, device_type: &DeviceType, samples: &[f32], rec_start: f64) {
        let overflowed = self.shadow_for(device_type).append(rec_start, samples);
        if overflowed && !self.shadow_cap_warned {
            self.shadow_cap_warned = true;
            warn!(
                "⚠️ Realtime shadow buffer hit its {}s cap ({:?}) — no transcript has covered that audio; dropping the oldest unconfirmed windows",
                ShadowBuffer::CAP_SAMPLES / 16000,
                device_type
            );
            // Surface it: the user is losing tail coverage, not just a log line.
            self.emit_realtime_warning(
                "Live transcription is not confirming text; some audio may be transcribed late or not at all.",
            );
        }
    }

    fn shadow_for(&mut self, device_type: &DeviceType) -> &mut ShadowBuffer {
        match device_type {
            DeviceType::Microphone => &mut self.mic_shadow,
            DeviceType::System => &mut self.system_shadow,
        }
    }

    /// Hand the shadow's remaining windows to the batch path as ONE concatenated
    /// chunk, exactly the shape the batch provider already receives. The windows
    /// are speech-only and non-contiguous (silence between them was never stored),
    /// so the chunk start timestamp is the FIRST window's recording start; the
    /// batch worker treats the block as one utterance run, which is what the
    /// ordinary VAD-accumulated batch buffer is too.
    fn flush_shadow(&mut self, device_type: &DeviceType) {
        let Some((first_start, data)) = self.shadow_for(device_type).drain_concatenated() else {
            return;
        };
        // Stage into the stream's batch buffer (always empty on a Realtime stream:
        // the realtime branch returns before the batch accumulation) and reuse the
        // ordinary flush, so overlap handling and chunk shape stay identical.
        let (buffer, start, last_activity) = self.buffer_for(device_type);
        if buffer.is_empty() {
            *start = first_start;
        }
        buffer.extend_from_slice(&data);
        *last_activity = std::time::Instant::now();
        info!(
            "🎧->📤 Flushing {:?} realtime shadow: {} samples ({:.1}s) from {:.1}s",
            device_type,
            data.len(),
            data.len() as f64 / 16000.0,
            first_start
        );
        self.flush_transcription_buffer(device_type.clone());
    }

    /// Return mutable references to the per-stream buffer triple.
    fn buffer_for(
        &mut self,
        device_type: &DeviceType,
    ) -> (&mut Vec<f32>, &mut f64, &mut std::time::Instant) {
        match device_type {
            DeviceType::Microphone => (
                &mut self.mic_transcription_buffer,
                &mut self.mic_transcription_buffer_start_ts,
                &mut self.mic_transcription_buffer_last_activity,
            ),
            DeviceType::System => (
                &mut self.system_transcription_buffer,
                &mut self.system_transcription_buffer_start_ts,
                &mut self.system_transcription_buffer_last_activity,
            ),
        }
    }

    /// Send the accumulated buffer for `device_type` to Whisper and reset.
    /// Called when buffer >= MIN_TRANSCRIPTION_SAMPLES, on silence gap, or on
    /// recording stop. The `device_type` flows into the AudioChunk so downstream
    /// transcripts are labeled by source.
    ///
    /// Left-context overlap: the last TRANSCRIPTION_OVERLAP_SAMPLES of the
    /// previous flush is prepended so words straddling buffer boundaries get
    /// a second chance. The fresh tail (last N samples of THIS buffer, before
    /// prepending) is then saved for the next flush. worker.rs dedupes the
    /// overlapping prefix words in the resulting transcript.
    fn flush_transcription_buffer(&mut self, device_type: DeviceType) {
        // Read before borrowing self mutably via buffer_for (E0503 otherwise).
        let reuse_capacity = self.flush_profile.min_samples;
        let (buffer, start_ts, _) = self.buffer_for(&device_type);
        if buffer.is_empty() {
            return;
        }

        let buffer_samples = buffer.len();
        let buffer_duration_ms = buffer_samples as f64 / 16.0;
        let start_timestamp = *start_ts;

        info!("🎤 Flushing {:?} transcription buffer: {:.1}ms ({} samples) to Whisper",
              device_type, buffer_duration_ms, buffer_samples);

        let mut data = std::mem::replace(buffer, Vec::with_capacity(reuse_capacity));
        *start_ts = 0.0;

        // Capture fresh tail from this buffer for the NEXT flush, then prepend
        // the PREVIOUS tail to `data` before dispatch.
        let new_tail: Vec<f32> = if Self::TRANSCRIPTION_OVERLAP_SAMPLES > 0
            && data.len() > Self::TRANSCRIPTION_OVERLAP_SAMPLES
        {
            data[data.len() - Self::TRANSCRIPTION_OVERLAP_SAMPLES..].to_vec()
        } else {
            data.clone()
        };
        let prev_tail_slot = match device_type {
            DeviceType::Microphone => &mut self.mic_overlap_tail,
            DeviceType::System => &mut self.system_overlap_tail,
        };
        let overlap_samples = if Self::TRANSCRIPTION_OVERLAP_SAMPLES > 0
            && !prev_tail_slot.is_empty()
        {
            let overlap_len = prev_tail_slot.len();
            let mut prepended = Vec::with_capacity(overlap_len + data.len());
            prepended.extend_from_slice(prev_tail_slot);
            prepended.extend_from_slice(&data);
            data = prepended;
            overlap_len
        } else {
            0
        };
        *prev_tail_slot = new_tail;

        let chunk = AudioChunk {
            data,
            sample_rate: 16000,
            timestamp: start_timestamp,
            chunk_id: self.chunk_id_counter,
            device_type,
            overlap_samples,
        };

        self.chunk_id_counter += 1;

        if let Err(e) = self.transcription_sender.send(chunk) {
            warn!("Failed to send buffered transcription chunk: {}", e);
        }
    }

    fn flush_remaining_audio(&mut self) -> Result<()> {
        info!("Flushing remaining audio from pipeline (processed {} chunks)", self.processed_chunks);

        for device_type in [DeviceType::Microphone, DeviceType::System] {
            // MAJOR-R1, revised: EVERY stream flushes at stop, Realtime included.
            // The staged stop already gave the WS path its chance (finalize commit
            // outside the danger band), so what remains in the shadow is exactly
            // the audio no emitted transcript covers. Duplicate emission is
            // prevented by begin_shutdown(), called before this flush.
            //
            // Take one last look at the commit progress first: a commit emitted
            // during teardown must remove its windows before we flush the rest.
            let session = self.realtime_session.clone();
            let route = session.as_ref().map(|s| s.route(&device_type));
            if let Some(session) = session.as_ref() {
                self.sync_commit_progress(session, &device_type);
            }
            if !should_batch_flush_on_stop(route) {
                continue;
            }

            if !should_drain_vad_into_batch_on_stop(route) {
                // M3: the VAD's open segment is ALREADY in the shadow (the realtime
                // tap shadows every speech window, in-speech ones included), so
                // appending vad.flush()'s segments on top transcribed the closing
                // sentence TWICE inside one chunk. Flush the processor to reset it,
                // then discard the result, exactly as the Realtime->Batch flip does.
                let _ = match device_type {
                    DeviceType::Microphone => self.vad_mic.flush(),
                    DeviceType::System => self.vad_system.flush(),
                };
                self.flush_shadow(&device_type);
                continue;
            }

            let vad_result = match device_type {
                DeviceType::Microphone => self.vad_mic.flush(),
                DeviceType::System => self.vad_system.flush(),
            };

            match vad_result {
                Ok(final_segments) => {
                    for segment in final_segments {
                        let duration_ms = segment.end_timestamp_ms - segment.start_timestamp_ms;
                        if segment.samples.len() < 800 {
                            info!("⏭️ Skipping short final {:?} segment: {:.1}ms ({} samples < 800)",
                                  device_type, duration_ms, segment.samples.len());
                            continue;
                        }
                        info!("🎤 Buffering final {:?} VAD segment: {:.1}ms duration, {} samples",
                              device_type, duration_ms, segment.samples.len());

                        let (buffer, start_ts, _) = self.buffer_for(&device_type);
                        if buffer.is_empty() {
                            *start_ts = segment.start_timestamp_ms / 1000.0;
                        }
                        buffer.extend_from_slice(&segment.samples);
                    }
                }
                Err(e) => warn!("Failed to flush {:?} VAD processor: {}", device_type, e),
            }

            let buffer_len = match device_type {
                DeviceType::Microphone => self.mic_transcription_buffer.len(),
                DeviceType::System => self.system_transcription_buffer.len(),
            };
            if buffer_len > 0 {
                info!("📤 Flushing final {:?} transcription buffer: {} samples ({:.1}s)",
                      device_type, buffer_len, buffer_len as f64 / 16000.0);
                self.flush_transcription_buffer(device_type.clone());
            }
            // A stream that was on Realtime earlier in the recording may still hold
            // shadow windows from before its route flipped; flush them too.
            self.flush_shadow(&device_type);
        }

        if let Some(ref mut saver) = self.raw_track_saver {
            saver.finish();
        }

        Ok(())
    }

}

/// Simple audio pipeline manager
pub struct AudioPipelineManager {
    pipeline_handle: Option<JoinHandle<Result<()>>>,
    audio_sender: Option<mpsc::UnboundedSender<AudioChunk>>,
}

impl AudioPipelineManager {
    pub fn new() -> Self {
        Self {
            pipeline_handle: None,
            audio_sender: None,
        }
    }

    /// Start the audio pipeline with device information for adaptive buffering
    pub fn start(
        &mut self,
        state: Arc<RecordingState>,
        transcription_sender: mpsc::UnboundedSender<AudioChunk>,
        target_chunk_duration_ms: u32,
        sample_rate: u32,
        recording_sender: Option<mpsc::UnboundedSender<AudioChunk>>,
        mic_device_name: String,
        mic_device_kind: super::device_detection::InputDeviceKind,
        system_device_name: String,
        system_device_kind: super::device_detection::InputDeviceKind,
        raw_track_folder: Option<std::path::PathBuf>,
        flush_profile: FlushProfile,
        realtime_session: Option<Arc<ElevenLabsRealtimeSession>>,
    ) -> Result<()> {
        // Log device information for adaptive buffering
        info!("🎙️ Starting pipeline with device info:");
        info!("   Microphone: '{}' ({:?})", mic_device_name, mic_device_kind);
        info!("   System Audio: '{}' ({:?})", system_device_name, system_device_kind);

        // Create audio processing channel
        let (audio_sender, audio_receiver) = mpsc::unbounded_channel::<AudioChunk>();

        // Set sender in state for audio captures to use
        state.set_audio_sender(audio_sender.clone());

        // Create and start pipeline with device information for adaptive mixing
        let mut pipeline = AudioPipeline::new(
            audio_receiver,
            transcription_sender,
            state.clone(),
            target_chunk_duration_ms,
            sample_rate,
            mic_device_name,
            mic_device_kind,
            system_device_name,
            system_device_kind,
            raw_track_folder,
            flush_profile,
            realtime_session,
        )?;

        // CRITICAL FIX: Connect recording sender to receive pre-mixed audio
        // This ensures both mic AND system audio are captured in recordings
        pipeline.recording_sender_for_mixed = recording_sender;

        let handle = tokio::spawn(async move {
            pipeline.run().await
        });

        self.pipeline_handle = Some(handle);
        self.audio_sender = Some(audio_sender);

        info!("Audio pipeline manager started with mixed audio recording");
        Ok(())
    }

    /// Stop the audio pipeline
    pub async fn stop(&mut self) -> Result<()> {
        // Drop the sender to close the pipeline
        self.audio_sender = None;

        // Wait for pipeline to finish
        if let Some(handle) = self.pipeline_handle.take() {
            match handle.await {
                Ok(result) => result,
                Err(e) => {
                    error!("Pipeline task failed: {}", e);
                    Ok(())
                }
            }
        } else {
            Ok(())
        }
    }

    /// Force immediate flush of accumulated audio and stop pipeline
    /// PERFORMANCE CRITICAL: Eliminates 30+ second shutdown delays
    pub async fn force_flush_and_stop(&mut self) -> Result<()> {
        info!("🚀 Force flushing pipeline - processing ALL accumulated audio immediately");

        // If we have a sender, send a special flush signal first
        if let Some(sender) = &self.audio_sender {
            // Create a special flush chunk to trigger immediate processing
            let flush_chunk = AudioChunk {
                data: vec![], // Empty data signals flush
                sample_rate: 16000,
                timestamp: 0.0,
                chunk_id: u64::MAX, // Special ID to indicate flush
                device_type: super::recording_state::DeviceType::Microphone,
                overlap_samples: 0,
            };

            if let Err(e) = sender.send(flush_chunk) {
                warn!("Failed to send flush signal: {}", e);
            } else {
                info!("📤 Sent flush signal to pipeline");

                // PERFORMANCE OPTIMIZATION: Reduced wait time from 50ms to 20ms
                // Pipeline should process flush signal very quickly
                tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;

                // Send multiple flush signals to ensure the pipeline catches it
                // This aggressive approach eliminates shutdown delay issues
                for i in 0..3 {
                    let additional_flush = AudioChunk {
                        data: vec![],
                        sample_rate: 16000,
                        timestamp: 0.0,
                        chunk_id: u64::MAX - (i as u64),
                        device_type: super::recording_state::DeviceType::Microphone,
                        overlap_samples: 0,
                    };
                    let _ = sender.send(additional_flush);
                }

                info!("📤 Sent additional flush signals for reliability");
                tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
            }
        }

        // Now stop normally
        self.stop().await
    }
}

impl Default for AudioPipelineManager {
    fn default() -> Self {
        Self::new()
    }
}
// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod shadow_tests {
    use super::*;
    use crate::audio::transcription::elevenlabs_realtime::should_drain_vad_into_batch_on_stop;

    /// `secs` of 16kHz samples marked with `v` so windows are distinguishable.
    fn win(secs: f64, v: f32) -> Vec<f32> {
        vec![v; (secs * 16000.0) as usize]
    }

    #[test]
    fn shadow_keeps_windows_and_reports_the_first_start() {
        let mut s = ShadowBuffer::new();
        assert!(s.is_empty());
        s.append(10.0, &win(0.6, 1.0));
        s.append(20.0, &win(0.6, 2.0)); // non-contiguous: silence in between
        assert_eq!(s.window_count(), 2);
        assert_eq!(s.first_start(), Some(10.0));
        let (start, data) = s.drain_concatenated().expect("non-empty");
        assert_eq!(start, 10.0, "chunk start is the OLDEST window's start");
        assert_eq!(data.len(), (0.6 * 16000.0) as usize * 2);
        assert!(s.is_empty(), "draining empties the buffer");
        assert!(s.drain_concatenated().is_none());
    }

    #[test]
    fn shadow_append_of_empty_samples_is_a_noop() {
        let mut s = ShadowBuffer::new();
        assert!(!s.append(1.0, &[]));
        assert!(s.is_empty());
    }

    #[test]
    fn commit_drops_only_the_windows_it_covered() {
        // M4: a flat clear wiped the speech fed while the commit was in flight,
        // losing 0.3-1.2s of the tail at stop. Only covered windows may go.
        let mut s = ShadowBuffer::new();
        s.append(10.0, &win(1.0, 1.0)); // covers 10.0..11.0
        s.append(11.0, &win(1.0, 2.0)); // covers 11.0..12.0
        s.append(12.0, &win(1.0, 3.0)); // in flight, NOT covered

        s.drop_through(12.0); // commit reached recording second 12.0
        assert_eq!(s.window_count(), 1, "only the two covered windows may go");
        assert_eq!(s.first_start(), Some(12.0));
        let (start, data) = s.drain_concatenated().unwrap();
        assert_eq!(start, 12.0);
        assert!(data.iter().all(|&v| v == 3.0), "the in-flight window survives");
    }

    #[test]
    fn commit_that_covers_nothing_drops_nothing() {
        let mut s = ShadowBuffer::new();
        s.append(50.0, &win(1.0, 1.0));
        s.drop_through(10.0); // an older commit
        assert_eq!(s.window_count(), 1);
    }

    #[test]
    fn commit_partially_covering_a_window_keeps_it_whole() {
        // Half a window is not covered, so the window stays: better to
        // re-transcribe a fragment than to lose speech.
        let mut s = ShadowBuffer::new();
        s.append(10.0, &win(1.0, 1.0)); // 10.0..11.0
        s.drop_through(10.5);
        assert_eq!(s.window_count(), 1);
        // And the tolerance still absorbs VAD-window granularity at the edge.
        s.drop_through(10.97);
        assert_eq!(s.window_count(), 0, "within 50ms of the end counts as covered");
    }

    #[test]
    fn cap_drops_whole_windows_and_keeps_start_times_honest() {
        // The flat buffer trimmed a byte range and advanced start_ts as if the
        // audio were contiguous. It is not: these windows are speech-only.
        let mut s = ShadowBuffer::new();
        let mut overflowed = false;
        // 70 windows of 1s, each starting 10s apart in recording time.
        for i in 0..70 {
            overflowed |= s.append(i as f64 * 10.0, &win(1.0, i as f32));
        }
        assert!(overflowed, "70s of speech must trip the 60s cap");
        assert!(
            s.len_samples() <= ShadowBuffer::CAP_SAMPLES,
            "capped, got {} samples",
            s.len_samples()
        );
        // The remaining start time is a REAL window start, not a shifted one.
        let first = s.first_start().unwrap();
        assert_eq!(
            first % 10.0,
            0.0,
            "start must still land on a real window boundary, got {}",
            first
        );
        let (start, _data) = s.drain_concatenated().unwrap();
        assert_eq!(start, first);
    }

    #[test]
    fn cap_never_empties_the_buffer_completely() {
        // Even a single window larger than the cap is retained: dropping it would
        // silently discard speech with nothing else to fall back on.
        let mut s = ShadowBuffer::new();
        s.append(0.0, &win(90.0, 1.0));
        assert_eq!(s.window_count(), 1);
        assert!(s.len_samples() > ShadowBuffer::CAP_SAMPLES);
    }

    #[test]
    fn stop_must_not_drain_the_vad_into_the_batch_for_realtime_streams() {
        // M3: the open segment is already in the shadow, so draining the VAD on
        // top transcribed the closing sentence twice inside one chunk.
        assert!(!should_drain_vad_into_batch_on_stop(Some(Route::Realtime)));
        assert!(should_drain_vad_into_batch_on_stop(Some(Route::Batch)));
        assert!(should_drain_vad_into_batch_on_stop(None));
    }

    #[test]
    fn stop_flush_contains_the_open_segment_exactly_once() {
        // The shadow already holds the open segment's windows; the stop flush must
        // therefore emit each of them once and only once.
        let mut s = ShadowBuffer::new();
        s.append(100.0, &win(0.6, 7.0)); // open segment, window 1
        s.append(100.6, &win(0.6, 7.0)); // open segment, window 2
        let (start, data) = s.drain_concatenated().unwrap();
        assert_eq!(start, 100.0);
        assert_eq!(
            data.iter().filter(|&&v| v == 7.0).count(),
            (0.6 * 16000.0) as usize * 2,
            "each window's samples appear exactly once"
        );
        assert!(s.is_empty(), "and nothing is left to be flushed again");
    }
}
