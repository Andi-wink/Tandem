// audio/transcription/mistral_provider.rs
//
// Mistral Voxtral cloud transcription provider implementation.
//
// Two backends, chosen by model id at call time:
// - `voxtral-mini-*`  → POST /v1/audio/transcriptions (multipart, dedicated STT)
// - `voxtral-small-*` → POST /v1/chat/completions (audio understanding via chat,
//                       slower + costlier per chunk, used when explicitly chosen)

use super::provider::{TranscriptResult, TranscriptionError, TranscriptionProvider};
use async_trait::async_trait;
use base64::Engine;
use log::{debug, warn};
use serde::Deserialize;

const MISTRAL_TRANSCRIPTIONS_URL: &str = "https://api.mistral.ai/v1/audio/transcriptions";
const MISTRAL_CHAT_URL: &str = "https://api.mistral.ai/v1/chat/completions";
const CHAT_TRANSCRIBE_PROMPT: &str =
    "Transcribe this audio verbatim. Output only the transcript with no preamble, no commentary, no quotation marks.";

/// Sample rate the worker resamples to before calling `transcribe()`.
/// Must match the conversion in `worker::transcribe_chunk_with_provider`.
const TRANSCRIBE_SAMPLE_RATE: u32 = 16_000;

/// Mistral Voxtral transcription provider.
///
/// Stateless except for an HTTP client and the (API key, model, language) config
/// captured at construction time. The key is held in-memory only and never logged.
pub struct MistralProvider {
    api_key: String,
    model: String,
    language: Option<String>,
    client: reqwest::Client,
}

impl MistralProvider {
    /// Create a new MistralProvider.
    ///
    /// # Arguments
    /// * `api_key` - Mistral API key (read from SQLite per-init by the engine layer; never logged).
    /// * `model` - Model id, e.g. `"voxtral-mini-latest"` or `"voxtral-small-latest"`.
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
    /// of the Voxtral multipart request.
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

/// Minimal Voxtral response shape — we only need `text`.
#[derive(Debug, Deserialize)]
struct VoxtralResponse {
    text: String,
}

/// Minimal chat-completions response shape — we only need the text from choices[0].
#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

#[derive(Debug, Deserialize)]
struct ChatMessage {
    content: String,
}

impl MistralProvider {
    /// True when this provider should route to /v1/chat/completions instead of
    /// the dedicated transcription endpoint. Only `voxtral-small-*` is exposed
    /// as a chat-only audio understanding model on Mistral's side.
    fn is_chat_model(&self) -> bool {
        self.model.starts_with("voxtral-small")
    }

    /// Audio-understanding fallback: send the WAV as base64 in a chat message
    /// with a "transcribe verbatim" instruction and read the assistant's reply
    /// as the transcript. Slower and costlier than the dedicated STT endpoint.
    async fn transcribe_via_chat(
        &self,
        wav_bytes: Vec<u8>,
    ) -> std::result::Result<TranscriptResult, TranscriptionError> {
        let b64 = base64::engine::general_purpose::STANDARD.encode(&wav_bytes);

        let body = serde_json::json!({
            "model": self.model,
            "temperature": 0,
            "messages": [{
                "role": "user",
                "content": [
                    {
                        "type": "input_audio",
                        "input_audio": { "data": b64, "format": "wav" }
                    },
                    { "type": "text", "text": CHAT_TRANSCRIBE_PROMPT }
                ]
            }]
        });

        let response = self
            .client
            .post(MISTRAL_CHAT_URL)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                TranscriptionError::EngineFailed(format!("Mistral chat request failed: {}", e))
            })?;

        let status = response.status();
        if !status.is_success() {
            let err_body = response
                .text()
                .await
                .unwrap_or_else(|_| "<failed to read error body>".to_string());
            warn!(
                "Mistral chat completions returned non-2xx ({}): {}",
                status, err_body
            );
            return Err(TranscriptionError::EngineFailed(format!(
                "Mistral chat HTTP {}: {}",
                status, err_body
            )));
        }

        let parsed: ChatResponse = response.json().await.map_err(|e| {
            TranscriptionError::EngineFailed(format!(
                "Failed to parse Mistral chat response JSON: {}",
                e
            ))
        })?;

        let text = parsed
            .choices
            .into_iter()
            .next()
            .map(|c| c.message.content)
            .unwrap_or_default();

        Ok(TranscriptResult {
            text: text.trim().to_string(),
            confidence: None,
            is_partial: false,
        })
    }
}

#[async_trait]
impl TranscriptionProvider for MistralProvider {
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
            "MistralProvider: encoded {} samples ({} bytes WAV) for model '{}'",
            audio.len(),
            wav_bytes.len(),
            self.model
        );

        if self.is_chat_model() {
            return self.transcribe_via_chat(wav_bytes).await;
        }

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
            .text("model", self.model.clone())
            .part("file", file_part);

        if let Some(l) = lang {
            if !l.is_empty() {
                form = form.text("language", l);
            }
        }

        // 3. POST to Voxtral. NOTE: never log self.api_key.
        let response = self
            .client
            .post(MISTRAL_TRANSCRIPTIONS_URL)
            .bearer_auth(&self.api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|e| {
                TranscriptionError::EngineFailed(format!("Mistral request failed: {}", e))
            })?;

        // 4. Surface non-2xx as a structured error (do not panic, do not return empty string).
        let status = response.status();
        if !status.is_success() {
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "<failed to read error body>".to_string());
            warn!(
                "Mistral Voxtral returned non-2xx ({}): {}",
                status, body
            );
            return Err(TranscriptionError::EngineFailed(format!(
                "Mistral Voxtral HTTP {}: {}",
                status, body
            )));
        }

        let parsed: VoxtralResponse = response.json().await.map_err(|e| {
            TranscriptionError::EngineFailed(format!(
                "Failed to parse Voxtral response JSON: {}",
                e
            ))
        })?;

        Ok(TranscriptResult {
            text: parsed.text.trim().to_string(),
            confidence: None, // Voxtral doesn't return chunk-level confidence
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
        "mistral"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_wav_header_is_well_formed() {
        // 0.1s of silence at 16 kHz mono
        let samples = vec![0.0f32; 1600];
        let wav = MistralProvider::encode_wav_pcm16(&samples, 16_000);

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
    fn encode_wav_clamps_and_scales() {
        let samples = vec![1.5f32, -1.5, 0.0, 0.5];
        let wav = MistralProvider::encode_wav_pcm16(&samples, 16_000);
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
