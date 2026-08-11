// audio/transcription/parakeet_provider.rs
//
// Parakeet transcription provider implementation.

use super::provider::{TranscriptionError, TranscriptionProvider, TranscriptResult};
use async_trait::async_trait;
use log::warn;
use std::sync::Arc;

/// Parakeet transcription provider (wraps ParakeetEngine)
pub struct ParakeetProvider {
    engine: Arc<crate::parakeet_engine::ParakeetEngine>,
}

impl ParakeetProvider {
    pub fn new(engine: Arc<crate::parakeet_engine::ParakeetEngine>) -> Self {
        Self { engine }
    }
}

#[async_trait]
impl TranscriptionProvider for ParakeetProvider {
    async fn transcribe(
        &self,
        audio: Vec<f32>,
        language: Option<String>,
    ) -> std::result::Result<TranscriptResult, TranscriptionError> {
        // Parakeet TDT v3 is multilingual and does its own language identification; there is no
        // language token to send. The hint is still forwarded because it gates the English-only
        // post-processing inside the engine. Warn once per non-English call so the limitation is
        // visible in the log rather than silently assumed to be honoured.
        if let Some(ref lang) = language {
            let l = lang.trim().to_ascii_lowercase();
            if !(l.is_empty() || l == "auto" || l == "auto-translate" || l == "en") {
                warn!(
                    "Parakeet cannot be steered to '{}': the model auto-detects language. \
                     English post-processing disabled for this chunk.",
                    lang
                );
            }
        }

        match self.engine.transcribe_audio(audio, language.as_deref()).await {
            Ok(text) => Ok(TranscriptResult {
                text: text.trim().to_string(),
                confidence: None, // Parakeet doesn't provide confidence scores
                is_partial: false, // Parakeet doesn't provide partial results
            }),
            Err(e) => Err(TranscriptionError::EngineFailed(e.to_string())),
        }
    }

    async fn is_model_loaded(&self) -> bool {
        self.engine.is_model_loaded().await
    }

    async fn get_current_model(&self) -> Option<String> {
        self.engine.get_current_model().await
    }

    fn provider_name(&self) -> &'static str {
        "Parakeet"
    }
}
