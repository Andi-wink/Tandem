use anyhow::{Context, Result};
use log::{info, warn};
use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// Streaming WAV writer for raw debug tracks (16-bit PCM, mono).
///
/// Hand-rolled 44-byte canonical RIFF/WAVE header. `hound` is intentionally
/// not in the dep tree (see Cargo.toml lines 75-77). Each instance writes one
/// file and patches the header sizes on `finish()`.
struct WavWriter {
    file: BufWriter<File>,
    data_bytes_written: u32,
    path: PathBuf,
}

impl WavWriter {
    fn create<P: AsRef<Path>>(path: P, sample_rate: u32) -> Result<Self> {
        let path_buf = path.as_ref().to_path_buf();
        let file = File::create(&path_buf)
            .with_context(|| format!("creating WAV file {}", path_buf.display()))?;
        let mut writer = BufWriter::new(file);

        let bits_per_sample: u16 = 16;
        let num_channels: u16 = 1;
        let byte_rate = sample_rate * num_channels as u32 * bits_per_sample as u32 / 8;
        let block_align = num_channels * bits_per_sample / 8;

        writer.write_all(b"RIFF")?;
        writer.write_all(&0u32.to_le_bytes())?;
        writer.write_all(b"WAVE")?;

        writer.write_all(b"fmt ")?;
        writer.write_all(&16u32.to_le_bytes())?;
        writer.write_all(&1u16.to_le_bytes())?;
        writer.write_all(&num_channels.to_le_bytes())?;
        writer.write_all(&sample_rate.to_le_bytes())?;
        writer.write_all(&byte_rate.to_le_bytes())?;
        writer.write_all(&block_align.to_le_bytes())?;
        writer.write_all(&bits_per_sample.to_le_bytes())?;

        writer.write_all(b"data")?;
        writer.write_all(&0u32.to_le_bytes())?;

        Ok(Self {
            file: writer,
            data_bytes_written: 0,
            path: path_buf,
        })
    }

    fn write_samples(&mut self, samples: &[f32]) -> Result<()> {
        let mut bytes = Vec::with_capacity(samples.len() * 2);
        for &s in samples {
            let clamped = s.clamp(-1.0, 1.0);
            let pcm = (clamped * i16::MAX as f32) as i16;
            bytes.extend_from_slice(&pcm.to_le_bytes());
        }
        self.file.write_all(&bytes)?;
        self.data_bytes_written = self
            .data_bytes_written
            .saturating_add(bytes.len() as u32);
        Ok(())
    }

    fn finish(mut self) -> Result<()> {
        self.file.flush()?;
        let mut inner = self
            .file
            .into_inner()
            .map_err(|e| anyhow::anyhow!("WavWriter unwrap failed: {}", e))?;

        let riff_size = 36u32.saturating_add(self.data_bytes_written);
        inner.seek(SeekFrom::Start(4))?;
        inner.write_all(&riff_size.to_le_bytes())?;
        inner.seek(SeekFrom::Start(40))?;
        inner.write_all(&self.data_bytes_written.to_le_bytes())?;
        inner.flush()?;
        info!(
            "RawTrackSaver: closed {} ({} data bytes)",
            self.path.display(),
            self.data_bytes_written
        );
        Ok(())
    }
}

/// Saves three parallel debug tracks (mic raw, mic post-AEC, system) when the
/// `TANDEM_SAVE_RAW_TRACKS=1` environment variable is set at recording start.
/// Files are 48kHz 16-bit PCM mono. Off by default with zero runtime cost.
pub struct RawTrackSaver {
    mic_raw: Option<WavWriter>,
    mic_clean: Option<WavWriter>,
    system: Option<WavWriter>,
}

impl RawTrackSaver {
    pub fn is_enabled() -> bool {
        std::env::var("TANDEM_SAVE_RAW_TRACKS")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    }

    pub fn new(meeting_folder: &Path, sample_rate: u32) -> Result<Self> {
        let mic_raw_path = meeting_folder.join("audio_mic_raw.wav");
        let mic_clean_path = meeting_folder.join("audio_mic_clean.wav");
        let system_path = meeting_folder.join("audio_system.wav");

        info!(
            "RawTrackSaver: writing debug tracks to {} (sample_rate={}Hz)",
            meeting_folder.display(),
            sample_rate
        );

        Ok(Self {
            mic_raw: Some(WavWriter::create(&mic_raw_path, sample_rate)?),
            mic_clean: Some(WavWriter::create(&mic_clean_path, sample_rate)?),
            system: Some(WavWriter::create(&system_path, sample_rate)?),
        })
    }

    pub fn write_mic_raw(&mut self, samples: &[f32]) {
        if let Some(writer) = self.mic_raw.as_mut() {
            if let Err(e) = writer.write_samples(samples) {
                warn!("RawTrackSaver: mic_raw write failed: {}", e);
            }
        }
    }

    pub fn write_mic_clean(&mut self, samples: &[f32]) {
        if let Some(writer) = self.mic_clean.as_mut() {
            if let Err(e) = writer.write_samples(samples) {
                warn!("RawTrackSaver: mic_clean write failed: {}", e);
            }
        }
    }

    pub fn write_system(&mut self, samples: &[f32]) {
        if let Some(writer) = self.system.as_mut() {
            if let Err(e) = writer.write_samples(samples) {
                warn!("RawTrackSaver: system write failed: {}", e);
            }
        }
    }

    pub fn finish(&mut self) {
        for (label, slot) in [
            ("mic_raw", &mut self.mic_raw),
            ("mic_clean", &mut self.mic_clean),
            ("system", &mut self.system),
        ] {
            if let Some(writer) = slot.take() {
                if let Err(e) = writer.finish() {
                    warn!("RawTrackSaver: failed to finalize {}: {}", label, e);
                }
            }
        }
    }
}

impl Drop for RawTrackSaver {
    fn drop(&mut self) {
        self.finish();
    }
}
