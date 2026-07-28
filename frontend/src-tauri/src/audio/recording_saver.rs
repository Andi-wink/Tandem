use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;
use anyhow::Result;
use log::{info, warn, error};
use tauri::{AppHandle, Runtime, Emitter};
use tokio::sync::mpsc;
use serde::{Serialize, Deserialize};
use std::path::PathBuf;

use super::recording_state::AudioChunk;
use super::audio_processing::{create_meeting_folder, create_dated_meeting_folder};
use super::incremental_saver::IncrementalAudioSaver;

/// Structured transcript segment for JSON export
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub id: String,
    pub text: String,
    pub audio_start_time: f64, // Seconds from recording start
    pub audio_end_time: f64,   // Seconds from recording start
    pub duration: f64,          // Segment duration in seconds
    pub display_time: String,   // Formatted time for display like "[02:15]"
    pub confidence: f32,
    pub sequence_id: u64,
    #[serde(default = "default_source")]
    pub source: String,         // "Local" (mic) or "Remote" (system audio)
}

fn default_source() -> String {
    "Local".to_string()
}

/// Meeting metadata structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingMetadata {
    pub version: String,
    pub meeting_id: Option<String>,
    pub meeting_name: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub duration_seconds: Option<f64>,
    pub devices: DeviceInfo,
    pub audio_file: String,
    pub transcript_file: String,
    pub sample_rate: u32,
    pub status: String,  // "recording", "completed", "error"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub microphone: Option<String>,
    pub system_audio: Option<String>,
}

/// New recording saver using incremental saving strategy
pub struct RecordingSaver {
    incremental_saver: Option<Arc<AsyncMutex<IncrementalAudioSaver>>>,
    meeting_folder: Option<PathBuf>,
    meeting_name: Option<String>,
    /// When set (R3), the meeting folder is created DATE-LED directly under this base directory
    /// (typically `<project>/.tandem`) instead of the platform default recordings folder.
    base_folder_override: Option<PathBuf>,
    metadata: Option<MeetingMetadata>,
    transcript_segments: Arc<Mutex<Vec<TranscriptSegment>>>,
    /// Debounce state for transcripts.json. `add_transcript_segment` used to
    /// clone, pretty-serialize and atomically rewrite the ENTIRE segment list on
    /// every single segment, which is O(n^2) in bytes written on the event thread.
    /// Utterance-level splitting turns ~700 segments per 3h meeting into several
    /// thousand, taking that from noticeable to gigabytes. The in-memory list and
    /// the per-segment DB upsert are unchanged; only the JSON mirror is debounced.
    ///
    /// SEMANTICS: this is a LAZY write, not a timer. A rewrite happens on the next
    /// `add_transcript_segment` that arrives at least `TRANSCRIPT_WRITE_DEBOUNCE`
    /// after the previous one; nothing is scheduled in between. The pending write
    /// is therefore only guaranteed to reach disk via
    /// [`flush_transcripts_now`](Self::flush_transcripts_now), which every
    /// terminal path must call.
    last_transcript_write: Arc<Mutex<Option<std::time::Instant>>>,
    transcripts_dirty: Arc<Mutex<bool>>,
    chunk_receiver: Option<mpsc::UnboundedReceiver<AudioChunk>>,
    is_saving: Arc<Mutex<bool>>,
}

/// Minimum wall-clock gap between incremental transcripts.json rewrites.
const TRANSCRIPT_WRITE_DEBOUNCE: std::time::Duration = std::time::Duration::from_secs(5);

impl RecordingSaver {
    pub fn new() -> Self {
        Self {
            incremental_saver: None,
            meeting_folder: None,
            meeting_name: None,
            base_folder_override: None,
            metadata: None,
            transcript_segments: Arc::new(Mutex::new(Vec::new())),
            last_transcript_write: Arc::new(Mutex::new(None)),
            transcripts_dirty: Arc::new(Mutex::new(false)),
            chunk_receiver: None,
            is_saving: Arc::new(Mutex::new(false)),
        }
    }

    /// Set the meeting name for this recording session
    pub fn set_meeting_name(&mut self, name: Option<String>) {
        self.meeting_name = name;
    }

    /// Set the base directory the meeting folder is created under (R3). Only absolute paths are
    /// honored; a relative/empty path is ignored so a bad seed can never redirect the write.
    pub fn set_base_folder_override(&mut self, dir: Option<PathBuf>) {
        self.base_folder_override = match dir {
            Some(p) if p.is_absolute() => Some(p),
            Some(p) => {
                warn!("Ignoring non-absolute meeting base override: {}", p.display());
                None
            }
            None => None,
        };
    }

    /// Set device information in metadata
    pub fn set_device_info(&mut self, mic_name: Option<String>, sys_name: Option<String>) {
        if let Some(ref mut metadata) = self.metadata {
            metadata.devices.microphone = mic_name;
            metadata.devices.system_audio = sys_name;

            // Write updated metadata to disk if folder exists
            if let Some(folder) = &self.meeting_folder {
                let metadata_clone = metadata.clone();
                if let Err(e) = self.write_metadata(folder, &metadata_clone) {
                    warn!("Failed to update metadata with device info: {}", e);
                }
            }
        }
    }

    /// Add or update a structured transcript segment (upserts based on sequence_id)
    /// Also saves incrementally to disk
    pub fn add_transcript_segment(&self, segment: TranscriptSegment) {
        if let Ok(mut segments) = self.transcript_segments.lock() {
            // Check if segment with same sequence_id exists (update it)
            if let Some(existing) = segments.iter_mut().find(|s| s.sequence_id == segment.sequence_id) {
                *existing = segment.clone();
                info!("Updated transcript segment {} (seq: {}) - total segments: {}",
                      segment.id, segment.sequence_id, segments.len());
            } else {
                // New segment, add it
                segments.push(segment.clone());
                info!("Added new transcript segment {} (seq: {}) - total segments: {}",
                      segment.id, segment.sequence_id, segments.len());
            }
        } else {
            error!("Failed to lock transcript segments for adding segment {}", segment.id);
        }

        // Mirror to disk incrementally, DEBOUNCED: at most one full rewrite every
        // TRANSCRIPT_WRITE_DEBOUNCE. Anything skipped is written by
        // `flush_transcripts_now`, which `stop_and_save` calls before any of its
        // returns (including the auto-save-off one) and which the stop path also
        // calls before the long, fallible save.
        self.write_transcripts_json_debounced();
    }

    /// Rewrite transcripts.json only if the debounce window has elapsed; otherwise
    /// just mark the mirror dirty.
    fn write_transcripts_json_debounced(&self) {
        let Some(folder) = self.meeting_folder.clone() else {
            return;
        };
        let due = {
            let mut last = match self.last_transcript_write.lock() {
                Ok(g) => g,
                Err(e) => e.into_inner(),
            };
            let now = std::time::Instant::now();
            let due = match *last {
                Some(prev) => now.duration_since(prev) >= TRANSCRIPT_WRITE_DEBOUNCE,
                None => true,
            };
            if due {
                *last = Some(now);
            }
            due
        };
        if !due {
            if let Ok(mut dirty) = self.transcripts_dirty.lock() {
                *dirty = true;
            }
            return;
        }
        if let Err(e) = self.write_transcripts_json(&folder) {
            warn!("Failed to write incremental transcript update: {}", e);
            return;
        }
        if let Ok(mut dirty) = self.transcripts_dirty.lock() {
            *dirty = false;
        }
    }

    /// Whether segments have been added since the last transcripts.json write.
    pub fn transcripts_pending_write(&self) -> bool {
        self.transcripts_dirty
            .lock()
            .map(|g| *g)
            .unwrap_or(false)
    }

    /// Write transcripts.json NOW if anything is pending, ignoring the debounce.
    ///
    /// Must be called on every terminal path (stop, save, error teardown): the
    /// debounce is a lazy "write on the next add if enough time has passed", so
    /// without a terminal flush the last burst of segments never reaches disk.
    pub fn flush_transcripts_now(&self) {
        if !self.transcripts_pending_write() {
            return;
        }
        let Some(folder) = self.meeting_folder.clone() else {
            return;
        };
        match self.write_transcripts_json(&folder) {
            Ok(()) => {
                if let Ok(mut dirty) = self.transcripts_dirty.lock() {
                    *dirty = false;
                }
                if let Ok(mut last) = self.last_transcript_write.lock() {
                    *last = Some(std::time::Instant::now());
                }
                info!("💾 Flushed pending transcripts.json before teardown");
            }
            Err(e) => warn!("Failed to flush pending transcripts.json: {}", e),
        }
    }

    /// Legacy method for backward compatibility - converts text to basic segment
    pub fn add_transcript_chunk(&self, text: String) {
        let segment = TranscriptSegment {
            id: format!("seg_{}", chrono::Utc::now().timestamp_millis()),
            text,
            audio_start_time: 0.0,
            audio_end_time: 0.0,
            duration: 0.0,
            display_time: "[00:00]".to_string(),
            confidence: 1.0,
            sequence_id: 0,
            source: default_source(),
        };
        self.add_transcript_segment(segment);
    }

    /// Start accumulation with optional incremental saving
    ///
    /// # Arguments
    /// * `auto_save` - If true, creates checkpoints and enables saving. If false, audio chunks are discarded.
    pub fn start_accumulation(&mut self, auto_save: bool) -> mpsc::UnboundedSender<AudioChunk> {
        if auto_save {
            info!("Initializing incremental audio saver for recording (auto-save ENABLED)");
        } else {
            info!("Starting recording without audio saving (auto-save DISABLED - transcripts only)");
        }

        // Create channel for receiving audio chunks
        let (sender, receiver) = mpsc::unbounded_channel::<AudioChunk>();
        self.chunk_receiver = Some(receiver);

        // Initialize meeting folder and incremental saver ONLY if auto_save is enabled
        if auto_save {
            if let Some(name) = self.meeting_name.clone() {
                match self.initialize_meeting_folder(&name, true) {
                    Ok(()) => info!("Successfully initialized meeting folder with checkpoints"),
                    Err(e) => {
                        error!("Failed to initialize meeting folder: {}", e);
                        // Continue anyway - will use fallback flat structure
                    }
                }
            }
        } else {
            // When auto_save is false, still create meeting folder for transcripts/metadata
            // but skip .checkpoints directory
            if let Some(name) = self.meeting_name.clone() {
                match self.initialize_meeting_folder(&name, false) {
                    Ok(()) => info!("Successfully initialized meeting folder (transcripts only)"),
                    Err(e) => {
                        error!("Failed to initialize meeting folder: {}", e);
                    }
                }
            }
        }

        // Start accumulation task
        let is_saving_clone = self.is_saving.clone();
        let incremental_saver_arc = self.incremental_saver.clone();
        let save_audio = auto_save;

        if let Some(mut receiver) = self.chunk_receiver.take() {
            tokio::spawn(async move {
                info!("Recording saver accumulation task started (save_audio: {})", save_audio);

                let result = std::panic::AssertUnwindSafe(async {
                    while let Some(chunk) = receiver.recv().await {
                        // Check if we should continue
                        let should_continue = if let Ok(is_saving) = is_saving_clone.lock() {
                            *is_saving
                        } else {
                            false
                        };

                        if !should_continue {
                            break;
                        }

                        // Only process audio chunks if auto_save is enabled
                        if save_audio {
                            // Add chunk to incremental saver
                            if let Some(saver_arc) = &incremental_saver_arc {
                                let mut saver_guard = saver_arc.lock().await;
                                if let Err(e) = saver_guard.add_chunk(chunk) {
                                    error!("Failed to add chunk to incremental saver: {}", e);
                                }
                            } else {
                                error!("Incremental saver not available while accumulating");
                            }
                        }
                    }
                });

                use futures_util::FutureExt;
                match result.catch_unwind().await {
                    Ok(()) => info!("Recording saver accumulation task ended"),
                    Err(panic) => error!("Recording saver accumulation task panicked: {:?}", panic),
                }
            });
        }

        // Set saving flag
        if let Ok(mut is_saving) = self.is_saving.lock() {
            *is_saving = true;
        }

        sender
    }

    /// Initialize meeting folder structure and metadata
    ///
    /// # Arguments
    /// * `meeting_name` - Name of the meeting
    /// * `create_checkpoints` - Whether to create .checkpoints/ directory and IncrementalAudioSaver
    fn initialize_meeting_folder(&mut self, meeting_name: &str, create_checkpoints: bool) -> Result<()> {
        // R3: when a base override is set (a known project's .tandem dir), create the meeting folder
        // DATE-LED directly there so it files under the client at start. On ANY failure (unwritable
        // dir, missing project) fall back to the platform default — a bad seed must never abort a
        // recording. The frontend then relocates post-stop via the pendingRelocation path.
        let meeting_folder = match &self.base_folder_override {
            Some(base) => {
                if let Err(e) = std::fs::create_dir_all(base) {
                    warn!("Could not create meeting base override {}: {} — falling back to default", base.display(), e);
                    let base_folder = super::recording_preferences::get_default_recordings_folder();
                    create_meeting_folder(&base_folder, meeting_name, create_checkpoints)?
                } else {
                    match create_dated_meeting_folder(base, meeting_name, create_checkpoints) {
                        Ok(folder) => {
                            info!("📁 Meeting folder created under project base: {}", folder.display());
                            folder
                        }
                        Err(e) => {
                            warn!("Dated folder create failed under {}: {} — falling back to default", base.display(), e);
                            let base_folder = super::recording_preferences::get_default_recordings_folder();
                            create_meeting_folder(&base_folder, meeting_name, create_checkpoints)?
                        }
                    }
                }
            }
            None => {
                // Load preferences to get base recordings folder
                let base_folder = super::recording_preferences::get_default_recordings_folder();
                // Create meeting folder structure (with or without .checkpoints/ subdirectory)
                create_meeting_folder(&base_folder, meeting_name, create_checkpoints)?
            }
        };

        // Only initialize incremental saver if checkpoints are needed (auto_save is true)
        if create_checkpoints {
            let incremental_saver = IncrementalAudioSaver::new(meeting_folder.clone(), 48000)?;
            self.incremental_saver = Some(Arc::new(AsyncMutex::new(incremental_saver)));
            info!("✅ Incremental audio saver initialized for meeting: {}", meeting_name);
        } else {
            info!("⚠️  Skipped incremental audio saver (auto-save disabled)");
        }

        // Create initial metadata
        let metadata = MeetingMetadata {
            version: "1.0".to_string(),
            meeting_id: None,  // Will be set by backend
            meeting_name: Some(meeting_name.to_string()),
            created_at: chrono::Utc::now().to_rfc3339(),
            completed_at: None,
            duration_seconds: None,
            devices: DeviceInfo {
                microphone: None,  // Could be enhanced to store actual device names
                system_audio: None,
            },
            audio_file: if create_checkpoints { "audio.mp4".to_string() } else { "".to_string() },
            transcript_file: "transcripts.json".to_string(),
            sample_rate: 48000,
            status: "recording".to_string(),
        };

        // Write initial metadata.json
        self.write_metadata(&meeting_folder, &metadata)?;

        self.meeting_folder = Some(meeting_folder);
        self.metadata = Some(metadata);

        Ok(())
    }

    /// Write metadata.json to disk (atomic write with temp file)
    fn write_metadata(&self, folder: &PathBuf, metadata: &MeetingMetadata) -> Result<()> {
        let metadata_path = folder.join("metadata.json");
        let temp_path = folder.join(".metadata.json.tmp");

        let json_string = serde_json::to_string_pretty(metadata)?;
        std::fs::write(&temp_path, json_string)?;
        std::fs::rename(&temp_path, &metadata_path)?;  // Atomic

        Ok(())
    }

    /// Write transcripts.json to disk (atomic write with temp file and validation)
    fn write_transcripts_json(&self, folder: &PathBuf) -> Result<()> {
        // Clone segments to avoid holding lock during I/O
        let segments_clone = if let Ok(segments) = self.transcript_segments.lock() {
            segments.clone()
        } else {
            error!("Failed to lock transcript segments for writing");
            return Err(anyhow::anyhow!("Failed to lock transcript segments"));
        };

        info!("Writing {} transcript segments to JSON", segments_clone.len());

        let transcript_path = folder.join("transcripts.json");
        let temp_path = folder.join(".transcripts.json.tmp");

        // Create JSON structure
        let json = serde_json::json!({
            "version": "1.0",
            "segments": segments_clone,
            "last_updated": chrono::Utc::now().to_rfc3339(),
            "total_segments": segments_clone.len()
        });

        // Serialize to pretty JSON string
        let json_string = serde_json::to_string_pretty(&json)
            .map_err(|e| {
                error!("Failed to serialize transcripts to JSON: {}", e);
                anyhow::anyhow!("JSON serialization failed: {}", e)
            })?;

        // Write to temp file with error handling
        std::fs::write(&temp_path, &json_string)
            .map_err(|e| {
                error!("Failed to write transcript temp file to {}: {}", temp_path.display(), e);
                anyhow::anyhow!("Failed to write temp file: {}", e)
            })?;

        // Verify temp file was written correctly
        if !temp_path.exists() {
            error!("Temp transcript file does not exist after write: {}", temp_path.display());
            return Err(anyhow::anyhow!("Temp file verification failed"));
        }

        // Atomic rename
        std::fs::rename(&temp_path, &transcript_path)
            .map_err(|e| {
                error!("Failed to rename transcript file from {} to {}: {}",
                       temp_path.display(), transcript_path.display(), e);
                anyhow::anyhow!("Failed to rename transcript file: {}", e)
            })?;

        info!("✅ Successfully wrote transcripts.json with {} segments", segments_clone.len());
        Ok(())
    }

    // in frontend/src-tauri/src/audio/recording_saver.rs
    pub fn get_stats(&self) -> (usize, u32) {
        if let Some(ref saver) = self.incremental_saver {
            if let Ok(guard) = saver.try_lock() {
                (guard.get_checkpoint_count() as usize, 48000)
            } else {
                (0, 48000)
            }
        } else {
            (0, 48000)
        }
    }

    /// Stop and save using incremental saving approach
    ///
    /// # Arguments
    /// * `app` - Tauri app handle for emitting events
    /// * `recording_duration` - Actual recording duration in seconds (from RecordingState)
    pub async fn stop_and_save<R: Runtime>(
        &mut self,
        app: &AppHandle<R>,
        recording_duration: Option<f64>
    ) -> Result<Option<String>, String> {
        info!("Stopping recording saver");

        // Stop accumulation
        if let Ok(mut is_saving) = self.is_saving.lock() {
            *is_saving = false;
        }

        // Give time for final chunks
        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

        // TERMINAL FLUSH (R1). The incremental transcripts.json mirror is
        // debounced, so the burst of segments produced during the stop drain is
        // still pending here. Every terminal path out of this function must write
        // it, including the early auto-save-off return below, which used to exit
        // before the write and lose those closing segments permanently.
        self.flush_transcripts_now();

        // Check if incremental saver exists (indicates auto_save was enabled)
        let should_save_audio = self.incremental_saver.is_some();

        if !should_save_audio {
            info!("⚠️  No audio saver initialized (auto-save was disabled) - skipping audio finalization");
            info!("✅ Transcripts and metadata written (including the closing segments)");
            return Ok(None);
        }

        // Finalize incremental saver (merge checkpoints into final audio.mp4)
        let final_audio_path = if let Some(saver_arc) = &self.incremental_saver {
            let mut saver = saver_arc.lock().await;
            match saver.finalize().await {
                Ok(path) => {
                    info!("✅ Successfully finalized audio: {}", path.display());
                    path
                }
                Err(e) => {
                    error!("❌ Failed to finalize incremental saver: {}", e);
                    return Err(format!("Failed to finalize audio: {}", e));
                }
            }
        } else {
            error!("No incremental saver initialized - cannot save recording");
            return Err("No incremental saver initialized".to_string());
        };

        // Save final transcripts.json with validation
        if let Some(folder) = &self.meeting_folder {
            if let Err(e) = self.write_transcripts_json(folder) {
                error!("❌ Failed to write final transcripts: {}", e);
                return Err(format!("Failed to save transcripts: {}", e));
            }

            // Verify transcripts were written correctly
            let transcript_path = folder.join("transcripts.json");
            if !transcript_path.exists() {
                error!("❌ Transcript file was not created at: {}", transcript_path.display());
                return Err("Transcript file verification failed".to_string());
            }
            info!("✅ Transcripts saved and verified at: {}", transcript_path.display());
        }

        // Update metadata to completed status with actual recording duration
        if let (Some(folder), Some(mut metadata)) = (&self.meeting_folder, self.metadata.clone()) {
            metadata.status = "completed".to_string();
            metadata.completed_at = Some(chrono::Utc::now().to_rfc3339());

            // Use actual recording duration from RecordingState (more accurate than transcript segments)
            // Falls back to last transcript segment if duration not provided
            metadata.duration_seconds = recording_duration.or_else(|| {
                if let Ok(segments) = self.transcript_segments.lock() {
                    segments.last().map(|seg| seg.audio_end_time)
                } else {
                    None
                }
            });

            if let Err(e) = self.write_metadata(folder, &metadata) {
                error!("❌ Failed to update metadata to completed: {}", e);
                return Err(format!("Failed to update metadata: {}", e));
            }

            info!("✅ Metadata updated with duration: {:?}s", metadata.duration_seconds);
        }

        // Emit save event with audio and transcript paths
        let save_event = serde_json::json!({
            "audio_file": final_audio_path.to_string_lossy(),
            "transcript_file": self.meeting_folder.as_ref()
                .map(|f| f.join("transcripts.json").to_string_lossy().to_string()),
            "meeting_name": self.meeting_name,
            "meeting_folder": self.meeting_folder.as_ref()
                .map(|f| f.to_string_lossy().to_string())
        });

        if let Err(e) = app.emit("recording-saved", &save_event) {
            warn!("Failed to emit recording-saved event: {}", e);
        }

        // Clean up transcript segments
        if let Ok(mut segments) = self.transcript_segments.lock() {
            segments.clear();
        }

        Ok(Some(final_audio_path.to_string_lossy().to_string()))
    }

    /// Get the meeting folder path (for passing to backend)
    pub fn get_meeting_folder(&self) -> Option<&PathBuf> {
        self.meeting_folder.as_ref()
    }

    /// Get accumulated transcript segments (for reload sync)
    pub fn get_transcript_segments(&self) -> Vec<TranscriptSegment> {
        if let Ok(segments) = self.transcript_segments.lock() {
            segments.clone()
        } else {
            Vec::new()
        }
    }

    /// Get meeting name (for reload sync)
    pub fn get_meeting_name(&self) -> Option<String> {
        self.meeting_name.clone()
    }
}

impl Default for RecordingSaver {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for RecordingSaver {
    fn drop(&mut self) {
        // Signal the accumulation task to stop by setting the flag
        if let Ok(mut is_saving) = self.is_saving.lock() {
            if *is_saving {
                info!("RecordingSaver dropped while saving — signalling accumulation task to stop");
                *is_saving = false;
            }
        }

        // Drop the chunk receiver to close the channel and unblock the accumulation task
        self.chunk_receiver.take();

        // Clear any accumulated transcript segments
        if let Ok(mut segments) = self.transcript_segments.lock() {
            if !segments.is_empty() {
                warn!("RecordingSaver dropped with {} unsaved transcript segments", segments.len());
                segments.clear();
            }
        }

        info!("RecordingSaver resources cleaned up");
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod transcript_debounce_tests {
    use super::*;

    fn seg(seq: u64) -> TranscriptSegment {
        TranscriptSegment {
            id: format!("seg_{}", seq),
            text: format!("segment {}", seq),
            audio_start_time: seq as f64,
            audio_end_time: seq as f64 + 1.0,
            duration: 1.0,
            display_time: "[00:00]".to_string(),
            confidence: 0.9,
            sequence_id: seq,
            source: "Local".to_string(),
        }
    }

    /// A saver pointed at a real temp folder so the JSON mirror actually writes.
    fn saver_in(dir: &std::path::Path) -> RecordingSaver {
        let mut s = RecordingSaver::new();
        s.meeting_folder = Some(dir.to_path_buf());
        s
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tandem_saver_test_{}_{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn segments_on_disk(dir: &std::path::Path) -> usize {
        let raw = std::fs::read_to_string(dir.join("transcripts.json")).expect("transcripts.json");
        let v: serde_json::Value = serde_json::from_str(&raw).expect("valid json");
        v["segments"].as_array().map(|a| a.len()).unwrap_or(0)
    }

    #[test]
    fn debounce_defers_writes_but_the_terminal_flush_catches_every_segment() {
        // R1: the debounce is a LAZY write, not a timer, so the burst of segments
        // produced during the stop drain stays pending. Without the terminal flush
        // (which the auto-save-off early return used to skip entirely) those
        // closing segments were lost from transcripts.json permanently.
        let dir = temp_dir("debounce");
        let saver = saver_in(&dir);

        // First add writes immediately (no previous write to debounce against).
        saver.add_transcript_segment(seg(1));
        assert_eq!(segments_on_disk(&dir), 1);
        assert!(!saver.transcripts_pending_write());

        // A burst inside the debounce window is held back...
        for i in 2..=12 {
            saver.add_transcript_segment(seg(i));
        }
        assert!(
            saver.transcripts_pending_write(),
            "the burst must be pending, not written one-by-one"
        );
        assert_eq!(
            segments_on_disk(&dir),
            1,
            "still only the first segment on disk: that is the whole point"
        );

        // ...and the terminal flush writes all of it.
        saver.flush_transcripts_now();
        assert!(!saver.transcripts_pending_write());
        assert_eq!(segments_on_disk(&dir), 12, "every segment must reach disk");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn terminal_flush_is_a_noop_when_nothing_is_pending() {
        let dir = temp_dir("noop");
        let saver = saver_in(&dir);
        saver.add_transcript_segment(seg(1));
        assert!(!saver.transcripts_pending_write());
        // Must not panic or corrupt the file.
        saver.flush_transcripts_now();
        assert_eq!(segments_on_disk(&dir), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn terminal_flush_without_a_meeting_folder_is_safe() {
        // Recording never got far enough to create a folder.
        let saver = RecordingSaver::new();
        saver.add_transcript_segment(seg(1));
        saver.flush_transcripts_now();
    }
}
