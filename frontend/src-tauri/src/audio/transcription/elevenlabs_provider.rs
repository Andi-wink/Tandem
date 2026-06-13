// audio/transcription/elevenlabs_provider.rs
//
// ElevenLabs Scribe cloud transcription provider implementation.
//
// POST /v1/speech-to-text (multipart, dedicated STT). Authentication uses the
// `xi-api-key` header (NOT Authorization: Bearer). The model id is sent as the
// `model_id` form field (e.g. "scribe_v2").

use super::provider::{TranscriptResult, TranscriptionError, TranscriptionProvider};
use async_trait::async_trait;
use log::{debug, warn};
use serde::Deserialize;

const ELEVENLABS_STT_URL: &str = "https://api.elevenlabs.io/v1/speech-to-text";

/// Sample rate the worker resamples to before calling `transcribe()`.
/// Must match the conversion in `worker::transcribe_chunk_with_provider`.
const TRANSCRIBE_SAMPLE_RATE: u32 = 16_000;

/// ElevenLabs Scribe transcription provider.
///
/// Stateless except for an HTTP client and the (API key, model, language) config
/// captured at construction time. The key is held in-memory only and never logged.
pub struct ElevenLabsProvider {
    api_key: String,
    model: String,
    language: Option<String>,
    client: reqwest::Client,
}

impl ElevenLabsProvider {
    /// Create a new ElevenLabsProvider.
    ///
    /// # Arguments
    /// * `api_key` - ElevenLabs API key (read from SQLite per-init by the engine layer; never logged).
    /// * `model` - Model id, e.g. `"scribe_v2"` or `"scribe_v1"`.
    /// * `language` - Optional language hint passed to the API on every request.
    pub fn new(api_key: String, model: String, language: Option<String>) -> Self {
        Self {
            api_key,
            model,
            language,
            client: reqwest::Client::new(),
        }
    }

    /// Encode 16 kHz mono f32 samples into an in-memory WAV (16-bit PCM).
    ///
    /// Returns a complete RIFF/WAVE byte stream suitable for the `file` part
    /// of the Scribe multipart request.
    fn encode_wav_pcm16(samples: &[f32], sample_rate: u32) -> Vec<u8> {
        let num_channels: u16 = 1;
        let bits_per_sample: u16 = 16;
        let byte_rate: u32 =
            sample_rate * u32::from(num_channels) * u32::from(bits_per_sample) / 8;
        let block_align: u16 = num_channels * bits_per_sample / 8;
        let data_size: u32 = (samples.len() as u32) * u32::from(block_align);
        let chunk_size: u32 = 36u32.saturating_add(data_size);

        let mut buf: Vec<u8> = Vec::with_capacity(44 + data_size as usize);

        // RIFF header
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&chunk_size.to_le_bytes());
        buf.extend_from_slice(b"WAVE");

        // fmt sub-chunk (PCM)
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&16u32.to_le_bytes()); // Subchunk1Size for PCM
        buf.extend_from_slice(&1u16.to_le_bytes()); // AudioFormat = 1 (PCM)
        buf.extend_from_slice(&num_channels.to_le_bytes());
        buf.extend_from_slice(&sample_rate.to_le_bytes());
        buf.extend_from_slice(&byte_rate.to_le_bytes());
        buf.extend_from_slice(&block_align.to_le_bytes());
        buf.extend_from_slice(&bits_per_sample.to_le_bytes());

        // data sub-chunk
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&data_size.to_le_bytes());

        // PCM samples (f32 in [-1, 1] -> i16 little-endian)
        for &s in samples {
            let clamped = s.clamp(-1.0, 1.0);
            let pcm = (clamped * 32767.0) as i16;
            buf.extend_from_slice(&pcm.to_le_bytes());
        }

        buf
    }
}

/// Minimal Scribe response shape — we only need `text`.
#[derive(Debug, Deserialize)]
struct ScribeResponse {
    text: String,
}

/// Map Tandem's language preference to the value ElevenLabs Scribe expects.
///
/// Scribe wants the `language_code` field OMITTED for auto-detect (sending the
/// literal "auto" is a 400), and ISO-639-3 codes for explicit languages.
/// Tandem's picker stores ISO-639-1 codes (e.g. "en", "de") plus the special
/// "auto"/"auto-translate" sentinels, so:
///   - "auto" / "auto-translate" / empty  -> None (field omitted -> auto-detect)
///   - known ISO-639-1                     -> Some(ISO-639-3)
///   - anything else (already 639-3, etc.) -> Some(as-is, best effort)
fn scribe_language_code(raw: &str) -> Option<String> {
    let t = raw.trim().to_ascii_lowercase();
    if t.is_empty() || t == "auto" || t == "auto-translate" {
        return None;
    }
    let mapped = match t.as_str() {
        "en" => "eng", "de" => "deu", "es" => "spa", "fr" => "fra", "it" => "ita",
        "pt" => "por", "nl" => "nld", "zh" => "zho", "ru" => "rus", "ko" => "kor",
        "ja" => "jpn", "tr" => "tur", "pl" => "pol", "ca" => "cat", "ar" => "ara",
        "sv" => "swe", "id" => "ind", "hi" => "hin", "fi" => "fin", "vi" => "vie",
        "he" => "heb", "uk" => "ukr", "el" => "ell", "ms" => "msa", "cs" => "ces",
        "ro" => "ron", "da" => "dan", "hu" => "hun", "ta" => "tam", "no" => "nor",
        "th" => "tha", "ur" => "urd", "hr" => "hrv", "bg" => "bul", "lt" => "lit",
        "la" => "lat",
        other => other,
    };
    Some(mapped.to_string())
}

#[async_trait]
impl TranscriptionProvider for ElevenLabsProvider {
    async fn transcribe(
        &self,
        audio: Vec<f32>,
        language: Option<String>,
    ) -> std::result::Result<TranscriptResult, TranscriptionError> {
        if audio.is_empty() {
            return Err(TranscriptionError::AudioTooShort {
                samples: 0,
                minimum: 1600, // 100 ms at 16 kHz, matches worker
            });
        }

        // 1. Encode to in-memory WAV bytes (16-bit PCM, 16 kHz mono).
        let wav_bytes = Self::encode_wav_pcm16(&audio, TRANSCRIBE_SAMPLE_RATE);
        debug!(
            "ElevenLabsProvider: encoded {} samples ({} bytes WAV) for model '{}'",
            audio.len(),
            wav_bytes.len(),
            self.model
        );

        // 2. Build multipart form. Per-call `language` argument wins over the
        //    instance default if both are present.
        let lang = language.or_else(|| self.language.clone());

        let file_part = reqwest::multipart::Part::bytes(wav_bytes)
            .file_name("audio.wav")
            .mime_str("audio/wav")
            .map_err(|e| {
                TranscriptionError::EngineFailed(format!(
                    "Failed to set WAV mime type: {}",
                    e
                ))
            })?;

        let mut form = reqwest::multipart::Form::new()
            .text("model_id", self.model.clone())
            .part("file", file_part);

        // Scribe wants the field OMITTED for auto-detect (literal "auto" is a 400)
        // and ISO-639-3 for explicit languages; normalize accordingly.
        if let Some(code) = lang.as_deref().and_then(scribe_language_code) {
            form = form.text("language_code", code);
        }

        // 3. POST to Scribe. Auth uses the xi-api-key header (NOT Bearer).
        //    NOTE: never log self.api_key.
        let response = self
            .client
            .post(ELEVENLABS_STT_URL)
            .header("xi-api-key", &self.api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|e| {
                TranscriptionError::EngineFailed(format!("ElevenLabs request failed: {}", e))
            })?;

        // 4. Surface non-2xx as a structured error (do not panic, do not return empty string).
        let status = response.status();
        if !status.is_success() {
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "<failed to read error body>".to_string());
            warn!(
                "ElevenLabs Scribe returned non-2xx ({}): {}",
                status, body
            );
            return Err(TranscriptionError::EngineFailed(format!(
                "ElevenLabs Scribe HTTP {}: {}",
                status, body
            )));
        }

        let parsed: ScribeResponse = response.json().await.map_err(|e| {
            TranscriptionError::EngineFailed(format!(
                "Failed to parse Scribe response JSON: {}",
                e
            ))
        })?;

        Ok(TranscriptResult {
            text: parsed.text.trim().to_string(),
            confidence: None, // Scribe doesn't return chunk-level confidence
            is_partial: false,
        })
    }

    async fn is_model_loaded(&self) -> bool {
        // Cloud provider — no local model to warm up.
        true
    }

    async fn get_current_model(&self) -> Option<String> {
        Some(self.model.clone())
    }

    fn provider_name(&self) -> &'static str {
        "ElevenLabs"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_wav_header_is_well_formed() {
        // 0.1s of silence at 16 kHz mono
        let samples = vec![0.0f32; 1600];
        let wav = ElevenLabsProvider::encode_wav_pcm16(&samples, 16_000);

        // Smallest sanity checks on the RIFF/WAVE header
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        // Subchunk1Size = 16
        assert_eq!(u32::from_le_bytes([wav[16], wav[17], wav[18], wav[19]]), 16);
        // AudioFormat = 1 (PCM)
        assert_eq!(u16::from_le_bytes([wav[20], wav[21]]), 1);
        // NumChannels = 1
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1);
        // SampleRate = 16000
        assert_eq!(
            u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
            16_000
        );
        // BitsPerSample = 16
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16);
        // "data" tag at offset 36
        assert_eq!(&wav[36..40], b"data");
        // data size = num_samples * 2 bytes
        assert_eq!(
            u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]),
            (samples.len() as u32) * 2
        );
        // Total file size = 44 header + data
        assert_eq!(wav.len(), 44 + samples.len() * 2);
    }

    #[test]
    fn scribe_language_code_omits_auto_and_maps_iso639() {
        // auto-detect sentinels -> omit the field
        assert_eq!(scribe_language_code("auto"), None);
        assert_eq!(scribe_language_code("auto-translate"), None);
        assert_eq!(scribe_language_code(""), None);
        assert_eq!(scribe_language_code("  AUTO "), None);
        // ISO-639-1 -> ISO-639-3
        assert_eq!(scribe_language_code("en").as_deref(), Some("eng"));
        assert_eq!(scribe_language_code("de").as_deref(), Some("deu"));
        assert_eq!(scribe_language_code("FR").as_deref(), Some("fra"));
        // already 639-3 / unknown -> passthrough (lowercased)
        assert_eq!(scribe_language_code("eng").as_deref(), Some("eng"));
    }

    #[test]
    fn encode_wav_clamps_and_scales() {
        let samples = vec![1.5f32, -1.5, 0.0, 0.5];
        let wav = ElevenLabsProvider::encode_wav_pcm16(&samples, 16_000);
        // First sample bytes start at offset 44
        let s0 = i16::from_le_bytes([wav[44], wav[45]]);
        let s1 = i16::from_le_bytes([wav[46], wav[47]]);
        let s2 = i16::from_le_bytes([wav[48], wav[49]]);
        let s3 = i16::from_le_bytes([wav[50], wav[51]]);
        assert_eq!(s0, 32767); // clamped from 1.5
        assert_eq!(s1, -32767); // clamped from -1.5
        assert_eq!(s2, 0);
        assert_eq!(s3, (0.5 * 32767.0) as i16);
    }
}
