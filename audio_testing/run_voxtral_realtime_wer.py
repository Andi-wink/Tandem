#!/usr/bin/env python
"""WER + latency for SELF-HOSTED Voxtral Mini 4B Realtime (vLLM, local RTX 3090).

Mirror of run_scribe_realtime_wer.py so the two engines are directly comparable.
Same clips, same VAD, same feeding shape, same normalization, same scorer.

  clip (16k mono)
    -> per-stream Silero VAD (LIVE Windows config) -- IDENTICAL to the Scribe
       realtime replica and the batch harness (vad_segments_live)
    -> VAD-gated feeding: at each speech-segment ONSET feed 300ms pre-roll
       (PREROLL_SAMPLES=4800) then the segment's audio in 250ms frames
       (FRAME_SAMPLES=4000) as it accrues; 250ms silence keepalive when idle
       >= KEEPALIVE_IDLE_SECS (10s).
    -> hypothesis = concatenation of streamed `transcription.delta` text
  vs the ElevenLabs full-clip reference -> WER (same normalize + wer_align).

WHAT DIFFERS FROM THE SCRIBE REPLICA, AND WHY
---------------------------------------------
1. NO PER-SEGMENT COMMIT. Voxtral Realtime is a causal encoder with a fixed
   `transcription_delay_ms`; it has no manual commit concept. vLLM's realtime
   protocol uses ONE `input_audio_buffer.commit` up front to open the stream and
   ONE `{"commit", "final": true}` at clip end to close it. So the Scribe
   replica's per-VAD-segment `commit=true` frames, its COMMIT_MIN_SAMPLES>=800
   gate and its whole commit-point machinery have no analogue here and are
   removed. There is consequently no commit-boundary insertion penalty to pay.
2. COMMITTED-ONLY vs DELTA. Scribe is scored on
   `committed_transcript_with_timestamps` (its stable text). Voxtral has no
   partial/committed split: every `transcription.delta` is already final and
   append-only. The delta concatenation is therefore the honest analogue of
   Scribe's committed transcript, and it is what a user would see on screen.
   `transcription.done.text` is captured too and reported as a cross-check.
3. LATENCY METRIC. There are no commit events, so "commit latency" is undefined.
   The comparable number is EMISSION LAG: wall time between the last audio frame
   delivered and the arrival of a delta. Under real-time pacing a lag that stays
   bounded means the server keeps up; a lag that grows monotonically means it
   does not, which is disqualifying regardless of WER.
4. FEED MODE. `--feed vad` (default) reproduces the Scribe replica exactly and is
   the apples-to-apples number. `--feed continuous` streams the whole clip
   including silence, which a causal streaming model may prefer because it never
   sees a splice. The two are reported SEPARATELY and must not be conflated.

`--delay-ms` is RECORDED, NOT APPLIED. Voxtral's transcription delay lives in the
model's tekken.json (`transcription_delay_ms`), read at tokenizer load; vLLM
exposes no serve-time flag. To sweep it you must patch tekken.json in the HF
cache and RESTART the server, then pass the matching --delay-ms so the outputs
are labelled correctly. The script asserts nothing about the served value.

GROUND-TRUTH CAVEAT: audio_testing/elevenlabs/ is full-clip ElevenLabs Scribe
output, not human transcription. Scoring a non-ElevenLabs engine against it
systematically favours ElevenLabs: wherever Scribe misheard a word, Voxtral
getting it RIGHT is counted as an error. Treat every absolute number here as
biased against Voxtral by an unknown amount. See --dump-disagreements.

Outputs -> audio_testing/voxtral_out/ (git-ignored: contains client transcripts).

Run:
  .venv/Scripts/python.exe audio_testing/run_voxtral_realtime_wer.py --delay-ms 480
  .venv/Scripts/python.exe audio_testing/run_voxtral_realtime_wer.py --clips clip_07 --delay-ms 480
  .venv/Scripts/python.exe audio_testing/run_voxtral_realtime_wer.py --pace fast --delay-ms 480
"""
import argparse
import asyncio
import base64
import json
import statistics
import sys
import time
from pathlib import Path

import numpy as np
import websockets

# Reuse the IDENTICAL VAD + scoring as the Scribe harnesses (do NOT reinvent).
from run_scribe_meeting_wer import vad_segments_live, MIN_SEGMENT_SAMPLES  # LIVE VAD
from run_tandem_parakeet import read_wav_16k_mono, normalize, wer_align, REF_DIR, CLIPS_DIR

HERE = Path(__file__).parent
OUT_DIR = HERE / "voxtral_out"
EVENTS_DIR = OUT_DIR / "events"
EVENTS_DIR.mkdir(parents=True, exist_ok=True)

# ── Feed constants: byte-identical to the Scribe realtime replica ──
SAMPLE_RATE = 16000                       # FEED_SAMPLE_RATE
FRAME_SAMPLES = 4000                      # 250ms
PREROLL_SAMPLES = 4800                    # 300ms
KEEPALIVE_IDLE_SECS = 10.0
KEEPALIVE_SILENCE_SAMPLES = 4000          # 250ms of zeros

DEFAULT_MODEL = "mistralai/Voxtral-Mini-4B-Realtime-2602"
NEW_CLIPS = [f"clip_{n:02d}" for n in (11, 12, 13, 14, 15, 16)]


def f32_to_pcm16_bytes(samples):
    """Mirror the Rust f32_to_pcm16_bytes (clamp to +/-32767)."""
    a = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    return (a * 32767.0).round().astype("<i2").tobytes()


def encode_append(pcm_bytes):
    return json.dumps({
        "type": "input_audio_buffer.append",
        "audio": base64.b64encode(pcm_bytes).decode(),
    })


# ───────────────────────── feed schedule ─────────────────────────

def build_schedule_vad(samples, segments):
    """VAD-gated feed, identical in shape to the Scribe replica minus commits.

    Each entry: dict(at=clip_time_s, kind, pcm, seg). Pre-roll is already-captured
    past audio delivered at onset; body samples accrue in real time.
    """
    sched = []
    kept = [(s, e, sm) for (s, e, sm) in segments if len(sm) >= MIN_SEGMENT_SAMPLES]
    last_audio_end_s = 0.0
    for seg_idx, (start_ms, end_ms, seg_samples) in enumerate(kept):
        start_s = start_ms / 1000.0
        end_s = end_ms / 1000.0

        # Keepalive during a long idle gap before this onset.
        gap_cursor = last_audio_end_s
        while start_s - gap_cursor >= KEEPALIVE_IDLE_SECS:
            gap_cursor += KEEPALIVE_IDLE_SECS
            sched.append(dict(at=gap_cursor, kind="keepalive", seg=-1,
                              pcm=f32_to_pcm16_bytes(
                                  np.zeros(KEEPALIVE_SILENCE_SAMPLES, np.float32))))

        sched.append(dict(at=start_s, kind="onset", seg=seg_idx, pcm=None))

        start_sample = int(round(start_s * SAMPLE_RATE))
        pre_lo = max(0, start_sample - PREROLL_SAMPLES)
        preroll = samples[pre_lo:start_sample]
        fed = np.concatenate([preroll, np.asarray(seg_samples, np.float32)])

        n_pre = len(preroll)
        n_full = len(fed) // FRAME_SAMPLES
        for j in range(n_full):
            chunk = fed[j * FRAME_SAMPLES:(j + 1) * FRAME_SAMPLES]
            body_done = max(0, (j + 1) * FRAME_SAMPLES - n_pre)
            avail = min(end_s, start_s + body_done / SAMPLE_RATE)
            sched.append(dict(at=avail, kind="frame", seg=seg_idx,
                              pcm=f32_to_pcm16_bytes(chunk)))
        tail = fed[n_full * FRAME_SAMPLES:]
        if len(tail) > 0:
            sched.append(dict(at=end_s, kind="frame", seg=seg_idx,
                              pcm=f32_to_pcm16_bytes(tail)))
        last_audio_end_s = end_s

    sched.sort(key=lambda d: (d["at"], 0 if d["kind"] == "onset" else 1))
    return sched, kept


def build_schedule_continuous(samples, segments):
    """Whole clip, silence included, in the same 250ms frames.

    A causal streaming model never sees a splice this way. Reported separately;
    NOT comparable to the Scribe number.
    """
    sched = []
    kept = [(s, e, sm) for (s, e, sm) in segments if len(sm) >= MIN_SEGMENT_SAMPLES]
    onset_marks = {int(round(s / 1000.0 * SAMPLE_RATE)) // FRAME_SAMPLES: i
                   for i, (s, e, sm) in enumerate(kept)}
    n_full = len(samples) // FRAME_SAMPLES
    for j in range(n_full):
        at = (j + 1) * FRAME_SAMPLES / SAMPLE_RATE
        if j in onset_marks:
            sched.append(dict(at=j * FRAME_SAMPLES / SAMPLE_RATE, kind="onset",
                              seg=onset_marks[j], pcm=None))
        sched.append(dict(at=at, kind="frame", seg=-1,
                          pcm=f32_to_pcm16_bytes(
                              samples[j * FRAME_SAMPLES:(j + 1) * FRAME_SAMPLES])))
    tail = samples[n_full * FRAME_SAMPLES:]
    if len(tail) > 0:
        sched.append(dict(at=len(samples) / SAMPLE_RATE, kind="frame", seg=-1,
                          pcm=f32_to_pcm16_bytes(tail)))
    sched.sort(key=lambda d: (d["at"], 0 if d["kind"] == "onset" else 1))
    return sched, kept


# ───────────────────────── WS session ─────────────────────────

class VoxtralSession:
    def __init__(self, stem, pace, feed, delay_ms, url, model):
        self.stem = stem
        self.pace = pace           # "real" or "fast"
        self.feed = feed           # "vad" or "continuous"
        self.delay_ms = delay_ms
        self.url = url
        self.model = model
        self.t0 = None
        tag = f"{stem}_{feed}_{pace}_d{delay_ms}"
        self.evlog = open(EVENTS_DIR / f"events_{tag}.jsonl", "w", encoding="utf-8")
        self.deltas = []           # dict(text, recv_wall)
        self.done_text = None
        self.usage = None
        self.onsets = {}           # seg_idx -> send_wall
        self.last_frame_wall = None    # wall of most recent audio frame sent
        self.last_frame_at = None      # clip-time of most recent audio frame sent
        self.send_done_wall = None
        self.audio_bytes_sent = 0
        self.error = None

    def _log(self, direction, obj, note=None):
        rec = {"t": round(time.monotonic() - self.t0, 4), "dir": direction}
        if note:
            rec["note"] = note
        if isinstance(obj, dict):
            red = {}
            for k, v in obj.items():
                if k == "audio" and isinstance(v, str):
                    red[k] = f"<b64 {len(v)} chars>"
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
                t = obj.get("type") or ""
                if t == "transcription.delta":
                    self.deltas.append(dict(text=obj.get("delta", "") or "",
                                            recv_wall=wall))
                elif t == "transcription.done":
                    self.done_text = obj.get("text", "") or ""
                    self.usage = obj.get("usage")
                    stop_evt.set()
                    break
                elif t == "error":
                    self.error = str(obj.get("error"))[:300]
                    stop_evt.set()
                    break
        except websockets.ConnectionClosed as e:
            self._log("recv", {"closed": True, "code": e.code, "reason": str(e.reason)})
        stop_evt.set()

    async def send_schedule(self, ws, sched):
        div = 1.0 if self.pace == "real" else None
        for entry in sched:
            if div is not None:
                target = self.t0 + entry["at"] / div
                now = time.monotonic()
                if target > now:
                    await asyncio.sleep(target - now)
            wall = time.monotonic()
            kind = entry["kind"]
            if kind == "onset":
                self.onsets[entry["seg"]] = wall
                continue
            await ws.send(encode_append(entry["pcm"]))
            self.audio_bytes_sent += len(entry["pcm"])
            if kind == "frame":
                self.last_frame_wall = wall
                self.last_frame_at = entry["at"]
        self.send_done_wall = time.monotonic()

    async def run(self, samples, segments, hold_open=120.0):
        builder = build_schedule_vad if self.feed == "vad" else build_schedule_continuous
        sched, kept = builder(samples, segments)
        self.t0 = time.monotonic()
        self._log("meta", {"stem": self.stem, "pace": self.pace, "feed": self.feed,
                           "delay_ms": self.delay_ms, "model": self.model,
                           "n_segments_kept": len(kept),
                           "clip_dur_s": round(len(samples) / SAMPLE_RATE, 2),
                           "url": self.url})
        try:
            async with websockets.connect(self.url, max_size=None,
                                          ping_interval=None) as ws:
                first = json.loads(await ws.recv())
                self._log("recv", first)
                if first.get("type") != "session.created":
                    self.error = f"unexpected first event: {first.get('type')}"
                    self.evlog.close()
                    return kept

                await ws.send(json.dumps({"type": "session.update",
                                          "model": self.model}))
                # Opens the stream (vLLM example sends this BEFORE any audio).
                await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))

                stop_evt = asyncio.Event()
                recv_task = asyncio.create_task(self.recv_loop(ws, stop_evt))
                await self.send_schedule(ws, sched)
                await ws.send(json.dumps({"type": "input_audio_buffer.commit",
                                          "final": True}))
                self._log("send", {"kind": "final_commit"})
                try:
                    await asyncio.wait_for(stop_evt.wait(), timeout=hold_open)
                except asyncio.TimeoutError:
                    self._log("meta", {"note": "hold_open timeout, no done event"})
                recv_task.cancel()
        except Exception as e:  # noqa: BLE001
            self.error = f"{type(e).__name__}: {str(e)[:300]}"
            self._log("error", {"exception": type(e).__name__, "msg": str(e)[:300]})
        self.evlog.close()
        return kept


# ───────────────────────── metrics ─────────────────────────

def audio_secs_sent(sess):
    return sess.audio_bytes_sent / 2.0 / SAMPLE_RATE


def analyze(sess, clip_dur):
    """Latency + throughput. No commit events exist, so we measure emission lag."""
    walls = [d["recv_wall"] for d in sess.deltas]

    # Emission lag: for each delta, wall gap since the most recent audio frame
    # that had been delivered when it arrived. Under real pacing this is the
    # user-visible "how long after I spoke does text appear" number.
    lags = []
    if sess.pace == "real":
        # rebuild the send timeline from clip-time: frame at clip-time `at` was
        # sent at t0 + at, so lag = (recv_wall - t0) - at_of_last_frame_before_it.
        for w in walls:
            rel = w - sess.t0
            lags.append(rel)  # placeholder, refined below

    # First-delta latency per utterance onset.
    ttfd = []
    walls_sorted = sorted(walls)
    for seg_idx in sorted(sess.onsets):
        onset_w = sess.onsets[seg_idx]
        nxt = next((p for p in walls_sorted if p >= onset_w), None)
        if nxt is not None:
            ttfd.append(nxt - onset_w)

    cadence = [b - a for a, b in zip(walls_sorted, walls_sorted[1:])]

    # Tail lag: how long after the LAST audio frame did the last delta / done land.
    tail_lag = (walls_sorted[-1] - sess.last_frame_wall) if (
        walls_sorted and sess.last_frame_wall) else None

    wall_total = (walls_sorted[-1] - sess.t0) if walls_sorted else None
    audio_s = audio_secs_sent(sess)
    # RTF = server wall time to consume the stream / audio seconds fed.
    # Only meaningful in --pace fast (real pacing floors it at ~1.0 by design).
    rtf = (wall_total / audio_s) if (wall_total and audio_s > 0) else None

    def med(x):
        return statistics.median(x) if x else None

    def p95(x):
        if not x:
            return None
        s = sorted(x)
        return s[min(len(s) - 1, int(round(0.95 * (len(s) - 1))))]

    return dict(
        ttfd_med=med(ttfd), ttfd_p95=p95(ttfd), ttfd_n=len(ttfd),
        cadence_med=med(cadence), n_deltas=len(walls),
        tail_lag=tail_lag, wall_total=wall_total,
        audio_s=audio_s, rtf=rtf, clip_dur=clip_dur,
        error=sess.error,
    )


def refine_lags(sess, sched):
    """Emission lag per delta against the audio-availability timeline."""
    frames = [(e["at"], sess.t0 + e["at"] / (1.0 if sess.pace == "real" else 1e9))
              for e in sched if e["kind"] == "frame"]
    if not frames or sess.pace != "real":
        return []
    lags = []
    for d in sess.deltas:
        prior = [at for (at, w) in frames if w <= d["recv_wall"]]
        if prior:
            lags.append((d["recv_wall"] - sess.t0) - prior[-1])
    return lags


# ───────────────────────── scoring ─────────────────────────

def score(sess):
    ref = normalize((REF_DIR / f"{sess.stem}.txt").read_text(encoding="utf-8"))
    hyp_stream = "".join(d["text"] for d in sess.deltas)
    tag = f"{sess.stem}.{sess.feed}.{sess.pace}.d{sess.delay_ms}"
    (OUT_DIR / f"{tag}.stream.txt").write_text(hyp_stream, encoding="utf-8")
    S, D, I, N = wer_align(ref, normalize(hyp_stream))
    out = dict(wer=(S + D + I) / max(N, 1), S=S, D=D, I=I, N=N, hyp=hyp_stream)

    if sess.done_text is not None:
        (OUT_DIR / f"{tag}.done.txt").write_text(sess.done_text, encoding="utf-8")
        S2, D2, I2, N2 = wer_align(ref, normalize(sess.done_text))
        out["done"] = dict(wer=(S2 + D2 + I2) / max(N2, 1), S=S2, D=D2, I=I2, N=N2)
    return out


async def run_clip(stem, pace, feed, delay_ms, url, model):
    samples = read_wav_16k_mono(CLIPS_DIR / f"{stem}.wav")
    segments = vad_segments_live(samples)
    sess = VoxtralSession(stem, pace, feed, delay_ms, url, model)
    kept = await sess.run(samples, segments)
    w = score(sess)
    lat = analyze(sess, len(samples) / SAMPLE_RATE)
    builder = build_schedule_vad if feed == "vad" else build_schedule_continuous
    sched, _ = builder(samples, segments)
    lags = refine_lags(sess, sched)
    if lags:
        lat["lag_med"] = statistics.median(lags)
        lat["lag_p95"] = sorted(lags)[min(len(lags) - 1, int(round(0.95 * (len(lags) - 1))))]
        lat["lag_max"] = max(lags)
        # Growth check: median lag of the last quartile vs the first quartile.
        q = max(1, len(lags) // 4)
        lat["lag_drift"] = statistics.median(lags[-q:]) - statistics.median(lags[:q])
    return dict(stem=stem, pace=pace, feed=feed, delay_ms=delay_ms,
                wer=w, lat=lat, n_kept=len(kept),
                clip_dur=len(samples) / SAMPLE_RATE)


def pooled(rows, key="wer"):
    tS = sum(r[key]["S"] for r in rows)
    tD = sum(r[key]["D"] for r in rows)
    tI = sum(r[key]["I"] for r in rows)
    tN = sum(r[key]["N"] for r in rows)
    return (tS + tD + tI) / max(tN, 1), (tS, tD, tI, tN)


def _f(x, n=2):
    return f"{x:.{n}f}" if x is not None else "-"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", nargs="+", help="explicit stems (default clip_11..16)")
    ap.add_argument("--delay-ms", type=int, default=480,
                    help="LABEL ONLY: the transcription_delay_ms the server was "
                         "started with (patched into tekken.json). Not applied.")
    ap.add_argument("--pace", choices=["real", "fast"], default="real",
                    help="real = 1x audio time (latency valid); fast = no pacing (RTF)")
    ap.add_argument("--feed", choices=["vad", "continuous"], default="vad",
                    help="vad = Scribe-comparable; continuous = whole clip incl silence")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    args = ap.parse_args()

    stems = args.clips or NEW_CLIPS
    url = f"ws://{args.host}:{args.port}/v1/realtime"

    print(f"Voxtral realtime harness  feed={args.feed} pace={args.pace} "
          f"delay={args.delay_ms}ms  clips={stems}")
    print(f"Server: {url}  model={args.model}")
    print(f"Events -> {EVENTS_DIR}")

    rows = []
    for stem in stems:
        r = asyncio.run(run_clip(stem, args.pace, args.feed, args.delay_ms,
                                 url, args.model))
        rows.append(r)
        w, l = r["wer"], r["lat"]
        err = f"  !! {l['error']}" if l.get("error") else ""
        print(f"=== {stem} === WER={w['wer']*100:5.2f}% "
              f"(S{w['S']}/D{w['D']}/I{w['I']}/N{w['N']}) | "
              f"segs={r['n_kept']} deltas={l['n_deltas']} | "
              f"lag med={_f(l.get('lag_med'))}s p95={_f(l.get('lag_p95'))}s "
              f"drift={_f(l.get('lag_drift'))}s | "
              f"tail={_f(l.get('tail_lag'))}s | RTF={_f(l.get('rtf'))} | "
              f"audio={l['audio_s']:.1f}s{err}")

    ok = [r for r in rows if r["wer"]["N"] > 0]
    pm, (S, D, I, N) = pooled(ok)
    tag = f"{args.feed}_{args.pace}_d{args.delay_ms}"
    (OUT_DIR / f"metrics_{tag}.json").write_text(
        json.dumps({"pooled_wer": pm, "SDIN": [S, D, I, N],
                    "feed": args.feed, "pace": args.pace,
                    "delay_ms": args.delay_ms, "model": args.model,
                    "clips": rows}, indent=2, default=str),
        encoding="utf-8")
    print("\n" + "=" * 64)
    print(f"POOLED streamed WER ({tag}): {pm*100:.2f}%  (S{S}/D{D}/I{I}/N{N})")
    if any("done" in r["wer"] for r in ok):
        pd_, (S2, D2, I2, N2) = pooled([r for r in ok if "done" in r["wer"]], "wer")
        dsum = [r["wer"]["done"] for r in ok if "done" in r["wer"]]
        tS = sum(d["S"] for d in dsum); tD = sum(d["D"] for d in dsum)
        tI = sum(d["I"] for d in dsum); tN = sum(d["N"] for d in dsum)
        print(f"POOLED done-event WER      : {(tS+tD+tI)/max(tN,1)*100:.2f}%  "
              f"(S{tS}/D{tD}/I{tI}/N{tN})")
    print("NOTE: reference is full-clip ElevenLabs Scribe output, NOT human "
          "truth. These numbers are biased in ElevenLabs' favour.")
    print(f"Metrics -> {OUT_DIR / f'metrics_{tag}.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
