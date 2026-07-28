// audio/transcription/elevenlabs_realtime.rs
//
// ElevenLabs Scribe v2 **Realtime** WebSocket transcription session engine
// (Phase 2 of research/scribe-realtime-ws-plan.md; contract confirmed in
// research/scribe-realtime-spike-notes.md, which overrides the plan where they
// differ).
//
// One WS connection per audio stream (mic / system = DeviceType, mapping to the
// source labels "Local" / "Remote" exactly as worker.rs does).
//
// COMMIT STRATEGY (rewritten 2026-07-28 from the WER study in
// audio_testing/run_hybrid_realtime_wer.py; supersedes the original VAD-gated
// feed + per-segment commit described in the Phase 2 plan):
//
//   * CONTINUOUS FEED. While the route is Realtime the pipeline tap forwards
//     ALL audio for the stream as ~250ms PCM16 frames, silence included. The
//     server keeps its cross-utterance context, which is where the accuracy
//     comes from. VAD segment ends are no longer commits: they are GAP SIGNALS
//     (commit candidates) via `segment_gap()`.
//   * PERIODIC COMMITS AT VAD GAPS, danger-band aware ([`CommitScheduler`]).
//     Pooled WER on six real meeting clips, continuous feed, committed text only:
//       per-VAD-segment commits 6.31%  |  every ~15s 5.90%
//       ~30s danger-band scheduler 4.68%  |  commit-once-at-end 4.58%
//     WER improves monotonically as commit frequency drops — every commit costs
//     boundary insertions — so 30s is the accuracy/latency knee we ship.
//   * SERVER FACT 1: under `commit_strategy=manual` the server AUTO-COMMITS at
//     ~36.5s of uncommitted FED AUDIO (audio-based, pacing-invariant; NOT the
//     documented 90s wall-clock).
//   * SERVER FACT 2: a client commit sent MID-SPEECH close to that boundary
//     deterministically STALLS the session (server goes silent, tail audio
//     orphaned). MEASURED: healthy at 34.5s uncommitted, stalled 3/3 at 35.0s.
//     Distinct from `commit_throttled`, which is two back-to-back commits with
//     no audio between and makes the server DROP one of them. Hence the
//     scheduler never client-commits past 32.0s and lets the server's own
//     auto-commit be the commit-point instead.
//   * THE SCHEDULER RUNS ON THE FED-AUDIO CLOCK, not on server messages: it
//     PREDICTS the auto-commit by subtracting 36.5s when the clock crosses it,
//     so a silent server cannot disarm it. But 36.5s is a RECEIVE-time figure
//     and the true trigger is ~0.5-1.0s earlier, so a purely predictive clock
//     under-counts a little every cycle with nothing to correct it. Each
//     received committed transcript therefore RE-SYNCS the clock, bounding that
//     error to one cycle instead of accumulating it over a long meeting.
//   * STALL WATCHDOG: a stalled session keeps the socket open and never errors,
//     so 10s of speech fed with zero server messages forces a disconnect and
//     lets the reconnect ladder + batch catch-up take over.
//   * STAGED STOP. A finalize commit IS sent at recording stop, but only from
//     outside the danger band and only with real audio outstanding (this is what
//     the 4.68% harness configuration did at clip end). Its reply is awaited
//     briefly and emitted normally. Then emission is suppressed and the pipeline
//     batch-flushes whatever shadow windows no emitted commit covered. Inside
//     the band nothing is sent at all: no more audio is fed after stop, so the
//     server would never reach its own boundary either, and the batch path is
//     the only safe route.
//
// ACCEPTED RISK: the batch fallback for the tail is an HTTP request that can
// still fail after its retries. A warning is emitted and the recorded .wav
// always survives, so the audio is never lost, only its transcript.
//
// COST: the continuous feed bills roughly wall-clock audio on BOTH sockets (mic
// and system) for the whole recording, i.e. ~3-5x the VAD-gated feed's billed
// seconds. That is an accepted, deliberate trade for the accuracy.
//
// During silence the per-connection task still sends periodic silence keepalive
// frames because the server closes idle sockets ~15.7s after the last AUDIO
// frame (WS pings do NOT prevent it — spike caveat C1). Under continuous feed
// they only matter when the feed itself pauses (recording paused / route flip).
// Keepalive silence counts toward the server's auto-commit boundary but
// deliberately does NOT arm a commit (committing over pure silence is pointless)
// and adds no timeline mapping entry.
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

/// Send a silence keepalive if no audio has been fed for this long. Chosen well
/// under the server's ~15.7s idle-close (spike C1) with margin for scheduling.
/// The tick period is [`KEEPALIVE_TICK_SECS`], so the true worst case is
/// `KEEPALIVE_IDLE_SECS + KEEPALIVE_TICK_SECS`.
pub const KEEPALIVE_IDLE_SECS: f64 = 10.0;

/// How often the keepalive condition is evaluated. At the previous 5.0s the
/// worst case was 10.0 + 4.99 = 14.99s against a ~15.7s idle close, a 0.7s
/// margin. 2.5s brings the worst case to 12.49s.
pub const KEEPALIVE_TICK_SECS: f64 = 2.5;

/// Stall watchdog (M1). If this many seconds of REAL audio are fed with ZERO
/// server messages of any kind (partial, committed, error) received, the session
/// is treated as dead and force-disconnected.
///
/// SERVER FACT 2 stalls do not close the socket and produce no send errors, so
/// nothing else detects them: partials freeze, the commit epoch freezes, the
/// route never flips, and the pipeline's shadow buffer silently eats the rest of
/// the meeting at its cap. A healthy session emits a partial roughly once a
/// second while speech is being fed, so 10s of speech with total silence from the
/// server is unambiguous.
pub const WATCHDOG_SECS: f64 = 10.0;

/// Length of each silence keepalive frame (250ms @ 16kHz of zeros). Billed as
/// audio-seconds but a few frames per idle gap is negligible (spike §4/D-dev-1).
pub const KEEPALIVE_SILENCE_SAMPLES: usize = 4_000;

/// Consecutive failed (re)connects after which the stream degrades permanently
/// to the batch path for the rest of the recording (plan D5).
pub const MAX_RECONNECTS: u32 = 5;

/// Reconnect backoff ladder in ms: 1s / 3s / 8s, capped at 30s (plan D5).
pub const BACKOFF_SCHEDULE_MS: [u64; 4] = [1_000, 3_000, 8_000, 30_000];

/// Bounded feed-ring capacity per stream (drop-oldest on overflow). One queued
/// `Audio` command carries one PIPELINE window (600ms), not one 250ms socket
/// frame, so 64 slots is ~38s of queued audio at 600ms shed granularity.
///
/// `SegmentGap` no longer erodes that depth: at most ONE gap signal is queued at
/// a time (they coalesce on push) and a queued gap is evicted before any audio.
/// Before that fix a silent stretch enqueued one gap per window alongside the
/// audio, so a backed-up ring converged to 64 gap signals and zero audio.
///
/// Kept at 64: the ring only backs up if the socket send path stalls, 38s is
/// already far more live tail than is useful, and the recording file remains the
/// source of truth so a shed window only degrades the live transcript, never the
/// audio. Shed windows are also harmless to timestamps: [`TimelineMapper`]
/// records an entry per frame actually SENT, so a hole simply maps around.
pub const FEED_RING_CAP: usize = 64;

// ============================================================================
// ROUTING — what the pipeline does with a stream's audio right now
// ============================================================================

/// How the pipeline should route a stream's audio at this instant.
///
/// `Realtime`: socket is connected — feed EVERY window live (continuous feed,
/// silence included) and bypass batch accumulation.
/// `Batch`: socket is (temporarily) disconnected or permanently degraded — route
/// VAD segments through the existing VAD-gated batch accumulation + HTTP provider
/// path so no words are lost (plan D5). That fallback path is unchanged.
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

/// Whether the pipeline should hand the session an explicit timeline anchor
/// because a socket just (re)connected while the stream's VAD segment is ALREADY
/// open (MAJOR-2a).
///
/// Under the continuous feed the anchor normally comes from the first fed frame's
/// own timestamp, so this is belt-and-braces: it guarantees an anchor for a
/// Batch -> Realtime flip mid-speech, where there is no `was->now` edge. The
/// re-fed audio starts "now", so the current recording clock is the right anchor,
/// and [`TimelineMapper`] keeps whichever anchor lands first on the connection.
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
/// buffer to the batch worker (MAJOR-R1). ALWAYS true, including for streams on
/// the Realtime route.
///
/// This inverts the original rule, which skipped Realtime streams because
/// `close_all` sent an UNCONDITIONAL final WS `commit` that owned the tail. That
/// commit had no danger-band check: stopping with uncommitted audio inside the
/// band sent exactly the commit SERVER FACT 2 says stalls the session, orphaning
/// the whole tail, and simply suppressing it lost the tail too, because after
/// stop no more audio is fed so the server never reaches its own boundary either.
///
/// The staged stop now sends a finalize commit only when
/// [`CommitScheduler::finalize_should_commit`] allows it, and this flush handles
/// the REMAINDER: the shadow windows no emitted commit covered. That remainder is
/// often empty (the finalize covered everything), is the whole tail when the
/// finalize was refused or its reply was late, and is also the right answer for a
/// stop inside the first 30s where nothing has been committed at all.
///
/// Double transcription is prevented structurally rather than by timing: the
/// shadow clear is WINDOWED by what each emitted commit actually covered, and
/// [`ElevenLabsRealtimeSession::begin_shutdown`] is called before the flush so a
/// late reply is dropped instead of emitted alongside it.
pub fn should_batch_flush_on_stop(_route: Option<Route>) -> bool {
    true
}

/// Whether recording-stop should drain the VAD processor's still-open segment
/// into the batch buffer. FALSE for a stream on the Realtime route (M3).
///
/// The realtime tap shadows EVERY speech window, in-speech ones included, so the
/// open segment is already in the shadow. Appending `vad.flush()`'s segments on
/// top of it transcribed the closing sentence TWICE inside a single chunk
/// ("...ship it on Friday so let's ship it on Friday"). The Realtime -> Batch
/// flip path already discards the flush result for exactly this reason; the stop
/// path must match it. The flush is still CALLED, to reset the processor, its
/// result is just dropped.
pub fn should_drain_vad_into_batch_on_stop(route: Option<Route>) -> bool {
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
///
/// NOTE: a fresh slicer is created per CONNECTION, so up to 249ms of pending
/// samples is discarded on a reconnect. Accepted: the socket rotation itself
/// already breaks the server's context, and the recording file keeps the audio.
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
// COMMIT SCHEDULER (pure, unit-tested) — the danger-band strategy
// ============================================================================

/// Audio-seconds of uncommitted feed after which the next speech gap is a commit
/// candidate.
///
/// The original WER sweep put the accuracy knee near 30s: per-segment (~1-2s)
/// 6.31% pooled WER, 15s 5.90%, 30s 4.68%, never (commit once at clip end)
/// 4.58%. But 30s paired with a 32.0s cutoff leaves only a 2s ARMING WINDOW, and
/// the live multi-cycle stress run showed speech-dense audio reproducibly passing
/// straight through it with no gap, so the cycle ran on into the server's
/// auto-commit every time. 27.0 widens the window to 5s, which catches those
/// gaps, at no measurable accuracy cost: two 6-minute live sessions at
/// 27 / 32 / re-sync scored 5.09% and 4.58% WER, the same band as the 4.68%
/// baseline, with zero stalls and zero `commit_throttled`.
///
/// TUNING: this and [`FORCE_CUTOFF_SECS`] are the only two knobs. Validation
/// source: `audio_testing/run_hybrid_realtime_wer.py` at harness commit d8c8dd3
/// (`--cutoff` / `--resync` / `--make-multi`).
pub const COMMIT_INTERVAL_SECS: f64 = 27.0;

/// SERVER FACT 1. Under `commit_strategy=manual` the server auto-commits on
/// uncommitted FED AUDIO, not wall clock (definitely not the documented 90s).
///
/// MEASUREMENT CAVEAT: 36.5s is a RECEIVE-time figure (when the committed event
/// arrived, seen at 9.15s wall-clock at 4x pacing = 36.6s audio on every clip).
/// The live multi-cycle run measured auto-commit RECEIPT SPACING of 34.75-36.25s,
/// median 35.5s, so the server's true TRIGGER is earlier still by roughly the
/// transcription plus network latency. Everything derived from this constant
/// treats it as an UPPER bound on the trigger, never as the trigger itself, and
/// [`CommitScheduler::on_committed_received`] corrects the residual each cycle.
pub const AUTO_COMMIT_AUDIO_SECS: f64 = 36.5;

/// SERVER FACT 2. A client commit fired mid-speech close to the auto-commit
/// boundary deterministically STALLS the session: the server stops emitting and
/// the trailing audio is orphaned.
///
/// MEASURED BOUNDARY (harness event logs): a commit at 34.5s uncommitted was
/// healthy; a commit at 35.0s stalled 3 runs out of 3. So the real stall edge is
/// 34.5-35.0s, NOT the 36.5s receive-time figure, and the previously claimed
/// "3.0s validated guard" was in truth only ~1.0-1.5s.
pub const STALL_EDGE_SECS: f64 = 34.5;

/// Margin held below the measured stall edge. 2.5s puts the cutoff at 32.0s.
pub const DANGER_GUARD_SECS: f64 = 2.5;

/// Hard cutoff for CLIENT commits: 32.0s of uncommitted fed audio, i.e. 2.5s
/// below the last position observed healthy. Past this the scheduler never
/// commits in this cycle and lets the server's own auto-commit land instead.
///
/// TUNING: this and [`COMMIT_INTERVAL_SECS`] are the only two knobs; a live
/// multi-cycle stress run may move them, and each is a one-line change here.
pub const FORCE_CUTOFF_SECS: f64 = STALL_EDGE_SECS - DANGER_GUARD_SECS;

/// Uncommitted seconds we assume the server still holds at the moment a
/// committed transcript REACHES us (the re-sync floor).
///
/// At the instant the server emits a commit its own uncommitted counter is zero;
/// by the time the event reaches us we have fed only the in-flight audio, ~0.5s
/// at real pace. 1.5s is a deliberate OVER-estimate: over-counting delays our
/// next commit slightly (harmless), under-counting walks us into the stall band.
///
/// MEASURED (live multi-cycle run, harness commit d8c8dd3): without the re-sync
/// the client model drifts -1.0s per auto-commit cycle, monotonically, over 3
/// consecutive cycles. With it the model error stays within [-0.25, +1.25] over
/// 9-10 cycles with no trend.
pub const RESYNC_MARGIN_SECS: f64 = 1.5;

/// A gap only arms a commit once this much REAL (non-keepalive) audio has been
/// fed since the last commit-point. Two jobs: committing over pure keepalive
/// silence is pointless (during a long pause ~130 keepalives would otherwise
/// reach the interval and fire a commit with nothing in it), and it keeps the
/// original `commit_throttled` guard — a commit with no audio behind it is the
/// back-to-back case the server answers by DROPPING one of the two.
pub const MIN_REAL_AUDIO_SECS: f64 = 1.0;

/// Decides WHEN to send a client `commit`, driven purely by FED-AUDIO seconds
/// (never wall clock, never server messages), one instance per stream per
/// connection.
///
/// Mirrors the validated Python harness scheduler in
/// `audio_testing/run_hybrid_realtime_wer.py` (`build_schedule`), with one
/// addition the 60s validation clips could never have exercised (they only ever
/// ran ONE auto-commit cycle): a receipt-driven re-sync.
///
/// A COMMIT-POINT is any of:
///   * a CLIENT commit we send — the clock resets at SEND time, so a second gap
///     arriving before the reply cannot fire a back-to-back commit;
///   * the PREDICTED server auto-commit — when the fed clock crosses
///     [`AUTO_COMMIT_AUDIO_SECS`] we subtract it, keeping the residual's phase.
///     This is the MESSAGE-LESS BACKSTOP: it keeps the scheduler armed even if
///     the server never says anything;
///   * a RECEIVED committed transcript — [`on_committed_received`](Self::on_committed_received)
///     re-syncs to [`RESYNC_MARGIN_SECS`].
///
/// Why the re-sync matters: [`AUTO_COMMIT_AUDIO_SECS`] is a RECEIVE-time figure
/// and the server's true trigger is ~0.5-1.0s earlier, so a purely predictive
/// subtract under-counts the server by that much on EVERY cycle, with nothing to
/// correct it. Over a long meeting the error accumulates (N cycles x ~0.8s) until
/// a "safe" 31s client commit is really a ~35s commit server-side, which is
/// precisely the stall in SERVER FACT 2. The re-sync bounds the error to one
/// cycle instead of accumulating it.
///
/// The re-sync only ever moves the clock FORWARD relative to the naive predictive
/// subtract (it floors at [`RESYNC_MARGIN_SECS`] rather than zeroing), so it can
/// only ever make us more conservative, never less.
#[derive(Debug, Default)]
pub struct CommitScheduler {
    /// ALL fed-audio seconds (real + keepalive) since the last commit-point.
    /// This is the quantity the server's auto-commit boundary tracks.
    uncommitted_secs: f64,
    /// REAL (non-keepalive) fed-audio seconds since the last commit-point.
    real_secs: f64,
    /// Predicted server auto-commits so far on this connection (diagnostics).
    predicted_auto_commits: u64,
}

impl CommitScheduler {
    pub fn new() -> Self {
        Self {
            uncommitted_secs: 0.0,
            real_secs: 0.0,
            predicted_auto_commits: 0,
        }
    }

    /// Account for REAL audio actually SENT on the socket.
    pub fn on_fed_real(&mut self, secs: f64) {
        if secs > 0.0 {
            self.uncommitted_secs += secs;
            self.real_secs += secs;
            self.apply_predicted_auto_commit();
        }
    }

    /// Account for KEEPALIVE silence sent on the socket. It counts toward the
    /// server's auto-commit boundary (the server counts every fed sample) but not
    /// toward arming a commit.
    pub fn on_fed_keepalive(&mut self, secs: f64) {
        if secs > 0.0 {
            self.uncommitted_secs += secs;
            self.apply_predicted_auto_commit();
        }
    }

    /// Advance the clock past every boundary the feed has crossed. Subtracting
    /// rather than zeroing keeps the residual audio's phase, exactly as the
    /// harness's `last_commit_at += AUTO_COMMIT_AUDIO_SECS` does.
    fn apply_predicted_auto_commit(&mut self) {
        while self.uncommitted_secs >= AUTO_COMMIT_AUDIO_SECS {
            self.uncommitted_secs -= AUTO_COMMIT_AUDIO_SECS;
            self.predicted_auto_commits += 1;
            // We cannot know how much of the residual was real, only that it
            // cannot exceed the residual itself. Taking the min is the accurate
            // bound and is conservative for arming.
            self.real_secs = self.real_secs.min(self.uncommitted_secs);
        }
    }

    /// Re-sync to a committed transcript that just ARRIVED (either message
    /// variant, whether or not we emitted it).
    ///
    /// `uncommitted := max(RESYNC_MARGIN_SECS, uncommitted - AUTO_COMMIT_AUDIO_SECS)`.
    /// The subtract handles the case where the predictive backstop has not fired
    /// yet (our clock still carries the whole cycle); the floor handles the case
    /// where it already did (our clock is a small residual, which we must not
    /// trust below the in-flight estimate). Either way the result is an
    /// over-estimate of what the server actually still holds, which is the safe
    /// direction.
    pub fn on_committed_received(&mut self) {
        let subtracted = self.uncommitted_secs - AUTO_COMMIT_AUDIO_SECS;
        self.uncommitted_secs = subtracted.max(RESYNC_MARGIN_SECS);
        self.real_secs = self.real_secs.min(self.uncommitted_secs);
    }

    /// A speech gap was observed: should we commit here?
    ///
    /// `pending_tail_secs` is REAL audio still held in the [`FrameSlicer`] that
    /// will be flushed immediately before the commit. Including it here is what
    /// makes the guard exact: checking the cutoff before the flush would shave
    /// one frame (250ms) off the intended margin.
    ///
    /// True only inside the safe window `[COMMIT_INTERVAL_SECS,
    /// FORCE_CUTOFF_SECS)` and with real speech behind it.
    pub fn on_gap(&self, pending_tail_secs: f64) -> bool {
        let unc = self.uncommitted_secs + pending_tail_secs;
        let real = self.real_secs + pending_tail_secs;
        unc >= COMMIT_INTERVAL_SECS && unc < FORCE_CUTOFF_SECS && real >= MIN_REAL_AUDIO_SECS
    }

    /// Whether a FINALIZE commit at recording stop is safe and worthwhile: same
    /// danger-band rule as a gap commit, but with no interval requirement (the
    /// point is to flush whatever is outstanding, however little).
    pub fn finalize_should_commit(&self, pending_tail_secs: f64) -> bool {
        let unc = self.uncommitted_secs + pending_tail_secs;
        let real = self.real_secs + pending_tail_secs;
        unc < FORCE_CUTOFF_SECS && real >= MIN_REAL_AUDIO_SECS
    }

    /// Record a CLIENT-initiated commit-point (call at SEND time, after the
    /// slicer tail has been flushed so both counters include it).
    pub fn on_client_commit(&mut self) {
        self.reset();
    }

    /// Fresh clock (new connection = new server session).
    pub fn reset(&mut self) {
        self.uncommitted_secs = 0.0;
        self.real_secs = 0.0;
    }

    /// Uncommitted fed-audio seconds, real + keepalive (diagnostics/tests).
    pub fn uncommitted_secs(&self) -> f64 {
        self.uncommitted_secs
    }

    /// Real (non-keepalive) fed seconds since the commit-point (diagnostics/tests).
    pub fn real_secs(&self) -> f64 {
        self.real_secs
    }

    /// How many server auto-commits the fed clock has predicted (diagnostics/tests).
    pub fn predicted_auto_commits(&self) -> u64 {
        self.predicted_auto_commits
    }
}

// ============================================================================
// TIMELINE MAPPER (pure, unit-tested)
// ============================================================================

/// How much fed-clock history the mapper keeps. Comfortably longer than the
/// worst commit interval (~36.5s) plus a slow reply, and bounded so a multi-hour
/// recording cannot grow the entry list without limit.
pub const MAPPER_HISTORY_SECS: f64 = 90.0;

/// One contiguous run of REAL audio actually SENT to the socket, recorded in both
/// clocks so the two can be related exactly.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FeedSpan {
    /// Position of this run on the server's cumulative fed-audio clock.
    pub fed_start: f64,
    /// Recording-relative time of the same first sample.
    pub rec_start: f64,
    /// Duration of the run in seconds.
    pub dur: f64,
}

/// Maps a committed segment's server word timings onto the recording timeline.
///
/// Server word timestamps are SESSION-CUMULATIVE over FED audio: `t = 0` is the
/// first sample the server received on THIS connection. The naive assumption
/// that fed-audio time therefore tracks recording time linearly is WRONG in two
/// live situations, and each produced permanent, unbounded drift:
///
///   * FEED HOLES. The bounded [`FeedRing`] sheds whole 600ms windows under
///     backpressure (e.g. a stalled socket, which does not flip the route because
///     the route only flips on a send error). Recording time advanced, fed time
///     did not: measured 80s of permanent offset in the reviewers' scenario.
///   * KEEPALIVE SILENCE. During a recording pause the fed clock keeps advancing
///     (~1.65s per 60s of pause) while the recording clock is frozen.
///
/// So the mapper keeps a PIECEWISE map instead of one anchor: one [`FeedSpan`]
/// per frame actually SENT (recorded at send time, so shed frames never enter,
/// and keepalives advance the fed clock without adding a span). A word time is
/// mapped by binary search into the spans:
///   `rec = span.rec_start + (t - span.fed_start)`, clamped inside the span.
/// A `t` landing in a keepalive/shed hole clamps to the nearest span edge, and a
/// `t` beyond the recorded history clamps to the last span's end.
///
/// The output is additionally clamped forward so it can never regress below the
/// previous commit's end (MAJOR-2b: audio_start_time ASC ordering).
///
/// Spans older than [`MAPPER_HISTORY_SECS`] of fed time are pruned. Everything
/// is reset per (re)connect, since a new server session restarts `t` at 0.
#[derive(Debug, Default)]
pub struct TimelineMapper {
    spans: VecDeque<FeedSpan>,
    /// Total fed seconds (real + keepalive) on this connection = the server's
    /// cumulative clock position of the next sample we send.
    fed_cursor: f64,
    /// Recording time to use for a word that arrives before ANY span exists
    /// (defensive; normally the first sent frame supplies the first span).
    pending_anchor: Option<f64>,
    /// End (recording-relative secs) of the last mapped commit — the monotonic
    /// floor. See MAJOR-2.
    last_commit_end_secs: f64,
}

impl TimelineMapper {
    pub fn new() -> Self {
        Self {
            spans: VecDeque::new(),
            fed_cursor: 0.0,
            pending_anchor: None,
            last_commit_end_secs: 0.0,
        }
    }

    /// Record REAL audio just SENT: `dur` seconds whose first sample sits at
    /// recording-relative `rec_start`. Call once per frame actually written to
    /// the socket, so shed frames never enter the map.
    pub fn note_sent_real(&mut self, rec_start: f64, dur: f64) {
        if dur <= 0.0 {
            return;
        }
        let rec_start = rec_start.max(0.0);
        // Extend the previous span when the two are contiguous in BOTH clocks
        // (the common case: consecutive 250ms frames of one continuous feed).
        // 1e-6 tolerance, not exact equality: both sums accumulate float error
        // independently, and a genuine break is at least one 250ms frame wide.
        if let Some(last) = self.spans.back_mut() {
            if (last.fed_start + last.dur - self.fed_cursor).abs() < 1e-6
                && (last.rec_start + last.dur - rec_start).abs() < 1e-6
            {
                last.dur += dur;
                self.fed_cursor += dur;
                self.prune();
                return;
            }
        }
        self.spans.push_back(FeedSpan {
            fed_start: self.fed_cursor,
            rec_start,
            dur,
        });
        self.fed_cursor += dur;
        self.prune();
    }

    /// Record KEEPALIVE silence just sent: it advances the server's cumulative
    /// clock but corresponds to no recording time, so it adds no span.
    pub fn note_sent_keepalive(&mut self, dur: f64) {
        if dur > 0.0 {
            self.fed_cursor += dur;
        }
    }

    /// Defensive anchor hint from the pipeline (speech onset / Batch->Realtime
    /// resume), used only until the first real frame is sent on this connection.
    pub fn mark_onset(&mut self, recording_secs: f64) {
        if self.spans.is_empty() {
            self.pending_anchor = Some(recording_secs.max(0.0));
        }
    }

    /// Drop the whole per-connection map because the socket is being
    /// (re)connected: the new server session restarts its cumulative clock at 0.
    /// `last_commit_end_secs` is deliberately KEPT so ordering stays monotonic
    /// across a socket rotation.
    pub fn reset_anchor(&mut self) {
        self.spans.clear();
        self.fed_cursor = 0.0;
        self.pending_anchor = None;
    }

    fn prune(&mut self) {
        let cutoff = self.fed_cursor - MAPPER_HISTORY_SECS;
        while self.spans.len() > 1 {
            let front = self.spans[0];
            if front.fed_start + front.dur < cutoff {
                self.spans.pop_front();
            } else {
                break;
            }
        }
    }

    /// Map a server cumulative fed-audio time to recording-relative seconds.
    pub fn map_time(&self, t: f64) -> f64 {
        if self.spans.is_empty() {
            return self.pending_anchor.unwrap_or(self.last_commit_end_secs) + t.max(0.0);
        }
        // Binary search for the last span starting at or before `t`.
        let mut lo = 0usize;
        let mut hi = self.spans.len();
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.spans[mid].fed_start <= t {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo == 0 {
            // Before the first recorded span (pruned history or a pre-feed time).
            return self.spans[0].rec_start;
        }
        let span = self.spans[lo - 1];
        // Inside the span -> exact; past its end (a keepalive/shed hole, or the
        // very tail) -> clamp to the span's end.
        let offset = (t - span.fed_start).clamp(0.0, span.dur);
        span.rec_start + offset
    }

    /// Compute (start, end, duration) in recording-relative seconds for a span of
    /// server word times, clamped forward past the previous commit's end.
    pub fn map_word_span(&mut self, first: f64, last: f64) -> (f64, f64, f64) {
        let mut start = self.map_time(first).max(0.0);
        let mut end = self.map_time(last.max(first)).max(start);
        if start < self.last_commit_end_secs {
            let span = end - start;
            start = self.last_commit_end_secs;
            end = start + span;
        }
        self.last_commit_end_secs = end;
        (start, end, end - start)
    }

    /// Compute (start, end, duration) for a whole commit's word list.
    pub fn map_commit(&mut self, words: &[WordTiming]) -> (f64, f64, f64) {
        let (first, last) = word_bounds_secs(words);
        self.map_word_span(first, last)
    }

    /// Number of recorded spans (diagnostics/tests).
    pub fn span_count(&self) -> usize {
        self.spans.len()
    }

    /// Server cumulative fed-clock position (diagnostics/tests).
    pub fn fed_cursor(&self) -> f64 {
        self.fed_cursor
    }
}

/// First word start and last word end (session-cumulative secs) of the timed
/// tokens; spacing tokens and untimed tokens are skipped. `(0.0, 0.0)` when the
/// commit carries no usable timings.
pub fn word_bounds_secs(words: &[WordTiming]) -> (f64, f64) {
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
        (Some(f), Some(l)) if l >= f => (f, l),
        (Some(f), _) => (f, f),
        _ => (0.0, 0.0),
    }
}

/// Duration in seconds spanned by the timed word tokens (spacing/None skipped).
pub fn word_span_secs(words: &[WordTiming]) -> f64 {
    let (first, last) = word_bounds_secs(words);
    (last - first).max(0.0)
}

/// Silence between two words that ends an utterance, for the commit splitter.
pub const UTTERANCE_SPLIT_GAP_SECS: f64 = 1.0;

/// One utterance carved out of a committed block: server cumulative start/end
/// plus the joined text.
#[derive(Debug, Clone, PartialEq)]
pub struct Utterance {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// Split a committed block into utterance-level segments at word gaps longer
/// than `gap_secs`.
///
/// A 30s commit interval means a commit can carry half a minute of speech as one
/// block. With mic and system on independent sockets those blocks interleave
/// badly: a mic block spanning 100..130s and a system block spanning 105..135s
/// render as two overlapping monologues once sorted by start time. Splitting on
/// natural pauses restores turn-level ordering without changing the transcribed
/// text.
///
/// Words with no timings, and blocks with no timings at all, come back as a
/// single segment so the caller always has something to emit. Spacing tokens
/// stay attached to the segment they follow and are trimmed at the edges.
pub fn split_committed_on_gaps(words: &[WordTiming], gap_secs: f64) -> Vec<Utterance> {
    split_committed_on_gaps_mapped(words, gap_secs, |t| t)
}

/// [`split_committed_on_gaps`] with the gap measured on a MAPPED clock.
///
/// `map` converts a server cumulative time to recording time. That matters
/// because keepalive silence and shed windows make the two clocks differ: two
/// utterances separated by a 40s recording pause are ADJACENT in server time, so
/// splitting on the raw server clock leaves them as one block whose mapped
/// duration wrongly spans the pause. The returned `start`/`end` stay in SERVER
/// time so the caller can map them itself (with monotonic clamping).
pub fn split_committed_on_gaps_mapped(
    words: &[WordTiming],
    gap_secs: f64,
    map: impl Fn(f64) -> f64,
) -> Vec<Utterance> {
    let mut out: Vec<Utterance> = Vec::new();
    let mut cur_text = String::new();
    let mut cur_start: Option<f64> = None;
    let mut cur_end: Option<f64> = None;

    for w in words {
        let is_spacing = w.word_type.as_deref() == Some("spacing");
        if !is_spacing {
            if let (Some(s), Some(prev_end)) = (w.start, cur_end) {
                if map(s) - map(prev_end) > gap_secs && !cur_text.trim().is_empty() {
                    out.push(Utterance {
                        start: cur_start.unwrap_or(prev_end),
                        end: prev_end,
                        text: cur_text.trim().to_string(),
                    });
                    cur_text.clear();
                    cur_start = None;
                    cur_end = None;
                }
            }
            if cur_start.is_none() {
                cur_start = w.start;
            }
            // The server does not always interleave explicit spacing tokens, so
            // separate adjacent words ourselves rather than producing "onetwo".
            if !cur_text.is_empty() && !cur_text.ends_with(char::is_whitespace) {
                cur_text.push(' ');
            }
        }
        cur_text.push_str(&w.text);
        if !is_spacing {
            if let Some(e) = w.end.or(w.start) {
                cur_end = Some(e);
            }
        }
    }

    if !cur_text.trim().is_empty() {
        let start = cur_start.unwrap_or(0.0);
        out.push(Utterance {
            start,
            end: cur_end.unwrap_or(start),
            text: cur_text.trim().to_string(),
        });
    }
    out
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
            // PER-ELEMENT lossy parse: one malformed token must not collapse the
            // whole array to empty (which would lose every word timing in the
            // block and force the untimed single-segment fallback).
            let mut words: Vec<WordTiming> = Vec::new();
            let mut skipped = 0usize;
            if let Some(arr) = val.get("words").and_then(|v| v.as_array()) {
                for item in arr {
                    match serde_json::from_value::<WordTiming>(item.clone()) {
                        Ok(w) => words.push(w),
                        Err(_) => skipped += 1,
                    }
                }
            }
            if skipped > 0 {
                debug!("🎧 Realtime: skipped {} malformed word timing(s)", skipped);
            }
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
/// Onset precedes the Audio it anchors, which precedes any SegmentGap).
#[derive(Debug, Clone)]
enum FeedCmd {
    /// Recording-relative seconds hint for the connection's timeline anchor.
    Onset(f64),
    /// Audio (16kHz f32), sliced into 250ms frames by the task. `at_secs` is the
    /// recording-relative time of the FIRST sample, used to anchor the timeline
    /// on the first audio of a connection. Under the continuous feed this is
    /// every window's audio, silence included — NOT only VAD-open segments.
    Audio { samples: Vec<f32>, at_secs: f64 },
    /// This window carried no speech: a COMMIT CANDIDATE, not a commit. The
    /// [`CommitScheduler`] decides whether this gap actually commits. Sent on
    /// EVERY silent window (matching the harness, which commits at the first
    /// silent chunk once armed) rather than only at VAD segment completion,
    /// which could otherwise push an armed cycle straight past the cutoff.
    /// COALESCED: at most one is ever queued (a second is a no-op), because a
    /// queued gap conveys nothing a fresher one does not.
    SegmentGap,
    /// Recording stop: flush the slicer tail and, if [`CommitScheduler::finalize_should_commit`]
    /// allows (outside the danger band, real audio behind it), send one final
    /// commit so the tail is transcribed by the WS path rather than by the batch
    /// fallback. Never sent inside the band: see [`should_batch_flush_on_stop`].
    Finalize,
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

    /// Non-blocking push.
    ///
    /// `SegmentGap` COALESCES: pushing one while another is already queued is a
    /// no-op, since a stale gap says nothing a fresher one does not. On overflow
    /// a queued `SegmentGap` is evicted first (it is pure signalling), then the
    /// oldest `Audio`; `Onset`/`Finalize`/`Close` are never evicted so control
    /// ordering survives shedding.
    fn push(&self, cmd: FeedCmd) {
        // Poison-tolerant: a panicked holder must not wedge the audio-thread feed.
        let mut q = self.q.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(cmd, FeedCmd::SegmentGap)
            && q.iter().any(|c| matches!(c, FeedCmd::SegmentGap))
        {
            return;
        }
        if q.len() >= self.cap {
            let victim = q
                .iter()
                .position(|c| matches!(c, FeedCmd::SegmentGap))
                .or_else(|| q.iter().position(|c| matches!(c, FeedCmd::Audio { .. })));
            match victim {
                Some(pos) => {
                    q.remove(pos);
                }
                None => {
                    q.pop_front();
                }
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
    /// Bumped exactly once per committed transcript we actually EMITTED.
    ///
    /// Not at send time: the shadow buffer means "speech no transcript covers
    /// yet", so clearing it while a commit is merely in flight would lose that
    /// audio if the socket died during the round trip.
    ///
    /// Not on `committed_transcript` (the plain variant) either, and not on a
    /// SUPPRESSED timestamps variant. The server sends the two variants ~0.1-0.35s
    /// apart for every commit (12/12 in the spike logs). If the plain one bumped
    /// the epoch and shutdown landed in that gap, the timestamps variant would be
    /// suppressed, the epoch would claim the audio was transcribed, the shadow
    /// would be cleared at the stop flush, and the block would exist nowhere.
    /// Tying the epoch to actual emission makes that structurally impossible.
    commit_epoch: Arc<AtomicU64>,
    /// Recording-relative time through which emitted commits have covered this
    /// stream, stored as `f64::to_bits`. Read together with `commit_epoch` so the
    /// pipeline can drop exactly the shadow windows a commit accounted for.
    committed_through_bits: Arc<AtomicU64>,
    join: tokio::task::JoinHandle<()>,
}

// ============================================================================
// THE SESSION
// ============================================================================

/// Manages the realtime WS connections for a recording (one per active stream).
///
/// Lifecycle: create with [`ElevenLabsRealtimeSession::start`] at recording
/// start; the pipeline calls [`feed`](Self::feed) / [`segment_gap`](Self::segment_gap) /
/// [`mark_onset`](Self::mark_onset) on the audio path and reads
/// [`route`](Self::route) each window. At stop the caller MUST call
/// [`begin_shutdown`](Self::begin_shutdown) BEFORE the pipeline's final
/// force-flush, then [`close_all`](Self::close_all).
pub struct ElevenLabsRealtimeSession {
    mic: StreamHandle,
    system: StreamHandle,
    /// Emitted once, guards the single permanent-degrade warning.
    warned: Arc<AtomicBool>,
    /// Set by [`begin_shutdown`](Self::begin_shutdown): suppresses all further
    /// transcript event emission from both streams.
    shutting_down: Arc<AtomicBool>,
    /// Retained so callers without an AppHandle (the pipeline) can raise a
    /// warning through the same bridge: see [`emit_warning`](Self::emit_warning).
    event_tx: mpsc::UnboundedSender<RealtimeEvent>,
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
        let shutting_down = Arc::new(AtomicBool::new(false));
        let url = Self::build_url(language_code.as_deref());

        let mic = Self::spawn_stream(
            transport.clone(),
            url.clone(),
            api_key.clone(),
            DeviceType::Microphone,
            event_tx.clone(),
            warned.clone(),
            shutting_down.clone(),
        );
        let system = Self::spawn_stream(
            transport,
            url,
            api_key,
            DeviceType::System,
            event_tx.clone(),
            warned.clone(),
            shutting_down.clone(),
        );

        Arc::new(Self {
            mic,
            system,
            warned,
            shutting_down,
            event_tx,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_stream(
        transport: Arc<dyn RealtimeTransport>,
        url: String,
        api_key: String,
        device_type: DeviceType,
        event_tx: mpsc::UnboundedSender<RealtimeEvent>,
        warned: Arc<AtomicBool>,
        shutting_down: Arc<AtomicBool>,
    ) -> StreamHandle {
        let ring = Arc::new(FeedRing::new(FEED_RING_CAP));
        // Start in Batch until the socket is up, so early audio isn't lost.
        let route = Arc::new(AtomicU8::new(ROUTE_BATCH));
        // Per-source monotonic partial sequence counter (owned by the task).
        let session_seq = Arc::new(AtomicU64::new(0));
        let commit_epoch = Arc::new(AtomicU64::new(0));
        let committed_through_bits = Arc::new(AtomicU64::new(0f64.to_bits()));

        let task_ring = ring.clone();
        let task_route = route.clone();
        let task_epoch = commit_epoch.clone();
        let task_through = committed_through_bits.clone();
        let join = tokio::spawn(async move {
            run_stream(
                transport,
                url,
                api_key,
                device_type,
                task_ring,
                task_route,
                session_seq,
                CommitProgress {
                    epoch: task_epoch,
                    through_bits: task_through,
                },
                event_tx,
                warned,
                shutting_down,
            )
            .await;
        });

        StreamHandle {
            ring,
            route,
            commit_epoch,
            committed_through_bits,
            join,
        }
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

    /// Hint the recording-relative anchor for the stream's current connection.
    /// Only the FIRST anchor after a (re)connect is used (see [`TimelineMapper`]);
    /// normally the first fed frame supplies it. Non-blocking.
    pub fn mark_onset(&self, device_type: &DeviceType, recording_secs: f64) {
        self.handle(device_type)
            .ring
            .push(FeedCmd::Onset(recording_secs));
    }

    /// Feed audio (16kHz mono f32) for a stream. Under the continuous-feed
    /// strategy this is EVERY window while the route is Realtime, silence
    /// included — the server's cross-utterance context is what buys the accuracy.
    /// `at_secs` is the recording-relative time of the first sample. Non-blocking
    /// (drop-oldest on overflow); safe to call from the audio pipeline thread.
    pub fn feed(&self, device_type: &DeviceType, samples: &[f32], at_secs: f64) {
        if samples.is_empty() {
            return;
        }
        self.handle(device_type).ring.push(FeedCmd::Audio {
            samples: samples.to_vec(),
            at_secs,
        });
    }

    /// Signal that this window carried no speech. A COMMIT CANDIDATE only: the
    /// per-connection [`CommitScheduler`] decides whether the gap actually
    /// commits (>= 30s uncommitted, outside the danger band, >= 1s of real audio
    /// behind it). The pipeline calls this on every silent window.
    pub fn segment_gap(&self, device_type: &DeviceType) {
        self.handle(device_type).ring.push(FeedCmd::SegmentGap);
    }

    /// Commit-point counter for a stream (see [`StreamHandle::commit_epoch`]).
    /// The pipeline clears the covered part of its shadow buffer when this
    /// advances. `Acquire` pairs with the `Release` bump so the pipeline's final
    /// pre-flush read is ordered against the emission that preceded it.
    pub fn commit_epoch(&self, device_type: &DeviceType) -> u64 {
        self.handle(device_type).commit_epoch.load(Ordering::Acquire)
    }

    /// Recording-relative time through which this stream's committed transcripts
    /// have been CONFIRMED. The pipeline drops exactly the shadow windows that
    /// end at or before this. Meaningful only alongside `commit_epoch`.
    pub fn committed_through_secs(&self, device_type: &DeviceType) -> f64 {
        f64::from_bits(
            self.handle(device_type)
                .committed_through_bits
                .load(Ordering::Acquire),
        )
    }

    /// Ask a stream to send its FINALIZE commit (recording stop). Whether one is
    /// actually sent is the [`CommitScheduler`]'s call: inside the danger band, or
    /// with no real audio outstanding, nothing is sent and the pipeline's batch
    /// flush of the shadow buffer is the tail transcription instead.
    pub fn finalize(&self, device_type: &DeviceType) {
        self.handle(device_type).ring.push(FeedCmd::Finalize);
    }

    /// Send the finalize commit on BOTH streams and wait (bounded) for the
    /// resulting committed replies to be emitted, so the common-case tail is
    /// transcribed by the accurate WS path. Returns when both streams have
    /// reported a confirmation or `timeout` elapses.
    pub async fn finalize_all(&self, timeout: Duration) {
        let before = [
            self.commit_epoch(&DeviceType::Microphone),
            self.commit_epoch(&DeviceType::System),
        ];
        self.finalize(&DeviceType::Microphone);
        self.finalize(&DeviceType::System);
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let done = self.commit_epoch(&DeviceType::Microphone) > before[0]
                && self.commit_epoch(&DeviceType::System) > before[1];
            if done || tokio::time::Instant::now() >= deadline {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    /// Number of audio frames shed under backpressure (diagnostics/tests).
    pub fn dropped_frames(&self, device_type: &DeviceType) -> u64 {
        self.handle(device_type).ring.dropped()
    }

    /// Whether the permanent-degrade warning has fired (tests/diagnostics).
    pub fn has_warned(&self) -> bool {
        self.warned.load(Ordering::Relaxed)
    }

    /// Surface a one-off transcription warning to the frontend through this
    /// session's event bridge. Used by the pipeline, which has no AppHandle of its
    /// own, e.g. when the shadow buffer hits its cap.
    pub fn emit_warning(&self, message: &str) {
        let _ = self.event_tx.send(RealtimeEvent::Warning {
            message: message.to_string(),
        });
    }

    /// Stop emitting transcript events from both streams, immediately and
    /// permanently.
    ///
    /// At recording stop this is called AFTER [`finalize_all`](Self::finalize_all)
    /// has had its bounded chance, and BEFORE the pipeline's force-flush. From
    /// here on the batch flush of the remaining shadow windows owns the tail, so
    /// a late commit reply covering that same audio must not also be emitted.
    /// Socket handling continues normally, only emission is suppressed.
    pub fn begin_shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
    }

    /// Whether [`begin_shutdown`](Self::begin_shutdown) has fired (tests).
    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    /// Close both connections. Sends no commit of its own: the staged stop path
    /// already had its chance via [`finalize_all`](Self::finalize_all), and a
    /// commit here could land inside the danger band.
    pub async fn close_all(self: Arc<Self>) {
        // Belt-and-braces: a caller that forgot begin_shutdown still must not
        // emit a late reply once we are tearing the sockets down.
        self.begin_shutdown();
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

/// How far this stream's EMITTED commits have covered the recording, published
/// for the pipeline's shadow buffer. The two fields are written together (epoch
/// last, with `Release`) so a reader that sees a new epoch also sees the matching
/// coverage time.
#[derive(Clone)]
struct CommitProgress {
    epoch: Arc<AtomicU64>,
    through_bits: Arc<AtomicU64>,
}

impl CommitProgress {
    /// Publish one emitted commit covering the recording up to `through_secs`.
    fn record(&self, through_secs: f64) {
        let prev = f64::from_bits(self.through_bits.load(Ordering::Relaxed));
        self.through_bits
            .store(through_secs.max(prev).to_bits(), Ordering::Relaxed);
        self.epoch.fetch_add(1, Ordering::Release);
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_stream(
    transport: Arc<dyn RealtimeTransport>,
    url: String,
    api_key: String,
    device_type: DeviceType,
    ring: Arc<FeedRing>,
    route: Arc<AtomicU8>,
    session_seq: Arc<AtomicU64>,
    progress: CommitProgress,
    event_tx: mpsc::UnboundedSender<RealtimeEvent>,
    warned: Arc<AtomicBool>,
    shutting_down: Arc<AtomicBool>,
) {
    let source = source_label(&device_type).to_string();
    let mut ladder = BackoffLadder::new();
    // Timeline mapper persists ACROSS reconnects so `last_commit_end` (the
    // monotonic floor, MAJOR-2b) and ordering survive a socket rotation. Its
    // per-connection SPAN MAP is reset per connection: a new server session
    // restarts the cumulative word clock at 0.
    let mut mapper = TimelineMapper::new();

    loop {
        match transport.connect(&url, &api_key).await {
            Ok(pair) => {
                ladder.reset();
                route.store(ROUTE_REALTIME, Ordering::Relaxed);
                info!("🎧 Realtime [{}] connected", source);
                mapper.reset_anchor();

                let outcome = duplex_loop(
                    pair,
                    &ring,
                    &session_seq,
                    &progress,
                    &event_tx,
                    &source,
                    &mut mapper,
                    &shutting_down,
                )
                .await;

                // Left the duplex loop: connection down (or asked to close).
                route.store(ROUTE_BATCH, Ordering::Relaxed);

                match outcome {
                    DuplexOutcome::Closed => {
                        info!("🎧 Realtime [{}] closed by request", source);
                        return;
                    }
                    DuplexOutcome::FatalError(kind) => {
                        degrade_permanently(
                            &kind,
                            &source,
                            &route,
                            &warned,
                            &event_tx,
                            &session_seq,
                            &shutting_down,
                        );
                        return;
                    }
                    DuplexOutcome::Disconnected => {
                        warn!("🎧 Realtime [{}] disconnected — will reconnect", source);
                        // Route flipped to Batch: clear the frozen volatile tail on
                        // the frontend by emitting an empty partial (MINOR-3).
                        emit_tail_clear(&event_tx, &source, &session_seq, &shutting_down);
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
                &shutting_down,
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
/// Suppressed once shutdown has begun, like every other transcript emission.
fn emit_tail_clear(
    event_tx: &mpsc::UnboundedSender<RealtimeEvent>,
    source: &str,
    session_seq: &Arc<AtomicU64>,
    shutting_down: &Arc<AtomicBool>,
) {
    if shutting_down.load(Ordering::SeqCst) {
        return;
    }
    let seq = session_seq.fetch_add(1, Ordering::SeqCst);
    let _ = event_tx.send(RealtimeEvent::Partial {
        source: source.to_string(),
        text: String::new(),
        session_seq: seq,
    });
}

#[allow(clippy::too_many_arguments)]
fn degrade_permanently(
    kind: &str,
    source: &str,
    route: &Arc<AtomicU8>,
    warned: &Arc<AtomicBool>,
    event_tx: &mpsc::UnboundedSender<RealtimeEvent>,
    session_seq: &Arc<AtomicU64>,
    shutting_down: &Arc<AtomicBool>,
) {
    route.store(ROUTE_BATCH, Ordering::Relaxed);
    warn!(
        "🎧 Realtime [{}] degraded permanently ({}) — continuing on batch path",
        source, kind
    );
    // Clear the frozen volatile tail for this source (MINOR-3).
    emit_tail_clear(event_tx, source, session_seq, shutting_down);
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

/// Seconds of audio represented by a frame of `n` samples at the feed rate.
fn frame_secs(n: usize) -> f64 {
    n as f64 / FEED_SAMPLE_RATE as f64
}

/// Send one REAL audio frame and record it in BOTH clocks.
///
/// Returns false if the socket died. `rec_start` is the recording-relative time
/// of the frame's first sample; recording the mapper span here (at send time,
/// not enqueue time) is what makes shed frames harmless to the timeline.
async fn send_real_frame(
    pair: &mut TransportPair,
    samples: &[f32],
    rec_start: f64,
    sched: &mut CommitScheduler,
    mapper: &mut TimelineMapper,
    last_audio: &mut tokio::time::Instant,
) -> bool {
    let secs = frame_secs(samples.len());
    let msg = encode_audio_chunk_message(samples, FEED_SAMPLE_RATE, false);
    if pair.outgoing.send(msg).await.is_err() {
        return false;
    }
    sched.on_fed_real(secs);
    mapper.note_sent_real(rec_start, secs);
    // Only a frame carrying actual audio bytes resets the server's idle timer.
    *last_audio = tokio::time::Instant::now();
    true
}

/// Collapse whitespace for comparing reconstructed text against the server's.
fn whitespace_normalized(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Emit the committed block, split into utterance-level segments at MAPPED
/// recording-time gaps, with per-segment times from the piecewise timeline map.
///
/// Returns the recording-relative time the block covers up to, for the shadow
/// buffer's windowed clear.
fn emit_committed(
    words: &[WordTiming],
    text: &str,
    mapper: &mut TimelineMapper,
    event_tx: &mpsc::UnboundedSender<RealtimeEvent>,
    source: &str,
    text_mismatch_warned: &mut bool,
) -> f64 {
    // Gaps are measured in RECORDING time, not server time: a pause bridged by
    // keepalive silence is a hole in the fed clock, so two utterances 40s apart in
    // the recording can be adjacent in server time. Splitting on the raw server
    // clock would merge them into one block whose mapped duration spans the pause.
    let mut segments = split_committed_on_gaps_mapped(words, UTTERANCE_SPLIT_GAP_SECS, |t| {
        mapper.map_time(t)
    });
    if segments.is_empty() {
        // No usable word timings: emit the block as one segment, positioned
        // monotonically after the previous commit.
        let (first, last) = word_bounds_secs(words);
        segments.push(Utterance {
            start: first,
            end: last,
            text: text.trim().to_string(),
        });
    }
    if segments.len() == 1 {
        // The server's own `text` is authoritative when there is nothing to split:
        // it carries the exact punctuation/spacing, which reconstruction can only
        // approximate.
        segments[0].text = text.trim().to_string();
    } else if !*text_mismatch_warned {
        let rebuilt = whitespace_normalized(
            &segments
                .iter()
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>()
                .join(" "),
        );
        if rebuilt != whitespace_normalized(text) {
            *text_mismatch_warned = true;
            // Text itself stays at debug! (privacy); only the fact is warned.
            warn!(
                "🎧 Realtime [{}] per-utterance reconstruction differs from the server text (lengths {} vs {}); splitting anyway",
                source,
                rebuilt.len(),
                whitespace_normalized(text).len()
            );
        }
    }
    let mut covered = 0.0f64;
    for seg in segments {
        let (start, end, dur) = mapper.map_word_span(seg.start, seg.end);
        covered = covered.max(end);
        debug!("🎧 Realtime [{}] committed: '{}'", source, seg.text);
        let _ = event_tx.send(RealtimeEvent::Committed {
            source: source.to_string(),
            text: seg.text,
            audio_start_time: start,
            audio_end_time: end,
            duration: dur,
        });
    }
    covered
}

/// The connected duplex loop: pump feed commands out, parse incoming events in,
/// and send silence keepalives during idle gaps.
#[allow(clippy::too_many_arguments)]
async fn duplex_loop(
    mut pair: TransportPair,
    ring: &Arc<FeedRing>,
    session_seq: &Arc<AtomicU64>,
    progress: &CommitProgress,
    event_tx: &mpsc::UnboundedSender<RealtimeEvent>,
    source: &str,
    mapper: &mut TimelineMapper,
    shutting_down: &Arc<AtomicBool>,
) -> DuplexOutcome {
    let mut slicer = FrameSlicer::new(FRAME_SAMPLES);
    // Fresh uncommitted clock: a new connection is a new server session.
    let mut sched = CommitScheduler::new();
    let mut last_audio = tokio::time::Instant::now();
    // Recording-relative time of the NEXT sample the slicer will emit. Re-derived
    // from every incoming window (`at_secs` minus whatever is still pending), so a
    // window shed by the FeedRing self-corrects on the next one instead of
    // accumulating error.
    let mut next_rec_time = 0.0f64;
    // Stall watchdog (M1): REAL audio fed since the last message of ANY kind from
    // the server. A healthy session emits ~1 partial/s while speech is flowing.
    let mut real_fed_since_server_msg = 0.0f64;
    let mut text_mismatch_warned = false;
    let mut ka_tick = tokio::time::interval(Duration::from_secs_f64(KEEPALIVE_TICK_SECS));
    ka_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            cmd = ring.recv() => {
                match cmd {
                    FeedCmd::Close => return DuplexOutcome::Closed,
                    FeedCmd::Onset(recording_secs) => {
                        mapper.mark_onset(recording_secs);
                    }
                    FeedCmd::Audio { samples, at_secs } => {
                        next_rec_time = (at_secs - frame_secs(slicer.pending())).max(0.0);
                        for frame in slicer.push(&samples) {
                            let secs = frame_secs(frame.len());
                            if !send_real_frame(
                                &mut pair, &frame, next_rec_time,
                                &mut sched, mapper, &mut last_audio,
                            ).await {
                                return DuplexOutcome::Disconnected;
                            }
                            next_rec_time += secs;
                            real_fed_since_server_msg += secs;
                        }
                        if real_fed_since_server_msg >= WATCHDOG_SECS {
                            // SERVER FACT 2 stall: the socket is fine, no send ever
                            // errors, but the server has gone silent. Nothing else
                            // detects this. Force a disconnect so the reconnect
                            // ladder runs: a new socket fully re-syncs the scheduler
                            // and mapper, and the pipeline's Realtime->Batch flip
                            // drains the shadow buffer through the batch path.
                            warn!(
                                "🎧 Realtime [{}] stall watchdog: {:.1}s of speech fed with no server response — reconnecting",
                                source, real_fed_since_server_msg
                            );
                            return DuplexOutcome::Disconnected;
                        }
                    }
                    FeedCmd::SegmentGap => {
                        // A speech gap: commit here ONLY if the scheduler says we
                        // are in the safe window. The slicer tail is included in the
                        // decision because it is flushed immediately before the
                        // commit, so the margin below the stall edge stays intact.
                        let pending = frame_secs(slicer.pending());
                        if sched.on_gap(pending) {
                            if !send_commit(
                                &mut pair, &mut slicer, &mut sched, mapper,
                                &mut last_audio, &mut next_rec_time, source, "gap",
                            ).await {
                                return DuplexOutcome::Disconnected;
                            }
                        }
                    }
                    FeedCmd::Finalize => {
                        // Recording stop. Same danger-band rule as a gap, minus the
                        // interval requirement: flush whatever is outstanding, but
                        // ONLY from outside the band. Inside it, sending nothing and
                        // letting the pipeline batch-flush the shadow is the only
                        // safe option (after stop no more audio is fed, so the
                        // server would never auto-commit the tail either).
                        let pending = frame_secs(slicer.pending());
                        if sched.finalize_should_commit(pending) {
                            if !send_commit(
                                &mut pair, &mut slicer, &mut sched, mapper,
                                &mut last_audio, &mut next_rec_time, source, "finalize",
                            ).await {
                                return DuplexOutcome::Disconnected;
                            }
                        } else {
                            info!(
                                "🎧 Realtime [{}] finalize skipped ({:.1}s uncommitted, {:.1}s real) — batch flush owns the tail",
                                source, sched.uncommitted_secs(), sched.real_secs()
                            );
                        }
                    }
                }
            }
            maybe_msg = pair.incoming.recv() => {
                match maybe_msg {
                    None => return DuplexOutcome::Disconnected,
                    Some(raw) => {
                        // ANY message proves the server is alive.
                        real_fed_since_server_msg = 0.0;
                        let suppressed = shutting_down.load(Ordering::SeqCst);
                        match parse_server_message(&raw) {
                            ServerMsg::Partial { text } => {
                                if !text.trim().is_empty() && !suppressed {
                                    let seq = session_seq.fetch_add(1, Ordering::SeqCst);
                                    let _ = event_tx.send(RealtimeEvent::Partial {
                                        source: source.to_string(),
                                        text,
                                        session_seq: seq,
                                    });
                                }
                            }
                            ServerMsg::Committed { text, words } => {
                                // C1 re-sync: bound the predictive clock's error to
                                // one cycle. Runs whether or not we emit.
                                sched.on_committed_received();
                                if suppressed {
                                    // Shutting down: this reply is DROPPED, so the
                                    // audio it covers is not transcribed by us. The
                                    // epoch must NOT advance, or the pipeline would
                                    // drop shadow windows for a tail that the stop
                                    // flush is about to transcribe.
                                } else if !text.trim().is_empty() {
                                    let covered = emit_committed(
                                        &words, &text, mapper, event_tx, source,
                                        &mut text_mismatch_warned,
                                    );
                                    // The epoch tracks EMISSION, never mere receipt:
                                    // see StreamHandle::commit_epoch for why the
                                    // paired plain variant must not bump it.
                                    progress.record(covered);
                                } else {
                                    // Empty commit (e.g. an auto-commit over
                                    // silence): nothing to persist, but the
                                    // frontend's volatile tail is now stale.
                                    emit_tail_clear(
                                        event_tx, source, session_seq, shutting_down,
                                    );
                                }
                            }
                            ServerMsg::CommittedPlain => {
                                // 1:1 paired with the timestamps variant (12/12 in
                                // the spike logs) and never emitted, so it must NOT
                                // bump the epoch: if it did and shutdown landed in
                                // the ~0.1-0.35s between the pair, the timestamps
                                // variant would be suppressed while the epoch claimed
                                // the audio was transcribed, and the block would exist
                                // nowhere. It still re-syncs the clock, which is pure
                                // safety. A server that sends ONLY this variant is
                                // covered by the stall watchdog.
                                sched.on_committed_received();
                            }
                            ServerMsg::Error { kind, fatal } => {
                                if fatal {
                                    return DuplexOutcome::FatalError(kind);
                                }
                                warn!("🎧 Realtime [{}] transient error event: {}", source, kind);
                            }
                            ServerMsg::SessionStarted | ServerMsg::Other => {}
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
                    // Counts toward the server's auto-commit boundary (it counts
                    // every fed sample) but NOT toward arming a commit, and adds no
                    // timeline span: no recording time elapsed for these samples.
                    // It also does not feed the stall watchdog, which is about
                    // SPEECH going unanswered.
                    let secs = frame_secs(KEEPALIVE_SILENCE_SAMPLES);
                    sched.on_fed_keepalive(secs);
                    mapper.note_sent_keepalive(secs);
                    last_audio = tokio::time::Instant::now();
                    debug!("🎧 Realtime [{}] silence keepalive", source);
                }
            }
        }
    }
}

/// Flush the slicer tail, then send one `commit:true` frame and reset the
/// scheduler at SEND time. Returns false if the socket died.
#[allow(clippy::too_many_arguments)]
async fn send_commit(
    pair: &mut TransportPair,
    slicer: &mut FrameSlicer,
    sched: &mut CommitScheduler,
    mapper: &mut TimelineMapper,
    last_audio: &mut tokio::time::Instant,
    next_rec_time: &mut f64,
    source: &str,
    reason: &str,
) -> bool {
    let pending = frame_secs(slicer.pending());
    let tail = slicer.drain();
    if !tail.is_empty()
        && !send_real_frame(pair, &tail, *next_rec_time, sched, mapper, last_audio).await
    {
        return false;
    }
    *next_rec_time += pending;
    let commit_msg = encode_audio_chunk_message(&[], FEED_SAMPLE_RATE, true);
    if pair.outgoing.send(commit_msg).await.is_err() {
        return false;
    }
    debug!(
        "🎧 Realtime [{}] {} commit at {:.1}s uncommitted ({:.1}s real)",
        source,
        reason,
        sched.uncommitted_secs(),
        sched.real_secs()
    );
    // Reset at SEND: a second gap arriving before the reply must not fire a
    // back-to-back commit. A commit frame carries no audio, so `last_audio` is
    // deliberately NOT touched (that could push the next keepalive past the
    // server's ~15.7s idle close).
    sched.on_client_commit();
    true
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

    /// Feed `secs` of contiguous real audio into a mapper in 250ms frames,
    /// starting at recording time `rec_start`.
    fn feed_mapper(m: &mut TimelineMapper, rec_start: f64, secs: f64) {
        let step = 0.25;
        let n = (secs / step).round() as usize;
        for i in 0..n {
            m.note_sent_real(rec_start + i as f64 * step, step);
        }
    }

    #[test]
    fn timeline_maps_absolute_from_fed_spans() {
        // Continuous feed starting at recording second 120: the server's cumulative
        // t=0 is recording 120.0, so word times add straight on.
        let mut m = TimelineMapper::new();
        feed_mapper(&mut m, 120.0, 2.0);
        let words = vec![w("okay", 0.0, 0.34), w("then", 0.5, 0.9)];
        let (start, end, dur) = m.map_commit(&words);
        assert!((start - 120.0).abs() < 1e-6, "got {}", start);
        assert!((dur - 0.9).abs() < 1e-6);
        assert!((end - 120.9).abs() < 1e-6);
    }

    #[test]
    fn timeline_contiguous_frames_collapse_into_one_span() {
        // The common case must not grow one span per 250ms frame.
        let mut m = TimelineMapper::new();
        feed_mapper(&mut m, 0.0, 30.0);
        assert_eq!(m.span_count(), 1, "contiguous frames must coalesce");
        assert!((m.fed_cursor() - 30.0).abs() < 1e-6);
    }

    #[test]
    fn timeline_survives_ring_shedding_without_drift() {
        // FINDING 4a: a stalled socket sheds whole windows from the FeedRing. The
        // route does NOT flip (it only flips on a send error), so under the old
        // single-anchor map every later word drifted by the total shed duration.
        // With per-SENT-frame spans the fed clock simply skips the hole.
        let mut m = TimelineMapper::new();
        feed_mapper(&mut m, 0.0, 10.0); // recording 0..10 == fed 0..10
        // 80s of recording shed (nothing sent), then the feed resumes at rec 90.
        feed_mapper(&mut m, 90.0, 5.0); // recording 90..95 == fed 10..15
        assert_eq!(m.span_count(), 2);

        // A word the server timestamps at cumulative 12.0 is really recording 92.0.
        let (start, _end, _dur) = m.map_word_span(12.0, 12.5);
        assert!(
            (start - 92.0).abs() < 0.6,
            "shed window must not drift the map: got {}",
            start
        );
    }

    #[test]
    fn timeline_survives_pause_keepalives_without_drift() {
        // FINDING 4b: during a recording pause the fed clock keeps advancing on
        // keepalive silence (~1.65s per 60s of pause) while recording time freezes.
        // Keepalives add no span, so they cannot shift later words.
        let mut m = TimelineMapper::new();
        feed_mapper(&mut m, 0.0, 20.0); // recording 0..20 == fed 0..20
        for _ in 0..6 {
            m.note_sent_keepalive(0.25); // 1.5s of keepalive during a 60s pause
        }
        feed_mapper(&mut m, 80.0, 5.0); // recording 80..85 == fed 21.5..26.5

        let (start, _end, _dur) = m.map_word_span(22.0, 22.5);
        assert!(
            (start - 80.5).abs() < 0.6,
            "keepalive silence must not drift the map: got {}",
            start
        );
    }

    #[test]
    fn timeline_clamps_a_time_inside_a_keepalive_hole_to_the_preceding_edge() {
        // m10: a surviving mutant proved this was untested — if keepalives wrongly
        // recorded a span, a word timed inside the hole would map into the middle
        // of the pause instead of to the last real audio before it.
        let mut m = TimelineMapper::new();
        feed_mapper(&mut m, 0.0, 4.0); // rec 0..4 == fed 0..4
        m.note_sent_keepalive(0.25);
        m.note_sent_keepalive(0.25);
        m.note_sent_keepalive(0.25);
        m.note_sent_keepalive(0.25); // fed 4..5 is a HOLE (no recording time)
        feed_mapper(&mut m, 70.0, 3.0); // rec 70..73 == fed 5..8

        // Exactly one span before the hole and one after: keepalives add none.
        assert_eq!(m.span_count(), 2, "keepalives must not record spans");
        // fed 4.5 sits inside the hole -> clamps to the end of the preceding span.
        assert!(
            (m.map_time(4.5) - 4.0).abs() < 1e-6,
            "hole must clamp to the preceding edge, got {}",
            m.map_time(4.5)
        );
        // The boundary itself and just after resolve to the two real spans.
        assert!((m.map_time(4.0) - 4.0).abs() < 1e-6);
        assert!((m.map_time(5.1) - 70.1).abs() < 1e-6);
    }

    #[test]
    fn timeline_clamps_times_landing_in_a_hole_or_past_the_end() {
        let mut m = TimelineMapper::new();
        feed_mapper(&mut m, 0.0, 2.0); // rec 0..2 == fed 0..2
        feed_mapper(&mut m, 50.0, 2.0); // rec 50..52 == fed 2..4
        // fed 1.9 is inside the first span.
        assert!((m.map_time(1.9) - 1.9).abs() < 1e-6);
        // fed 2.1 is inside the second span -> rec 50.1.
        assert!((m.map_time(2.1) - 50.1).abs() < 1e-6);
        // Past everything recorded -> clamps to the last span's end.
        assert!((m.map_time(99.0) - 52.0).abs() < 1e-6);
        // Before anything recorded -> clamps to the first span's start.
        assert!((m.map_time(-5.0) - 0.0).abs() < 1e-6);
    }

    #[test]
    fn timeline_resets_per_connection_and_never_regresses() {
        // MAJOR-2b retained: a reconnect restarts the server's cumulative clock at
        // 0, so the span map is dropped, but `last_commit_end` is kept as a
        // monotonic floor so audio_start_time ASC ordering can never break.
        let mut m = TimelineMapper::new();
        feed_mapper(&mut m, 10.0, 6.0);
        let (_s1, e1, _d1) = m.map_commit(&[w("one", 0.0, 5.0)]); // 10.0..15.0
        assert!((e1 - 15.0).abs() < 1e-6);

        // Reconnect: the new session's cumulative clock restarts at 0.
        m.reset_anchor();
        assert_eq!(m.span_count(), 0);
        feed_mapper(&mut m, 20.0, 3.0);
        let (s2, e2, _d2) = m.map_commit(&[w("two", 1.0, 1.5)]);
        assert!((s2 - 21.0).abs() < 1e-6, "got {}", s2);
        assert!((e2 - 21.5).abs() < 1e-6);

        // Pathological: a reconnect whose feed starts EARLIER than the last commit
        // end must still not place the commit behind it (duration preserved).
        m.reset_anchor();
        feed_mapper(&mut m, 5.0, 2.0);
        let (s3, e3, d3) = m.map_commit(&[w("three", 0.0, 0.4)]);
        assert!((s3 - 21.5).abs() < 1e-6, "must clamp forward, got {}", s3);
        assert!((e3 - 21.9).abs() < 1e-6);
        assert!((d3 - 0.4).abs() < 1e-6);
    }

    #[test]
    fn timeline_prunes_old_spans_but_keeps_the_map_usable() {
        let mut m = TimelineMapper::new();
        // 100 disjoint 1s spans -> 100 spans, but only ~90s of fed history is kept.
        for i in 0..100 {
            m.note_sent_real(i as f64 * 10.0, 1.0);
        }
        assert!(
            m.span_count() <= 92,
            "history must be pruned, got {} spans",
            m.span_count()
        );
        // The most recent span still maps exactly.
        assert!((m.map_time(99.5) - 990.5).abs() < 1e-6);
    }

    #[test]
    fn timeline_initial_no_span_edge_is_zero_then_monotonic() {
        // Defensive: the ONLY way map_commit yields start 0.0 is the true initial
        // state — no frame ever sent AND no prior commit. In normal operation the
        // first sent frame records a span before any commit can arrive, so this is
        // unreachable live. Prove the fallback stays sane (monotonic, never
        // negative) even here.
        let mut m = TimelineMapper::new();
        let (s0, e0, d0) = m.map_commit(&[w("x", 0.0, 0.5)]);
        assert_eq!(s0, 0.0);
        assert!((e0 - 0.5).abs() < 1e-9);
        assert!((d0 - 0.5).abs() < 1e-9);
        let (s1, e1, _d1) = m.map_commit(&[w("y", 0.0, 0.3)]);
        assert!(s1 >= e0, "must not regress: {} < {}", s1, e0);
        assert!((s1 - 0.5).abs() < 1e-9);
        assert!((e1 - 0.8).abs() < 1e-9);
    }

    // ---- utterance splitting (finding 6) ----------------------------------

    #[test]
    fn split_breaks_a_committed_block_at_a_long_word_gap() {
        let words = vec![
            w("hello", 1.0, 1.4),
            WordTiming {
                text: " ".into(),
                start: Some(1.4),
                end: Some(1.5),
                word_type: Some("spacing".into()),
            },
            w("there", 1.5, 1.9),
            // 1.5s of silence -> new utterance.
            w("okay", 3.4, 3.8),
            w("then", 3.9, 4.3),
        ];
        let segs = split_committed_on_gaps(&words, UTTERANCE_SPLIT_GAP_SECS);
        assert_eq!(segs.len(), 2, "{:?}", segs);
        assert_eq!(segs[0].text, "hello there");
        assert!((segs[0].start - 1.0).abs() < 1e-9);
        assert!((segs[0].end - 1.9).abs() < 1e-9);
        assert_eq!(segs[1].text, "okay then");
        assert!((segs[1].start - 3.4).abs() < 1e-9);
        assert!((segs[1].end - 4.3).abs() < 1e-9);
    }

    #[test]
    fn split_keeps_a_gapless_block_whole_and_handles_no_timings() {
        let words = vec![w("one", 0.0, 0.4), w("two", 0.6, 1.0)];
        let segs = split_committed_on_gaps(&words, UTTERANCE_SPLIT_GAP_SECS);
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].text, "one two");
        // No timings at all -> a single segment, no panic.
        let untimed = vec![WordTiming {
            text: "hi".into(),
            start: None,
            end: None,
            word_type: Some("word".into()),
        }];
        let segs = split_committed_on_gaps(&untimed, UTTERANCE_SPLIT_GAP_SECS);
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].text, "hi");
        // Empty input -> no segments (the caller falls back to one block).
        assert!(split_committed_on_gaps(&[], UTTERANCE_SPLIT_GAP_SECS).is_empty());
    }

    #[test]
    fn split_uses_mapped_recording_time_not_server_time() {
        // m3: a pause bridged by keepalives is a HOLE in the fed clock, so two
        // utterances 60s apart in the recording are ADJACENT in server time.
        // Splitting on the raw server clock leaves one block whose mapped duration
        // wrongly spans the whole pause.
        let mut m = TimelineMapper::new();
        feed_mapper(&mut m, 0.0, 2.0); // rec 0..2 == fed 0..2
        for _ in 0..8 {
            m.note_sent_keepalive(0.25); // fed 2..4 is a hole (60s of pause)
        }
        feed_mapper(&mut m, 62.0, 2.0); // rec 62..64 == fed 4..6

        // In SERVER time these words are 2.1 apart... but only 0.1s apart once the
        // hole is removed, so the raw-clock split would fire and the mapped split
        // must not. And the reverse case below.
        let words = vec![w("before", 1.0, 1.8), w("after", 4.1, 4.6)];
        let server_split = split_committed_on_gaps(&words, UTTERANCE_SPLIT_GAP_SECS);
        let mapped_split =
            split_committed_on_gaps_mapped(&words, UTTERANCE_SPLIT_GAP_SECS, |t| m.map_time(t));
        assert_eq!(server_split.len(), 2, "server clock sees a 2.3s gap");
        assert_eq!(
            mapped_split.len(), 2,
            "recording clock sees a 60s gap: still two utterances"
        );
        // The mapped ends are what matter: the second utterance must be placed
        // after the pause, not stretched across it.
        let (s0, e0, _) = m.map_word_span(mapped_split[0].start, mapped_split[0].end);
        let (s1, _e1, d1) = m.map_word_span(mapped_split[1].start, mapped_split[1].end);
        assert!((s0 - 1.0).abs() < 1e-6);
        assert!((e0 - 1.8).abs() < 1e-6);
        assert!((s1 - 62.1).abs() < 1e-6, "got {}", s1);
        assert!(d1 < 1.0, "duration must not span the pause, got {}", d1);
    }

    #[test]
    fn split_does_not_break_words_that_only_look_far_apart_on_the_server_clock() {
        // The complementary case: adjacent speech whose SERVER gap is inflated by
        // nothing (no hole) must behave identically under both splitters.
        let mut m = TimelineMapper::new();
        feed_mapper(&mut m, 10.0, 6.0);
        let words = vec![w("one", 0.5, 0.9), w("two", 1.1, 1.6)];
        let a = split_committed_on_gaps(&words, UTTERANCE_SPLIT_GAP_SECS);
        let b = split_committed_on_gaps_mapped(&words, UTTERANCE_SPLIT_GAP_SECS, |t| m.map_time(t));
        assert_eq!(a.len(), 1);
        assert_eq!(a, b);
    }

    #[test]
    fn split_sub_segments_map_to_separate_timeline_slots() {
        let mut m = TimelineMapper::new();
        feed_mapper(&mut m, 100.0, 10.0); // rec 100..110 == fed 0..10
        let words = vec![w("a", 1.0, 1.4), w("b", 4.0, 4.4)];
        let segs = split_committed_on_gaps(&words, UTTERANCE_SPLIT_GAP_SECS);
        assert_eq!(segs.len(), 2);
        let (s0, e0, _) = m.map_word_span(segs[0].start, segs[0].end);
        let (s1, e1, _) = m.map_word_span(segs[1].start, segs[1].end);
        assert!((s0 - 101.0).abs() < 1e-6);
        assert!((e0 - 101.4).abs() < 1e-6);
        assert!((s1 - 104.0).abs() < 1e-6, "got {}", s1);
        assert!((e1 - 104.4).abs() < 1e-6);
        assert!(s1 >= e0, "sub-segments must stay ordered");
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
    fn stop_flush_now_covers_realtime_streams_too() {
        // CONTRACT CHANGE (finding 1): there is no safe WS finalize commit, so the
        // shadow buffer is the authoritative tail transcription for EVERY stream.
        assert!(should_batch_flush_on_stop(Some(Route::Realtime)));
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
        let audio = |v: f32, at: f64| FeedCmd::Audio {
            samples: vec![v],
            at_secs: at,
        };
        let ring = FeedRing::new(3);
        ring.push(FeedCmd::Onset(1.0));
        ring.push(audio(1.0, 0.0));
        ring.push(audio(2.0, 1.0));
        // Overflow: should evict the OLDEST Audio (the vec![1.0]), keep Onset.
        ring.push(audio(3.0, 2.0));
        assert_eq!(ring.dropped(), 1);

        let a = ring.recv().await;
        assert!(matches!(a, FeedCmd::Onset(x) if (x - 1.0).abs() < 1e-9));
        let b = ring.recv().await;
        assert!(matches!(b, FeedCmd::Audio { ref samples, .. } if samples == &vec![2.0]));
        let c = ring.recv().await;
        assert!(matches!(c, FeedCmd::Audio { ref samples, .. } if samples == &vec![3.0]));
    }

    #[tokio::test]
    async fn feed_ring_coalesces_gaps_and_evicts_them_before_audio() {
        // m1: silent windows push Audio + SegmentGap each. With gaps neither
        // coalesced nor preferentially evicted, a backed-up ring converged to all
        // gap signals and zero audio, halving the effective queue depth and then
        // starving the socket entirely.
        let ring = FeedRing::new(4);
        ring.push(FeedCmd::SegmentGap);
        ring.push(FeedCmd::SegmentGap);
        ring.push(FeedCmd::SegmentGap);
        let gaps = {
            let q = ring.q.lock().unwrap();
            q.iter().filter(|c| matches!(c, FeedCmd::SegmentGap)).count()
        };
        assert_eq!(gaps, 1, "a queued gap must absorb later ones");

        // Fill with audio, then overflow: the GAP is the first victim.
        for i in 0..3 {
            ring.push(FeedCmd::Audio {
                samples: vec![i as f32],
                at_secs: i as f64,
            });
        }
        ring.push(FeedCmd::Audio {
            samples: vec![99.0],
            at_secs: 9.0,
        });
        let (gaps, audio) = {
            let q = ring.q.lock().unwrap();
            (
                q.iter().filter(|c| matches!(c, FeedCmd::SegmentGap)).count(),
                q.iter()
                    .filter(|c| matches!(c, FeedCmd::Audio { .. }))
                    .count(),
            )
        };
        assert_eq!(gaps, 0, "the gap must be evicted before any audio");
        assert_eq!(audio, 4, "all four audio windows survive");
    }

    #[tokio::test]
    async fn feed_ring_never_evicts_finalize_or_close() {
        let ring = FeedRing::new(2);
        ring.push(FeedCmd::Finalize);
        ring.push(FeedCmd::Audio {
            samples: vec![1.0],
            at_secs: 0.0,
        });
        ring.push(FeedCmd::Close);
        let q = ring.q.lock().unwrap();
        assert!(q.iter().any(|c| matches!(c, FeedCmd::Finalize)));
        assert!(q.iter().any(|c| matches!(c, FeedCmd::Close)));
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
        // Bound (not `_`) so the session stays alive for the whole test.
        let _session =
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
        /// Send a `partial_transcript` back after every N frames we receive, so
        /// the stall watchdog stays quiet (a live server emits ~1 partial/s while
        /// speech flows). `None` models a server that never answers, which is
        /// exactly what the watchdog exists to catch.
        heartbeat_every: Option<usize>,
        /// Deliver `incoming` only after this many frames have been received, so a
        /// canned commit can land AFTER some audio has been fed (delivering it at
        /// connect time would map against an empty timeline). 0 = immediately.
        incoming_after_frames: usize,
    }

    impl CapturingTransport {
        /// Responsive server: heartbeats every 4 frames (= 1s of audio).
        fn responsive(sent: Arc<Mutex<Vec<String>>>, incoming: Vec<String>) -> Self {
            Self {
                sent,
                incoming,
                heartbeat_every: Some(4),
                incoming_after_frames: 0,
            }
        }

        /// Responsive server whose canned messages arrive only after `after`
        /// frames of audio have been fed.
        fn responsive_after(
            sent: Arc<Mutex<Vec<String>>>,
            incoming: Vec<String>,
            after: usize,
        ) -> Self {
            Self {
                sent,
                incoming,
                heartbeat_every: Some(4),
                incoming_after_frames: after,
            }
        }
    }

    #[async_trait]
    impl RealtimeTransport for CapturingTransport {
        async fn connect(&self, _url: &str, _api_key: &str) -> Result<TransportPair, String> {
            let (out_tx, mut out_rx) = mpsc::channel::<String>(64);
            let (in_tx, in_rx) = mpsc::channel::<String>(512);
            let sent = self.sent.clone();
            let heartbeat_every = self.heartbeat_every;
            let after = self.incoming_after_frames;
            let deferred = if after > 0 {
                self.incoming.clone()
            } else {
                Vec::new()
            };
            let hb_tx = in_tx.clone();
            tokio::spawn(async move {
                let mut n = 0usize;
                while let Some(m) = out_rx.recv().await {
                    sent.lock().unwrap().push(m);
                    n += 1;
                    if let Some(every) = heartbeat_every {
                        if n % every == 0 {
                            let _ = hb_tx
                                .send(
                                    r#"{"message_type":"partial_transcript","text":"hb"}"#
                                        .to_string(),
                                )
                                .await;
                        }
                    }
                    if after > 0 && n == after {
                        for m in deferred.iter() {
                            let _ = hb_tx.send(m.clone()).await;
                        }
                    }
                }
            });
            let incoming = if after > 0 {
                Vec::new()
            } else {
                self.incoming.clone()
            };
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

    /// Samples of continuous feed audio worth `secs` seconds at the feed rate.
    fn feed_secs(secs: f64) -> Vec<f32> {
        vec![0.1f32; (secs * FEED_SAMPLE_RATE as f64) as usize]
    }

    /// Drive the paused clock so the spawned stream tasks make progress.
    async fn pump(steps: usize, step_ms: u64) {
        for _ in 0..steps {
            tokio::time::advance(Duration::from_millis(step_ms)).await;
            tokio::task::yield_now().await;
        }
    }

    /// Feed `secs` of audio the way the pipeline does: one 600ms window per call,
    /// pumping between them. Feeding it as a single giant command would let the
    /// duplex loop push tens of seconds of frames without ever returning to its
    /// select, which is neither realistic nor how the stall watchdog is meant to
    /// see the world.
    async fn feed_windows(
        session: &Arc<ElevenLabsRealtimeSession>,
        device_type: &DeviceType,
        secs: f64,
        start: f64,
    ) {
        const WIN: f64 = 0.6;
        let window = feed_secs(WIN);
        let n = (secs / WIN).round() as usize;
        for i in 0..n {
            session.feed(device_type, &window, start + i as f64 * WIN);
            pump(2, 5).await;
        }
        pump(4, 10).await;
    }

    #[tokio::test(start_paused = true)]
    async fn segment_gap_before_interval_never_commits() {
        // CONTRACT CHANGE (continuous feed): a VAD segment end is a commit
        // CANDIDATE, not a commit. With only ~1s of uncommitted audio the
        // scheduler must stay quiet — the old engine committed here, which is
        // exactly the 6.31% pooled-WER behaviour the study replaced.
        let sent = Arc::new(Mutex::new(Vec::<String>::new()));
        let transport = Arc::new(CapturingTransport::responsive(sent.clone(), vec![]));
        let (tx, _rx) = mpsc::unbounded_channel::<RealtimeEvent>();
        let session =
            ElevenLabsRealtimeSession::start_with_transport(transport, "k".into(), None, tx);
        pump(1, 10).await;

        feed_windows(&session, &DeviceType::Microphone, 1.0, 0.0).await;
        session.segment_gap(&DeviceType::Microphone);
        pump(10, 20).await;

        assert_eq!(count_commits(&sent), 0, "no commit below the 30s interval");
    }

    #[tokio::test(start_paused = true)]
    async fn segment_gap_past_interval_commits_once() {
        // >= COMMIT_INTERVAL_SECS of uncommitted feed and still clear of the
        // danger band -> the first gap commits, and the counter reset means a
        // second gap right after does NOT produce a back-to-back commit.
        let sent = Arc::new(Mutex::new(Vec::<String>::new()));
        let transport = Arc::new(CapturingTransport::responsive(sent.clone(), vec![]));
        let (tx, _rx) = mpsc::unbounded_channel::<RealtimeEvent>();
        let session =
            ElevenLabsRealtimeSession::start_with_transport(transport, "k".into(), None, tx);
        pump(1, 10).await;

        feed_windows(&session, &DeviceType::Microphone, 31.0, 0.0).await;
        pump(40, 20).await;
        assert_eq!(count_commits(&sent), 0, "feeding alone never commits");

        session.segment_gap(&DeviceType::Microphone);
        session.segment_gap(&DeviceType::Microphone);
        pump(20, 20).await;
        assert_eq!(
            count_commits(&sent),
            1,
            "exactly one gap commit: {:?}",
            sent.lock().unwrap().len()
        );
        // CONTRACT CHANGE (finding 5): sending a commit does NOT advance the
        // epoch. Only a CONFIRMED commit does, and this stub never replies.
        assert_eq!(session.commit_epoch(&DeviceType::Microphone), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn segment_gap_inside_danger_band_never_commits() {
        // SERVER FACT 2: past FORCE_CUTOFF_SECS a client commit would land within
        // DANGER_GUARD_SECS of the server's ~36.5s auto-commit and stall the
        // session. The scheduler must go silent and let the auto-commit land.
        let sent = Arc::new(Mutex::new(Vec::<String>::new()));
        let transport = Arc::new(CapturingTransport::responsive(sent.clone(), vec![]));
        let (tx, _rx) = mpsc::unbounded_channel::<RealtimeEvent>();
        let session =
            ElevenLabsRealtimeSession::start_with_transport(transport, "k".into(), None, tx);
        pump(1, 10).await;

        // 34.0s > FORCE_CUTOFF_SECS (33.5) with no gap along the way.
        feed_windows(&session, &DeviceType::Microphone, 34.0, 0.0).await;
        pump(40, 20).await;
        session.segment_gap(&DeviceType::Microphone);
        pump(20, 20).await;

        assert_eq!(count_commits(&sent), 0, "must not commit in the danger band");
    }

    #[tokio::test(start_paused = true)]
    async fn commit_epoch_advances_only_on_emitted_commits() {
        // FINDING 5: the epoch means "a transcript covers this audio". Never at
        // send time (the shadow must survive the round trip).
        let sent = Arc::new(Mutex::new(Vec::<String>::new()));
        let transport = Arc::new(CapturingTransport::responsive(sent.clone(), vec![]));
        let (tx, _rx) = mpsc::unbounded_channel::<RealtimeEvent>();
        let session =
            ElevenLabsRealtimeSession::start_with_transport(transport, "k".into(), None, tx);
        pump(1, 10).await;

        feed_windows(&session, &DeviceType::Microphone, 31.0, 0.0).await;
        pump(40, 20).await;
        session.segment_gap(&DeviceType::Microphone);
        pump(20, 20).await;
        assert_eq!(count_commits(&sent), 1, "gap commit should be sent");
        assert_eq!(
            session.commit_epoch(&DeviceType::Microphone),
            0,
            "sending a commit must NOT advance the epoch"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn only_the_emitted_timestamps_variant_bumps_the_epoch() {
        // M2: the server sends the plain and timestamps variants ~0.1-0.35s apart
        // for EVERY commit (12/12 in the spike logs). Exactly one bump, from the
        // one we actually emit.
        let sent = Arc::new(Mutex::new(Vec::<String>::new()));
        let transport = Arc::new(CapturingTransport::responsive(sent.clone(), vec![
                r#"{"message_type":"committed_transcript","text":"a"}"#.into(),
                r#"{"message_type":"committed_transcript_with_timestamps","text":"a","words":[{"text":"a","start":0.0,"end":0.4,"type":"word"}]}"#.into(),
            ]));
        let (tx, _rx) = mpsc::unbounded_channel::<RealtimeEvent>();
        let session =
            ElevenLabsRealtimeSession::start_with_transport(transport, "k".into(), None, tx);
        pump(40, 20).await;
        assert_eq!(
            session.commit_epoch(&DeviceType::Microphone),
            1,
            "one bump per COMMIT, not per message"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_between_the_paired_variants_loses_nothing() {
        // M2, the proven losing ordering: plain arrives, shutdown lands, then the
        // timestamps variant is suppressed. If the plain one had bumped the epoch,
        // the pipeline would drop the shadow windows at the stop flush while the
        // text was never emitted, and the block would exist NOWHERE.
        let sent = Arc::new(Mutex::new(Vec::<String>::new()));
        let transport = Arc::new(CapturingTransport::responsive(
            sent.clone(),
            vec![r#"{"message_type":"committed_transcript","text":"the last sentence"}"#.into()],
        ));
        let (tx, mut rx) = mpsc::unbounded_channel::<RealtimeEvent>();
        let session =
            ElevenLabsRealtimeSession::start_with_transport(transport, "k".into(), None, tx);
        pump(20, 20).await;
        // Only the plain variant has arrived so far.
        assert_eq!(
            session.commit_epoch(&DeviceType::Microphone),
            0,
            "the plain variant alone must never claim coverage"
        );
        // Shutdown lands in the gap; the timestamps variant would now be dropped.
        session.begin_shutdown();
        pump(20, 20).await;
        assert_eq!(
            session.commit_epoch(&DeviceType::Microphone),
            0,
            "still no coverage claimed, so the shadow survives for the batch flush"
        );
        // And nothing was emitted, so there is nothing to duplicate either.
        let mut committed = 0;
        while let Ok(ev) = rx.try_recv() {
            if matches!(ev, RealtimeEvent::Committed { .. }) {
                committed += 1;
            }
        }
        assert_eq!(committed, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn emitted_commit_publishes_its_coverage_time() {
        // M4: the pipeline drops exactly the shadow windows this covers.
        let sent = Arc::new(Mutex::new(Vec::<String>::new()));
        // The commit lands after 12 frames (3s) of audio, so the timeline map
        // already covers the words it timestamps.
        let transport = Arc::new(CapturingTransport::responsive_after(sent.clone(), vec![
                r#"{"message_type":"committed_transcript_with_timestamps","text":"hi","words":[{"text":"hi","start":1.0,"end":2.0,"type":"word"}]}"#.into(),
            ], 12));
        let (tx, _rx) = mpsc::unbounded_channel::<RealtimeEvent>();
        let session =
            ElevenLabsRealtimeSession::start_with_transport(transport, "k".into(), None, tx);
        pump(1, 10).await;
        // Feed from recording second 100 so the mapping is unambiguous.
        feed_windows(&session, &DeviceType::Microphone, 5.0, 100.0).await;
        pump(40, 20).await;
        assert_eq!(session.commit_epoch(&DeviceType::Microphone), 1);
        let through = session.committed_through_secs(&DeviceType::Microphone);
        assert!(
            (through - 102.0).abs() < 0.6,
            "coverage should map to ~102s, got {}",
            through
        );
    }

    #[tokio::test(start_paused = true)]
    async fn predicted_auto_commit_rearms_without_any_committed_event() {
        // FINDING 3: a server that emits partials but never a committed event (its
        // auto-commits going unreported) used to leave the scheduler disarmed
        // forever past the cutoff. The predictive reset must re-arm it purely on
        // the fed clock. The partials keep the stall watchdog quiet, which is what
        // separates "alive but quiet about commits" from "dead".
        let sent = Arc::new(Mutex::new(Vec::<String>::new()));
        let transport = Arc::new(CapturingTransport::responsive(sent.clone(), vec![]));
        let (tx, _rx) = mpsc::unbounded_channel::<RealtimeEvent>();
        let session =
            ElevenLabsRealtimeSession::start_with_transport(transport, "k".into(), None, tx);
        pump(1, 10).await;

        // Cross the 36.5s boundary (predicted auto-commit) with 3.5s left over.
        feed_windows(&session, &DeviceType::Microphone, 40.0, 0.0).await;
        pump(80, 20).await;
        session.segment_gap(&DeviceType::Microphone);
        pump(20, 20).await;
        assert_eq!(
            count_commits(&sent),
            0,
            "3.5s past the predicted boundary is below the interval"
        );

        feed_windows(&session, &DeviceType::Microphone, 28.0, 40.0).await;
        pump(80, 20).await;
        session.segment_gap(&DeviceType::Microphone);
        pump(20, 20).await;
        assert_eq!(
            count_commits(&sent),
            1,
            "the predicted reset must re-arm the scheduler with no committed events"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn no_commit_is_ever_sent_inside_the_danger_band_including_at_close() {
        // FINDING 1 (CRITICAL) as a property: across dense-speech, gap and stop
        // scenarios, NO commit:true may be sent while uncommitted audio sits in
        // [FORCE_CUTOFF_SECS, AUTO_COMMIT_AUDIO_SECS). The old finalize commit did
        // exactly that and stalled the session, orphaning the whole tail.
        for fed in [10.0f64, 25.0, 31.0, 31.9, 32.1, 33.0, 34.5, 36.4] {
            let sent = Arc::new(Mutex::new(Vec::<String>::new()));
            let transport = Arc::new(CapturingTransport::responsive(sent.clone(), vec![]));
            let (tx, _rx) = mpsc::unbounded_channel::<RealtimeEvent>();
            let session =
                ElevenLabsRealtimeSession::start_with_transport(transport, "k".into(), None, tx);
            pump(1, 10).await;

            feed_windows(&session, &DeviceType::Microphone, fed, 0.0).await;
            pump(60, 20).await;
            session.segment_gap(&DeviceType::Microphone);
            pump(20, 20).await;
            let after_gap = count_commits(&sent);
            if fed >= FORCE_CUTOFF_SECS {
                assert_eq!(after_gap, 0, "danger band at {}s must not commit", fed);
            }

            // Stop: the STAGED finalize must obey the same band, and close itself
            // must add nothing.
            session.finalize(&DeviceType::Microphone);
            pump(40, 20).await;
            let after_finalize = count_commits(&sent);
            if fed >= FORCE_CUTOFF_SECS && after_gap == 0 {
                assert_eq!(
                    after_finalize, 0,
                    "finalize must not commit inside the danger band (fed {}s)",
                    fed
                );
            }
            let close = tokio::spawn(session.clone().close_all());
            pump(40, 100).await;
            let _ = close.await;
            assert_eq!(
                count_commits(&sent),
                after_finalize,
                "close itself must never send a commit (fed {}s)",
                fed
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn staged_finalize_commits_the_tail_when_outside_the_band() {
        // M6: the validated 4.68% configuration DID commit at clip end. A stop
        // with a small outstanding tail must use the accurate WS path.
        let sent = Arc::new(Mutex::new(Vec::<String>::new()));
        let transport = Arc::new(CapturingTransport::responsive(sent.clone(), vec![]));
        let (tx, _rx) = mpsc::unbounded_channel::<RealtimeEvent>();
        let session =
            ElevenLabsRealtimeSession::start_with_transport(transport, "k".into(), None, tx);
        pump(1, 10).await;

        // 5s outstanding: below the interval (so no gap commit), but a legitimate
        // finalize.
        feed_windows(&session, &DeviceType::Microphone, 5.0, 0.0).await;
        pump(30, 20).await;
        session.segment_gap(&DeviceType::Microphone);
        pump(10, 20).await;
        assert_eq!(count_commits(&sent), 0, "5s is below the commit interval");

        session.finalize(&DeviceType::Microphone);
        pump(20, 20).await;
        assert_eq!(count_commits(&sent), 1, "finalize must flush the tail");
    }

    #[tokio::test(start_paused = true)]
    async fn staged_finalize_skips_when_nothing_real_is_outstanding() {
        // Guards the old commit_throttled case: a finalize right behind a commit,
        // with no real audio between, must not be sent.
        let sent = Arc::new(Mutex::new(Vec::<String>::new()));
        let transport = Arc::new(CapturingTransport::responsive(sent.clone(), vec![]));
        let (tx, _rx) = mpsc::unbounded_channel::<RealtimeEvent>();
        let session =
            ElevenLabsRealtimeSession::start_with_transport(transport, "k".into(), None, tx);
        pump(1, 10).await;

        feed_windows(&session, &DeviceType::Microphone, 31.0, 0.0).await;
        pump(60, 20).await;
        session.segment_gap(&DeviceType::Microphone);
        pump(20, 20).await;
        assert_eq!(count_commits(&sent), 1, "gap commit");

        session.finalize(&DeviceType::Microphone);
        pump(20, 20).await;
        assert_eq!(count_commits(&sent), 1, "finalize must not double-commit");
    }

    #[tokio::test(start_paused = true)]
    async fn stall_watchdog_forces_a_reconnect_when_the_server_goes_silent() {
        // M1: a SERVER FACT 2 stall leaves the socket open with no errors. Without
        // the watchdog the route never flips, partials freeze and the pipeline's
        // shadow buffer silently eats the rest of the meeting.
        let sent = Arc::new(Mutex::new(Vec::<String>::new()));
        let transport = Arc::new(CapturingTransport {
            sent: sent.clone(),
            incoming: vec![],
            heartbeat_every: None, // server never answers
            incoming_after_frames: 0,
        });
        let (tx, _rx) = mpsc::unbounded_channel::<RealtimeEvent>();
        let session =
            ElevenLabsRealtimeSession::start_with_transport(transport, "k".into(), None, tx);
        pump(1, 10).await;
        assert_eq!(session.route(&DeviceType::Microphone), Route::Realtime);

        // Feed past WATCHDOG_SECS of speech with no reply.
        feed_windows(&session, &DeviceType::Microphone, WATCHDOG_SECS + 1.0, 0.0).await;
        pump(40, 20).await;
        assert_eq!(
            session.route(&DeviceType::Microphone),
            Route::Batch,
            "the watchdog must drop the route so the batch path takes over"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn responsive_server_never_trips_the_watchdog() {
        let sent = Arc::new(Mutex::new(Vec::<String>::new()));
        let transport = Arc::new(CapturingTransport::responsive(sent.clone(), vec![]));
        let (tx, _rx) = mpsc::unbounded_channel::<RealtimeEvent>();
        let session =
            ElevenLabsRealtimeSession::start_with_transport(transport, "k".into(), None, tx);
        pump(1, 10).await;
        feed_windows(&session, &DeviceType::Microphone, 60.0, 0.0).await;
        pump(80, 20).await;
        assert_eq!(
            session.route(&DeviceType::Microphone),
            Route::Realtime,
            "partials prove liveness; the watchdog must stay quiet"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn begin_shutdown_suppresses_further_transcript_events() {
        // M6 stage (b): once the batch flush owns the remainder, a commit reply
        // still in flight must not also be emitted.
        let sent = Arc::new(Mutex::new(Vec::<String>::new()));
        let transport = Arc::new(CapturingTransport::responsive(sent.clone(), vec![]));
        let (tx, mut rx) = mpsc::unbounded_channel::<RealtimeEvent>();
        let session =
            ElevenLabsRealtimeSession::start_with_transport(transport, "k".into(), None, tx);
        pump(1, 10).await;

        session.begin_shutdown();
        assert!(session.is_shutting_down());
        // The stream tasks are alive; drive them and confirm nothing is emitted.
        feed_windows(&session, &DeviceType::Microphone, 1.0, 0.0).await;
        pump(20, 20).await;
        assert!(
            rx.try_recv().is_err(),
            "no transcript event may be emitted after begin_shutdown"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn suppressed_commit_reply_must_not_advance_the_epoch() {
        // A commit reply landing AFTER begin_shutdown is dropped, so its audio is
        // not transcribed by the realtime path. Advancing the epoch would make the
        // pipeline clear the shadow buffer that the stop flush is about to
        // transcribe, losing the tail from BOTH paths.
        let sent = Arc::new(Mutex::new(Vec::<String>::new()));
        let transport = Arc::new(CapturingTransport::responsive(
            sent.clone(),
            vec![
                r#"{"message_type":"committed_transcript_with_timestamps","text":"tail","words":[{"text":"tail","start":0.0,"end":0.4,"type":"word"}]}"#.into(),
                r#"{"message_type":"committed_transcript","text":"tail"}"#.into(),
            ],
        ));
        let (tx, mut rx) = mpsc::unbounded_channel::<RealtimeEvent>();
        let session =
            ElevenLabsRealtimeSession::start_with_transport(transport, "k".into(), None, tx);
        // Shut down before the socket task ever pumps its canned messages.
        session.begin_shutdown();
        pump(40, 20).await;

        assert_eq!(
            session.commit_epoch(&DeviceType::Microphone),
            0,
            "a dropped reply must not look like a confirmed commit"
        );
        assert!(rx.try_recv().is_err(), "and must not emit anything");
    }

    // ---- commit scheduler (pure) ------------------------------------------

    #[test]
    fn scheduler_constants_hold_the_measured_margin() {
        // Live-validated set (harness commit d8c8dd3): 27 / 32 / re-sync 1.5.
        assert_eq!(COMMIT_INTERVAL_SECS, 27.0);
        assert_eq!(AUTO_COMMIT_AUDIO_SECS, 36.5); // receive-time upper bound
        assert_eq!(STALL_EDGE_SECS, 34.5); // last position observed healthy
        assert_eq!(DANGER_GUARD_SECS, 2.5);
        assert_eq!(FORCE_CUTOFF_SECS, 32.0);
        assert_eq!(MIN_REAL_AUDIO_SECS, 1.0);
        assert_eq!(RESYNC_MARGIN_SECS, 1.5);
        // The cutoff must stay a real margin below the measured stall edge.
        assert!(STALL_EDGE_SECS - FORCE_CUTOFF_SECS >= 2.5);
        // The ARMING WINDOW must be wide enough for a speech gap to land in it.
        // At 30/32 the 2s window was reproducibly missed on speech-dense audio,
        // sending every cycle into the server's auto-commit instead.
        assert!(
            FORCE_CUTOFF_SECS - COMMIT_INTERVAL_SECS >= 5.0,
            "arming window {}s is too narrow",
            FORCE_CUTOFF_SECS - COMMIT_INTERVAL_SECS
        );
    }

    #[test]
    fn scheduler_never_commits_before_the_interval() {
        let mut s = CommitScheduler::new();
        assert!(!s.on_gap(0.0), "a gap at 0s uncommitted must not commit");
        s.on_fed_real(26.9);
        assert!(!s.on_gap(0.0), "26.9s is still below the 27s interval");
    }

    #[test]
    fn scheduler_commits_at_the_first_gap_past_the_interval() {
        let mut s = CommitScheduler::new();
        s.on_fed_real(27.0);
        assert!(s.on_gap(0.0), "exactly at the interval is armed");
        s.on_fed_real(4.0);
        assert!(s.on_gap(0.0), "still armed anywhere below the cutoff");
        assert!((s.uncommitted_secs() - 31.0).abs() < 1e-9);
    }

    #[test]
    fn scheduler_goes_silent_inside_the_danger_band() {
        // SERVER FACT 2: no client commit at/after FORCE_CUTOFF_SECS, ever, no
        // matter how many gaps arrive — the server's auto-commit takes over.
        let mut s = CommitScheduler::new();
        s.on_fed_real(31.9);
        assert!(s.on_gap(0.0), "31.9s is the last safe moment");
        s.on_fed_real(0.1); // 32.0 == FORCE_CUTOFF_SECS
        assert!(!s.on_gap(0.0), "at the cutoff we must stop committing");
        s.on_fed_real(4.4); // 36.4, just under the auto-commit boundary
        assert!(!s.on_gap(0.0), "and never resume inside the band");
    }

    #[test]
    fn scheduler_counts_the_pending_slicer_tail_in_the_cutoff_check() {
        // FINDING 9: the tail is flushed immediately BEFORE the commit, so it must
        // be part of the decision or the effective margin shrinks by one frame.
        let mut s = CommitScheduler::new();
        s.on_fed_real(31.9);
        assert!(s.on_gap(0.0), "safe with nothing pending");
        assert!(
            !s.on_gap(0.25),
            "adding the pending 250ms tail crosses the cutoff -> must not commit"
        );
        // And the same inclusion can ARM a gap that is just under the interval.
        let mut s2 = CommitScheduler::new();
        s2.on_fed_real(26.9);
        assert!(!s2.on_gap(0.0));
        assert!(s2.on_gap(0.25), "26.9 + 0.25 >= 27 -> armed");
    }

    #[test]
    fn scheduler_predicts_the_server_auto_commit_without_any_server_event() {
        // FINDING 3: crossing AUTO_COMMIT_AUDIO_SECS IS a commit-point. Subtract
        // rather than zero, keeping the residual audio's phase (as the harness's
        // `last_commit_at += AUTO_COMMIT` does).
        let mut s = CommitScheduler::new();
        s.on_fed_real(36.4);
        assert_eq!(s.predicted_auto_commits(), 0);
        s.on_fed_real(0.2); // crosses 36.5
        assert_eq!(s.predicted_auto_commits(), 1);
        assert!(
            (s.uncommitted_secs() - 0.1).abs() < 1e-9,
            "residual phase must be kept, got {}",
            s.uncommitted_secs()
        );
        // Re-arms a full interval later, with no server message at any point.
        s.on_fed_real(26.8); // 26.9
        assert!(!s.on_gap(0.0));
        s.on_fed_real(0.2); // 27.1
        assert!(s.on_gap(0.0), "predictive reset must re-arm the scheduler");
    }

    #[test]
    fn scheduler_in_flight_reply_cannot_undercount_the_server() {
        // FINDING 2 (round 2): resetting fully on the reply as well as on the send
        // discarded the round trip's audio, leaving the client BELOW the server.
        // The re-sync floors at RESYNC_MARGIN_SECS instead of zeroing, so the
        // client stays at or above the server's true position.
        let mut s = CommitScheduler::new();
        s.on_fed_real(31.0);
        assert!(s.on_gap(0.0));
        s.on_client_commit(); // reset at SEND
        s.on_fed_real(2.0); // fed during the round trip
        s.on_committed_received(); // the reply lands
        assert!(
            s.uncommitted_secs() >= RESYNC_MARGIN_SECS - 1e-9,
            "the re-sync must not drop below the in-flight estimate, got {}",
            s.uncommitted_secs()
        );
        s.on_fed_real(30.4); // 31.9 total: still just inside the safe window
        assert!(s.on_gap(0.0));
        s.on_fed_real(0.2); // 32.1 > FORCE_CUTOFF
        assert!(!s.on_gap(0.0), "must refuse the gap past the cutoff");
    }

    /// Outcome of a simulated meeting.
    struct SimResult {
        /// Client commits actually sent.
        commits: u32,
        /// Worst SERVER-side uncommitted position at which we sent one. This is
        /// the safety number: it must stay clear of [`STALL_EDGE_SECS`].
        worst_commit_pos: f64,
        /// Most negative `client_estimate - server_truth` seen at a sync point,
        /// i.e. how far the client model fell BELOW reality (the unsafe side).
        worst_model_error: f64,
    }

    /// Walk a simulated server through `secs` of continuous speech.
    ///
    /// Server model: auto-commits at `true_trigger` of uncommitted audio; every
    /// commit (ours or its own) produces a committed event that reaches us
    /// `reply_lag` of audio later. A speech gap is offered every `gap_period`
    /// seconds, which is what decides whether the client can catch its arming
    /// window at all. `resync` toggles the C1 fix.
    fn simulate_meeting(
        secs: f64,
        true_trigger: f64,
        reply_lag: f64,
        gap_period: f64,
        resync: bool,
    ) -> SimResult {
        const FRAME: f64 = 0.25;
        let mut s = CommitScheduler::new();
        let mut server_unc = 0.0f64;
        let mut pending_reply: Option<f64> = None;
        let mut commits = 0u32;
        let mut worst_commit_pos: f64 = 0.0;
        let mut worst_model_error: f64 = 0.0;
        let mut t = 0.0f64;
        let mut since_gap = 0.0f64;

        while t < secs {
            s.on_fed_real(FRAME);
            server_unc += FRAME;
            t += FRAME;
            since_gap += FRAME;

            // Server's own auto-commit.
            if server_unc >= true_trigger {
                server_unc = 0.0;
                pending_reply = Some(reply_lag);
            }

            // Deliver a due reply; that is the natural sync point to measure the
            // client's model against the server's truth.
            if let Some(lag) = pending_reply {
                let lag = lag - FRAME;
                if lag <= 0.0 {
                    pending_reply = None;
                    if resync {
                        s.on_committed_received();
                    }
                    worst_model_error =
                        worst_model_error.min(s.uncommitted_secs() - server_unc);
                } else {
                    pending_reply = Some(lag);
                }
            }

            // Offer a speech gap on the configured cadence.
            if since_gap >= gap_period {
                since_gap = 0.0;
                if s.on_gap(0.0) {
                    worst_commit_pos = worst_commit_pos.max(server_unc);
                    commits += 1;
                    s.on_client_commit();
                    server_unc = 0.0;
                    pending_reply = Some(reply_lag);
                }
            }
        }
        SimResult {
            commits,
            worst_commit_pos,
            worst_model_error,
        }
    }

    #[test]
    fn scheduler_resync_keeps_every_commit_clear_of_the_stall_edge() {
        // C1 (CRITICAL): AUTO_COMMIT_AUDIO_SECS is a RECEIVE-time figure, so the
        // server's true trigger is earlier (observed receipt spacing 34.75-36.25s,
        // median 35.5s). A purely predictive clock therefore drifts ~1.0s per
        // auto-commit cycle, monotonically, with nothing to correct it: after
        // enough cycles a commit we believe is at 30s is really at ~35s
        // server-side, which is the SERVER FACT 2 stall. The 60s validation clips
        // only ever ran ONE cycle, which is why this stayed invisible.
        //
        // The safety property that actually matters is not "never under-count" but
        // "never commit while the server is near its stall edge". Simulate a
        // 10-minute meeting with frequent gaps and assert it.
        let r = simulate_meeting(600.0, 35.5, 0.5, 2.0, true);
        assert!(
            r.worst_commit_pos < STALL_EDGE_SECS,
            "committed at {:.2}s server-side; the measured stall edge is {:.2}s",
            r.worst_commit_pos,
            STALL_EDGE_SECS
        );
        // Liveness: a scheduler that never commits would pass the above trivially.
        assert!(
            r.commits >= 10,
            "expected regular commits over 10 minutes, got {}",
            r.commits
        );
        // And the model never sits meaningfully below reality at a sync point
        // (live measurement put the error in [-0.25, +1.25] with no trend).
        assert!(
            r.worst_model_error >= -0.5,
            "model fell {:.2}s below the server at a sync point",
            r.worst_model_error
        );
    }

    #[test]
    fn scheduler_resync_stops_the_model_drifting_across_auto_commit_cycles() {
        // The drift only bites when the CLIENT keeps missing its arming window and
        // the SERVER's auto-commit is what closes each cycle (speech-dense audio,
        // sparse gaps). Each such cycle shifts the client's clock ~1.0s below
        // reality, monotonically, so eventually a gap the client believes is at
        // 27-32s is really at 34-36s server-side: the stall.
        //
        // Whether that happens depends on how the gap cadence beats against the
        // cycle, so sweep the cadence and take the worst case of each variant.
        let mut worst_without: f64 = 0.0;
        let mut worst_with: f64 = 0.0;
        let mut period = 1.0f64;
        while period <= 45.0 {
            worst_without = worst_without
                .max(simulate_meeting(900.0, 35.5, 0.5, period, false).worst_commit_pos);
            worst_with = worst_with
                .max(simulate_meeting(900.0, 35.5, 0.5, period, true).worst_commit_pos);
            period += 0.5;
        }

        assert!(
            worst_without >= STALL_EDGE_SECS,
            "without the re-sync the drift must reach the stall band, got {:.2}s",
            worst_without
        );
        assert!(
            worst_with < STALL_EDGE_SECS,
            "with the re-sync every commit must stay clear, got {:.2}s",
            worst_with
        );
    }

    #[test]
    fn scheduler_stays_safe_across_the_observed_trigger_spread() {
        // Observed auto-commit receipt spacing was 34.75-36.25s (median 35.5).
        // Sweep that whole range, slow replies, and both dense and sparse gaps.
        for trigger in [34.75f64, 35.0, 35.5, 36.0, 36.25] {
            for lag in [0.25f64, 0.5, 1.0, 1.5] {
                for gap_period in [1.0f64, 5.0, 13.0, 29.0, 90.0] {
                    let r = simulate_meeting(400.0, trigger, lag, gap_period, true);
                    assert!(
                        r.worst_commit_pos < STALL_EDGE_SECS,
                        "trigger {} lag {} gaps every {}s: committed at {:.2}s server-side",
                        trigger,
                        lag,
                        gap_period,
                        r.worst_commit_pos
                    );
                }
            }
        }
    }

    #[test]
    fn scheduler_resync_floors_rather_than_zeroing() {
        // The floor is what makes the re-sync safe: never claim less outstanding
        // than the audio that must still be in flight.
        let mut s = CommitScheduler::new();
        s.on_fed_real(2.0);
        s.on_committed_received();
        assert!((s.uncommitted_secs() - RESYNC_MARGIN_SECS).abs() < 1e-9);
        // And when the predictive subtract has NOT fired yet, it removes a whole
        // cycle rather than flooring.
        let mut s2 = CommitScheduler::new();
        s2.on_fed_real(36.0);
        s2.on_committed_received();
        assert!(
            (s2.uncommitted_secs() - RESYNC_MARGIN_SECS).abs() < 1e-9,
            "36.0 - 36.5 is negative -> floor, got {}",
            s2.uncommitted_secs()
        );
    }

    #[test]
    fn scheduler_keepalive_silence_counts_for_the_boundary_but_never_arms() {
        // FINDING 7: during a long pause ~130 keepalives would otherwise reach the
        // interval and fire a commit over pure silence, and at ~22.5min idle would
        // lock the scheduler into the danger band.
        let mut s = CommitScheduler::new();
        for _ in 0..200 {
            s.on_fed_keepalive(0.25); // 50s of keepalive silence
            assert!(!s.on_gap(0.0), "keepalive silence must never arm a commit");
        }
        // It DID count toward the boundary: 50s crosses 36.5 exactly once.
        assert_eq!(s.predicted_auto_commits(), 1);
        // One second of real speech after that is enough to arm, once the total
        // uncommitted clock is also past the interval.
        assert!((s.real_secs() - 0.0).abs() < 1e-9);
        s.on_fed_real(1.0);
        assert!(
            !s.on_gap(0.0),
            "real audio alone does not arm below the interval"
        );
        s.on_fed_keepalive(20.0); // uncommitted now 34.5 > cutoff
        assert!(!s.on_gap(0.0), "and the cutoff still applies");
    }

    #[test]
    fn scheduler_rearms_after_a_long_idle_without_locking_up() {
        // FINDING 7's second half: a very long pause must not leave the scheduler
        // permanently stuck in the danger band once speech resumes.
        let mut s = CommitScheduler::new();
        for _ in 0..5400 {
            s.on_fed_keepalive(0.25); // 22.5 minutes of keepalive silence
        }
        // Speech resumes; within one interval the scheduler arms again.
        let mut armed = false;
        for _ in 0..(4 * 40) {
            s.on_fed_real(0.25);
            if s.on_gap(0.0) {
                armed = true;
                break;
            }
        }
        assert!(armed, "must re-arm within ~40s of resumed speech");
    }

    #[test]
    fn scheduler_requires_real_audio_behind_a_commit() {
        let mut s = CommitScheduler::new();
        s.on_fed_keepalive(30.0);
        s.on_fed_real(0.5);
        assert!(
            !s.on_gap(0.0),
            "0.5s of real audio is below MIN_REAL_AUDIO_SECS"
        );
        s.on_fed_real(0.5);
        assert!(s.on_gap(0.0), "1.0s of real audio arms it");
    }

    #[test]
    fn scheduler_reset_models_a_reconnect() {
        // A new socket is a new server session: the uncommitted clock starts over.
        let mut s = CommitScheduler::new();
        s.on_fed_real(34.0);
        assert!(!s.on_gap(0.0), "danger band before the reconnect");
        s.reset();
        assert_eq!(s.uncommitted_secs(), 0.0);
        assert_eq!(s.real_secs(), 0.0);
        s.on_fed_real(30.0);
        assert!(s.on_gap(0.0), "fresh connection commits normally again");
    }

    #[test]
    fn scheduler_client_commit_resets_both_counters() {
        let mut s = CommitScheduler::new();
        s.on_fed_real(31.0);
        assert!(s.on_gap(0.0));
        s.on_client_commit();
        assert_eq!(s.uncommitted_secs(), 0.0);
        assert_eq!(s.real_secs(), 0.0);
        assert!(!s.on_gap(0.0), "a second gap right after must not re-commit");
    }

    /// Property sweep: no reachable (real, keepalive, pending) combination may
    /// arm a commit inside the danger band or without real audio behind it.
    #[test]
    fn scheduler_never_arms_inside_the_danger_band_property() {
        for real_tenths in 0..400u32 {
            for ka_tenths in [0u32, 5, 50] {
                for pending in [0.0f64, 0.1, 0.25] {
                    let mut s = CommitScheduler::new();
                    s.on_fed_keepalive(ka_tenths as f64 / 10.0);
                    s.on_fed_real(real_tenths as f64 / 10.0);
                    if s.on_gap(pending) {
                        let unc = s.uncommitted_secs() + pending;
                        assert!(
                            unc >= COMMIT_INTERVAL_SECS && unc < FORCE_CUTOFF_SECS,
                            "armed at {}s uncommitted (real {} ka {} pending {})",
                            unc,
                            real_tenths,
                            ka_tenths,
                            pending
                        );
                        assert!(s.real_secs() + pending >= MIN_REAL_AUDIO_SECS);
                    }
                }
            }
        }
    }
}
