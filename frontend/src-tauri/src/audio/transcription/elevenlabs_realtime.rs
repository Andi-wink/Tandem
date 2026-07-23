// audio/transcription/elevenlabs_realtime.rs
//
// ElevenLabs Scribe v2 **Realtime** WebSocket transcription session engine
// (Phase 2 of research/scribe-realtime-ws-plan.md; contract confirmed in
// research/scribe-realtime-spike-notes.md, which overrides the plan where they
// differ).
//
// One WS connection per audio stream (mic / system = DeviceType, mapping to the
// source labels "Local" / "Remote" exactly as worker.rs does). Audio of OPEN VAD
// speech segments is forwarded live as ~250ms PCM16 frames (+300ms pre-roll at
// segment open) by the pipeline tap; on VAD segment end the pipeline sends an
// explicit `commit`. During silence the per-connection task sends periodic
// silence keepalive frames because the server closes idle sockets ~15.7s after
// the last AUDIO frame (WS pings do NOT prevent it — spike caveat C1).
//
// This module is deliberately free of Tauri types: the receive loop emits
// `RealtimeEvent`s onto an mpsc channel, and a small bridge task (spawned where an
// AppHandle is available, in recording_commands.rs) maps them to the Tauri events
// `transcript-partial` / `transcript-update` / `transcription-warning`. That keeps
// the whole session unit-testable without a Tauri runtime or a network.
//
// PRIVACY: the API key is held in-memory only and never logged. Transcript text is
// only ever logged at `debug!` level (matching worker.rs), never at info/warn.

use crate::audio::recording_state::DeviceType;
use async_trait::async_trait;
use base64::Engine;
use log::{debug, info, warn};
use serde::Deserialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::sync::Notify;

// ============================================================================
// CONSTANTS (empirically grounded in the Phase 0 spike)
// ============================================================================

/// WS endpoint (spike-confirmed working). Regional variants exist; unused.
pub const WS_BASE_URL: &str = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

/// The settings model id that selects this engine.
pub const REALTIME_MODEL_ID: &str = "scribe_v2_realtime";

/// Sample rate of the frames we feed (worker/VAD format; spike-tested at 4.24% WER).
pub const FEED_SAMPLE_RATE: u32 = 16_000;

/// Frame size fed to the socket: 250ms @ 16kHz. Spike scenario (a) used 250ms
/// frames — ~1 partial/s cadence, 0.44s commit latency. Phase 3 may retune.
pub const FRAME_SAMPLES: usize = 4_000;

/// Pre-roll prepended at speech onset: 300ms @ 16kHz (plan D2). Approximates
/// silero's 300ms pre_speech_pad so the server sees the word onset.
pub const PREROLL_SAMPLES: usize = 4_800;

/// Send a silence keepalive if no audio has been fed for this long. Chosen well
/// under the server's ~15.7s idle-close (spike C1) with margin for scheduling.
pub const KEEPALIVE_IDLE_SECS: f64 = 10.0;

/// Length of each silence keepalive frame (250ms @ 16kHz of zeros). Billed as
/// audio-seconds but a few frames per idle gap is negligible (spike §4/D-dev-1).
pub const KEEPALIVE_SILENCE_SAMPLES: usize = 4_000;

/// Consecutive failed (re)connects after which the stream degrades permanently
/// to the batch path for the rest of the recording (plan D5).
pub const MAX_RECONNECTS: u32 = 5;

/// Reconnect backoff ladder in ms: 1s / 3s / 8s, capped at 30s (plan D5).
pub const BACKOFF_SCHEDULE_MS: [u64; 4] = [1_000, 3_000, 8_000, 30_000];

/// Bounded feed-ring capacity per stream (drop-oldest on overflow). ~64 * 250ms
/// = 16s of queued audio before shedding; the recording file is the source of
/// truth so a shed frame only degrades the live tail, never the saved audio.
pub const FEED_RING_CAP: usize = 64;

// ============================================================================
// ROUTING — what the pipeline does with a stream's audio right now
// ============================================================================

/// How the pipeline should route a stream's VAD audio at this instant.
///
/// `Realtime`: socket is connected — tap live frames, bypass batch accumulation.
/// `Batch`: socket is (temporarily) disconnected or permanently degraded — route
/// VAD segments through the existing batch accumulation + HTTP provider path so
/// no words are lost (plan D5).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    Realtime,
    Batch,
}

// Route encoded in an AtomicU8 on each StreamHandle.
const ROUTE_REALTIME: u8 = 0;
const ROUTE_BATCH: u8 = 1;

fn route_from_u8(v: u8) -> Route {
    match v {
        ROUTE_REALTIME => Route::Realtime,
        _ => Route::Batch,
    }
}

/// Pure routing decision (unit-tested): only a live, non-degraded connection
/// streams; everything else falls back to batch.
pub fn route_for_state(connected: bool, degraded: bool) -> Route {
    if connected && !degraded {
        Route::Realtime
    } else {
        Route::Batch
    }
}

/// Whether the pipeline must re-mark the segment onset because a socket just
/// (re)connected while the stream's VAD segment is ALREADY open (MAJOR-2a).
///
/// On a normal onset the pipeline detects `!was_in_speech && now_in_speech` and
/// marks the anchor itself. But when the route flips Batch -> Realtime mid-speech
/// there is no `was->now` edge, so without this the resumed stream would commit
/// with a stale/absent anchor. The re-fed audio starts "now", so the current
/// recording clock is the correct anchor.
///
/// `prev`/`cur` are the stream's realtime route on the previous / current window
/// (None = no realtime session). Returns true only on a Batch->Realtime flip
/// while speech is open.
pub fn should_remark_onset_on_resume(
    prev: Option<Route>,
    cur: Option<Route>,
    in_speech: bool,
) -> bool {
    cur == Some(Route::Realtime) && prev != Some(Route::Realtime) && in_speech
}

/// Whether the pipeline must flush the shadow batch buffer because the route just
/// flipped Realtime -> Batch (disconnect/degrade), draining the uncommitted
/// audio through the batch machinery so no words are lost (MAJOR-1).
pub fn is_realtime_to_batch_flip(prev: Option<Route>, cur: Option<Route>) -> bool {
    prev == Some(Route::Realtime) && cur == Some(Route::Batch)
}

/// Whether recording-stop's `flush_remaining_audio` should push a stream's batch
/// buffer to the batch worker (MAJOR-R1).
///
/// For a stream still on the Realtime route the batch buffer is the SHADOW
/// (holding the current uncommitted open segment); the realtime session's
/// `close_all` sends the final `commit`, which is the SOLE transcription of the
/// closing segment. Flushing here too would double-transcribe that tail with a
/// distinct sequence_id (frontend dedup cannot catch it). So skip Realtime
/// streams; Batch/degraded (and no-session) streams still flush normally.
///
/// Accepted race: if `close_all`'s final commit then fails/times out within its
/// grace window, that closing tail is lost — the same commit-sent-vs-received
/// race already accepted for MAJOR-1.
pub fn should_batch_flush_on_stop(route: Option<Route>) -> bool {
    route != Some(Route::Realtime)
}

// ============================================================================
// MODEL SELECTION
// ============================================================================

/// True when the configured provider+model select the realtime engine.
/// (provider stored as "elevenLabs"; compared case-insensitively.)
pub fn is_realtime_model(provider: &str, model: &str) -> bool {
    provider.trim().eq_ignore_ascii_case("elevenlabs")
        && model.trim().eq_ignore_ascii_case(REALTIME_MODEL_ID)
}

/// Map a DeviceType to the transcript source label used everywhere downstream.
pub fn source_label(device_type: &DeviceType) -> &'static str {
    match device_type {
        DeviceType::Microphone => "Local",
        DeviceType::System => "Remote",
    }
}

// ============================================================================
// EVENTS EMITTED TO THE TAURI BRIDGE
// ============================================================================

/// A single timed token from `committed_transcript_with_timestamps`.
#[derive(Debug, Clone, Deserialize)]
pub struct WordTiming {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub start: Option<f64>,
    #[serde(default)]
    pub end: Option<f64>,
    #[serde(default, rename = "type")]
    pub word_type: Option<String>,
}

/// Events the session emits; the bridge maps these to Tauri events.
#[derive(Debug, Clone)]
pub enum RealtimeEvent {
    /// -> Tauri `transcript-partial` { source, text, session_seq }
    Partial {
        source: String,
        text: String,
        session_seq: u64,
    },
    /// -> Tauri `transcript-update` (TranscriptUpdate) with a fresh sequence_id
    /// from the shared worker counter and recording-relative timings.
    Committed {
        source: String,
        text: String,
        audio_start_time: f64,
        audio_end_time: f64,
        duration: f64,
    },
    /// -> Tauri `transcription-warning`, emitted once on permanent degrade.
    Warning { message: String },
}

// ============================================================================
// FRAME ENCODING (pure, unit-tested)
// ============================================================================

/// f32 [-1,1] mono -> little-endian PCM16 bytes (clamped).
pub fn f32_to_pcm16_bytes(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        let clamped = s.clamp(-1.0, 1.0);
        let pcm = (clamped * 32767.0) as i16;
        out.extend_from_slice(&pcm.to_le_bytes());
    }
    out
}

/// Decode PCM16 LE bytes back to f32 (test helper / symmetry with the encoder).
pub fn pcm16_bytes_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32767.0)
        .collect()
}

/// Build the `input_audio_chunk` JSON message (spike D-dev-3 field names).
pub fn encode_audio_chunk_message(samples: &[f32], sample_rate: u32, commit: bool) -> String {
    let bytes = f32_to_pcm16_bytes(samples);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    serde_json::json!({
        "message_type": "input_audio_chunk",
        "audio_base_64": b64,
        "sample_rate": sample_rate,
        "commit": commit,
    })
    .to_string()
}

// ============================================================================
// FRAME SLICER — accumulate variable feeds into fixed 250ms frames (pure)
// ============================================================================

/// Accumulates fed samples and yields fixed-size frames. Any tail shorter than
/// `frame_samples` is held until more audio arrives or `drain()` is called.
pub struct FrameSlicer {
    buf: Vec<f32>,
    frame_samples: usize,
}

impl FrameSlicer {
    pub fn new(frame_samples: usize) -> Self {
        Self {
            buf: Vec::with_capacity(frame_samples * 2),
            frame_samples,
        }
    }

    /// Append samples and return every complete frame now available.
    pub fn push(&mut self, samples: &[f32]) -> Vec<Vec<f32>> {
        self.buf.extend_from_slice(samples);
        let mut frames = Vec::new();
        while self.buf.len() >= self.frame_samples {
            let frame: Vec<f32> = self.buf.drain(..self.frame_samples).collect();
            frames.push(frame);
        }
        frames
    }

    /// Take whatever partial frame remains (may be empty), clearing the buffer.
    pub fn drain(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.buf)
    }

    pub fn pending(&self) -> usize {
        self.buf.len()
    }
}

// ============================================================================
// PRE-ROLL RING — last N samples of pre-speech audio (pure, unit-tested)
// ============================================================================

/// Fixed-capacity ring holding the most recent `cap` samples. The pipeline fills
/// it during silence; at speech onset it is drained as the pre-roll lead-in.
pub struct PrerollRing {
    buf: VecDeque<f32>,
    cap: usize,
}

impl PrerollRing {
    pub fn new(cap: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(cap),
            cap,
        }
    }

    pub fn push(&mut self, samples: &[f32]) {
        for &s in samples {
            if self.buf.len() == self.cap {
                self.buf.pop_front();
            }
            self.buf.push_back(s);
        }
    }

    /// Drain the ring, returning up to `cap` most-recent samples in order.
    pub fn take(&mut self) -> Vec<f32> {
        self.buf.drain(..).collect()
    }

    pub fn clear(&mut self) {
        self.buf.clear();
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}

// ============================================================================
// RECONNECT LADDER (pure state machine, unit-tested)
// ============================================================================

/// Tracks consecutive (re)connect failures and yields the backoff schedule.
#[derive(Debug, Default)]
pub struct BackoffLadder {
    failures: u32,
}

impl BackoffLadder {
    pub fn new() -> Self {
        Self { failures: 0 }
    }

    /// Delay for the Nth consecutive failure (0-based): 1s, 3s, 8s, then 30s cap.
    pub fn delay_for(failure_index: u32) -> Duration {
        let idx = (failure_index as usize).min(BACKOFF_SCHEDULE_MS.len() - 1);
        Duration::from_millis(BACKOFF_SCHEDULE_MS[idx])
    }

    /// Record a failure and return how long to wait before the next attempt.
    pub fn record_failure(&mut self) -> Duration {
        let d = Self::delay_for(self.failures);
        self.failures += 1;
        d
    }

    /// Reset on a successful connect.
    pub fn reset(&mut self) {
        self.failures = 0;
    }

    /// Whether we have hit the permanent-degrade threshold.
    pub fn should_degrade(&self) -> bool {
        self.failures >= MAX_RECONNECTS
    }

    pub fn failures(&self) -> u32 {
        self.failures
    }
}

// ============================================================================
// KEEPALIVE SCHEDULING (pure, unit-tested)
// ============================================================================

/// Whether a silence keepalive is due given seconds since the last audio frame.
pub fn keepalive_due(secs_since_last_audio: f64) -> bool {
    secs_since_last_audio >= KEEPALIVE_IDLE_SECS
}

// ============================================================================
// TIMELINE MAPPER (pure, unit-tested)
// ============================================================================

/// Maps a committed segment's server word timings onto the recording timeline.
///
/// The absolute position is anchored to the recording clock captured at segment
/// onset (the recording-relative time of the first fed sample, i.e. pre-roll
/// start). The intra-segment duration is taken from the word span
/// (`last.end - first.start`), which is independent of whether the server's word
/// timestamps are session-cumulative or reset per commit — sidestepping that
/// unconfirmed detail (spike open item).
///
/// PRECISION LIMITS: the anchor is captured one VAD window (~600ms) after true
/// onset at worst, and the pre-roll (300ms) shifts the start slightly earlier
/// than the first spoken word. Good enough for playback sync; Phase 3 measures
/// the residual and can tighten this once the server's timestamp origin is
/// confirmed.
#[derive(Debug, Default)]
pub struct TimelineMapper {
    anchor_recording_secs: Option<f64>,
    /// End (recording-relative secs) of the last mapped commit — used as a
    /// monotonic fallback so a commit that arrives with no fresh onset anchor is
    /// NEVER placed at 0.0 (which would corrupt the meeting store's
    /// audio_start_time ASC ordering). See MAJOR-2.
    last_commit_end_secs: f64,
}

impl TimelineMapper {
    pub fn new() -> Self {
        Self {
            anchor_recording_secs: None,
            last_commit_end_secs: 0.0,
        }
    }

    /// Record the recording-relative time of the first fed sample of a segment.
    /// Called at speech onset AND on a mid-open-segment reconnect (the re-fed
    /// audio starts "now", so that is the correct anchor — MAJOR-2a).
    pub fn mark_onset(&mut self, recording_secs: f64) {
        self.anchor_recording_secs = Some(recording_secs.max(0.0));
    }

    /// Compute (start, end, duration) in recording-relative seconds for a commit.
    /// Uses the onset anchor when present (the normal path); otherwise continues
    /// monotonically from the previous commit's end so the absolute position is
    /// never 0.0 once any commit has occurred. The anchor is consumed each commit
    /// so a stale one can't be reused, and `last_commit_end` advances so ordering
    /// stays monotonic across reconnects.
    pub fn map_commit(&mut self, words: &[WordTiming]) -> (f64, f64, f64) {
        let span = word_span_secs(words);
        let start = self
            .anchor_recording_secs
            .take()
            .unwrap_or(self.last_commit_end_secs);
        let end = start + span;
        self.last_commit_end_secs = end;
        (start, end, span)
    }
}

/// Duration in seconds spanned by the timed word tokens (spacing/None skipped).
pub fn word_span_secs(words: &[WordTiming]) -> f64 {
    let mut first: Option<f64> = None;
    let mut last: Option<f64> = None;
    for w in words {
        if w.word_type.as_deref() == Some("spacing") {
            continue;
        }
        if let Some(s) = w.start {
            if first.is_none() {
                first = Some(s);
            }
        }
        if let Some(e) = w.end {
            last = Some(e);
        } else if let Some(s) = w.start {
            last = Some(s);
        }
    }
    match (first, last) {
        (Some(f), Some(l)) if l >= f => l - f,
        _ => 0.0,
    }
}

// ============================================================================
// SERVER MESSAGE PARSING (pure, unit-tested)
// ============================================================================

/// Parsed server -> client message. Only the variants the session acts on.
#[derive(Debug, Clone, PartialEq)]
pub enum ServerMsg {
    SessionStarted,
    Partial { text: String },
    /// From `committed_transcript_with_timestamps` — the ONLY commit event we
    /// persist (plain `committed_transcript` is ignored to avoid double-emit).
    Committed { text: String, words: Vec<WordTiming> },
    /// Plain `committed_transcript` — deliberately ignored.
    CommittedPlain,
    /// Any error event. `fatal` marks auth/quota/terms failures that degrade the
    /// session permanently rather than triggering a reconnect.
    Error { kind: String, fatal: bool },
    Other,
}

impl PartialEq for WordTiming {
    fn eq(&self, other: &Self) -> bool {
        self.text == other.text
            && self.start == other.start
            && self.end == other.end
            && self.word_type == other.word_type
    }
}

/// Error kinds that must degrade the session permanently (no point retrying).
fn is_fatal_error_kind(kind: &str) -> bool {
    matches!(
        kind,
        "auth_error"
            | "quota_exceeded"
            | "unaccepted_terms"
            | "resource_exhausted"
            | "session_time_limit_exceeded"
    )
}

/// Parse a raw server text frame. The discriminator field name is unconfirmed by
/// the spike, so both `message_type` and `type` are accepted. Unknown shapes map
/// to `Other` and are ignored.
pub fn parse_server_message(raw: &str) -> ServerMsg {
    let val: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return ServerMsg::Other,
    };

    let kind = val
        .get("message_type")
        .and_then(|v| v.as_str())
        .or_else(|| val.get("type").and_then(|v| v.as_str()))
        .unwrap_or("");

    match kind {
        "session_started" => ServerMsg::SessionStarted,
        "partial_transcript" => ServerMsg::Partial {
            text: val
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        },
        "committed_transcript_with_timestamps" => {
            let text = val
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let words: Vec<WordTiming> = val
                .get("words")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            ServerMsg::Committed { text, words }
        }
        "committed_transcript" => ServerMsg::CommittedPlain,
        "error" => {
            // message_type == "error" with a nested error kind.
            let inner = val
                .get("error")
                .and_then(|v| v.as_str())
                .or_else(|| val.get("error_type").and_then(|v| v.as_str()))
                .unwrap_or("error")
                .to_string();
            let fatal = is_fatal_error_kind(&inner);
            ServerMsg::Error { kind: inner, fatal }
        }
        other if other.ends_with("_error") || is_fatal_error_kind(other) => ServerMsg::Error {
            kind: other.to_string(),
            fatal: is_fatal_error_kind(other),
        },
        // Also treat a bare top-level "error" field as an error message.
        _ => {
            if let Some(e) = val.get("error").and_then(|v| v.as_str()) {
                let fatal = is_fatal_error_kind(e);
                ServerMsg::Error {
                    kind: e.to_string(),
                    fatal,
                }
            } else {
                ServerMsg::Other
            }
        }
    }
}

// ============================================================================
// TRANSPORT ABSTRACTION (stubbable for tests)
// ============================================================================

/// A connected duplex text-message transport. Sending a `String` transmits one
/// WS text frame; the `incoming` receiver yields server text frames. Either end
/// closing signals a disconnect.
pub struct TransportPair {
    pub outgoing: mpsc::Sender<String>,
    pub incoming: mpsc::Receiver<String>,
}

/// Abstracts the WebSocket so the reconnect ladder / receive loop can be tested
/// with an in-memory stub (no network). The real impl wraps tokio-tungstenite.
#[async_trait]
pub trait RealtimeTransport: Send + Sync + 'static {
    async fn connect(&self, url: &str, api_key: &str) -> Result<TransportPair, String>;
}

/// Production transport over tokio-tungstenite (native-tls).
pub struct TungsteniteTransport;

#[async_trait]
impl RealtimeTransport for TungsteniteTransport {
    async fn connect(&self, url: &str, api_key: &str) -> Result<TransportPair, String> {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        use tokio_tungstenite::tungstenite::http::HeaderValue;
        use tokio_tungstenite::tungstenite::Message;

        let mut request = url
            .into_client_request()
            .map_err(|e| format!("bad WS request: {}", e))?;
        request.headers_mut().insert(
            "xi-api-key",
            HeaderValue::from_str(api_key).map_err(|_| "invalid api key header".to_string())?,
        );

        let (ws_stream, _resp) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|e| format!("WS connect failed: {}", e))?;
        let (mut sink, mut stream) = ws_stream.split();

        // Outgoing pump: channel Strings -> WS text frames.
        let (out_tx, mut out_rx) = mpsc::channel::<String>(FEED_RING_CAP);
        tokio::spawn(async move {
            while let Some(text) = out_rx.recv().await {
                if sink.send(Message::Text(text)).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });

        // Incoming pump: WS text frames -> channel Strings. Close/err ends it.
        let (in_tx, in_rx) = mpsc::channel::<String>(FEED_RING_CAP);
        tokio::spawn(async move {
            while let Some(msg) = stream.next().await {
                match msg {
                    Ok(Message::Text(t)) => {
                        if in_tx.send(t).await.is_err() {
                            break;
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {} // ignore binary/ping/pong
                }
            }
            // Dropping in_tx closes the incoming channel -> session sees disconnect.
        });

        Ok(TransportPair {
            outgoing: out_tx,
            incoming: in_rx,
        })
    }
}

// ============================================================================
// FEED COMMANDS + BOUNDED DROP-OLDEST RING
// ============================================================================

/// Commands the pipeline pushes to a stream's connection task (ordering matters:
/// Onset precedes the Audio it anchors, which precedes its Commit).
#[derive(Debug, Clone)]
enum FeedCmd {
    /// Recording-relative seconds of the first fed sample of a new segment.
    Onset(f64),
    /// Speech audio (16kHz f32), sliced into 250ms frames by the task.
    Audio(Vec<f32>),
    /// End of a VAD segment: flush the partial frame and send an explicit commit.
    Commit,
    /// Shut the connection down.
    Close,
}

/// Bounded ring with drop-OLDEST overflow (plan backpressure rule). `push` never
/// blocks (safe from the audio thread); `recv` awaits new items.
struct FeedRing {
    q: Mutex<VecDeque<FeedCmd>>,
    notify: Notify,
    cap: usize,
    dropped: AtomicU64,
}

impl FeedRing {
    fn new(cap: usize) -> Self {
        Self {
            q: Mutex::new(VecDeque::with_capacity(cap)),
            notify: Notify::new(),
            cap,
            dropped: AtomicU64::new(0),
        }
    }

    /// Non-blocking push. On overflow, evicts the oldest queued command. Close
    /// and Onset/Commit control messages are never evicted (only Audio is), so
    /// commit/onset ordering survives shedding.
    fn push(&self, cmd: FeedCmd) {
        // Poison-tolerant: a panicked holder must not wedge the audio-thread feed.
        let mut q = self.q.lock().unwrap_or_else(|e| e.into_inner());
        if q.len() >= self.cap {
            // Evict the oldest Audio command; if none, evict the front.
            if let Some(pos) = q.iter().position(|c| matches!(c, FeedCmd::Audio(_))) {
                q.remove(pos);
            } else {
                q.pop_front();
            }
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
        q.push_back(cmd);
        drop(q);
        self.notify.notify_one();
    }

    async fn recv(&self) -> FeedCmd {
        loop {
            let notified = self.notify.notified();
            if let Some(cmd) = self.q.lock().unwrap_or_else(|e| e.into_inner()).pop_front() {
                return cmd;
            }
            notified.await;
        }
    }

    fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

// ============================================================================
// PER-STREAM HANDLE
// ============================================================================

struct StreamHandle {
    ring: Arc<FeedRing>,
    route: Arc<AtomicU8>,
    join: tokio::task::JoinHandle<()>,
}

// ============================================================================
// THE SESSION
// ============================================================================

/// Manages the realtime WS connections for a recording (one per active stream).
///
/// Lifecycle: create with [`ElevenLabsRealtimeSession::start`] at recording
/// start; the pipeline calls [`feed`](Self::feed) / [`commit`](Self::commit) /
/// [`mark_onset`](Self::mark_onset) on the audio path and reads
/// [`route`](Self::route) each window; [`close_all`](Self::close_all) on stop.
pub struct ElevenLabsRealtimeSession {
    mic: StreamHandle,
    system: StreamHandle,
    /// Emitted once, guards the single permanent-degrade warning.
    warned: Arc<AtomicBool>,
}

impl ElevenLabsRealtimeSession {
    /// Build the config query string for a session (manual commit + timestamps).
    pub fn build_url(api_language_code: Option<&str>) -> String {
        let mut url = format!(
            "{}?model_id={}&audio_format=pcm_16000&commit_strategy=manual&include_timestamps=true&include_language_detection=true",
            WS_BASE_URL, REALTIME_MODEL_ID
        );
        if let Some(code) = api_language_code {
            if !code.is_empty() {
                url.push_str("&language_code=");
                url.push_str(code);
            }
        }
        url
    }

    /// Start a session with the production transport.
    pub fn start(
        api_key: String,
        language_code: Option<String>,
        event_tx: mpsc::UnboundedSender<RealtimeEvent>,
    ) -> Arc<Self> {
        Self::start_with_transport(
            Arc::new(TungsteniteTransport),
            api_key,
            language_code,
            event_tx,
        )
    }

    /// Start a session with an injected transport (tests use an in-memory stub).
    pub fn start_with_transport(
        transport: Arc<dyn RealtimeTransport>,
        api_key: String,
        language_code: Option<String>,
        event_tx: mpsc::UnboundedSender<RealtimeEvent>,
    ) -> Arc<Self> {
        let warned = Arc::new(AtomicBool::new(false));
        let url = Self::build_url(language_code.as_deref());

        let mic = Self::spawn_stream(
            transport.clone(),
            url.clone(),
            api_key.clone(),
            DeviceType::Microphone,
            event_tx.clone(),
            warned.clone(),
        );
        let system = Self::spawn_stream(
            transport,
            url,
            api_key,
            DeviceType::System,
            event_tx,
            warned.clone(),
        );

        Arc::new(Self {
            mic,
            system,
            warned,
        })
    }

    fn spawn_stream(
        transport: Arc<dyn RealtimeTransport>,
        url: String,
        api_key: String,
        device_type: DeviceType,
        event_tx: mpsc::UnboundedSender<RealtimeEvent>,
        warned: Arc<AtomicBool>,
    ) -> StreamHandle {
        let ring = Arc::new(FeedRing::new(FEED_RING_CAP));
        // Start in Batch until the socket is up, so early audio isn't lost.
        let route = Arc::new(AtomicU8::new(ROUTE_BATCH));
        // Per-source monotonic partial sequence counter (owned by the task).
        let session_seq = Arc::new(AtomicU64::new(0));

        let task_ring = ring.clone();
        let task_route = route.clone();
        let join = tokio::spawn(async move {
            run_stream(
                transport,
                url,
                api_key,
                device_type,
                task_ring,
                task_route,
                session_seq,
                event_tx,
                warned,
            )
            .await;
        });

        StreamHandle { ring, route, join }
    }

    fn handle(&self, device_type: &DeviceType) -> &StreamHandle {
        match device_type {
            DeviceType::Microphone => &self.mic,
            DeviceType::System => &self.system,
        }
    }

    /// Current route for a stream (read by the pipeline every window). Non-blocking.
    pub fn route(&self, device_type: &DeviceType) -> Route {
        route_from_u8(self.handle(device_type).route.load(Ordering::Relaxed))
    }

    /// Mark the recording-relative onset time of a new segment (call before the
    /// first `feed` of that segment). Non-blocking.
    pub fn mark_onset(&self, device_type: &DeviceType, recording_secs: f64) {
        self.handle(device_type)
            .ring
            .push(FeedCmd::Onset(recording_secs));
    }

    /// Feed speech audio (16kHz mono f32) for a stream. Non-blocking (drop-oldest
    /// on overflow); safe to call from the audio pipeline thread.
    pub fn feed(&self, device_type: &DeviceType, samples: &[f32]) {
        if samples.is_empty() {
            return;
        }
        self.handle(device_type)
            .ring
            .push(FeedCmd::Audio(samples.to_vec()));
    }

    /// Signal a VAD segment end for a stream (flush partial + explicit commit).
    pub fn commit(&self, device_type: &DeviceType) {
        self.handle(device_type).ring.push(FeedCmd::Commit);
    }

    /// Number of audio frames shed under backpressure (diagnostics/tests).
    pub fn dropped_frames(&self, device_type: &DeviceType) -> u64 {
        self.handle(device_type).ring.dropped()
    }

    /// Whether the permanent-degrade warning has fired (tests/diagnostics).
    pub fn has_warned(&self) -> bool {
        self.warned.load(Ordering::Relaxed)
    }

    /// Close both connections. Sends a final `commit` first so an open segment at
    /// recording stop is still transcribed, allows a brief window for the
    /// committed response to round-trip and persist, then shuts the sockets down.
    pub async fn close_all(self: Arc<Self>) {
        self.mic.ring.push(FeedCmd::Commit);
        self.system.ring.push(FeedCmd::Commit);
        // 2s grace: enough for a slow-network final commit round-trip, still bounded.
        tokio::time::sleep(Duration::from_millis(2000)).await;
        self.mic.ring.push(FeedCmd::Close);
        self.system.ring.push(FeedCmd::Close);
        tokio::time::sleep(Duration::from_millis(50)).await;
        // We can't move the JoinHandles out of an Arc, so abort any that ignored
        // Close (e.g. mid-backoff). The tasks are cancellation-safe.
        self.mic.join.abort();
        self.system.join.abort();
    }
}

// ============================================================================
// PER-STREAM CONNECTION TASK (reconnect ladder + duplex loop)
// ============================================================================

#[allow(clippy::too_many_arguments)]
async fn run_stream(
    transport: Arc<dyn RealtimeTransport>,
    url: String,
    api_key: String,
    device_type: DeviceType,
    ring: Arc<FeedRing>,
    route: Arc<AtomicU8>,
    session_seq: Arc<AtomicU64>,
    event_tx: mpsc::UnboundedSender<RealtimeEvent>,
    warned: Arc<AtomicBool>,
) {
    let source = source_label(&device_type).to_string();
    let mut ladder = BackoffLadder::new();
    // Timeline mapper persists ACROSS reconnects so `last_commit_end` (the
    // monotonic anchor fallback, MAJOR-2b) and ordering survive a socket rotation.
    let mut mapper = TimelineMapper::new();

    loop {
        match transport.connect(&url, &api_key).await {
            Ok(pair) => {
                ladder.reset();
                route.store(ROUTE_REALTIME, Ordering::Relaxed);
                info!("🎧 Realtime [{}] connected", source);

                let outcome =
                    duplex_loop(pair, &ring, &session_seq, &event_tx, &source, &mut mapper).await;

                // Left the duplex loop: connection down (or asked to close).
                route.store(ROUTE_BATCH, Ordering::Relaxed);

                match outcome {
                    DuplexOutcome::Closed => {
                        info!("🎧 Realtime [{}] closed by request", source);
                        return;
                    }
                    DuplexOutcome::FatalError(kind) => {
                        degrade_permanently(&kind, &source, &route, &warned, &event_tx, &session_seq);
                        return;
                    }
                    DuplexOutcome::Disconnected => {
                        warn!("🎧 Realtime [{}] disconnected — will reconnect", source);
                        // Route flipped to Batch: clear the frozen volatile tail on
                        // the frontend by emitting an empty partial (MINOR-3).
                        emit_tail_clear(&event_tx, &source, &session_seq);
                        // fall through to backoff below
                    }
                }
            }
            Err(e) => {
                route.store(ROUTE_BATCH, Ordering::Relaxed);
                warn!("🎧 Realtime [{}] connect error: {}", source, e);
            }
        }

        // Reconnect ladder.
        let delay = ladder.record_failure();
        if ladder.should_degrade() {
            degrade_permanently(
                "reconnect_exhausted",
                &source,
                &route,
                &warned,
                &event_tx,
                &session_seq,
            );
            return;
        }
        // Wait the backoff, but bail early if asked to close.
        if wait_or_close(&ring, delay).await {
            info!("🎧 Realtime [{}] close during backoff", source);
            return;
        }
    }
}

/// Emit an empty-text partial so the frontend drops the (now frozen) volatile
/// tail for this source when the stream leaves the Realtime route (MINOR-3).
fn emit_tail_clear(
    event_tx: &mpsc::UnboundedSender<RealtimeEvent>,
    source: &str,
    session_seq: &Arc<AtomicU64>,
) {
    let seq = session_seq.fetch_add(1, Ordering::SeqCst);
    let _ = event_tx.send(RealtimeEvent::Partial {
        source: source.to_string(),
        text: String::new(),
        session_seq: seq,
    });
}

fn degrade_permanently(
    kind: &str,
    source: &str,
    route: &Arc<AtomicU8>,
    warned: &Arc<AtomicBool>,
    event_tx: &mpsc::UnboundedSender<RealtimeEvent>,
    session_seq: &Arc<AtomicU64>,
) {
    route.store(ROUTE_BATCH, Ordering::Relaxed);
    warn!(
        "🎧 Realtime [{}] degraded permanently ({}) — continuing on batch path",
        source, kind
    );
    // Clear the frozen volatile tail for this source (MINOR-3).
    emit_tail_clear(event_tx, source, session_seq);
    // Emit the single session-wide warning at most once across both streams.
    if !warned.swap(true, Ordering::SeqCst) {
        let _ = event_tx.send(RealtimeEvent::Warning {
            message:
                "Live transcription degraded; the transcript continues with a higher delay."
                    .to_string(),
        });
    }
}

/// Drain the ring during a backoff wait; returns true if a Close was seen.
async fn wait_or_close(ring: &Arc<FeedRing>, delay: Duration) -> bool {
    let sleep = tokio::time::sleep(delay);
    tokio::pin!(sleep);
    loop {
        tokio::select! {
            _ = &mut sleep => return false,
            cmd = ring.recv() => {
                if matches!(cmd, FeedCmd::Close) {
                    return true;
                }
                // Discard audio/onset/commit while disconnected — the pipeline is
                // routing this stream through the batch path (route == Batch).
            }
        }
    }
}

enum DuplexOutcome {
    Closed,
    Disconnected,
    FatalError(String),
}

/// The connected duplex loop: pump feed commands out, parse incoming events in,
/// and send silence keepalives during idle gaps.
async fn duplex_loop(
    mut pair: TransportPair,
    ring: &Arc<FeedRing>,
    session_seq: &Arc<AtomicU64>,
    event_tx: &mpsc::UnboundedSender<RealtimeEvent>,
    source: &str,
    mapper: &mut TimelineMapper,
) -> DuplexOutcome {
    let mut slicer = FrameSlicer::new(FRAME_SAMPLES);
    let mut last_audio = tokio::time::Instant::now();
    // Whether a SPEECH audio frame has actually been SENT on the socket since the
    // last commit frame was sent. Gates every commit so a back-to-back commit with
    // no audio in between is never sent — the server answers that with
    // `commit_throttled` and can DROP the previously committed event (Phase 3 live
    // bug: spiked a run to 18.3% WER / 150 deletions). Set only on a real send
    // (not on enqueue), so a frame evicted from the FeedRing under backpressure
    // can never leave this flag stale. Keepalive silence deliberately does NOT set
    // it (it is liveness, not uncommitted speech). Local to the connection so it
    // resets cleanly on reconnect.
    let mut sent_audio_since_commit = false;
    let keepalive_period = Duration::from_secs_f64(KEEPALIVE_IDLE_SECS / 2.0);
    let mut ka_tick = tokio::time::interval(keepalive_period);
    ka_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            cmd = ring.recv() => {
                match cmd {
                    FeedCmd::Close => return DuplexOutcome::Closed,
                    FeedCmd::Onset(recording_secs) => {
                        mapper.mark_onset(recording_secs);
                    }
                    FeedCmd::Audio(samples) => {
                        for frame in slicer.push(&samples) {
                            let msg = encode_audio_chunk_message(&frame, FEED_SAMPLE_RATE, false);
                            if pair.outgoing.send(msg).await.is_err() {
                                return DuplexOutcome::Disconnected;
                            }
                            sent_audio_since_commit = true;
                            last_audio = tokio::time::Instant::now();
                        }
                    }
                    FeedCmd::Commit => {
                        // Flush any partial frame first (counts as fed audio).
                        let tail = slicer.drain();
                        if !tail.is_empty() {
                            let msg = encode_audio_chunk_message(&tail, FEED_SAMPLE_RATE, false);
                            if pair.outgoing.send(msg).await.is_err() {
                                return DuplexOutcome::Disconnected;
                            }
                            sent_audio_since_commit = true;
                            last_audio = tokio::time::Instant::now();
                        }
                        // Only send the commit if audio was fed since the last one.
                        // close_all enqueues a Commit unconditionally at stop; when
                        // the last segment already committed at its end (recording
                        // stopped during silence) this skips the redundant second
                        // commit that would otherwise throttle-drop the last event.
                        if sent_audio_since_commit {
                            let commit_msg =
                                encode_audio_chunk_message(&[], FEED_SAMPLE_RATE, true);
                            if pair.outgoing.send(commit_msg).await.is_err() {
                                return DuplexOutcome::Disconnected;
                            }
                            sent_audio_since_commit = false;
                            last_audio = tokio::time::Instant::now();
                        }
                    }
                }
            }
            maybe_msg = pair.incoming.recv() => {
                match maybe_msg {
                    None => return DuplexOutcome::Disconnected,
                    Some(raw) => {
                        match parse_server_message(&raw) {
                            ServerMsg::Partial { text } => {
                                if !text.trim().is_empty() {
                                    let seq = session_seq.fetch_add(1, Ordering::SeqCst);
                                    let _ = event_tx.send(RealtimeEvent::Partial {
                                        source: source.to_string(),
                                        text,
                                        session_seq: seq,
                                    });
                                }
                            }
                            ServerMsg::Committed { text, words } => {
                                if !text.trim().is_empty() {
                                    let (start, end, dur) = mapper.map_commit(&words);
                                    debug!("🎧 Realtime [{}] committed: '{}'", source, text);
                                    let _ = event_tx.send(RealtimeEvent::Committed {
                                        source: source.to_string(),
                                        text,
                                        audio_start_time: start,
                                        audio_end_time: end,
                                        duration: dur,
                                    });
                                }
                            }
                            ServerMsg::Error { kind, fatal } => {
                                if fatal {
                                    return DuplexOutcome::FatalError(kind);
                                }
                                warn!("🎧 Realtime [{}] transient error event: {}", source, kind);
                            }
                            ServerMsg::CommittedPlain | ServerMsg::SessionStarted | ServerMsg::Other => {}
                        }
                    }
                }
            }
            _ = ka_tick.tick() => {
                if keepalive_due(last_audio.elapsed().as_secs_f64()) {
                    let silence = vec![0.0f32; KEEPALIVE_SILENCE_SAMPLES];
                    let msg = encode_audio_chunk_message(&silence, FEED_SAMPLE_RATE, false);
                    if pair.outgoing.send(msg).await.is_err() {
                        return DuplexOutcome::Disconnected;
                    }
                    last_audio = tokio::time::Instant::now();
                    debug!("🎧 Realtime [{}] silence keepalive", source);
                }
            }
        }
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ---- frame encoding roundtrip ----------------------------------------

    #[test]
    fn pcm16_roundtrip_is_near_lossless() {
        let samples = vec![0.0f32, 0.5, -0.5, 1.0, -1.0, 0.25, -0.25];
        let bytes = f32_to_pcm16_bytes(&samples);
        assert_eq!(bytes.len(), samples.len() * 2);
        let back = pcm16_bytes_to_f32(&bytes);
        for (a, b) in samples.iter().zip(back.iter()) {
            assert!((a - b).abs() < 1.0 / 32000.0, "{} vs {}", a, b);
        }
    }

    #[test]
    fn pcm16_clamps_out_of_range() {
        let bytes = f32_to_pcm16_bytes(&[1.5, -1.5]);
        assert_eq!(i16::from_le_bytes([bytes[0], bytes[1]]), 32767);
        assert_eq!(i16::from_le_bytes([bytes[2], bytes[3]]), -32767);
    }

    #[test]
    fn audio_chunk_message_has_expected_fields() {
        let msg = encode_audio_chunk_message(&[0.0, 0.0], 16000, true);
        let v: serde_json::Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(v["message_type"], "input_audio_chunk");
        assert_eq!(v["sample_rate"], 16000);
        assert_eq!(v["commit"], true);
        assert!(v["audio_base_64"].as_str().is_some());
        // base64 decodes back to 2 samples * 2 bytes.
        let b64 = v["audio_base_64"].as_str().unwrap();
        let decoded = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
        assert_eq!(decoded.len(), 4);
    }

    // ---- frame slicer -----------------------------------------------------

    #[test]
    fn frame_slicer_emits_fixed_frames_and_holds_tail() {
        let mut s = FrameSlicer::new(4000);
        // 4100 samples -> one 4000 frame, 100 held.
        let frames = s.push(&vec![0.1f32; 4100]);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].len(), 4000);
        assert_eq!(s.pending(), 100);
        // 3900 more -> total 4000 -> one more frame, 0 held.
        let frames2 = s.push(&vec![0.1f32; 3900]);
        assert_eq!(frames2.len(), 1);
        assert_eq!(s.pending(), 0);
        // drain of empty is empty.
        assert!(s.drain().is_empty());
    }

    #[test]
    fn frame_slicer_drain_returns_partial() {
        let mut s = FrameSlicer::new(4000);
        s.push(&vec![0.2f32; 1000]);
        let tail = s.drain();
        assert_eq!(tail.len(), 1000);
        assert_eq!(s.pending(), 0);
    }

    // ---- pre-roll ring ----------------------------------------------------

    #[test]
    fn preroll_ring_caps_length_and_keeps_most_recent() {
        let mut r = PrerollRing::new(4800);
        r.push(&vec![7.0f32; 3000]); // 3000 marker samples
        r.push(&(0..3000).map(|i| i as f32).collect::<Vec<_>>()); // then 0..2999
        assert_eq!(r.len(), 4800); // capped at 4800 (evicted oldest 1200)
        let out = r.take();
        assert_eq!(out.len(), 4800);
        // Most recent sample retained = 2999.
        assert_eq!(*out.last().unwrap(), 2999.0);
        // The retained window is the LAST 4800 pushed: 1800 markers then 0..2999.
        assert_eq!(out[0], 7.0); // oldest retained is still a marker
        assert_eq!(out[1799], 7.0); // last marker
        assert_eq!(out[1800], 0.0); // first sample of the second push
        assert!(r.is_empty());
    }

    #[test]
    fn preroll_ring_under_cap_returns_all() {
        let mut r = PrerollRing::new(4800);
        r.push(&vec![0.5f32; 1000]);
        assert_eq!(r.len(), 1000);
        assert_eq!(r.take().len(), 1000);
    }

    // ---- backoff ladder ---------------------------------------------------

    #[test]
    fn backoff_schedule_is_1_3_8_then_30_capped() {
        assert_eq!(BackoffLadder::delay_for(0), Duration::from_secs(1));
        assert_eq!(BackoffLadder::delay_for(1), Duration::from_secs(3));
        assert_eq!(BackoffLadder::delay_for(2), Duration::from_secs(8));
        assert_eq!(BackoffLadder::delay_for(3), Duration::from_secs(30));
        assert_eq!(BackoffLadder::delay_for(9), Duration::from_secs(30));
    }

    #[test]
    fn backoff_degrades_after_five_failures() {
        let mut l = BackoffLadder::new();
        for _ in 0..4 {
            l.record_failure();
        }
        assert!(!l.should_degrade(), "4 failures must not degrade");
        l.record_failure();
        assert!(l.should_degrade(), "5 failures must degrade");
        assert_eq!(l.failures(), 5);
        // Reset returns to healthy.
        l.reset();
        assert!(!l.should_degrade());
        assert_eq!(l.failures(), 0);
    }

    #[test]
    fn backoff_record_failure_returns_current_delay_then_advances() {
        let mut l = BackoffLadder::new();
        assert_eq!(l.record_failure(), Duration::from_secs(1)); // for failure #0
        assert_eq!(l.record_failure(), Duration::from_secs(3)); // for failure #1
        assert_eq!(l.record_failure(), Duration::from_secs(8)); // for failure #2
    }

    // ---- keepalive --------------------------------------------------------

    #[test]
    fn keepalive_due_at_threshold() {
        assert!(!keepalive_due(0.0));
        assert!(!keepalive_due(9.9));
        assert!(keepalive_due(10.0));
        assert!(keepalive_due(15.0));
    }

    // ---- routing decision -------------------------------------------------

    #[test]
    fn routing_only_streams_when_connected_and_healthy() {
        assert_eq!(route_for_state(true, false), Route::Realtime);
        assert_eq!(route_for_state(true, true), Route::Batch);
        assert_eq!(route_for_state(false, false), Route::Batch);
        assert_eq!(route_for_state(false, true), Route::Batch);
    }

    // ---- model selection --------------------------------------------------

    #[test]
    fn realtime_model_selection_is_case_insensitive() {
        assert!(is_realtime_model("elevenLabs", "scribe_v2_realtime"));
        assert!(is_realtime_model("elevenlabs", "SCRIBE_V2_REALTIME"));
        assert!(!is_realtime_model("elevenLabs", "scribe_v2"));
        assert!(!is_realtime_model("mistral", "scribe_v2_realtime"));
    }

    #[test]
    fn source_labels_match_worker_convention() {
        assert_eq!(source_label(&DeviceType::Microphone), "Local");
        assert_eq!(source_label(&DeviceType::System), "Remote");
    }

    // ---- timeline mapping -------------------------------------------------

    fn w(text: &str, start: f64, end: f64) -> WordTiming {
        WordTiming {
            text: text.to_string(),
            start: Some(start),
            end: Some(end),
            word_type: Some("word".to_string()),
        }
    }

    #[test]
    fn word_span_ignores_spacing_and_uses_first_to_last() {
        let words = vec![
            w("Hello", 0.5, 0.9),
            WordTiming {
                text: " ".into(),
                start: Some(0.9),
                end: Some(0.95),
                word_type: Some("spacing".into()),
            },
            w("world", 1.0, 1.6),
        ];
        assert!((word_span_secs(&words) - 1.1).abs() < 1e-9); // 1.6 - 0.5
    }

    #[test]
    fn timeline_maps_absolute_from_anchor_and_span_from_words() {
        let mut m = TimelineMapper::new();
        m.mark_onset(120.0); // recording-relative onset (pre-roll start)
        let words = vec![w("okay", 0.0, 0.34), w("then", 0.5, 0.9)];
        let (start, end, dur) = m.map_commit(&words);
        assert!((start - 120.0).abs() < 1e-9);
        assert!((dur - 0.9).abs() < 1e-9); // 0.9 - 0.0
        assert!((end - 120.9).abs() < 1e-9);
    }

    #[test]
    fn timeline_never_anchors_at_zero_uses_monotonic_fallback() {
        // MAJOR-2b: a commit with no fresh onset continues from the last commit
        // end, never 0.0 (which would corrupt audio_start_time ASC ordering).
        let mut m = TimelineMapper::new();
        m.mark_onset(10.0);
        let (_s1, e1, _d1) = m.map_commit(&[w("one", 0.0, 0.5)]); // 10.0..10.5
        assert!((e1 - 10.5).abs() < 1e-9);
        // No new onset (anchor consumed): next commit continues from 10.5, not 0.
        let (s2, e2, _d2) = m.map_commit(&[w("two", 0.0, 0.4)]);
        assert!((s2 - 10.5).abs() < 1e-9, "start must continue, got {}", s2);
        assert!((e2 - 10.9).abs() < 1e-9);
        // A fresh onset overrides the fallback again.
        m.mark_onset(30.0);
        let (s3, _e3, _d3) = m.map_commit(&[w("three", 0.0, 0.2)]);
        assert!((s3 - 30.0).abs() < 1e-9);
    }

    #[test]
    fn timeline_initial_no_onset_edge_is_zero_then_monotonic() {
        // Defensive (re-QA #4): the ONLY way map_commit yields start 0.0 is the
        // true initial state — no onset ever marked AND no prior commit
        // (last_commit_end = 0.0). In normal operation the FeedRing FIFO
        // guarantees an Onset precedes the Audio that precedes a Commit, and
        // MAJOR-2a marks onset on a mid-open reconnect, so this state is
        // unreachable live. Prove the fallback stays sane (monotonic, never
        // negative) even here.
        let mut m = TimelineMapper::new();
        let (s0, e0, d0) = m.map_commit(&[w("x", 0.0, 0.5)]);
        assert_eq!(s0, 0.0); // documented initial-state value
        assert!((e0 - 0.5).abs() < 1e-9);
        assert!((d0 - 0.5).abs() < 1e-9);
        // Subsequent no-onset commits continue monotonically from the last end.
        let (s1, e1, _d1) = m.map_commit(&[w("y", 0.0, 0.3)]);
        assert!(s1 >= e0, "must not regress: {} < {}", s1, e0);
        assert!((s1 - 0.5).abs() < 1e-9);
        assert!((e1 - 0.8).abs() < 1e-9);
    }

    #[test]
    fn onset_remark_on_resume_rules() {
        // MAJOR-2a: re-mark onset only on a Batch->Realtime flip while in speech.
        assert!(should_remark_onset_on_resume(
            Some(Route::Batch),
            Some(Route::Realtime),
            true
        ));
        assert!(should_remark_onset_on_resume(None, Some(Route::Realtime), true));
        // Not in speech -> normal onset detection handles it.
        assert!(!should_remark_onset_on_resume(
            Some(Route::Batch),
            Some(Route::Realtime),
            false
        ));
        // Already streaming (prev Realtime) -> the was->now edge handles onset.
        assert!(!should_remark_onset_on_resume(
            Some(Route::Realtime),
            Some(Route::Realtime),
            true
        ));
    }

    #[test]
    fn realtime_to_batch_flip_detection() {
        // MAJOR-1: shadow flushes only on a Realtime->Batch flip.
        assert!(is_realtime_to_batch_flip(
            Some(Route::Realtime),
            Some(Route::Batch)
        ));
        assert!(!is_realtime_to_batch_flip(
            Some(Route::Batch),
            Some(Route::Realtime)
        ));
        assert!(!is_realtime_to_batch_flip(None, Some(Route::Batch)));
        assert!(!is_realtime_to_batch_flip(
            Some(Route::Realtime),
            Some(Route::Realtime)
        ));
    }

    #[test]
    fn stop_flush_skips_realtime_streams_only() {
        // MAJOR-R1: at recording stop, a Realtime stream's buffer is the shadow
        // (the open segment) — do NOT batch-flush it (close_all commits it).
        assert!(!should_batch_flush_on_stop(Some(Route::Realtime)));
        // Batch (degraded) and no-session streams flush normally.
        assert!(should_batch_flush_on_stop(Some(Route::Batch)));
        assert!(should_batch_flush_on_stop(None));
    }

    // ---- server message parsing ------------------------------------------

    #[test]
    fn parses_partial_and_committed_with_both_discriminators() {
        // message_type discriminator
        assert_eq!(
            parse_server_message(r#"{"message_type":"partial_transcript","text":"hel"}"#),
            ServerMsg::Partial { text: "hel".into() }
        );
        // type discriminator
        assert_eq!(
            parse_server_message(r#"{"type":"partial_transcript","text":"hello"}"#),
            ServerMsg::Partial {
                text: "hello".into()
            }
        );
        let committed = parse_server_message(
            r#"{"message_type":"committed_transcript_with_timestamps","text":"Okay.","language_code":"eng","words":[{"text":"Okay.","start":0.059,"end":0.34,"type":"word"}]}"#,
        );
        match committed {
            ServerMsg::Committed { text, words } => {
                assert_eq!(text, "Okay.");
                assert_eq!(words.len(), 1);
                assert_eq!(words[0].start, Some(0.059));
            }
            other => panic!("expected Committed, got {:?}", other),
        }
    }

    #[test]
    fn plain_committed_is_ignored_variant() {
        assert_eq!(
            parse_server_message(r#"{"message_type":"committed_transcript","text":"dup"}"#),
            ServerMsg::CommittedPlain
        );
    }

    #[test]
    fn session_started_and_unknown_map_cleanly() {
        assert_eq!(
            parse_server_message(r#"{"message_type":"session_started","session_id":"x"}"#),
            ServerMsg::SessionStarted
        );
        assert_eq!(parse_server_message(r#"{"foo":"bar"}"#), ServerMsg::Other);
        assert_eq!(parse_server_message("not json"), ServerMsg::Other);
    }

    #[test]
    fn error_events_flag_fatal_correctly() {
        // nested error kind under message_type=error
        match parse_server_message(r#"{"message_type":"error","error":"quota_exceeded"}"#) {
            ServerMsg::Error { kind, fatal } => {
                assert_eq!(kind, "quota_exceeded");
                assert!(fatal);
            }
            o => panic!("{:?}", o),
        }
        // discriminator itself is an *_error kind (transient)
        match parse_server_message(r#"{"message_type":"rate_limited"}"#) {
            ServerMsg::Other => {} // rate_limited is not *_error and not fatal set -> Other
            _ => {}
        }
        match parse_server_message(r#"{"message_type":"auth_error"}"#) {
            ServerMsg::Error { fatal, .. } => assert!(fatal),
            o => panic!("{:?}", o),
        }
        match parse_server_message(r#"{"message_type":"input_error"}"#) {
            ServerMsg::Error { fatal, .. } => assert!(!fatal),
            o => panic!("{:?}", o),
        }
    }

    // ---- feed ring: drop-oldest ------------------------------------------

    #[tokio::test]
    async fn feed_ring_drops_oldest_audio_and_preserves_controls() {
        let ring = FeedRing::new(3);
        ring.push(FeedCmd::Onset(1.0));
        ring.push(FeedCmd::Audio(vec![1.0]));
        ring.push(FeedCmd::Audio(vec![2.0]));
        // Overflow: should evict the OLDEST Audio (the vec![1.0]), keep Onset.
        ring.push(FeedCmd::Audio(vec![3.0]));
        assert_eq!(ring.dropped(), 1);

        let a = ring.recv().await;
        assert!(matches!(a, FeedCmd::Onset(x) if (x - 1.0).abs() < 1e-9));
        let b = ring.recv().await;
        assert!(matches!(b, FeedCmd::Audio(ref v) if v == &vec![2.0]));
        let c = ring.recv().await;
        assert!(matches!(c, FeedCmd::Audio(ref v) if v == &vec![3.0]));
    }

    // ---- session seq monotonicity + reconnect ladder via stub transport ---

    /// Stub transport: fails `fail_first` connects, then serves canned messages.
    struct StubTransport {
        remaining_failures: std::sync::Mutex<u32>,
        // Messages to deliver once connected (in order), then hold the socket open.
        canned: Vec<String>,
        // Reports how many times connect() was called.
        connects: Arc<AtomicU64>,
    }

    #[async_trait]
    impl RealtimeTransport for StubTransport {
        async fn connect(&self, _url: &str, _api_key: &str) -> Result<TransportPair, String> {
            self.connects.fetch_add(1, Ordering::SeqCst);
            {
                let mut rf = self.remaining_failures.lock().unwrap();
                if *rf > 0 {
                    *rf -= 1;
                    return Err("stub forced failure".into());
                }
            }
            let (out_tx, _out_rx) = mpsc::channel::<String>(16);
            let (in_tx, in_rx) = mpsc::channel::<String>(16);
            let canned = self.canned.clone();
            tokio::spawn(async move {
                for m in canned {
                    if in_tx.send(m).await.is_err() {
                        return;
                    }
                }
                // Keep the socket "open" by holding in_tx until dropped elsewhere.
                tokio::time::sleep(Duration::from_secs(3600)).await;
                drop(in_tx);
            });
            Ok(TransportPair {
                outgoing: out_tx,
                incoming: in_rx,
            })
        }
    }

    #[tokio::test(start_paused = true)]
    async fn session_emits_partials_with_monotonic_seq() {
        let connects = Arc::new(AtomicU64::new(0));
        let transport = Arc::new(StubTransport {
            remaining_failures: std::sync::Mutex::new(0),
            canned: vec![
                r#"{"message_type":"session_started","session_id":"a"}"#.into(),
                r#"{"message_type":"partial_transcript","text":"one"}"#.into(),
                r#"{"message_type":"partial_transcript","text":"one two"}"#.into(),
                r#"{"message_type":"committed_transcript_with_timestamps","text":"one two","words":[{"text":"one","start":0.0,"end":0.3,"type":"word"},{"text":"two","start":0.4,"end":0.8,"type":"word"}]}"#.into(),
            ],
            connects: connects.clone(),
        });
        let (tx, mut rx) = mpsc::unbounded_channel::<RealtimeEvent>();
        let session =
            ElevenLabsRealtimeSession::start_with_transport(transport, "k".into(), None, tx);

        // Set a timeline anchor so the commit maps.
        session.mark_onset(&DeviceType::Microphone, 5.0);

        // Advance the paused clock so spawned tasks run.
        tokio::time::advance(Duration::from_millis(10)).await;
        tokio::task::yield_now().await;

        // Collect a few events (mic + system both connect; we filter Local).
        let mut partial_seqs = Vec::new();
        let mut committed = None;
        for _ in 0..12 {
            tokio::time::advance(Duration::from_millis(5)).await;
            match tokio::time::timeout(Duration::from_millis(50), rx.recv()).await {
                Ok(Some(RealtimeEvent::Partial { source, session_seq, .. })) if source == "Local" => {
                    partial_seqs.push(session_seq);
                }
                Ok(Some(RealtimeEvent::Committed { source, text, .. })) if source == "Local" => {
                    committed = Some(text);
                }
                Ok(Some(_)) => {}
                _ => {}
            }
        }

        assert!(
            partial_seqs.len() >= 2,
            "expected >=2 Local partials, got {:?}",
            partial_seqs
        );
        // Strictly monotonic per source.
        for pair in partial_seqs.windows(2) {
            assert!(pair[1] > pair[0], "seq must be monotonic: {:?}", partial_seqs);
        }
        assert_eq!(committed.as_deref(), Some("one two"));
    }

    #[tokio::test(start_paused = true)]
    async fn session_reconnects_through_ladder_then_streams() {
        let connects = Arc::new(AtomicU64::new(0));
        let transport = Arc::new(StubTransport {
            // Fail the first 2 connects on each stream, then succeed.
            remaining_failures: std::sync::Mutex::new(2),
            canned: vec![
                r#"{"message_type":"partial_transcript","text":"hi"}"#.into(),
            ],
            connects: connects.clone(),
        });
        let (tx, mut rx) = mpsc::unbounded_channel::<RealtimeEvent>();
        let session =
            ElevenLabsRealtimeSession::start_with_transport(transport, "k".into(), None, tx);

        // Initially Batch (not yet connected).
        assert_eq!(session.route(&DeviceType::Microphone), Route::Batch);

        // Advance through the 1s + 3s backoff so the 3rd connect (success) fires.
        // (Only mic shares the remaining_failures counter with system; both draw
        // from it, so allow generous advancement.)
        for _ in 0..20 {
            tokio::time::advance(Duration::from_secs(1)).await;
            tokio::task::yield_now().await;
        }

        // At least one Partial should have been emitted after reconnect.
        let mut got_partial = false;
        for _ in 0..10 {
            tokio::time::advance(Duration::from_millis(50)).await;
            if let Ok(Some(ev)) = tokio::time::timeout(Duration::from_millis(20), rx.recv()).await {
                if matches!(ev, RealtimeEvent::Partial { .. }) {
                    got_partial = true;
                    break;
                }
            }
        }
        assert!(got_partial, "expected a Partial after reconnect ladder");
        assert!(connects.load(Ordering::SeqCst) >= 3, "should have retried");
    }

    #[tokio::test(start_paused = true)]
    async fn session_degrades_and_warns_once_after_exhausting_reconnects() {
        let connects = Arc::new(AtomicU64::new(0));
        let transport = Arc::new(StubTransport {
            // Always fail -> both streams exhaust the ladder and degrade.
            remaining_failures: std::sync::Mutex::new(u32::MAX),
            canned: vec![],
            connects: connects.clone(),
        });
        let (tx, mut rx) = mpsc::unbounded_channel::<RealtimeEvent>();
        let session =
            ElevenLabsRealtimeSession::start_with_transport(transport, "k".into(), None, tx);

        // Advance well past the full ladder (1+3+8+30+... per stream).
        for _ in 0..200 {
            tokio::time::advance(Duration::from_secs(1)).await;
            tokio::task::yield_now().await;
        }

        // Exactly one Warning is emitted across both streams.
        let mut warnings = 0;
        while let Ok(Some(ev)) = tokio::time::timeout(Duration::from_millis(10), rx.recv()).await {
            if matches!(ev, RealtimeEvent::Warning { .. }) {
                warnings += 1;
            }
        }
        assert_eq!(warnings, 1, "degrade warning must fire exactly once");
        assert!(session.has_warned());
        assert_eq!(session.route(&DeviceType::Microphone), Route::Batch);
    }

    /// Stub that delivers one message batch per connect, then CLOSES the socket
    /// (drops the incoming sender) to force a reconnect. Exhausted batches -> hold
    /// open. Used to prove the per-source seq counter survives reconnects (7a).
    struct ReconnectStub {
        batches: std::sync::Mutex<std::collections::VecDeque<Vec<String>>>,
        connects: Arc<AtomicU64>,
    }

    #[async_trait]
    impl RealtimeTransport for ReconnectStub {
        async fn connect(&self, _url: &str, _api_key: &str) -> Result<TransportPair, String> {
            self.connects.fetch_add(1, Ordering::SeqCst);
            let batch = self.batches.lock().unwrap().pop_front();
            let (out_tx, _out_rx) = mpsc::channel::<String>(16);
            let (in_tx, in_rx) = mpsc::channel::<String>(16);
            tokio::spawn(async move {
                match batch {
                    Some(msgs) => {
                        for m in msgs {
                            if in_tx.send(m).await.is_err() {
                                return;
                            }
                        }
                        // Close the socket -> duplex loop sees Disconnected -> reconnect.
                        drop(in_tx);
                    }
                    None => {
                        tokio::time::sleep(Duration::from_secs(3600)).await;
                        drop(in_tx);
                    }
                }
            });
            Ok(TransportPair {
                outgoing: out_tx,
                incoming: in_rx,
            })
        }
    }

    #[tokio::test(start_paused = true)]
    async fn session_seq_survives_reconnect_no_reset() {
        // 7a: each connect delivers one partial then drops the socket. Because the
        // per-source seq counter lives OUTSIDE the reconnect loop, seqs must keep
        // increasing across reconnects (a reset would repeat/lower a seq).
        let partial = |t: &str| format!(r#"{{"message_type":"partial_transcript","text":"{}"}}"#, t);
        let mut batches = std::collections::VecDeque::new();
        for i in 0..8 {
            batches.push_back(vec![partial(&format!("p{}", i))]);
        }
        let connects = Arc::new(AtomicU64::new(0));
        let transport = Arc::new(ReconnectStub {
            batches: std::sync::Mutex::new(batches),
            connects: connects.clone(),
        });
        let (tx, mut rx) = mpsc::unbounded_channel::<RealtimeEvent>();
        let session =
            ElevenLabsRealtimeSession::start_with_transport(transport, "k".into(), None, tx);

        // Drive through several reconnect cycles (1s+3s+... backoffs).
        let mut local_seqs = Vec::new();
        for _ in 0..80 {
            tokio::time::advance(Duration::from_secs(1)).await;
            tokio::task::yield_now().await;
            while let Ok(Some(ev)) = tokio::time::timeout(Duration::from_millis(1), rx.recv()).await
            {
                if let RealtimeEvent::Partial { source, session_seq, .. } = ev {
                    if source == "Local" {
                        local_seqs.push(session_seq);
                    }
                }
            }
        }

        assert!(
            local_seqs.len() >= 3,
            "expected multiple Local partials across reconnects, got {:?}",
            local_seqs
        );
        // Strictly increasing => the counter never reset to a prior value.
        for pair in local_seqs.windows(2) {
            assert!(
                pair[1] > pair[0],
                "seq must not reset across reconnect: {:?}",
                local_seqs
            );
        }
        assert!(
            connects.load(Ordering::SeqCst) >= 4,
            "reconnects should have happened"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn disconnect_emits_empty_partial_to_clear_tail() {
        // MINOR-3: on the route flip to Batch (socket close), an empty-text partial
        // is emitted so the frontend drops the frozen volatile tail.
        let connects = Arc::new(AtomicU64::new(0));
        let mut batches = std::collections::VecDeque::new();
        // First connect delivers a real partial then closes (-> Disconnected).
        batches.push_back(vec![
            r#"{"message_type":"partial_transcript","text":"hello"}"#.into(),
        ]);
        let transport = Arc::new(ReconnectStub {
            batches: std::sync::Mutex::new(batches),
            connects: connects.clone(),
        });
        let (tx, mut rx) = mpsc::unbounded_channel::<RealtimeEvent>();
        let _session =
            ElevenLabsRealtimeSession::start_with_transport(transport, "k".into(), None, tx);

        let mut saw_nonempty = false;
        let mut saw_empty_after = false;
        for _ in 0..20 {
            tokio::time::advance(Duration::from_millis(200)).await;
            tokio::task::yield_now().await;
            while let Ok(Some(ev)) = tokio::time::timeout(Duration::from_millis(1), rx.recv()).await
            {
                if let RealtimeEvent::Partial { source, text, .. } = ev {
                    if source == "Local" {
                        if text.is_empty() && saw_nonempty {
                            saw_empty_after = true;
                        } else if !text.is_empty() {
                            saw_nonempty = true;
                        }
                    }
                }
            }
        }
        assert!(saw_nonempty, "expected the 'hello' partial first");
        assert!(
            saw_empty_after,
            "expected an empty-text partial after disconnect to clear the tail"
        );
    }

    /// Transport that records every outgoing frame into a shared Vec so tests can
    /// assert exactly which commit/audio messages hit the socket.
    struct CapturingTransport {
        sent: Arc<Mutex<Vec<String>>>,
        incoming: Vec<String>,
    }

    #[async_trait]
    impl RealtimeTransport for CapturingTransport {
        async fn connect(&self, _url: &str, _api_key: &str) -> Result<TransportPair, String> {
            let (out_tx, mut out_rx) = mpsc::channel::<String>(64);
            let (in_tx, in_rx) = mpsc::channel::<String>(64);
            let sent = self.sent.clone();
            tokio::spawn(async move {
                while let Some(m) = out_rx.recv().await {
                    sent.lock().unwrap().push(m);
                }
            });
            let incoming = self.incoming.clone();
            tokio::spawn(async move {
                for m in incoming {
                    if in_tx.send(m).await.is_err() {
                        return;
                    }
                }
                tokio::time::sleep(Duration::from_secs(3600)).await;
                drop(in_tx);
            });
            Ok(TransportPair {
                outgoing: out_tx,
                incoming: in_rx,
            })
        }
    }

    fn count_commits(sent: &Arc<Mutex<Vec<String>>>) -> usize {
        sent.lock()
            .unwrap()
            .iter()
            .filter(|m| m.contains("\"commit\":true"))
            .count()
    }

    #[tokio::test(start_paused = true)]
    async fn close_after_segment_commit_sends_no_second_commit() {
        // Phase 3 bug: recording stops during silence after the last segment
        // already committed at its end. close_all enqueues a final Commit, but no
        // audio was fed since -> the gate must skip it (a back-to-back commit is
        // commit_throttled and drops the last event). Expect exactly ONE commit.
        let sent = Arc::new(Mutex::new(Vec::<String>::new()));
        let transport = Arc::new(CapturingTransport {
            sent: sent.clone(),
            incoming: vec![],
        });
        let (tx, _rx) = mpsc::unbounded_channel::<RealtimeEvent>();
        let session =
            ElevenLabsRealtimeSession::start_with_transport(transport, "k".into(), None, tx);

        tokio::time::advance(Duration::from_millis(10)).await;
        tokio::task::yield_now().await;

        // One segment fed, then committed at segment end.
        session.mark_onset(&DeviceType::Microphone, 1.0);
        session.feed(&DeviceType::Microphone, &vec![0.1f32; FRAME_SAMPLES]);
        session.commit(&DeviceType::Microphone);
        for _ in 0..10 {
            tokio::time::advance(Duration::from_millis(20)).await;
            tokio::task::yield_now().await;
        }
        assert_eq!(count_commits(&sent), 1, "segment-end commit should be sent");

        // Stop: close_all enqueues a Commit, but nothing was fed since -> skipped.
        let close = tokio::spawn(session.clone().close_all());
        for _ in 0..40 {
            tokio::time::advance(Duration::from_millis(100)).await;
            tokio::task::yield_now().await;
        }
        let _ = close.await;

        assert_eq!(
            count_commits(&sent),
            1,
            "close must NOT add a second commit: {:?}",
            *sent.lock().unwrap()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn close_mid_open_segment_sends_exactly_one_final_commit() {
        // Recording stops mid-utterance: audio fed, no commit yet. close_all's
        // final Commit MUST fire (exactly once) to transcribe the closing segment.
        let sent = Arc::new(Mutex::new(Vec::<String>::new()));
        let transport = Arc::new(CapturingTransport {
            sent: sent.clone(),
            incoming: vec![],
        });
        let (tx, _rx) = mpsc::unbounded_channel::<RealtimeEvent>();
        let session =
            ElevenLabsRealtimeSession::start_with_transport(transport, "k".into(), None, tx);

        tokio::time::advance(Duration::from_millis(10)).await;
        tokio::task::yield_now().await;

        // Audio fed, NO commit (open segment).
        session.mark_onset(&DeviceType::Microphone, 1.0);
        session.feed(&DeviceType::Microphone, &vec![0.1f32; FRAME_SAMPLES]);
        for _ in 0..10 {
            tokio::time::advance(Duration::from_millis(20)).await;
            tokio::task::yield_now().await;
        }
        assert_eq!(count_commits(&sent), 0, "no commit before close");

        let close = tokio::spawn(session.clone().close_all());
        for _ in 0..40 {
            tokio::time::advance(Duration::from_millis(100)).await;
            tokio::task::yield_now().await;
        }
        let _ = close.await;

        assert_eq!(
            count_commits(&sent),
            1,
            "exactly one final commit for the open segment: {:?}",
            *sent.lock().unwrap()
        );
    }
}
