//! F047: Wake word detection for voice commands.
//!
//! Uses OpenWakeWord's 3-stage ONNX pipeline via the `ort` crate:
//!   1. Mel spectrogram extraction (melspectrogram.onnx)
//!   2. Audio embedding via Google's speech model (embedding_model.onnx)
//!   3. Wake word classifier (e.g. hey_tandem.onnx)
//!
//! Audio is tapped from RecordingState (mic-only, post-noise-suppression)
//! and resampled from 48kHz to 16kHz before feeding to the pipeline.
//!
//! Robustness layers:
//!   1. Isolated mic stream (no system audio)
//!   2. Noise suppression already applied by AudioCapture
//!   3. Embedding-based architecture (inherently noise-robust)
//!   4. Confidence smoothing (rolling avg over 12 frames) + 3s cooldown
//!   5. Frontend confirmation UI (auto-cancel after 5s silence)

use anyhow::{Context, Result};
use log::{debug, info, warn};
use ndarray::{Array2, ArrayD};
use ort::execution_providers::CPUExecutionProvider;
use ort::inputs;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::TensorRef;
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::mpsc;

use super::recording_state::AudioChunk;

// ── OpenWakeWord pipeline constants ──────────────────────────────────────────

/// Audio chunk size expected by the mel spectrogram model (80ms at 16kHz)
const OWW_CHUNK_SIZE: usize = 1280;
/// Number of mel spectrogram chunks to buffer (16 * 5 frames = 80 frames)
const MEL_BUFFER_SIZE: usize = 16;
/// Number of embedding vectors to buffer for the classifier
const EMBEDDING_BUFFER_SIZE: usize = 16;
/// Number of detection scores for rolling average
const DETECTION_BUFFER_SIZE: usize = 12;
/// Mel output: 5 time frames per chunk
const MEL_FRAMES_PER_CHUNK: usize = 5;
/// Mel output: 32 frequency bins
const MEL_FREQ_BINS: usize = 32;
/// Embedding dimensionality
const EMBEDDING_DIM: usize = 96;

// ── Detection parameters ─────────────────────────────────────────────────────

/// Default detection threshold (configurable via settings)
/// Using 0.3 for Alexa dev model — production "Hey Tandem" model may need tuning
const DEFAULT_THRESHOLD: f32 = 0.3;
/// Cooldown between detections to prevent rapid re-triggers
const DETECTION_COOLDOWN: Duration = Duration::from_secs(3);

// ── Audio resampling constants ───────────────────────────────────────────────

/// Input sample rate from the audio pipeline
const INPUT_SAMPLE_RATE: u32 = 48000;
/// OpenWakeWord expects 16kHz audio
const OWW_SAMPLE_RATE: u32 = 16000;
/// Resampler fixed chunk size
const RESAMPLER_CHUNK_SIZE: usize = 512;

/// Wake word detector that runs on a separate tokio task.
/// Receives mic-only audio chunks and emits Tauri events on detection.
pub struct WakeWordDetector<R: Runtime> {
    // ONNX sessions (3-stage pipeline)
    mel_session: Session,
    embedding_session: Session,
    classifier_session: Session,
    // Circular buffers for streaming inference
    mel_buffer: VecDeque<Array2<f32>>,   // each [5, 32]
    embedding_buffer: VecDeque<Vec<f32>>, // each 96-dim
    detection_buffer: VecDeque<f32>,      // probability scores
    // Audio pipeline
    audio_receiver: mpsc::UnboundedReceiver<AudioChunk>,
    app_handle: AppHandle<R>,
    resampler: SincFixedIn<f32>,
    resample_buffer: Vec<f32>,
    sample_buffer: Vec<f32>, // accumulate until OWW_CHUNK_SIZE (1280)
    // Detection state
    threshold: f32,
    last_detection: Instant,
}

impl<R: Runtime> WakeWordDetector<R> {
    /// Create a new wake word detector.
    ///
    /// `model_dir` should contain: `melspectrogram.onnx`, `embedding_model.onnx`,
    /// and at least one classifier model (e.g. `hey_tandem.onnx` or `alexa_v0.1.onnx`).
    ///
    /// Returns `None`-style error if model files are missing.
    pub fn new(
        app: AppHandle<R>,
        rx: mpsc::UnboundedReceiver<AudioChunk>,
        model_dir: &Path,
        classifier_filename: &str,
        threshold: Option<f32>,
    ) -> Result<Self> {
        let mel_path = model_dir.join("melspectrogram.onnx");
        let emb_path = model_dir.join("embedding_model.onnx");
        let cls_path = model_dir.join(classifier_filename);

        // Validate all model files exist
        for (name, path) in [
            ("melspectrogram", &mel_path),
            ("embedding_model", &emb_path),
            ("classifier", &cls_path),
        ] {
            if !path.exists() {
                return Err(anyhow::anyhow!(
                    "OpenWakeWord {} model not found: {}",
                    name,
                    path.display()
                ));
            }
        }

        let providers = vec![CPUExecutionProvider::default().build()];

        let mel_session = Session::builder()?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_execution_providers(providers.clone())?
            .with_intra_threads(1)?
            .commit_from_file(&mel_path)
            .context("Failed to load melspectrogram.onnx")?;

        let embedding_session = Session::builder()?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_execution_providers(providers.clone())?
            .with_intra_threads(1)?
            .commit_from_file(&emb_path)
            .context("Failed to load embedding_model.onnx")?;

        let classifier_session = Session::builder()?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_execution_providers(providers)?
            .with_intra_threads(1)?
            .commit_from_file(&cls_path)
            .context("Failed to load classifier model")?;

        // High-quality sinc resampler: 48kHz → 16kHz (3:1 downsampling)
        let params = SincInterpolationParameters {
            sinc_len: 256,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Cubic,
            oversampling_factor: 256,
            window: WindowFunction::BlackmanHarris2,
        };
        let ratio = OWW_SAMPLE_RATE as f64 / INPUT_SAMPLE_RATE as f64;
        let resampler = SincFixedIn::<f32>::new(ratio, 2.0, params, RESAMPLER_CHUNK_SIZE, 1)
            .map_err(|e| anyhow::anyhow!("Failed to create KWS resampler: {}", e))?;

        let threshold = threshold.unwrap_or(DEFAULT_THRESHOLD);

        info!(
            "OpenWakeWord detector initialized (model_dir: {}, classifier: {}, threshold: {:.2})",
            model_dir.display(),
            classifier_filename,
            threshold
        );

        Ok(Self {
            mel_session,
            embedding_session,
            classifier_session,
            mel_buffer: VecDeque::with_capacity(MEL_BUFFER_SIZE),
            embedding_buffer: VecDeque::with_capacity(EMBEDDING_BUFFER_SIZE),
            detection_buffer: VecDeque::with_capacity(DETECTION_BUFFER_SIZE),
            audio_receiver: rx,
            app_handle: app,
            resampler,
            resample_buffer: Vec::with_capacity(8192),
            sample_buffer: Vec::with_capacity(OWW_CHUNK_SIZE * 2),
            threshold,
            last_detection: Instant::now() - DETECTION_COOLDOWN, // allow immediate first detection
        })
    }

    /// Run the mel spectrogram model on a 1280-sample chunk.
    /// Returns a [5, 32] array of normalized mel features.
    fn process_mel(&mut self, chunk: &[f32]) -> Result<Array2<f32>> {
        debug_assert_eq!(chunk.len(), OWW_CHUNK_SIZE);

        // Input shape: [1, 1280]
        let input = ArrayD::from_shape_vec(vec![1, OWW_CHUNK_SIZE], chunk.to_vec())?;
        let input_ref = TensorRef::from_array_view(input.view())?;
        let outputs = self.mel_session.run(inputs!["input" => input_ref])?;

        // Output: extract as ArrayD<f32> — raw shape is [1, 1, 5, 32]
        let raw_output: ArrayD<f32> = outputs[0].try_extract_array()?.to_owned();

        // Flatten and validate size
        let flat: Vec<f32> = raw_output.into_iter().collect();
        if flat.len() != MEL_FRAMES_PER_CHUNK * MEL_FREQ_BINS {
            return Err(anyhow::anyhow!(
                "Mel output size mismatch: expected {}, got {}",
                MEL_FRAMES_PER_CHUNK * MEL_FREQ_BINS,
                flat.len()
            ));
        }

        // Apply normalization: (x / 10.0) + 2.0
        let normalized: Vec<f32> = flat.iter().map(|&v| (v / 10.0) + 2.0).collect();
        let mel = Array2::from_shape_vec((MEL_FRAMES_PER_CHUNK, MEL_FREQ_BINS), normalized)?;

        Ok(mel)
    }

    /// Run the embedding model on the accumulated mel buffer.
    /// Returns a 96-dim embedding vector, or None if buffer isn't full yet.
    fn process_embedding(&mut self) -> Result<Option<Vec<f32>>> {
        if self.mel_buffer.len() < MEL_BUFFER_SIZE {
            return Ok(None);
        }

        // Stack all mel chunks: 16 * [5, 32] → [80, 32]
        let mut stacked: Vec<f32> = Vec::with_capacity(MEL_BUFFER_SIZE * MEL_FRAMES_PER_CHUNK * MEL_FREQ_BINS);
        for mel_chunk in &self.mel_buffer {
            stacked.extend(mel_chunk.iter());
        }

        // Slice to [76, 32] — skip first 4 rows
        let skip = 4 * MEL_FREQ_BINS;
        let sliced = &stacked[skip..];
        debug_assert_eq!(sliced.len(), 76 * MEL_FREQ_BINS);

        // Reshape to [1, 76, 32, 1] for the embedding model
        let input = ArrayD::from_shape_vec(vec![1, 76, MEL_FREQ_BINS, 1], sliced.to_vec())?;
        let input_ref = TensorRef::from_array_view(input.view())?;
        let outputs = self
            .embedding_session
            .run(inputs!["input_1" => input_ref])?;

        // Output: [1, 1, 1, 96] → squeeze to 96-dim vector
        let raw: ArrayD<f32> = outputs[0].try_extract_array()?.to_owned();
        let embedding: Vec<f32> = raw.into_iter().collect();

        if embedding.len() != EMBEDDING_DIM {
            return Err(anyhow::anyhow!(
                "Embedding size mismatch: expected {}, got {}",
                EMBEDDING_DIM,
                embedding.len()
            ));
        }

        Ok(Some(embedding))
    }

    /// Run the classifier on the accumulated embedding buffer.
    /// Returns a probability score (0.0-1.0), or None if buffer isn't full yet.
    fn process_classifier(&mut self) -> Result<Option<f32>> {
        if self.embedding_buffer.len() < EMBEDDING_BUFFER_SIZE {
            return Ok(None);
        }

        // Stack embeddings: 16 * 96-dim → [1, 16, 96]
        let mut flat: Vec<f32> = Vec::with_capacity(EMBEDDING_BUFFER_SIZE * EMBEDDING_DIM);
        for emb in &self.embedding_buffer {
            flat.extend(emb);
        }

        let input = ArrayD::from_shape_vec(
            vec![1, EMBEDDING_BUFFER_SIZE, EMBEDDING_DIM],
            flat,
        )?;

        // Dynamically get the classifier's input tensor name
        let input_name = self.classifier_session.inputs[0].name.clone();
        let input_ref = TensorRef::from_array_view(input.view())?;
        let outputs = self
            .classifier_session
            .run(inputs![input_name.as_str() => input_ref])?;

        // Output: [1, 1] → single probability
        let raw: ArrayD<f32> = outputs[0].try_extract_array()?.to_owned();
        let probability = raw.into_iter().next().unwrap_or(0.0);

        Ok(Some(probability))
    }

    /// Check if a detection should be triggered.
    /// Matches OpenWakeWord's approach: trigger immediately when score >= threshold,
    /// with a cooldown to prevent rapid re-triggering.
    fn check_detection(&self, current_score: f32) -> bool {
        // Cooldown check
        if self.last_detection.elapsed() < DETECTION_COOLDOWN {
            return false;
        }
        // Simple threshold crossing — matches official OpenWakeWord behavior
        current_score >= self.threshold
    }

    /// Process a single 1280-sample chunk through the full 3-stage pipeline.
    fn process_chunk(&mut self, chunk: &[f32]) -> Result<Option<f32>> {
        // Stage 1: Mel spectrogram
        let mel = self.process_mel(chunk)?;
        self.mel_buffer.push_back(mel);
        if self.mel_buffer.len() > MEL_BUFFER_SIZE {
            self.mel_buffer.pop_front();
        }

        // Stage 2: Embedding (needs full mel buffer)
        if let Some(embedding) = self.process_embedding()? {
            self.embedding_buffer.push_back(embedding);
            if self.embedding_buffer.len() > EMBEDDING_BUFFER_SIZE {
                self.embedding_buffer.pop_front();
            }

            // Stage 3: Classifier (needs full embedding buffer)
            if let Some(probability) = self.process_classifier()? {
                self.detection_buffer.push_back(probability);
                if self.detection_buffer.len() > DETECTION_BUFFER_SIZE {
                    self.detection_buffer.pop_front();
                }
                // Log scores above noise floor so we can tune threshold
                if probability > 0.05 {
                    debug!("KWS score: {:.3} (threshold: {:.2})", probability, self.threshold);
                }
                return Ok(Some(probability));
            }
        }

        Ok(None)
    }

    /// Run the detection loop. Blocks until the audio channel is closed.
    pub async fn run(mut self) {
        info!("OpenWakeWord detector started");

        while let Some(chunk) = self.audio_receiver.recv().await {
            // Resample 48kHz → 16kHz
            self.resample_buffer.extend_from_slice(&chunk.data);

            while self.resample_buffer.len() >= RESAMPLER_CHUNK_SIZE {
                let input_chunk: Vec<f32> =
                    self.resample_buffer.drain(..RESAMPLER_CHUNK_SIZE).collect();
                match self.resampler.process(&[input_chunk], None) {
                    Ok(output) => {
                        if let Some(resampled) = output.first() {
                            self.sample_buffer.extend_from_slice(resampled);
                        }
                    }
                    Err(e) => {
                        warn!("KWS resampler error: {}", e);
                        continue;
                    }
                }
            }

            // Process complete 1280-sample chunks through the OWW pipeline
            while self.sample_buffer.len() >= OWW_CHUNK_SIZE {
                let oww_chunk: Vec<f32> =
                    self.sample_buffer.drain(..OWW_CHUNK_SIZE).collect();

                match self.process_chunk(&oww_chunk) {
                    Ok(Some(probability)) => {
                        // Check if we should trigger a detection
                        if self.check_detection(probability) {
                            info!(
                                "Wake word detected! score={:.3}, threshold={:.2}",
                                probability, self.threshold
                            );
                            self.last_detection = Instant::now();

                            // Clear detection buffer to prevent re-triggering
                            self.detection_buffer.clear();

                            // Emit Tauri event for frontend
                            if let Err(e) =
                                self.app_handle.emit("wake-word-detected", serde_json::json!({
                                    "confidence": probability,
                                    "timestamp": chrono::Utc::now().timestamp_millis(),
                                }))
                            {
                                warn!("Failed to emit wake-word-detected event: {}", e);
                            }
                        }
                    }
                    Ok(None) => {
                        // Pipeline buffers still filling up — normal during warmup
                    }
                    Err(e) => {
                        warn!("KWS pipeline error: {}", e);
                    }
                }
            }
        }

        info!("OpenWakeWord detector stopped (audio channel closed)");
    }
}

/// Get the default directory for OpenWakeWord model files.
pub fn default_model_dir() -> PathBuf {
    if let Some(data_dir) = dirs::data_dir() {
        data_dir.join("Tandem").join("models").join("openwakeword")
    } else {
        PathBuf::from("models").join("openwakeword")
    }
}

/// Default classifier model filename.
/// Using alexa_v0.1.onnx as a stand-in for development while custom "Hey Tandem" model is trained.
pub fn default_classifier_filename() -> &'static str {
    "alexa_v0.1.onnx"
}
