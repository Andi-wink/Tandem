use anyhow::Result;
use log::{debug, warn};
use sonora::config::{EchoCanceller as SonoraEchoCanceller, MaxProcessingRate, Pipeline};
use sonora::{AudioProcessing, Config, StreamConfig};

/// Wrapper around sonora's WebRTC Audio Processing Module for acoustic echo
/// cancellation. Sonora requires fixed 10ms frames; this wrapper buffers
/// arbitrary input lengths and emits cleaned mic samples in the same order.
///
/// Configured with AEC3 enabled and every other module (HPF, NS, AGC) disabled.
/// Tandem already applies its own 80Hz HPF, RNNoise noise suppression, and EBU
/// R128 loudness normalization downstream of AEC.
pub struct EchoCanceller {
    apm: AudioProcessing,
    sample_rate: u32,
    frame_size: usize,
    mic_carry: Vec<f32>,
    ref_carry: Vec<f32>,
}

impl EchoCanceller {
    pub fn new(sample_rate: u32) -> Result<Self> {
        let stream_config = StreamConfig::new(sample_rate, 1);
        let frame_size = stream_config.num_frames();
        if frame_size == 0 {
            return Err(anyhow::anyhow!(
                "EchoCanceller: invalid sample rate {} (yields 0-sample frames)",
                sample_rate
            ));
        }

        let max_internal_rate = if sample_rate >= 48_000 {
            MaxProcessingRate::Rate48kHz
        } else {
            MaxProcessingRate::Rate32kHz
        };

        let config = Config {
            pipeline: Pipeline {
                maximum_internal_processing_rate: max_internal_rate,
                ..Pipeline::default()
            },
            echo_canceller: Some(Self::aec_config()),
            high_pass_filter: None,
            noise_suppression: None,
            gain_controller2: None,
            pre_amplifier: None,
            capture_level_adjustment: None,
        };

        let apm = AudioProcessing::builder()
            .config(config)
            .capture_config(stream_config)
            .render_config(stream_config)
            .build();

        log::info!(
            "EchoCanceller initialized: sample_rate={}Hz, frame_size={} samples (10ms)",
            sample_rate,
            frame_size
        );

        Ok(Self {
            apm,
            sample_rate,
            frame_size,
            mic_carry: Vec::with_capacity(frame_size),
            ref_carry: Vec::with_capacity(frame_size),
        })
    }

    fn aec_config() -> SonoraEchoCanceller {
        SonoraEchoCanceller {
            enforce_high_pass_filtering: false,
            ..SonoraEchoCanceller::default()
        }
    }

    /// In-place AEC on a mic window using `reference` (system audio) as the
    /// far-end playback signal. Both buffers must be at `self.sample_rate`.
    /// Leftover samples that don't fill a 10ms frame are carried over to the
    /// next call so windowed input length is preserved.
    pub fn process(&mut self, mic: &mut [f32], reference: &[f32]) {
        let mic_total: Vec<f32> = self
            .mic_carry
            .iter()
            .copied()
            .chain(mic.iter().copied())
            .collect();
        let ref_total: Vec<f32> = self
            .ref_carry
            .iter()
            .copied()
            .chain(reference.iter().copied())
            .collect();

        let mic_frames = mic_total.len() / self.frame_size;
        let ref_frames = ref_total.len() / self.frame_size;
        let pairs = mic_frames.min(ref_frames);

        let mut cleaned: Vec<f32> = Vec::with_capacity(pairs * self.frame_size);
        let mut frame_out = vec![0.0f32; self.frame_size];

        for i in 0..pairs {
            let start = i * self.frame_size;
            let end = start + self.frame_size;

            let ref_frame: &[f32] = &ref_total[start..end];
            let mic_frame: &[f32] = &mic_total[start..end];

            if let Err(e) = self.apm.process_render_f32(
                &[ref_frame],
                &mut [&mut frame_out[..]],
            ) {
                warn!("AEC render frame failed: {}", e);
            }

            if let Err(e) = self.apm.process_capture_f32(
                &[mic_frame],
                &mut [&mut frame_out[..]],
            ) {
                warn!("AEC capture frame failed: {}", e);
                cleaned.extend_from_slice(mic_frame);
            } else {
                cleaned.extend_from_slice(&frame_out);
            }
        }

        let mic_consumed = pairs * self.frame_size;
        self.mic_carry.clear();
        self.mic_carry.extend_from_slice(&mic_total[mic_consumed..]);

        let ref_consumed = pairs * self.frame_size;
        self.ref_carry.clear();
        self.ref_carry.extend_from_slice(&ref_total[ref_consumed..]);

        let copy_len = cleaned.len().min(mic.len());
        mic[..copy_len].copy_from_slice(&cleaned[..copy_len]);

        if cleaned.len() < mic.len() {
            debug!(
                "AEC: produced {} cleaned samples for {} mic samples (carry: mic={}, ref={})",
                cleaned.len(),
                mic.len(),
                self.mic_carry.len(),
                self.ref_carry.len()
            );
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constructs_at_48khz() {
        let ec = EchoCanceller::new(48_000).expect("AEC should construct at 48kHz");
        assert_eq!(ec.sample_rate(), 48_000);
        assert_eq!(ec.frame_size, 480);
    }

    #[test]
    fn processes_window_in_place() {
        let mut ec = EchoCanceller::new(48_000).unwrap();
        let mut mic = vec![0.1f32; 480 * 4];
        let reference = vec![0.5f32; 480 * 4];
        ec.process(&mut mic, &reference);
        assert_eq!(mic.len(), 480 * 4);
    }

    #[test]
    fn handles_partial_frame_with_carryover() {
        let mut ec = EchoCanceller::new(48_000).unwrap();
        let mut mic = vec![0.0f32; 500];
        let reference = vec![0.0f32; 500];
        ec.process(&mut mic, &reference);
        assert!(!ec.mic_carry.is_empty());
    }
}
