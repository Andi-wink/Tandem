#!/usr/bin/env python
"""WER for the WHISPERING Scribe v2 Realtime client strategy (comparison harness).

Faithful offline replica of the Whispering realtime client
(D:\\Dev-projects\\Whispering\\epicenter\\.claude\\worktrees\\realtime-scribe\\
 apps\\whispering\\src\\lib\\services\\transcription\\cloud\\elevenlabs-realtime.ts
 + apps\\whispering\\src\\lib\\utils\\pcm.ts), streaming clips 11-16 over the live
ElevenLabs Realtime WebSocket. It exists to be compared, apples-to-apples, against
Tandem's own realtime strategy in run_scribe_realtime_wer.py (same model, same
clips, same scoring).

WHISPERING strategy (confirmed against the source above):
  - Endpoint: wss://api.elevenlabs.io/v1/speech-to-text/realtime
  - Query: model_id=scribe_v2_realtime & audio_format=pcm_16000 &
           commit_strategy=manual. NO language_code (auto-detect), NO keyterms,
           NO include_timestamps, NO vad_silence_threshold. (buildWsUrl only adds
           language_code when set and != 'auto', vad_silence_threshold when
           defined, keyterms when present; this harness sets none of them.)
  - Feed: the ENTIRE clip as continuous 250ms chunks (4000 samples int16 base64)
           with commit:false, no VAD gating, no pre-roll. flushFullChunks() emits
           every full 4000-sample chunk as it accrues; the sub-4000 remainder is
           held. finalize() sends that remainder (or an empty audio marker if the
           clip is an exact multiple of 4000 samples) with commit:true.
  - int16 conversion mirrors pcm.ts float32ToInt16 (asymmetric: neg*0x8000,
           pos*0x7fff, clamp to [-1,1]) and int16ToBase64 (little-endian).
  - Message shape: {message_type:"input_audio_chunk", audio_base_64, commit,
           sample_rate:16000}. No previous_text (previousText unset here).
  - Collects committed_transcript messages ONLY (partial_transcript ignored, like
           Whispering). Final hypothesis = space-joined committed texts, whitespace
           collapsed, trimmed (joinedTranscript()).

DOCUMENTED DEVIATION (does NOT affect WER): Whispering mints a single-use token and
passes ?token= because BROWSER WebSockets cannot set request headers. This harness
runs in Python (not a browser) so it uses the same xi-api-key HEADER auth as
Tandem's RTSession for simplicity. Auth strategy is orthogonal to transcription
accuracy; the audio fed and messages sent are identical to Whispering's.

Two pacing modes (Phase 3 proved 4x gives WER identical to real pace):
  --pace real   250ms sleep per 250ms chunk  (REQUIRED for turnaround timing)
  --pace 4x     62.5ms per chunk             (cheaper WER re-runs)

Cache is impossible (stateful stream): every run costs realtime API minutes.
API key read from the app SQLite; NEVER printed/logged. Event logs (contain client
transcript text) -> realtime_out/events/  (git-ignored).

Run:
  .venv/Scripts/python.exe audio_testing/run_whispering_realtime_wer.py --pace 4x
  .venv/Scripts/python.exe audio_testing/run_whispering_realtime_wer.py --pace real --clips clip_11
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

# Reuse the IDENTICAL scoring as every other harness (import, do NOT copy).
from run_tandem_parakeet import read_wav_16k_mono, normalize, wer_align, REF_DIR, CLIPS_DIR

HERE = Path(__file__).parent
OUT_DIR = HERE / "realtime_out"
EVENTS_DIR = OUT_DIR / "events"
EVENTS_DIR.mkdir(parents=True, exist_ok=True)

# ── Constants confirmed against elevenlabs-realtime.ts + pcm.ts (2026-07-27) ──
BASE_WSS = "wss://api.elevenlabs.io/v1/speech-to-text/realtime"
MODEL_ID = "scribe_v2_realtime"          # MODEL_ID
SAMPLE_RATE = 16000                       # SAMPLE_RATE
CHUNK_SAMPLES = 4000                       # CHUNK_SAMPLES = 16000*250/1000 (250ms)
CHUNK_SECS = CHUNK_SAMPLES / SAMPLE_RATE   # 0.25
COMMIT_STRATEGY = "manual"                 # options.commitStrategy passed by caller

NEW_CLIPS = [f"clip_{n:02d}" for n in (11, 12, 13, 14, 15, 16)]

# Server message types Whispering treats as fatal (SERVER_ERROR_TYPES). We only
# need to *report* these; the harness does not model the finalize fallback.
SERVER_ERROR_TYPES = {
    "error", "auth_error", "quota_exceeded", "commit_throttled", "rate_limited",
    "queue_overflow", "resource_exhausted", "session_time_limit_exceeded",
    "input_error", "chunk_size_exceeded", "insufficient_audio_activity",
    "transcriber_error",
}

_API_KEY = None


def get_api_key():
    """Read the ElevenLabs key from the app SQLite. Never printed/logged.

    Same source + table as run_scribe_realtime_wer.get_api_key (replicated, not
    imported, to keep this module's import graph minimal)."""
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


def float32_to_int16(samples):
    """Mirror pcm.ts float32ToInt16: clamp [-1,1]; neg*0x8000, pos*0x7fff; round."""
    a = np.asarray(samples, dtype=np.float32)
    a = np.clip(a, -1.0, 1.0)
    scaled = np.where(a < 0, a * 0x8000, a * 0x7fff)
    return np.round(scaled).astype("<i2")


def int16_to_base64(int16):
    """Mirror pcm.ts int16ToBase64: little-endian int16 bytes -> base64."""
    return base64.b64encode(np.asarray(int16, dtype="<i2").tobytes()).decode()


def build_url():
    # URLSearchParams order in buildWsUrl: model_id, audio_format, commit_strategy.
    # language_code / vad_silence_threshold / keyterms omitted (unset here).
    return (f"{BASE_WSS}?model_id={MODEL_ID}&audio_format=pcm_{SAMPLE_RATE}"
            f"&commit_strategy={COMMIT_STRATEGY}")


def encode_chunk(int16, commit):
    """Mirror sendChunk(): empty audio -> '' , else int16ToBase64. No previous_text."""
    return json.dumps({
        "message_type": "input_audio_chunk",
        "audio_base_64": int16_to_base64(int16) if len(int16) else "",
        "commit": commit,
        "sample_rate": SAMPLE_RATE,
    })


# ───────────────────────── feed schedule ─────────────────────────

def build_schedule(int16):
    """Whispering feed: continuous 250ms chunks (commit:false), remainder committed.

    flushFullChunks emits each full 4000-sample chunk as it becomes available
    (audio-availability time = (j+1)*250ms). finalize sends the sub-4000 remainder
    (splice of pending) with commit:true; if the clip is an exact multiple of 4000
    the remainder is empty and an empty-audio commit marker is sent instead.

    Returns (sched, n_full, n_remainder). Each sched entry:
      dict(at=audio_avail_s, kind='frame'|'commit', int16=<array>)
    """
    n = len(int16)
    n_full = n // CHUNK_SAMPLES
    sched = []
    for j in range(n_full):
        chunk = int16[j * CHUNK_SAMPLES:(j + 1) * CHUNK_SAMPLES]
        avail = (j + 1) * CHUNK_SECS
        sched.append(dict(at=avail, kind="frame", int16=chunk))
    remainder = int16[n_full * CHUNK_SAMPLES:]
    total_dur = n / SAMPLE_RATE
    # finalize() fires when the last audio has been captured -> at clip end.
    sched.append(dict(at=total_dur, kind="commit", int16=remainder))
    return sched, n_full, len(remainder)


# ───────────────────────── WS session ─────────────────────────

class WhisperingSession:
    def __init__(self, stem, pace):
        self.stem = stem
        self.pace = pace          # "real" or "4x"
        self.div = 1.0 if pace == "real" else 4.0
        self.t0 = None
        self.evlog = open(EVENTS_DIR / f"events_{stem}_whispering_{pace}.jsonl", "w",
                          encoding="utf-8")
        self.commits = []         # dict(text, recv_wall) — committed_transcript only
        self.n_partials = 0
        self.commit_send_wall = None   # wall the finalize commit:true was sent
        self.commit_send_t = None      # clip-relative send time
        self.server_errors = []        # (message_type, wall)
        self.unexpected_types = {}     # message_type -> count (diagnostics)
        self.saw_with_timestamps = 0   # anomaly: server sent timestamps we didn't ask for

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
                    self.n_partials += 1              # ignored, like Whispering
                elif mt == "committed_transcript":
                    txt = obj.get("text", "") or ""
                    if txt:                            # Whispering: push only if length
                        self.commits.append(dict(text=txt, recv_wall=wall))
                elif mt == "committed_transcript_with_timestamps":
                    # Anomaly: we did NOT request include_timestamps. Record it, and
                    # still capture the text so a stray variant is not silently lost.
                    self.saw_with_timestamps += 1
                    txt = obj.get("text", "") or ""
                    if txt:
                        self.commits.append(dict(text=txt, recv_wall=wall))
                elif mt in SERVER_ERROR_TYPES:
                    self.server_errors.append((mt, wall))
                elif mt not in ("session_started",):
                    self.unexpected_types[mt] = self.unexpected_types.get(mt, 0) + 1
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
            if kind == "frame":
                await ws.send(encode_chunk(entry["int16"], False))
            elif kind == "commit":
                await ws.send(encode_chunk(entry["int16"], True))
                self.commit_send_wall = wall
                self.commit_send_t = entry["at"]
            self._log("send", {"kind": kind, "at": round(entry["at"], 3),
                               "n_samples": int(len(entry["int16"]))})

    async def run(self, int16, hold_open=8.0):
        sched, n_full, n_rem = build_schedule(int16)
        url = build_url()
        self.t0 = time.monotonic()
        self._log("meta", {"stem": self.stem, "pace": self.pace,
                            "n_full_chunks": n_full, "n_remainder_samples": n_rem,
                            "clip_dur_s": round(len(int16) / SAMPLE_RATE, 2),
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
            raise
        finally:
            self.evlog.close()
        return n_full, n_rem


# ───────────────────────── metrics ─────────────────────────

def score_clip(sess):
    ref = normalize((REF_DIR / f"{sess.stem}.txt").read_text(encoding="utf-8"))
    # joinedTranscript(): join with ' ', collapse whitespace, trim.
    hyp = " ".join(c["text"] for c in sess.commits)
    hyp = " ".join(hyp.split())
    (OUT_DIR / f"{sess.stem}.whispering.committed.txt").write_text(hyp, encoding="utf-8")
    S, D, I, N = wer_align(ref, normalize(hyp))
    return dict(wer=(S + D + I) / max(N, 1), S=S, D=D, I=I, N=N, hyp=hyp)


def turnaround(sess):
    """Final-commit turnaround = time from commit:true sent to the committed
    transcript that arrives after it (Whispering commits once at clip end)."""
    if sess.commit_send_wall is None:
        return None
    after = [c["recv_wall"] for c in sess.commits if c["recv_wall"] >= sess.commit_send_wall]
    if not after:
        return None
    # last committed_transcript after the final commit == the finalize resolution.
    return max(after) - sess.commit_send_wall


# ───────────────────────── per-clip run ─────────────────────────

async def run_clip_once(stem, pace):
    samples = read_wav_16k_mono(CLIPS_DIR / f"{stem}.wav")
    int16 = float32_to_int16(samples)
    sess = WhisperingSession(stem, pace)
    n_full, n_rem = await sess.run(int16)
    wer = score_clip(sess)
    ta = turnaround(sess)
    return dict(stem=stem, pace=pace, wer=wer,
                turnaround=ta, n_commits=len(sess.commits),
                n_partials=sess.n_partials,
                empty_hyp=(not wer["hyp"].strip()),
                server_errors=[e[0] for e in sess.server_errors],
                unexpected_types=sess.unexpected_types,
                saw_with_timestamps=sess.saw_with_timestamps,
                n_full_chunks=n_full, n_remainder=n_rem,
                clip_dur=len(samples) / SAMPLE_RATE)


def run_clip(stem, pace):
    """Run one clip; retry ONCE on a transient WS failure or empty hypothesis."""
    try:
        r = asyncio.run(run_clip_once(stem, pace))
        if r["empty_hyp"]:
            print(f"    [warn] {stem}: empty committed hypothesis, retrying once")
            r2 = asyncio.run(run_clip_once(stem, pace))
            r2["retried"] = True
            return r2
        return r
    except Exception as e:
        print(f"    [warn] {stem}: WS run failed ({type(e).__name__}), retrying once")
        r = asyncio.run(run_clip_once(stem, pace))
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pace", choices=["real", "4x"], default="real")
    ap.add_argument("--clips", nargs="+", help="explicit stems (default clip_11..16)")
    args = ap.parse_args()
    stems = args.clips or NEW_CLIPS

    print(f"Whispering-strategy realtime WER harness  pace={args.pace}  clips={stems}")
    print(f"Events -> {EVENTS_DIR}")
    rows = []
    for stem in stems:
        r = run_clip(stem, args.pace)
        rows.append(r)
        w = r["wer"]
        errs = ("  ERR:" + ",".join(r["server_errors"])) if r["server_errors"] else ""
        print(f"=== {stem} === WER={w['wer']*100:5.2f}% "
              f"(S{w['S']}/D{w['D']}/I{w['I']}/N{w['N']}) | "
              f"commits={r['n_commits']} partials={r['n_partials']} | "
              f"turnaround={_f(r['turnaround'])}s | "
              f"chunks={r['n_full_chunks']}+{r['n_remainder']}smp{errs}")

    pm, (S, D, I, N) = pooled(rows)
    turnarounds = [r["turnaround"] for r in rows if r["turnaround"] is not None]
    dump = []
    for r in rows:
        dump.append(dict(stem=r["stem"], pace=r["pace"], wer=r["wer"],
                         turnaround=r["turnaround"], n_commits=r["n_commits"],
                         n_partials=r["n_partials"], empty_hyp=r["empty_hyp"],
                         retried=r.get("retried", False),
                         server_errors=r["server_errors"],
                         unexpected_types=r["unexpected_types"],
                         saw_with_timestamps=r["saw_with_timestamps"],
                         n_full_chunks=r["n_full_chunks"], n_remainder=r["n_remainder"],
                         clip_dur=r["clip_dur"]))
    out = {
        "strategy": "whispering",
        "pooled_wer": pm,
        "SDIN": [S, D, I, N],
        "turnaround_median": statistics.median(turnarounds) if turnarounds else None,
        "turnaround_max": max(turnarounds) if turnarounds else None,
        "turnaround_min": min(turnarounds) if turnarounds else None,
        "clips": dump,
    }
    path = OUT_DIR / f"metrics_whispering_{args.pace}.json"
    path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print("\n" + "=" * 64)
    print(f"POOLED committed WER ({args.pace}): {pm*100:.2f}%  (S{S}/D{D}/I{I}/N{N})")
    if turnarounds:
        print(f"Final-commit turnaround: median={statistics.median(turnarounds):.2f}s  "
              f"min={min(turnarounds):.2f}s  max={max(turnarounds):.2f}s")
    print(f"Metrics -> {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
