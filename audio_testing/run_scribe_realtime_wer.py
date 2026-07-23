#!/usr/bin/env python
"""Phase 3: WER + latency for the SHIPPED Scribe v2 Realtime WS path.

Faithful offline replica of the Rust realtime tap
(frontend/src-tauri/src/audio/transcription/elevenlabs_realtime.rs + pipeline.rs
REALTIME TAP), streaming clips 11-16 over the live ElevenLabs Realtime WebSocket:

  clip (16k mono)
    -> per-stream Silero VAD (LIVE Windows config, IDENTICAL to the batch harness)
    -> VAD-gated feeding: at each speech-segment ONSET feed 300ms pre-roll
       (PREROLL_SAMPLES=4800) then the segment's audio in 250ms frames
       (FRAME_SAMPLES=4000) as it accrues; explicit commit=true at VAD segment
       end (samples>=800, matching pipeline.rs); final commit at clip end;
       250ms silence keepalive when idle >= KEEPALIVE_IDLE_SECS (10s).
    -> persist ONLY committed_transcript_with_timestamps -> concatenate = hypothesis
  vs ElevenLabs ground truth -> WER (same normalize + wer_align as the batch harness).

WS config mirrors ElevenLabsRealtimeSession::session_config_query:
  model_id=scribe_v2_realtime & audio_format=pcm_16000 & commit_strategy=manual
  & include_timestamps=true & include_language_detection=true
Messages: {message_type:"input_audio_chunk", audio_base_64, sample_rate:16000, commit}

Two pacing modes (spike proved 4x gives identical WER to real pace):
  --pace real   sleep to real audio time  (REQUIRED for latency metrics)
  --pace 4x     4x faster than real time  (cheaper WER re-runs only)

Cache is impossible (stateful stream): every run costs realtime API minutes.
API key read from the app SQLite; NEVER printed/logged. Event logs (contain
client transcript text) -> realtime_out/events/  (git-ignored).

Run:
  .venv/Scripts/python.exe audio_testing/run_scribe_realtime_wer.py --pace real
  .venv/Scripts/python.exe audio_testing/run_scribe_realtime_wer.py --pace 4x --clips clip_11
"""
import argparse
import asyncio
import base64
import json
import os
import sqlite3
import statistics
import sys
import time
from pathlib import Path

import numpy as np
import websockets

# Reuse the IDENTICAL VAD + scoring as the batch harness (do NOT reinvent).
from run_scribe_meeting_wer import vad_segments_live, MIN_SEGMENT_SAMPLES  # LIVE VAD
from run_tandem_parakeet import read_wav_16k_mono, normalize, wer_align, REF_DIR, CLIPS_DIR

HERE = Path(__file__).parent
OUT_DIR = HERE / "realtime_out"
EVENTS_DIR = OUT_DIR / "events"
EVENTS_DIR.mkdir(parents=True, exist_ok=True)

# ── Constants confirmed against elevenlabs_realtime.rs (2026-07-23) ──
BASE_WSS = "wss://api.elevenlabs.io/v1/speech-to-text/realtime"
MODEL_ID = "scribe_v2_realtime"          # REALTIME_MODEL_ID
SAMPLE_RATE = 16000                       # FEED_SAMPLE_RATE
FRAME_SAMPLES = 4000                      # FRAME_SAMPLES  (250ms)
PREROLL_SAMPLES = 4800                    # PREROLL_SAMPLES (300ms)
KEEPALIVE_IDLE_SECS = 10.0                # KEEPALIVE_IDLE_SECS
KEEPALIVE_SILENCE_SAMPLES = 4000          # KEEPALIVE_SILENCE_SAMPLES (250ms zeros)
COMMIT_MIN_SAMPLES = 800                  # pipeline.rs: commit only segments >=800

NEW_CLIPS = [f"clip_{n:02d}" for n in (11, 12, 13, 14, 15, 16)]

_API_KEY = None


def get_api_key():
    """Read the ElevenLabs key from the app SQLite. Never printed/logged."""
    global _API_KEY
    if _API_KEY is not None:
        return _API_KEY
    db = os.path.expandvars(r"%APPDATA%\com.tandem.ai\meeting_minutes.sqlite")
    con = sqlite3.connect(db)
    try:
        row = con.execute("SELECT elevenLabsApiKey FROM transcript_settings").fetchone()
    finally:
        con.close()
    if not row or not row[0]:
        raise RuntimeError("No elevenLabsApiKey in transcript_settings")
    _API_KEY = row[0]
    return _API_KEY


def f32_to_pcm16_bytes(samples):
    """Mirror elevenlabs_realtime f32_to_pcm16_bytes (clamp to +/-32767)."""
    a = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    return (a * 32767.0).round().astype("<i2").tobytes()


def build_url():
    return (f"{BASE_WSS}?model_id={MODEL_ID}&audio_format=pcm_{SAMPLE_RATE}"
            "&commit_strategy=manual&include_timestamps=true"
            "&include_language_detection=true")


def encode_chunk(pcm_bytes, commit):
    return json.dumps({
        "message_type": "input_audio_chunk",
        "audio_base_64": base64.b64encode(pcm_bytes).decode(),
        "sample_rate": SAMPLE_RATE,
        "commit": commit,
    })


# ───────────────────────── feed schedule ─────────────────────────

def build_schedule(samples, segments):
    """Replicate the Rust REALTIME TAP feed sequence as a timed send list.

    Each entry: dict(at=audio_time_s, kind, pcm, seg). `at` is clip-relative
    audio-availability time (real-pace wall = t0 + at). Pre-roll samples are
    already-captured (past) audio delivered at onset; body samples accrue in
    real time. A partial tail (<FRAME_SAMPLES) is flushed just before the commit
    (FrameSlicer.drain), then the empty commit frame is sent (both at segment end).
    """
    sched = []
    kept = [(s, e, sm) for (s, e, sm) in segments if len(sm) >= MIN_SEGMENT_SAMPLES]
    last_audio_end_s = 0.0
    for seg_idx, (start_ms, end_ms, seg_samples) in enumerate(kept):
        start_s = start_ms / 1000.0
        end_s = end_ms / 1000.0

        # Keepalive during a long idle gap before this onset (audio-idle >= 10s).
        gap_cursor = last_audio_end_s
        while start_s - gap_cursor >= KEEPALIVE_IDLE_SECS:
            gap_cursor += KEEPALIVE_IDLE_SECS
            sched.append(dict(at=gap_cursor, kind="keepalive", seg=-1,
                              pcm=f32_to_pcm16_bytes(
                                  np.zeros(KEEPALIVE_SILENCE_SAMPLES, np.float32))))

        # Onset marker (for latency: utterance audio onset).
        sched.append(dict(at=start_s, kind="onset", seg=seg_idx, pcm=None))

        # Pre-roll = up to 4800 clip samples immediately preceding segment start.
        start_sample = int(round(start_s * SAMPLE_RATE))
        pre_lo = max(0, start_sample - PREROLL_SAMPLES)
        preroll = samples[pre_lo:start_sample]
        fed = np.concatenate([preroll, np.asarray(seg_samples, np.float32)])

        # Slice into 4000-sample frames (FrameSlicer.push); hold the partial tail.
        n_pre = len(preroll)
        n_full = len(fed) // FRAME_SAMPLES
        for j in range(n_full):
            chunk = fed[j * FRAME_SAMPLES:(j + 1) * FRAME_SAMPLES]
            # body samples delivered up to and including this frame's end:
            body_done = max(0, (j + 1) * FRAME_SAMPLES - n_pre)
            avail = min(end_s, start_s + body_done / SAMPLE_RATE)
            sched.append(dict(at=avail, kind="frame", seg=seg_idx,
                              pcm=f32_to_pcm16_bytes(chunk)))
        tail = fed[n_full * FRAME_SAMPLES:]
        if len(tail) > 0:  # FrameSlicer.drain flushed as a non-commit sub-frame
            sched.append(dict(at=end_s, kind="frame", seg=seg_idx,
                              pcm=f32_to_pcm16_bytes(tail)))
        # Explicit commit at VAD segment end (empty audio, commit=true).
        sched.append(dict(at=end_s, kind="commit", seg=seg_idx, pcm=b""))
        last_audio_end_s = end_s

    # NOTE: no separate "final commit". The Rust close_all final commit only
    # flushes a STILL-OPEN segment; our segment-based replica closes every
    # segment via vad.finish(), so each has its own commit already. Emitting an
    # extra clip-end commit collides with the last segment's commit when speech
    # runs to the clip end, and the server drops it with `commit_throttled`
    # (verified: clips 12/13/15/16 lost their entire trailing segment this way).
    sched.sort(key=lambda d: (d["at"], 0 if d["kind"] == "onset" else 1))
    return sched, kept


# ───────────────────────── WS session ─────────────────────────

class RTSession:
    def __init__(self, stem, pace):
        self.stem = stem
        self.pace = pace          # "real" or "4x"
        self.div = 1.0 if pace == "real" else 4.0
        self.t0 = None
        self.evlog = open(EVENTS_DIR / f"events_{stem}_{pace}.jsonl", "w",
                          encoding="utf-8")
        # committed_transcript_with_timestamps payloads in arrival order:
        self.commits = []         # dict(text, words, recv_wall)
        self.partials = []        # recv_wall of each partial event
        self.onsets = {}          # seg_idx -> send_wall (utterance onset)
        self.commit_sends = []    # (seg_idx, end_s, send_wall) in send order

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
                    self.partials.append(wall)
                elif mt == "committed_transcript_with_timestamps":
                    txt = obj.get("text", "") or ""
                    self.commits.append(dict(text=txt,
                                             words=obj.get("words", []) or [],
                                             recv_wall=wall))
                # plain committed_transcript deliberately IGNORED (avoid double-emit)
        except websockets.ConnectionClosed as e:
            self._log("recv", {"closed": True, "code": e.code, "reason": str(e.reason)})
        stop_evt.set()

    async def send_schedule(self, ws, sched):
        for entry in sched:
            target = self.t0 + entry["at"] / self.div
            now = time.monotonic()
            if target > now:
                await asyncio.sleep(target - now)
            wall = time.monotonic()
            kind = entry["kind"]
            if kind == "onset":
                self.onsets[entry["seg"]] = wall
                continue
            if kind == "frame":
                await ws.send(encode_chunk(entry["pcm"], False))
            elif kind in ("commit", "final_commit"):
                await ws.send(encode_chunk(entry["pcm"], True))
                self.commit_sends.append((entry["seg"], entry["at"], wall))
            elif kind == "keepalive":
                await ws.send(encode_chunk(entry["pcm"], False))
            self._log("send", {"kind": kind, "seg": entry["seg"], "at": entry["at"]})

    async def run(self, samples, segments, hold_open=8.0):
        sched, kept = build_schedule(samples, segments)
        url = build_url()
        self.t0 = time.monotonic()
        self._log("meta", {"stem": self.stem, "pace": self.pace,
                            "n_segments_kept": len(kept),
                            "clip_dur_s": round(len(samples) / SAMPLE_RATE, 2),
                            "url_no_key": url})
        try:
            async with websockets.connect(
                    url, additional_headers={"xi-api-key": get_api_key()},
                    max_size=None, ping_interval=None) as ws:
                stop_evt = asyncio.Event()
                recv_task = asyncio.create_task(self.recv_loop(ws, stop_evt))
                await self.send_schedule(ws, sched)
                send_done = time.monotonic() - self.t0
                self._log("meta", {"send_done_t": round(send_done, 3)})
                try:
                    await asyncio.wait_for(stop_evt.wait(), timeout=hold_open)
                except asyncio.TimeoutError:
                    pass
                recv_task.cancel()
        except Exception as e:
            self._log("error", {"exception": type(e).__name__, "msg": str(e)[:300]})
        self.evlog.close()
        return kept


# ───────────────────────── metrics ─────────────────────────

def audio_secs_sent(kept):
    """Approx billed audio-seconds = pre-roll + segment bodies (keepalive negligible)."""
    total = 0.0
    for (start_ms, end_ms, sm) in kept:
        total += PREROLL_SAMPLES / SAMPLE_RATE + len(sm) / SAMPLE_RATE
    return total


def analyze(sess, kept):
    """Compute latency metrics from send/recv walls."""
    # time-to-first-partial per utterance: first partial at/after each onset wall.
    ttfp = []
    partials_sorted = sorted(sess.partials)
    for seg_idx in sorted(sess.onsets):
        onset_w = sess.onsets[seg_idx]
        nxt = next((p for p in partials_sorted if p >= onset_w), None)
        if nxt is not None:
            ttfp.append(nxt - onset_w)
    session_first_partial = (partials_sorted[0] - sess.t0) if partials_sorted else None

    # partial cadence: inter-arrival gaps between consecutive partial events.
    cadence = [b - a for a, b in zip(partials_sorted, partials_sorted[1:])]

    # commit latency: for each NON-empty committed event, pair it with the
    # nearest commit-send at or before it (robust to stray empty commits and to
    # a commit that produced no event). commit-send wall ~= VAD segment-end time.
    commit_sends_sorted = sorted(w for (_, _, w) in sess.commit_sends)
    commit_lat = []
    for c in sess.commits:
        if not c["text"].strip():
            continue
        prior = [w for w in commit_sends_sorted if w <= c["recv_wall"]]
        if prior:
            commit_lat.append(c["recv_wall"] - prior[-1])

    def med(x):
        return statistics.median(x) if x else None

    def p95(x):
        if not x:
            return None
        s = sorted(x)
        return s[min(len(s) - 1, int(round(0.95 * (len(s) - 1))))]

    return dict(
        ttfp_med=med(ttfp), ttfp_p95=p95(ttfp), ttfp_n=len(ttfp),
        session_first_partial=session_first_partial,
        cadence_med=med(cadence), n_partials=len(partials_sorted),
        commit_lat_med=med(commit_lat), commit_lat_p95=p95(commit_lat),
        commit_lat_max=max(commit_lat) if commit_lat else None,
        n_commits=len(sess.commits), n_commit_sends=len(sess.commit_sends),
    )


def timestamp_origin_probe(sess):
    """Decide whether words[].start is session-cumulative or per-commit-relative.

    For each commit i>=1, compare its first word's start to the running sum of
    prior segment audio lengths. If starts reset toward ~0 each commit ->
    per-commit relative; if they keep climbing with session time -> cumulative.
    """
    rows = []
    for i, c in enumerate(sess.commits):
        words = [w for w in c["words"] if w.get("type") == "word" and w.get("start") is not None]
        if not words:
            rows.append((i, None, None))
            continue
        rows.append((i, float(words[0]["start"]), float(words[-1]["end"])))
    return rows


# ───────────────────────── per-clip run ─────────────────────────

def score_clip(sess):
    ref = normalize((REF_DIR / f"{sess.stem}.txt").read_text(encoding="utf-8"))
    hyp = " ".join(c["text"] for c in sess.commits if c["text"].strip())
    (OUT_DIR / f"{sess.stem}.{sess.pace}.committed.txt").write_text(hyp, encoding="utf-8")
    S, D, I, N = wer_align(ref, normalize(hyp))
    return dict(wer=(S + D + I) / max(N, 1), S=S, D=D, I=I, N=N, hyp=hyp)


async def run_clip(stem, pace):
    samples = read_wav_16k_mono(CLIPS_DIR / f"{stem}.wav")
    segments = vad_segments_live(samples)
    sess = RTSession(stem, pace)
    kept = await sess.run(samples, segments)
    wer = score_clip(sess)
    lat = analyze(sess, kept)
    ts = timestamp_origin_probe(sess)
    audio_s = audio_secs_sent(kept)
    return dict(stem=stem, pace=pace, wer=wer, lat=lat, ts=ts,
                audio_s=audio_s, n_kept=len(kept),
                clip_dur=len(samples) / SAMPLE_RATE)


def pooled(rows):
    tS = sum(r["wer"]["S"] for r in rows)
    tD = sum(r["wer"]["D"] for r in rows)
    tI = sum(r["wer"]["I"] for r in rows)
    tN = sum(r["wer"]["N"] for r in rows)
    return (tS + tD + tI) / max(tN, 1), (tS, tD, tI, tN)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pace", choices=["real", "4x"], default="real")
    ap.add_argument("--clips", nargs="+", help="explicit stems (default clip_11..16)")
    args = ap.parse_args()
    stems = args.clips or NEW_CLIPS

    print(f"Realtime WER/latency harness  pace={args.pace}  clips={stems}")
    print(f"Events -> {EVENTS_DIR}")
    rows = []
    for stem in stems:
        r = asyncio.run(run_clip(stem, args.pace))
        rows.append(r)
        w, l = r["wer"], r["lat"]
        print(f"=== {stem} === WER={w['wer']*100:5.2f}% "
              f"(S{w['S']}/D{w['D']}/I{w['I']}/N{w['N']}) | "
              f"segs={r['n_kept']} commits={l['n_commits']} | "
              f"TTFP med={_f(l['ttfp_med'])}s | "
              f"commit-lat med={_f(l['commit_lat_med'])}s p95={_f(l['commit_lat_p95'])}s | "
              f"audio_sent={r['audio_s']:.1f}s")

    pm, (S, D, I, N) = pooled(rows)
    # persist raw metrics json for the report writer
    dump = []
    for r in rows:
        dump.append(dict(stem=r["stem"], pace=r["pace"], wer=r["wer"],
                         lat=r["lat"], ts=r["ts"], audio_s=r["audio_s"],
                         n_kept=r["n_kept"], clip_dur=r["clip_dur"]))
    (OUT_DIR / f"metrics_{args.pace}.json").write_text(
        json.dumps({"pooled_wer": pm, "SDIN": [S, D, I, N], "clips": dump}, indent=2),
        encoding="utf-8")
    print("\n" + "=" * 64)
    print(f"POOLED committed WER ({args.pace}): {pm*100:.2f}%  (S{S}/D{D}/I{I}/N{N})")
    print(f"Metrics -> {OUT_DIR / f'metrics_{args.pace}.json'}")
    return 0


def _f(x):
    return f"{x:.2f}" if x is not None else "—"


if __name__ == "__main__":
    sys.exit(main())
