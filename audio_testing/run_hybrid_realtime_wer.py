#!/usr/bin/env python
"""WER for a HYBRID Scribe v2 Realtime strategy (comparison harness).

Motivation: the Whispering strategy (run_whispering_realtime_wer.py, pooled WER
4.58% @4x) beats Tandem's own realtime strategy (run_scribe_realtime_wer.py,
pooled 6.31% @4x) purely because it feeds ALL audio continuously and keeps the
server's cross-utterance context, committing only once at clip end. That is great
for accuracy but useless for a LIVE call: the user would see nothing until the
call ends. This hybrid asks: can we KEEP Whispering's continuous feed (and thus
its context / accuracy) while still emitting PERIODIC live commits, so words don't
wait forever, by placing each periodic commit at a natural VAD speech-gap.

HYBRID strategy:
  - Feed: EXACTLY like Whispering. The entire clip as continuous 250ms chunks
    (4000 samples), commit:false, no VAD gating of audio, no pre-roll. Conversion
    + message shape + URL are imported verbatim from run_whispering_realtime_wer
    (float32_to_int16, int16_to_base64, encode_chunk, build_url), so the audio the
    server sees is byte-identical to Whispering's.
  - Periodic commits at VAD gaps: run Silero VAD (LIVE config, same helper the
    other harnesses use) over the clip UP FRONT to find speech-gap timestamps.
    Commit rule, walking the 250ms chunks in order:
        * "audio fed since last commit" = chunk-availability time - last commit
          availability time (both audio-clock).
        * Once that reaches INTERVAL seconds we are ARMED. While armed, the FIRST
          chunk whose audio window falls entirely in a VAD silence gap gets
          commit:true.
        * Safety valve: if armed and still no gap has appeared after INTERVAL+5s
          of audio since the last commit, commit at that chunk anyway (mid-speech).
        * The clip's final chunk / finalize remainder ALWAYS commits (like
          Whispering's finalize()).
  - Collect committed_transcript messages ONLY (partials ignored). Hypothesis =
    space-joined committed texts, whitespace-collapsed (joinedTranscript()).

Auth: xi-api-key header from the app SQLite (same as the other harnesses). Key is
NEVER printed/logged. Event logs -> realtime_out/events/ (git-ignored).

Two pacing modes (Phase 3 proved 4x gives WER identical to real pace):
  --pace real   250ms sleep per 250ms chunk  (REQUIRED for turnaround timing)
  --pace 4x     62.5ms per chunk             (cheaper WER re-runs)

MULTI-CYCLE VALIDATION (added after QA): every clip is 60s, so a session reaches the
server's uncommitted-audio auto-commit boundary AT MOST ONCE and any drift in the
client's model of that boundary stays invisible. --make-multi concatenates clips
11-16 into one ~6min stress clip (realtime_out/, git-ignored) that runs ~9-10
consecutive auto-commit cycles per session, and --single-wav runs it against the
concatenated reference. --cutoff / --resync tune the scheduler (see CommitScheduler).

Run:
  .venv/Scripts/python.exe audio_testing/run_hybrid_realtime_wer.py --interval 10 --pace 4x
  .venv/Scripts/python.exe audio_testing/run_hybrid_realtime_wer.py --interval 15 --pace 4x --clips clip_11
  .venv/Scripts/python.exe audio_testing/run_hybrid_realtime_wer.py --make-multi
  .venv/Scripts/python.exe audio_testing/run_hybrid_realtime_wer.py --interval 30 --cutoff 32 \
      --resync --pace 4x --single-wav audio_testing/realtime_out/multi6.wav --tag 30c32rs
"""
import argparse
import asyncio
import json
import statistics
import sys
import time
import wave
from pathlib import Path

import websockets

# VAD helper (LIVE config) + scoring, IDENTICAL to the other harnesses.
from run_scribe_meeting_wer import vad_segments_live, MIN_SEGMENT_SAMPLES
from run_tandem_parakeet import read_wav_16k_mono, normalize, wer_align, REF_DIR, CLIPS_DIR
# Whispering feed primitives, imported verbatim so the fed audio is identical.
from run_whispering_realtime_wer import (
    float32_to_int16, build_url, encode_chunk, get_api_key,
    SAMPLE_RATE, CHUNK_SAMPLES, CHUNK_SECS, SERVER_ERROR_TYPES,
)

HERE = Path(__file__).parent
OUT_DIR = HERE / "realtime_out"
EVENTS_DIR = OUT_DIR / "events"
EVENTS_DIR.mkdir(parents=True, exist_ok=True)

# Finalize collision guard (mirrors the Rust engine's commit_throttled fix): only
# emit the separate clip-end finalize commit if meaningful audio has been fed since
# the last commit-point. When a periodic commit fired on the final full chunk, the
# finalize would land ~0.075s later, the server throttles one of the two back-to-
# back commits (commit_throttled) and orphans the whole trailing window. A 1.0s
# guard cleanly separates that collision (gap < 0.25s remainder) from a legitimate
# flush (gap = seconds since the last commit-point). "Commit-point" here counts BOTH
# client commit:true sends AND the server's own auto-commit (see below).
FINALIZE_MIN_GAP_SECS = 1.0

# The server (commit_strategy=manual) auto-commits after ~36.5s of UNCOMMITTED audio
# (verified audio-based, pacing-invariant: Whispering runs saw it at 9.15s wall @4x =
# 36.6s audio, every clip). A client commit fired MID-SPEECH just before that
# boundary deterministically STALLS the stream (server goes silent, trailing window
# orphaned). So instead of the old INTERVAL+5s mid-speech safety valve, we NEVER
# force a mid-speech commit inside the danger band: if no VAD gap appears by
# (AUTO_COMMIT - DANGER_GUARD) of uncommitted audio, we stop trying and fall back to
# the server's auto-commit, keeping the interval clock in sync by treating the
# predicted auto-commit as a commit-point.
AUTO_COMMIT_AUDIO_SECS = 36.5   # server auto-commit RECEIPT boundary (uncommitted audio)
DANGER_GUARD_SECS = 3.0         # don't client-commit within this of the boundary
FORCE_CUTOFF_SECS = AUTO_COMMIT_AUDIO_SECS - DANGER_GUARD_SECS  # 33.5s uncommitted

# 36.5 is where the auto-commit RECEIPT lands, not where the server TRIGGERS. Event
# logs put the receipt at ~36.25-36.5s fed while client commits are healthy at 34.5s
# uncommitted and stall at 35.0s (3/3), so the true trigger is ~35.5-36s. Two
# consequences the original constants missed, both invisible on 60s clips (at most
# ONE auto-commit cycle ever fired):
#   1) FORCE_CUTOFF 33.5 leaves only ~1.0-1.5s of real margin, not 3.0s.
#   2) The predictive reset (advance the clock by 36.5 at the cutoff crossing)
#      under-counts by (36.5 - true_trigger) EVERY cycle and never re-syncs, so the
#      model drifts later and later until a "safe" commit lands inside the danger
#      band. --resync fixes that by re-anchoring on real receipts.
RESYNC_MARGIN = 1.5             # audio-seconds assumed still uncommitted at a receipt

NEW_CLIPS = [f"clip_{n:02d}" for n in (11, 12, 13, 14, 15, 16)]
MULTI_STEM = "multi6"           # concatenated clip_11..16 stress clip (in realtime_out/)


# ──────────────── multi-cycle stress clip (clips 11-16 concatenated) ────────────

def build_multi_clip(stems=NEW_CLIPS, stem=MULTI_STEM):
    """Concatenate the 60s clips into one ~6min WAV + one concatenated reference.

    Why: every clip in the suite is 60s, so a session can only ever reach the
    server's ~36.5s uncommitted boundary ONCE. Any drift in the client's model of
    that boundary is therefore invisible per clip. Six clips back to back give
    ~9-10 consecutive auto-commit/commit cycles in a single session, which is what
    actually exercises the scheduler.

    Outputs land in realtime_out/ (git-ignored); nothing here is committed.
    """
    wav_out = OUT_DIR / f"{stem}.wav"
    ref_out = OUT_DIR / f"{stem}.txt"
    frames, params = [], None
    for s in stems:
        with wave.open(str(CLIPS_DIR / f"{s}.wav"), "rb") as w:
            p = w.getparams()
            assert (p.framerate, p.nchannels, p.sampwidth) == (SAMPLE_RATE, 1, 2), \
                f"{s}: expected 16k mono 16-bit, got {p}"
            params = params or p
            frames.append(w.readframes(p.nframes))
    with wave.open(str(wav_out), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(b"".join(frames))
    ref = " ".join((REF_DIR / f"{s}.txt").read_text(encoding="utf-8").strip()
                   for s in stems)
    ref_out.write_text(" ".join(ref.split()), encoding="utf-8")
    return wav_out, ref_out


# ───────────────────────── VAD gaps + commit schedule ─────────────────────────

def kept_segments_secs(samples):
    """LIVE-config VAD segments >= MIN_SEGMENT_SAMPLES, as (start_s, end_s)."""
    segs = vad_segments_live(samples)
    return [(s / 1000.0, e / 1000.0) for (s, e, sm) in segs
            if len(sm) >= MIN_SEGMENT_SAMPLES]


class CommitScheduler:
    """Commit-decision state machine on the audio clock. ONE implementation, used
    both offline (plan_commits, for the up-front prediction logged in the meta) and
    LIVE inside the send loop, so plan and run can never diverge.

    State: `last_commit_at`, the audio time the last commit-point is BELIEVED to
    have happened; "uncommitted" = audio fed so far - last_commit_at.

      * ARMED once uncommitted >= interval. While armed, commit at the first VAD gap
        chunk (silence -> safe), as long as uncommitted < cutoff.
      * DANGER BAND: at uncommitted >= cutoff we never force a mid-speech commit
        (that stalls the server near its auto-commit boundary). Instead we fall back
        to the server's own auto-commit: keep feeding commit:false, record a
        PREDICTED commit-point at last_commit_at + AUTO_COMMIT_AUDIO_SECS and
        restart the interval clock from it. This predictive backstop is what a 60s
        clip exercises at most once.
      * RESYNC (opt-in, --resync): the backstop assumes the boundary is exactly
        AUTO_COMMIT_AUDIO_SECS, but that is the RECEIPT time; the true trigger is
        earlier, so every predicted cycle over-advances the clock and the error
        accumulates unbounded. With resync on, EVERY committed_transcript receipt
        re-anchors the model to reality:
            uncommitted := max(RESYNC_MARGIN, uncommitted - AUTO_COMMIT_AUDIO_SECS)
        Receipts caused by our own client commits clamp to RESYNC_MARGIN, a small
        conservative OVER-estimate of the audio still in flight, so the model errs
        early (safe) rather than late (stall).

    Gap test: a 250ms chunk [c0,c1] is a gap chunk iff it overlaps NO kept segment.
    """

    def __init__(self, kept, interval, cutoff, resync, margin=RESYNC_MARGIN):
        self.kept = kept
        self.interval = interval
        self.cutoff = cutoff
        self.resync = resync
        self.margin = margin
        self.last_commit_at = 0.0
        self.client_commits = []      # dict(at, uncommitted) per commit:true decision
        self.server_predicted = []    # predicted server auto-commit audio times
        self.resyncs = []             # dict(fed_at, unc_before, unc_after)

    def in_gap(self, c0, c1):
        return not any(c0 < e and s < c1 for (s, e) in self.kept)

    def uncommitted(self, fed_at):
        return fed_at - self.last_commit_at

    def decide(self, c0, c1):
        """Decide commit:true for the 250ms chunk [c0,c1); advances the state."""
        avail = c1
        unc = avail - self.last_commit_at
        if self.interval <= unc < self.cutoff and self.in_gap(c0, c1):
            self.last_commit_at = avail          # safe: armed, outside danger band
            self.client_commits.append(dict(at=avail, uncommitted=unc))
            return True
        if unc >= self.cutoff:
            server_at = self.last_commit_at + AUTO_COMMIT_AUDIO_SECS
            self.server_predicted.append(server_at)
            self.last_commit_at = server_at
        return False

    def on_committed(self, fed_at):
        """Re-anchor on a committed_transcript receipt (no-op unless --resync)."""
        if not self.resync:
            return
        unc = fed_at - self.last_commit_at
        new_unc = max(self.margin, unc - AUTO_COMMIT_AUDIO_SECS)
        self.last_commit_at = fed_at - new_unc
        self.resyncs.append(dict(fed_at=round(fed_at, 3),
                                 unc_before=round(unc, 3),
                                 unc_after=round(new_unc, 3)))

    def finalize_commits(self, total_dur):
        """finalize(): commit the clip-end remainder ONLY IF meaningful audio has
        been fed since the last commit-point (FINALIZE_MIN_GAP_SECS guard), so a
        finalize landing right on top of a commit-point cannot collide."""
        return total_dur - self.last_commit_at > FINALIZE_MIN_GAP_SECS


def build_frames(int16):
    """Slice into the Whispering 250ms frame sequence + trailing sub-4000 remainder.

    Returns (frames, remainder, n_full); frame = dict(at=avail_s, c0, c1, int16).
    """
    n_full = len(int16) // CHUNK_SAMPLES
    frames = [dict(at=(j + 1) * CHUNK_SECS,
                   c0=j * CHUNK_SECS, c1=(j + 1) * CHUNK_SECS,
                   int16=int16[j * CHUNK_SAMPLES:(j + 1) * CHUNK_SAMPLES])
              for j in range(n_full)]
    return frames, int16[n_full * CHUNK_SAMPLES:], n_full


def plan_commits(frames, total_dur, kept, interval, cutoff):
    """Dry-run the scheduler with NO receipts: the pure predictive model, logged as
    the up-front prediction. Returns (client_commit_ats, server_predicted_ats)."""
    sch = CommitScheduler(kept, interval, cutoff, resync=False)
    client = [f["at"] for f in frames if sch.decide(f["c0"], f["c1"])]
    if sch.finalize_commits(total_dur):
        client.append(total_dur)
    return client, list(sch.server_predicted)


# ───────────────────────── WS session ─────────────────────────

class HybridSession:
    def __init__(self, stem, pace, interval, tag, cutoff=FORCE_CUTOFF_SECS,
                 resync=False, margin=RESYNC_MARGIN, wav_path=None, ref_path=None):
        self.stem = stem
        self.pace = pace
        self.interval = interval
        self.tag = tag               # filename tag, e.g. "30fix" or "30"
        self.cutoff = cutoff
        self.resync = resync
        self.margin = margin
        self.wav_path = wav_path or (CLIPS_DIR / f"{stem}.wav")
        self.ref_path = ref_path or (REF_DIR / f"{stem}.txt")
        self.div = 1.0 if pace == "real" else 4.0
        self.t0 = None
        self.sched = None            # live CommitScheduler (built in run())
        self.last_fed_at = 0.0       # audio seconds handed to the socket so far
        self.evlog = open(
            EVENTS_DIR / f"events_{stem}_hybrid{tag}_{pace}.jsonl", "w",
            encoding="utf-8")
        self.commits = []            # dict(text, recv_wall) — committed_transcript only
        self.commit_recvs = []       # dict(t, fed_at, unc_model) per committed receipt
        self.n_partials = 0
        self.partial_walls = []      # recv wall of every partial (stall detection)
        self.commit_sends = []       # (audio_at, send_wall) for each client commit:true
        self.client_commit_log = []  # dict(at, uncommitted, t) per client commit sent
        self.server_commit_ats = []  # predicted server auto-commit audio times
        self.server_errors = []      # (message_type, wall)
        self.unexpected_types = {}
        self.saw_with_timestamps = 0
        self.send_done_wall = None

    def _log(self, direction, obj, note=None):
        rec = {"t": round(time.monotonic() - self.t0, 4), "dir": direction}
        if note:
            rec["note"] = note
        if isinstance(obj, dict):
            red = {}
            for k, v in obj.items():
                if k in ("session_id", "request_id") and isinstance(v, str):
                    red[k] = f"<redacted len={len(v)}>"
                elif k == "audio_base_64":
                    red[k] = f"<b64 {len(v)} bytes>"
                else:
                    red[k] = v
            rec["msg"] = red
        else:
            rec["raw"] = str(obj)[:400]
        self.evlog.write(json.dumps(rec) + "\n")
        self.evlog.flush()

    async def recv_loop(self, ws, stop_evt):
        try:
            async for raw in ws:
                wall = time.monotonic()
                try:
                    obj = json.loads(raw)
                except Exception:
                    self._log("recv", None, note="non-json")
                    continue
                self._log("recv", obj)
                mt = obj.get("message_type") or obj.get("type") or ""
                if mt == "partial_transcript":
                    self.n_partials += 1
                    self.partial_walls.append(wall)
                elif mt == "committed_transcript":
                    txt = obj.get("text", "") or ""
                    if txt:
                        self.commits.append(dict(text=txt, recv_wall=wall))
                    self._on_committed(wall)
                elif mt == "committed_transcript_with_timestamps":
                    # We did NOT request include_timestamps; record + still capture.
                    self.saw_with_timestamps += 1
                    txt = obj.get("text", "") or ""
                    if txt:
                        self.commits.append(dict(text=txt, recv_wall=wall))
                    self._on_committed(wall)
                elif mt in SERVER_ERROR_TYPES:
                    self.server_errors.append((mt, wall))
                elif mt not in ("session_started",):
                    self.unexpected_types[mt] = self.unexpected_types.get(mt, 0) + 1
        except websockets.ConnectionClosed as e:
            self._log("recv", {"closed": True, "code": e.code, "reason": str(e.reason)})
        stop_evt.set()

    def _on_committed(self, wall):
        """Record a committed receipt and (if --resync) re-anchor the scheduler."""
        fed = self.last_fed_at
        unc = self.sched.uncommitted(fed) if self.sched else None
        self.commit_recvs.append(dict(wall=wall, t=round(wall - self.t0, 3),
                                      fed_at=round(fed, 3),
                                      unc_model=None if unc is None else round(unc, 3)))
        if self.sched:
            self.sched.on_committed(fed)

    async def _pace_to(self, at):
        target = self.t0 + at / self.div
        now = time.monotonic()
        if target > now:
            await asyncio.sleep(target - now)

    async def send_schedule(self, ws, frames, remainder, total_dur):
        """Feed the frames, deciding commit:true ONLINE so receipt-driven resyncs
        (recv_loop -> sched.on_committed) affect the very next decision."""
        for f in frames:
            await self._pace_to(f["at"])
            unc = self.sched.uncommitted(f["at"])
            commit = self.sched.decide(f["c0"], f["c1"])
            self.last_fed_at = f["at"]
            await ws.send(encode_chunk(f["int16"], commit))
            wall = time.monotonic()
            if commit:
                self.commit_sends.append((f["at"], wall))
                self.client_commit_log.append(dict(at=round(f["at"], 2),
                                                   uncommitted=round(unc, 2),
                                                   t=round(wall - self.t0, 3)))
            self._log("send", {"kind": "frame", "at": round(f["at"], 3),
                               "commit": commit, "uncommitted": round(unc, 2),
                               "n_samples": int(len(f["int16"]))})

        # finalize(): remainder (possibly empty marker) with the collision guard.
        await self._pace_to(total_dur)
        unc = self.sched.uncommitted(total_dur)
        commit = self.sched.finalize_commits(total_dur)
        if commit or len(remainder):
            self.last_fed_at = total_dur
            await ws.send(encode_chunk(remainder, commit))
            wall = time.monotonic()
            if commit:
                self.commit_sends.append((total_dur, wall))
                self.client_commit_log.append(dict(at=round(total_dur, 2),
                                                   uncommitted=round(unc, 2),
                                                   t=round(wall - self.t0, 3),
                                                   finalize=True))
            self._log("send", {"kind": "commit" if commit else "frame",
                               "at": round(total_dur, 3), "commit": commit,
                               "uncommitted": round(unc, 2),
                               "n_samples": int(len(remainder))})

    async def run(self, int16, kept, hold_open=8.0):
        frames, remainder, n_full = build_frames(int16)
        n_rem = len(remainder)
        total_dur = len(int16) / SAMPLE_RATE
        planned_client, planned_server = plan_commits(
            frames, total_dur, kept, self.interval, self.cutoff)
        self.server_commit_ats = planned_server   # replaced by the live model below
        self.sched = CommitScheduler(kept, self.interval, self.cutoff,
                                     self.resync, self.margin)
        url = build_url()
        self.t0 = time.monotonic()
        self._log("meta", {"stem": self.stem, "pace": self.pace,
                            "interval": self.interval, "tag": self.tag,
                            "cutoff": self.cutoff, "resync": self.resync,
                            "resync_margin": self.margin,
                            "n_full_chunks": n_full, "n_remainder_samples": n_rem,
                            "n_client_commits_planned": len(planned_client),
                            "server_autocommits_predicted": [round(a, 2) for a in planned_server],
                            "clip_dur_s": round(total_dur, 2),
                            "url_no_key": url})
        try:
            async with websockets.connect(
                    url, additional_headers={"xi-api-key": get_api_key()},
                    max_size=None, ping_interval=None) as ws:
                stop_evt = asyncio.Event()
                recv_task = asyncio.create_task(self.recv_loop(ws, stop_evt))
                await self.send_schedule(ws, frames, remainder, total_dur)
                self.send_done_wall = time.monotonic()
                self._log("meta", {"send_done_t": round(self.send_done_wall - self.t0, 3),
                                   "server_autocommits_live": [
                                       round(a, 2) for a in self.sched.server_predicted],
                                   "n_resyncs": len(self.sched.resyncs)})
                try:
                    await asyncio.wait_for(stop_evt.wait(), timeout=hold_open)
                except asyncio.TimeoutError:
                    pass
                recv_task.cancel()
        except Exception as e:
            self._log("error", {"exception": type(e).__name__, "msg": str(e)[:300]})
            raise
        finally:
            self.evlog.close()
        # The LIVE model's predicted auto-commits are what actually drove the run.
        self.server_commit_ats = list(self.sched.server_predicted)
        return n_full, n_rem, planned_client


# ───────────────────────── metrics ─────────────────────────

def score_clip(sess):
    ref = normalize(sess.ref_path.read_text(encoding="utf-8"))
    hyp = " ".join(c["text"] for c in sess.commits)
    hyp = " ".join(hyp.split())
    (OUT_DIR / f"{sess.stem}.hybrid{sess.tag}.committed.txt").write_text(
        hyp, encoding="utf-8")
    S, D, I, N = wer_align(ref, normalize(hyp))
    return dict(wer=(S + D + I) / max(N, 1), S=S, D=D, I=I, N=N, hyp=hyp)


def commit_analysis(sess):
    """Client vs server commits, turnaround, and audio-time commit cadence.

    Server auto-commit inference (conservative): walk received committed_transcript
    events in arrival order, consuming one unconsumed client commit:true send for
    each committed_transcript whose recv_wall is >= that send's wall. A received
    committed_transcript with NO unconsumed client send at/before it is counted as
    a server auto-commit (the server committed on its own, e.g. its ~36.5s
    audio-time auto-commit). This under-counts rather than over-counts server
    commits, since a client send that produced no visible event would otherwise
    mask a later server one.
    """
    client_walls = sorted(w for (_at, w) in sess.commit_sends)
    consumed = [False] * len(client_walls)
    n_server = 0
    turnarounds = []  # send -> first committed_transcript after it
    for c in sess.commits:
        rw = c["recv_wall"]
        # find earliest unconsumed client send with wall <= rw
        idx = None
        for i, w in enumerate(client_walls):
            if not consumed[i] and w <= rw:
                idx = i
                break
        if idx is not None:
            consumed[idx] = True
            turnarounds.append(rw - client_walls[idx])
        else:
            n_server += 1

    # Audio-time commit cadence: gaps between ALL successive commit-points, i.e.
    # client commits AND server auto-commits (both make words visible to the user).
    client_ats = [at for (at, _w) in sess.commit_sends]
    all_ats = sorted(client_ats + list(sess.server_commit_ats))
    cadence = [b - a for a, b in zip(all_ats, all_ats[1:])]

    def med(x):
        return statistics.median(x) if x else None

    return dict(
        n_client_commits=len(sess.commit_sends),
        n_server_autocommits=n_server,                 # observed (inference rule)
        n_server_autocommits_predicted=len(sess.server_commit_ats),
        n_committed_recv=len(sess.commits),
        turnaround_med=med(turnarounds),
        turnaround_max=max(turnarounds) if turnarounds else None,
        turnaround_min=min(turnarounds) if turnarounds else None,
        cadence_med=med(cadence),
        cadence_max=max(cadence) if cadence else None,
        commit_audio_times=[round(a, 2) for a in all_ats],
        client_commit_audio_times=[round(a, 2) for a in sorted(client_ats)],
        server_commit_audio_times=[round(a, 2) for a in sorted(sess.server_commit_ats)],
    )


# ── multi-cycle validation: drift of the client model vs observed receipts ──

STALL_PARTIAL_GAP_SECS = 5.0     # wall gap with no partials while still feeding
UNANSWERED_COMMIT_SECS = 5.0     # wall a client commit may go without a receipt


def cycle_analysis(sess):
    """Attribute every committed RECEIPT to a client commit or a server auto-commit,
    then measure how far the client's predictive model drifts from reality.

    Attribution is the same conservative rule as commit_analysis (consume one
    unconsumed client send per receipt, in arrival order), applied to ALL receipts
    (including empty-text ones, which still reset the server's uncommitted window).
    Drift for the k-th server-attributed receipt = observed fed_at - the k-th
    PREDICTED auto-commit time, i.e. how wrong the model's boundary assumption was.
    """
    client_walls = sorted(w for (_at, w) in sess.commit_sends)
    consumed = [False] * len(client_walls)
    server_recvs, client_recvs = [], []
    for r in sess.commit_recvs:
        idx = next((i for i, w in enumerate(client_walls)
                    if not consumed[i] and w <= r["wall"]), None)
        if idx is None:
            server_recvs.append(r)
        else:
            consumed[idx] = True
            client_recvs.append(r)

    predicted = sorted(sess.server_commit_ats)
    drifts = [round(r["fed_at"] - p, 2)
              for r, p in zip(server_recvs, predicted)]

    return dict(
        n_cycles_predicted=len(predicted),
        n_cycles_observed=len(server_recvs),
        predicted_autocommit_fed=[round(p, 2) for p in predicted],
        observed_autocommit_fed=[r["fed_at"] for r in server_recvs],
        autocommit_unc_model=[r["unc_model"] for r in server_recvs],
        drift_per_cycle=drifts,
        drift_max_abs=max((abs(d) for d in drifts), default=None),
        client_commits=list(sess.client_commit_log),
        client_recv_fed=[r["fed_at"] for r in client_recvs],
        n_resyncs=len(sess.sched.resyncs) if sess.sched else 0,
        resyncs=(sess.sched.resyncs if sess.sched else []),
    )


def stall_analysis(sess):
    """Stall = the server stops talking. Two independent detectors:
      * partial_gap_max: biggest wall gap between successive partial_transcript
        events while audio is still being fed (a stalled stream goes silent).
      * unanswered client commits: a commit:true that never draws a committed
        receipt within UNANSWERED_COMMIT_SECS (or before the session ends).
    """
    end = sess.send_done_wall or (sess.partial_walls[-1] if sess.partial_walls else sess.t0)
    walls = [sess.t0] + sess.partial_walls + [end]
    gaps = [b - a for a, b in zip(walls, walls[1:]) if b >= a]
    gap_max = max(gaps) if gaps else None
    gap_at = None
    if gaps:
        i = gaps.index(gap_max)
        gap_at = round(walls[i] - sess.t0, 2)

    recv_walls = [r["wall"] for r in sess.commit_recvs]
    unanswered = []
    used = [False] * len(recv_walls)
    for (at, w) in sess.commit_sends:
        idx = next((i for i, rw in enumerate(recv_walls)
                    if not used[i] and rw >= w), None)
        if idx is None:
            unanswered.append(round(at, 2))
        else:
            used[idx] = True
    return dict(
        partial_gap_max=None if gap_max is None else round(gap_max, 2),
        partial_gap_max_at=gap_at,
        partial_silence_stall=(gap_max is not None and gap_max > STALL_PARTIAL_GAP_SECS),
        unanswered_client_commits=unanswered,
        stalled=bool(unanswered) or (gap_max is not None and gap_max > STALL_PARTIAL_GAP_SECS),
    )


# ───────────────────────── per-clip run ─────────────────────────

async def run_clip_once(stem, pace, interval, tag, opts=None):
    opts = dict(opts or {})
    wav_path = opts.get("wav_path") or (CLIPS_DIR / f"{stem}.wav")
    samples = read_wav_16k_mono(wav_path)
    int16 = float32_to_int16(samples)
    kept = kept_segments_secs(samples)
    sess = HybridSession(stem, pace, interval, tag, **opts)
    n_full, n_rem, _ = await sess.run(int16, kept)
    wer = score_clip(sess)
    ca = commit_analysis(sess)
    return dict(stem=stem, pace=pace, interval=interval, tag=tag, wer=wer, commit=ca,
                cycles=cycle_analysis(sess), stall=stall_analysis(sess),
                cutoff=sess.cutoff, resync=sess.resync, resync_margin=sess.margin,
                n_partials=sess.n_partials,
                empty_hyp=(not wer["hyp"].strip()),
                server_errors=[e[0] for e in sess.server_errors],
                unexpected_types=sess.unexpected_types,
                saw_with_timestamps=sess.saw_with_timestamps,
                n_full_chunks=n_full, n_remainder=n_rem, n_kept_segs=len(kept),
                clip_dur=len(samples) / SAMPLE_RATE)


def run_clip(stem, pace, interval, tag, opts=None, retry=True):
    """Run one clip; retry ONCE on a transient WS failure or empty hypothesis.

    --no-retry (retry=False) matters for the deliberately-stalling control runs:
    a retry there would burn another paid session to reproduce a known failure.
    """
    try:
        r = asyncio.run(run_clip_once(stem, pace, interval, tag, opts))
        if r["empty_hyp"] and retry:
            print(f"    [warn] {stem}: empty committed hypothesis, retrying once")
            r2 = asyncio.run(run_clip_once(stem, pace, interval, tag, opts))
            r2["retried"] = True
            return r2
        return r
    except Exception as e:
        print(f"    [warn] {stem}: WS run failed ({type(e).__name__})"
              f"{'' if retry else ' (no retry)'}")
        if not retry:
            raise
        r = asyncio.run(run_clip_once(stem, pace, interval, tag, opts))
        r["retried"] = True
        return r


def pooled(rows):
    tS = sum(r["wer"]["S"] for r in rows)
    tD = sum(r["wer"]["D"] for r in rows)
    tI = sum(r["wer"]["I"] for r in rows)
    tN = sum(r["wer"]["N"] for r in rows)
    return (tS + tD + tI) / max(tN, 1), (tS, tD, tI, tN)


def _f(x):
    return f"{x:.2f}" if x is not None else "—"


def dump_entry(r):
    """Serialize one clip result dict to a JSON-safe dump record."""
    return dict(stem=r["stem"], pace=r["pace"], interval=r["interval"],
                cutoff=r.get("cutoff"), resync=r.get("resync"),
                resync_margin=r.get("resync_margin"),
                wer=r["wer"], commit=r["commit"],
                cycles=r.get("cycles"), stall=r.get("stall"),
                n_partials=r["n_partials"],
                empty_hyp=r["empty_hyp"], retried=r.get("retried", False),
                server_errors=r["server_errors"],
                unexpected_types=r["unexpected_types"],
                saw_with_timestamps=r["saw_with_timestamps"],
                n_full_chunks=r["n_full_chunks"], n_remainder=r["n_remainder"],
                n_kept_segs=r["n_kept_segs"], clip_dur=r["clip_dur"])


def aggregate(dump, interval, pace):
    """Build the metrics JSON body (pooled WER + aggregates) from clip dumps."""
    tS = sum(c["wer"]["S"] for c in dump)
    tD = sum(c["wer"]["D"] for c in dump)
    tI = sum(c["wer"]["I"] for c in dump)
    tN = sum(c["wer"]["N"] for c in dump)
    pm = (tS + tD + tI) / max(tN, 1)
    all_turn = [c["commit"]["turnaround_med"] for c in dump
                if c["commit"]["turnaround_med"] is not None]
    all_cad = []
    for c in dump:
        ats = c["commit"]["commit_audio_times"]
        all_cad += [b - a for a, b in zip(ats, ats[1:])]
    mean_client = (statistics.mean(c["commit"]["n_client_commits"] for c in dump)
                   if dump else 0)
    mean_server = (statistics.mean(c["commit"]["n_server_autocommits"] for c in dump)
                   if dump else 0)
    return {
        "strategy": "hybrid",
        "interval": interval,
        "pace": pace,
        "cutoff": dump[0].get("cutoff") if dump else None,
        "resync": dump[0].get("resync") if dump else None,
        "resync_margin": dump[0].get("resync_margin") if dump else None,
        "pooled_wer": pm,
        "SDIN": [tS, tD, tI, tN],
        "total_cycles_observed": sum((c.get("cycles") or {}).get("n_cycles_observed", 0)
                                     for c in dump),
        "total_cycles_predicted": sum((c.get("cycles") or {}).get("n_cycles_predicted", 0)
                                      for c in dump),
        "drift_max_abs": max((d for c in dump
                              for d in [(c.get("cycles") or {}).get("drift_max_abs")]
                              if d is not None), default=None),
        "any_stall": any((c.get("stall") or {}).get("stalled") for c in dump),
        "mean_client_commits_per_clip": mean_client,
        "mean_server_autocommits_per_clip": mean_server,
        "total_server_autocommits": sum(c["commit"]["n_server_autocommits"] for c in dump),
        "total_server_autocommits_predicted": sum(
            c["commit"].get("n_server_autocommits_predicted", 0) for c in dump),
        "cadence_audio_median": statistics.median(all_cad) if all_cad else None,
        "cadence_audio_max": max(all_cad) if all_cad else None,
        "turnaround_median_of_clip_medians": statistics.median(all_turn) if all_turn else None,
        "clips": dump,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=float,
                    help="audio-seconds between periodic commits")
    ap.add_argument("--pace", choices=["real", "4x"], default="4x")
    ap.add_argument("--clips", nargs="+", help="explicit stems (default clip_11..16)")
    ap.add_argument("--merge", action="store_true",
                    help="merge rerun clips into the existing metrics JSON (replace "
                         "matching stems, keep the rest), then recompute aggregates")
    ap.add_argument("--tag", help="filename tag for outputs (default = interval, "
                                  "e.g. --tag 30fix -> metrics_hybrid30fix_*.json)")
    ap.add_argument("--cutoff", type=float, default=FORCE_CUTOFF_SECS,
                    help=f"uncommitted-audio danger-band cutoff (default "
                         f"{FORCE_CUTOFF_SECS}); no client commit is sent at or "
                         f"above this")
    ap.add_argument("--resync", action="store_true",
                    help="re-anchor the uncommitted model on every committed "
                         "receipt instead of trusting the predictive backstop")
    ap.add_argument("--resync-margin", type=float, default=RESYNC_MARGIN,
                    help=f"audio-seconds assumed still uncommitted at a receipt "
                         f"(default {RESYNC_MARGIN})")
    ap.add_argument("--single-wav", help="run ONE wav (e.g. the concatenated "
                                         "multi-cycle stress clip) instead of clips/")
    ap.add_argument("--single-ref", help="ground-truth text for --single-wav "
                                         "(default: sibling .txt)")
    ap.add_argument("--no-retry", action="store_true",
                    help="never re-run a failed/empty session (control runs that "
                         "are EXPECTED to stall)")
    ap.add_argument("--make-multi", action="store_true",
                    help="build the multi-cycle stress clip (clip_11..16 "
                         "concatenated) into realtime_out/ and exit")
    args = ap.parse_args()

    if args.make_multi:
        wav, ref = build_multi_clip()
        print(f"Multi-cycle stress clip -> {wav}\nReference -> {ref}")
        return 0
    if args.interval is None:
        ap.error("--interval is required (unless --make-multi)")

    opts = dict(cutoff=args.cutoff, resync=args.resync, margin=args.resync_margin)
    if args.single_wav:
        wav = Path(args.single_wav)
        opts["wav_path"] = wav
        opts["ref_path"] = Path(args.single_ref) if args.single_ref \
            else wav.with_suffix(".txt")
        stems = [wav.stem]
    else:
        stems = args.clips or NEW_CLIPS
    interval = args.interval
    itag = args.tag or (int(interval) if float(interval).is_integer() else interval)

    print(f"Hybrid-strategy realtime WER harness  interval={interval}s  "
          f"cutoff={args.cutoff}s  resync={args.resync} "
          f"(margin={args.resync_margin}s)  tag={itag}  pace={args.pace}  "
          f"clips={stems}")
    print(f"Events -> {EVENTS_DIR}")
    rows = []
    for stem in stems:
        r = run_clip(stem, args.pace, interval, itag, opts, retry=not args.no_retry)
        rows.append(r)
        w, cm, cy, st = r["wer"], r["commit"], r["cycles"], r["stall"]
        errs = ("  ERR:" + ",".join(r["server_errors"])) if r["server_errors"] else ""
        print(f"=== {stem} === WER={w['wer']*100:5.2f}% "
              f"(S{w['S']}/D{w['D']}/I{w['I']}/N{w['N']}) | "
              f"client_commits={cm['n_client_commits']} "
              f"server_auto={cm['n_server_autocommits']} "
              f"partials={r['n_partials']} | "
              f"turnaround med={_f(cm['turnaround_med'])}s "
              f"max={_f(cm['turnaround_max'])}s | "
              f"cadence med={_f(cm['cadence_med'])}s max={_f(cm['cadence_max'])}s"
              f"{errs}")
        print(f"    cycles pred={cy['n_cycles_predicted']} obs={cy['n_cycles_observed']} "
              f"drift={cy['drift_per_cycle']} max|drift|={_f(cy['drift_max_abs'])}s "
              f"resyncs={cy['n_resyncs']}")
        print(f"    STALL={st['stalled']} partial_gap_max={_f(st['partial_gap_max'])}s "
              f"@t={st['partial_gap_max_at']} "
              f"unanswered_commits={st['unanswered_client_commits']}")
        print(f"    client commits (audio_at, uncommitted): "
              f"{[(c['at'], c['uncommitted']) for c in cy['client_commits']]}")

    dump = [dump_entry(r) for r in rows]
    path = OUT_DIR / f"metrics_hybrid{itag}_{args.pace}.json"

    if args.merge and path.exists():
        existing = json.loads(path.read_text(encoding="utf-8"))
        rerun = {c["stem"] for c in dump}
        by_stem = {c["stem"]: c for c in existing.get("clips", [])}
        for c in dump:                       # replace rerun stems, keep the rest
            by_stem[c["stem"]] = c
        # keep clip_11..16 ordering, then any stray stems
        order = {s: i for i, s in enumerate(NEW_CLIPS)}
        dump = sorted(by_stem.values(), key=lambda c: order.get(c["stem"], 999))
        print(f"\n[merge] reran {sorted(rerun)} into {path.name}; "
              f"total clips now {len(dump)}")

    out = aggregate(dump, interval, args.pace)
    S, D, I, N = out["SDIN"]
    pm = out["pooled_wer"]
    path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print("\n" + "=" * 64)
    print(f"POOLED committed WER (hybrid{itag}, {args.pace}): "
          f"{pm*100:.2f}%  (S{S}/D{D}/I{I}/N{N})  over {len(dump)} clips")
    print(f"Mean client commits/clip: {out['mean_client_commits_per_clip']:.1f}")
    print(f"Auto-commit cycles: predicted={out['total_cycles_predicted']} "
          f"observed={out['total_cycles_observed']}  "
          f"max|drift|={_f(out['drift_max_abs'])}s  "
          f"any_stall={out['any_stall']}")
    if out["cadence_audio_median"] is not None:
        print(f"Audio-time commit cadence: median={out['cadence_audio_median']:.2f}s  "
              f"max={out['cadence_audio_max']:.2f}s")
    print(f"Metrics -> {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
