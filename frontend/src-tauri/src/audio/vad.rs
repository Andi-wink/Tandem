use anyhow::{anyhow, Result};
use silero_rs::{VadConfig, VadSession, VadTransition};
use log::{debug, info, warn};
use std::collections::VecDeque;
use std::time::Duration;
use rubato::{Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};

/// Represents a complete speech segment detected by VAD
#[derive(Debug, Clone)]
pub struct SpeechSegment {
    pub samples: Vec<f32>,
    pub start_timestamp_ms: f64,
    pub end_timestamp_ms: f64,
    pub confidence: f32,
}

/// Processes audio in 30ms chunks but returns complete speech segments
pub struct ContinuousVadProcessor {
    session: VadSession,
    chunk_size: usize,
    sample_rate: u32,
    buffer: Vec<f32>,
    speech_segments: VecDeque<SpeechSegment>,
    current_speech: Vec<f32>,
    in_speech: bool,
    processed_samples: usize,
    speech_start_sample: usize,
    // State tracking for smart logging
    last_logged_state: bool,
    // High-quality Rubato sinc resampler (persistent across calls)
    resampler: Option<SincFixedIn<f32>>,
    resampler_input_buffer: Vec<f32>,
    resampler_chunk_size: usize,
}

impl ContinuousVadProcessor {
    pub fn new(input_sample_rate: u32, redemption_time_ms: u32) -> Result<Self> {
        // Silero VAD MUST use 16kHz - this is hardcoded requirement
        const VAD_SAMPLE_RATE: u32 = 16000;

        // Use STRICT settings to prevent silence from reaching Whisper
        let mut config = VadConfig::default();
        config.sample_rate = VAD_SAMPLE_RATE as usize;

        // CONTINUOUS SPEECH FIX: Tuned for capturing complete 5+ second utterances
        // Previous: 0.55/0.40 with 400ms redemption was fragmenting speech into 40ms segments
        // New: More lenient thresholds + longer redemption for continuous speech
        config.positive_speech_threshold = 0.50;  // Silero default - good for continuous speech
        config.negative_speech_threshold = 0.35;  // Silero default - allows natural pauses

        // CRITICAL FIX: Removed redemption_time capping to support long continuous speech
        // Previous: capped at 400ms, causing VAD to fragment 5-second speech into 40ms segments
        // New: Use full redemption_time from pipeline (2000ms) to bridge natural pauses
        config.redemption_time = Duration::from_millis(redemption_time_ms as u64);
        config.pre_speech_pad = Duration::from_millis(500);   // Increased from 300ms: capture speech onset more reliably
        config.post_speech_pad = Duration::from_millis(600);  // Increased from 400ms: capture trailing words

        // CRITICAL FIX: Increased min_speech_time to prevent tiny 40ms fragments
        // Previous: 100ms allowed too-short segments that Whisper rejects
        // New: 250ms ensures segments are substantial enough for Whisper (>100ms requirement)
        config.min_speech_time = Duration::from_millis(250);  // Prevent tiny fragments

        debug!("Creating VAD session with: sample_rate={}Hz, redemption={}ms, min_speech={}ms, input_rate={}Hz",
               VAD_SAMPLE_RATE, redemption_time_ms, 250, input_sample_rate);

        let session = VadSession::new(config)
            .map_err(|e| anyhow!("Failed to create VAD session: {:?}", e))?;

        // VAD uses 30ms chunks at 16kHz (480 samples)
        let vad_chunk_size = (VAD_SAMPLE_RATE as f32 * 0.03) as usize; // 480 samples

        // Initialize high-quality Rubato sinc resampler for 48kHz → 16kHz
        // This replaces the previous basic low-pass + linear interpolation
        const RESAMPLER_CHUNK_SIZE: usize = 512;
        let resampler = if input_sample_rate != VAD_SAMPLE_RATE {
            let ratio = VAD_SAMPLE_RATE as f64 / input_sample_rate as f64;

            // 48kHz → 16kHz is a 3:1 downsampling (ratio ≤ 0.5)
            // Use high-quality anti-aliased settings to prevent artifacts
            let params = SincInterpolationParameters {
                sinc_len: 512,
                f_cutoff: 0.95,
                interpolation: SincInterpolationType::Cubic,
                oversampling_factor: 512,
                window: WindowFunction::BlackmanHarris2,
            };

            match SincFixedIn::<f32>::new(
                ratio,
                2.0,
                params,
                RESAMPLER_CHUNK_SIZE,
                1, // mono
            ) {
                Ok(r) => {
                    info!("✅ VAD resampler initialized: {}Hz → {}Hz (Rubato sinc, 512-tap, Cubic)",
                          input_sample_rate, VAD_SAMPLE_RATE);
                    Some(r)
                }
                Err(e) => {
                    warn!("⚠️ Failed to create Rubato resampler for VAD: {}, falling back to basic resampling", e);
                    None
                }
            }
        } else {
            None
        };

        info!("VAD processor created: input={}Hz, vad={}Hz, chunk_size={} samples",
              input_sample_rate, VAD_SAMPLE_RATE, vad_chunk_size);

        Ok(Self {
            session,
            chunk_size: vad_chunk_size,
            sample_rate: input_sample_rate,
            buffer: Vec::with_capacity(vad_chunk_size * 2),
            speech_segments: VecDeque::new(),
            current_speech: Vec::new(),
            in_speech: false,
            processed_samples: 0,
            speech_start_sample: 0,
            last_logged_state: false,
            resampler,
            resampler_input_buffer: Vec::with_capacity(RESAMPLER_CHUNK_SIZE * 2),
            resampler_chunk_size: RESAMPLER_CHUNK_SIZE,
        })
    }

    /// Process incoming audio samples and return any complete speech segments
    /// Handles resampling from input sample rate to 16kHz for VAD processing
    pub fn process_audio(&mut self, samples: &[f32]) -> Result<Vec<SpeechSegment>> {
        // Resample to 16kHz if needed
        let resampled_audio = if self.sample_rate == 16000 {
            samples.to_vec()
        } else {
            self.resample_to_16k(samples)?
        };

        self.buffer.extend_from_slice(&resampled_audio);
        let mut completed_segments = Vec::new();

        // Process complete 30ms chunks (480 samples at 16kHz)
        while self.buffer.len() >= self.chunk_size {
            let chunk: Vec<f32> = self.buffer.drain(..self.chunk_size).collect();
            self.process_chunk(&chunk)?;

            // Extract any completed speech segments
            while let Some(segment) = self.speech_segments.pop_front() {
                completed_segments.push(segment);
            }
        }

        Ok(completed_segments)
    }

    /// High-quality resampling from input sample rate to 16kHz using Rubato sinc resampler
    /// Uses persistent resampler with 512-tap sinc filter and cubic interpolation
    /// for proper anti-aliasing (replaces previous basic low-pass + linear interpolation)
    fn resample_to_16k(&mut self, samples: &[f32]) -> Result<Vec<f32>> {
        if self.sample_rate == 16000 {
            return Ok(samples.to_vec());
        }

        // Try high-quality Rubato resampler first
        if let Some(ref mut resampler) = self.resampler {
            self.resampler_input_buffer.extend_from_slice(samples);

            let mut resampled_output = Vec::new();

            // Process complete fixed-size chunks through the resampler
            while self.resampler_input_buffer.len() >= self.resampler_chunk_size {
                let chunk: Vec<f32> = self.resampler_input_buffer
                    .drain(0..self.resampler_chunk_size)
                    .collect();

                let waves_in = vec![chunk];
                match resampler.process(&waves_in, None) {
                    Ok(mut waves_out) => {
                        if let Some(output) = waves_out.pop() {
                            resampled_output.extend_from_slice(&output);
                        }
                    }
                    Err(e) => {
                        warn!("⚠️ Rubato VAD resampling failed: {}, falling back", e);
                        return self.resample_to_16k_fallback(samples);
                    }
                }
            }
            // Remaining samples stay in buffer for next call

            return Ok(resampled_output);
        }

        // Fallback: basic resampling if Rubato init failed
        self.resample_to_16k_fallback(samples)
    }

    /// Fallback resampling using simple linear interpolation (only if Rubato unavailable)
    fn resample_to_16k_fallback(&self, samples: &[f32]) -> Result<Vec<f32>> {
        let ratio = self.sample_rate as f64 / 16000.0;
        let output_len = (samples.len() as f64 / ratio) as usize;
        let mut resampled = Vec::with_capacity(output_len);

        for i in 0..output_len {
            let source_pos = i as f64 * ratio;
            let source_index = source_pos as usize;
            let fraction = source_pos - source_index as f64;

            if source_index + 1 < samples.len() {
                let sample1 = samples[source_index];
                let sample2 = samples[source_index + 1];
                resampled.push(sample1 + (sample2 - sample1) * fraction as f32);
            } else if source_index < samples.len() {
                resampled.push(samples[source_index]);
            }
        }

        Ok(resampled)
    }

    /// Flush any remaining audio and return final speech segments
    pub fn flush(&mut self) -> Result<Vec<SpeechSegment>> {
        let mut completed_segments = Vec::new();

        // Process any remaining buffered audio
        if !self.buffer.is_empty() {
            let remaining = self.buffer.clone();
            self.buffer.clear();

            // Pad to chunk size if needed
            let mut padded_chunk = remaining;
            if padded_chunk.len() < self.chunk_size {
                padded_chunk.resize(self.chunk_size, 0.0);
            }

            self.process_chunk(&padded_chunk)?;
        }

        // Force end any ongoing speech
        if self.in_speech && !self.current_speech.is_empty() {
            let start_ms = (self.speech_start_sample as f64 / self.sample_rate as f64) * 1000.0;
            let end_ms = (self.processed_samples as f64 / self.sample_rate as f64) * 1000.0;

            let segment = SpeechSegment {
                samples: self.current_speech.clone(),
                start_timestamp_ms: start_ms,
                end_timestamp_ms: end_ms,
                confidence: 0.8, // Estimated confidence for forced end
            };

            self.speech_segments.push_back(segment);
            self.current_speech.clear();
            self.in_speech = false;
        }

        // Extract all remaining segments
        while let Some(segment) = self.speech_segments.pop_front() {
            completed_segments.push(segment);
        }

        Ok(completed_segments)
    }

    fn process_chunk(&mut self, chunk: &[f32]) -> Result<()> {
        let transitions = self.session.process(chunk)
            .map_err(|e| anyhow!("VAD processing failed: {}", e))?;

        // Handle VAD transitions
        for transition in transitions {
            match transition {
                VadTransition::SpeechStart { timestamp_ms } => {
                    // Only log if state changed
                    if !self.last_logged_state {
                        info!("VAD: Speech started at {}ms", timestamp_ms);
                        self.last_logged_state = true;
                    }
                    self.in_speech = true;
                    self.speech_start_sample = self.processed_samples + (timestamp_ms * self.sample_rate as usize / 1000);
                    self.current_speech.clear();
                }
                VadTransition::SpeechEnd { start_timestamp_ms, end_timestamp_ms, samples } => {
                    // Only log if we were previously in speech state
                    if self.last_logged_state {
                        info!("VAD: Speech ended at {}ms (duration: {}ms)", end_timestamp_ms, end_timestamp_ms - start_timestamp_ms);
                        self.last_logged_state = false;
                    }
                    self.in_speech = false;

                    // Use samples from VAD transition if available, otherwise use accumulated samples
                    let speech_samples = if !samples.is_empty() {
                        samples
                    } else {
                        self.current_speech.clone()
                    };

                    if !speech_samples.is_empty() {
                        let segment = SpeechSegment {
                            samples: speech_samples,
                            start_timestamp_ms: start_timestamp_ms as f64,
                            end_timestamp_ms: end_timestamp_ms as f64,
                            confidence: 0.9, // VAD confidence
                        };

                        info!("VAD: Completed speech segment: {:.1}ms duration, {} samples",
                              end_timestamp_ms - start_timestamp_ms, segment.samples.len());

                        self.speech_segments.push_back(segment);
                    }

                    self.current_speech.clear();
                }
            }
        }

        // Accumulate speech if we're currently in a speech state
        if self.in_speech {
            self.current_speech.extend_from_slice(chunk);
        }

        self.processed_samples += chunk.len();
        Ok(())
    }
}

/// Legacy function for backward compatibility - now uses the optimized approach
pub fn extract_speech_16k(samples_mono_16k: &[f32]) -> Result<Vec<f32>> {
    let mut processor = ContinuousVadProcessor::new(16000, 400)?;

    // Process all audio
    let mut all_segments = processor.process_audio(samples_mono_16k)?;
    let final_segments = processor.flush()?;
    all_segments.extend(final_segments);

    // Concatenate all speech segments
    let mut result = Vec::new();
    let num_segments = all_segments.len();
    for segment in &all_segments {
        result.extend_from_slice(&segment.samples);
    }

    // Apply balanced energy filtering for very short segments
    if result.len() < 1600 { // Less than 100ms at 16kHz
        let input_energy: f32 = samples_mono_16k.iter().map(|&x| x * x).sum::<f32>() / samples_mono_16k.len() as f32;
        let rms = input_energy.sqrt();
        let peak = samples_mono_16k.iter().map(|&x| x.abs()).fold(0.0f32, f32::max);

        // Energy filter: reject pure silence/noise to prevent Whisper hallucinations
        // on very short segments. RMS 0.2 / peak 0.20 catches quiet speech while
        // still filtering ambient noise.
        if rms < 0.2 || peak < 0.20 {
            info!("-----VAD detected silence/noise (RMS: {:.6}, Peak: {:.6}), skipping to prevent hallucinations-----", rms, peak);
            return Ok(Vec::new());
        } else {
            info!("VAD detected speech with sufficient energy (RMS: {:.6}, Peak: {:.6})", rms, peak);
            return Ok(samples_mono_16k.to_vec());
        }
    }

    debug!("VAD: Processed {} samples, extracted {} speech samples from {} segments",
           samples_mono_16k.len(), result.len(), num_segments);

    Ok(result)
}

/// Simple convenience function to get speech chunks from audio
/// Uses the optimized ContinuousVadProcessor with configurable redemption time
pub fn get_speech_chunks(samples_mono_16k: &[f32], redemption_time_ms: u32) -> Result<Vec<SpeechSegment>> {
    let mut processor = ContinuousVadProcessor::new(16000, redemption_time_ms)?;

    // Process all audio
    let mut segments = processor.process_audio(samples_mono_16k)?;
    let final_segments = processor.flush()?;
    segments.extend(final_segments);

    Ok(segments)
}

 
