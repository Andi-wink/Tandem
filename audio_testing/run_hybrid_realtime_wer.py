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

Run:
  .venv/Scripts/python.exe audio_testing/run_hybrid_realtime_wer.py --interval 10 --pace 4x
  .venv/Scripts/python.exe audio_testing/run_hybrid_realtime_wer.py --interval 15 --pace 4x --clips clip_11
"""
import argparse
import asyncio
import json
import statistics
import sys
import time
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

SAFETY_EXTRA_SECS = 5.0  # mid-speech safety valve: INTERVAL + this and still no gap
# Finalize collision guard (mirrors the Rust engine's commit_throttled fix): only
# emit the separate clip-end finalize commit if meaningful audio has been fed since
# the last commit. When a periodic/safety-valve commit fired on the final full
# chunk, the finalize would land ~0.075s later, the server throttles one of the two
# back-to-back commits (commit_throttled) and orphans the whole trailing window. A
# 1.0s guard cleanly separates that collision (gap < 0.25s remainder) from a
# legitimate flush (gap = seconds since the last periodic commit).
FINALIZE_MIN_GAP_SECS = 1.0
NEW_CLIPS = [f"clip_{n:02d}" for n in (11, 12, 13, 14, 15, 16)]


# ───────────────────────── VAD gaps + commit schedule ─────────────────────────

def kept_segments_secs(samples):
    """LIVE-config VAD segments >= MIN_SEGMENT_SAMPLES, as (start_s, end_s)."""
    segs = vad_segments_live(samples)
    return [(s / 1000.0, e / 1000.0) for (s, e, sm) in segs
            if len(sm) >= MIN_SEGMENT_SAMPLES]


def build_schedule(int16, kept, interval):
    """Whispering continuous feed with periodic commit flags placed at VAD gaps.

    Returns (sched, n_full, n_remainder, commit_audio_times). Each frame entry:
      dict(at=audio_avail_s, kind='frame', int16=<array>, commit=<bool>)
    Plus a final dict(kind='commit', ...) for the sub-4000 remainder / finalize
    (always commit:true), exactly like Whispering.

    Gap test: a 250ms chunk covering [c0,c1] is a "gap chunk" iff it overlaps NO
    kept VAD segment (pure silence window). ARMED once (avail - last_commit) >=
    interval; commit at the first gap chunk while armed, or unconditionally once
    (avail - last_commit) >= interval + SAFETY_EXTRA_SECS (mid-speech valve).
    """
    n = len(int16)
    n_full = n // CHUNK_SAMPLES

    def in_gap(c0, c1):
        return not any(c0 < e and s < c1 for (s, e) in kept)

    sched = []
    commit_audio_times = []  # audio-availability time of every commit point
    last_commit_at = 0.0
    for j in range(n_full):
        chunk = int16[j * CHUNK_SAMPLES:(j + 1) * CHUNK_SAMPLES]
        c0 = j * CHUNK_SECS
        c1 = (j + 1) * CHUNK_SECS
        avail = c1
        elapsed = avail - last_commit_at
        do_commit = False
        if elapsed >= interval:
            if in_gap(c0, c1):
                do_commit = True
            elif elapsed >= interval + SAFETY_EXTRA_SECS:
                do_commit = True  # safety valve: commit mid-speech
        if do_commit:
            last_commit_at = avail
            commit_audio_times.append(avail)
        sched.append(dict(at=avail, kind="frame", int16=chunk, commit=do_commit))

    remainder = int16[n_full * CHUNK_SAMPLES:]
    total_dur = n / SAMPLE_RATE
    # finalize(): commit the remainder at clip end ONLY IF meaningful audio has been
    # fed since the last commit (FINALIZE_MIN_GAP_SECS guard). If a periodic/
    # safety-valve commit just fired on the final full chunk, committing again here
    # collides -> commit_throttled -> orphaned trailing window. In that case still
    # DELIVER the tiny remainder audio (commit:false) so the feed stays identical;
    # it is already covered by the just-fired commit's transcript.
    if total_dur - last_commit_at > FINALIZE_MIN_GAP_SECS:
        sched.append(dict(at=total_dur, kind="commit", int16=remainder, commit=True))
        commit_audio_times.append(total_dur)
    elif len(remainder):
        sched.append(dict(at=total_dur, kind="frame", int16=remainder, commit=False))
    return sched, n_full, len(remainder), commit_audio_times


# ───────────────────────── WS session ─────────────────────────

class HybridSession:
    def __init__(self, stem, pace, interval):
        self.stem = stem
        self.pace = pace
        self.interval = interval
        self.div = 1.0 if pace == "real" else 4.0
        self.t0 = None
        self.evlog = open(
            EVENTS_DIR / f"events_{stem}_hybrid{interval}_{pace}.jsonl", "w",
            encoding="utf-8")
        self.commits = []            # dict(text, recv_wall) — committed_transcript only
        self.n_partials = 0
        self.commit_sends = []       # (audio_at, send_wall) for each client commit:true
        self.server_errors = []      # (message_type, wall)
        self.unexpected_types = {}
        self.saw_with_timestamps = 0

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
                elif mt == "committed_transcript":
                    txt = obj.get("text", "") or ""
                    if txt:
                        self.commits.append(dict(text=txt, recv_wall=wall))
                elif mt == "committed_transcript_with_timestamps":
                    # We did NOT request include_timestamps; record + still capture.
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
            commit = bool(entry.get("commit"))
            await ws.send(encode_chunk(entry["int16"], commit))
            if commit:
                self.commit_sends.append((entry["at"], wall))
            self._log("send", {"kind": entry["kind"], "at": round(entry["at"], 3),
                               "commit": commit,
                               "n_samples": int(len(entry["int16"]))})

    async def run(self, int16, kept, hold_open=8.0):
        sched, n_full, n_rem, commit_ats = build_schedule(int16, kept, self.interval)
        url = build_url()
        self.t0 = time.monotonic()
        self._log("meta", {"stem": self.stem, "pace": self.pace,
                            "interval": self.interval,
                            "n_full_chunks": n_full, "n_remainder_samples": n_rem,
                            "n_client_commits_planned": len(commit_ats),
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
        return n_full, n_rem, commit_ats


# ───────────────────────── metrics ─────────────────────────

def score_clip(sess):
    ref = normalize((REF_DIR / f"{sess.stem}.txt").read_text(encoding="utf-8"))
    hyp = " ".join(c["text"] for c in sess.commits)
    hyp = " ".join(hyp.split())
    (OUT_DIR / f"{sess.stem}.hybrid{sess.interval}.committed.txt").write_text(
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

    # Audio-time commit cadence: gaps between successive client commit points.
    commit_ats = sorted(at for (at, _w) in sess.commit_sends)
    cadence = [b - a for a, b in zip(commit_ats, commit_ats[1:])]

    def med(x):
        return statistics.median(x) if x else None

    return dict(
        n_client_commits=len(sess.commit_sends),
        n_server_autocommits=n_server,
        n_committed_recv=len(sess.commits),
        turnaround_med=med(turnarounds),
        turnaround_max=max(turnarounds) if turnarounds else None,
        turnaround_min=min(turnarounds) if turnarounds else None,
        cadence_med=med(cadence),
        cadence_max=max(cadence) if cadence else None,
        commit_audio_times=[round(a, 2) for a in commit_ats],
    )


# ───────────────────────── per-clip run ─────────────────────────

async def run_clip_once(stem, pace, interval):
    samples = read_wav_16k_mono(CLIPS_DIR / f"{stem}.wav")
    int16 = float32_to_int16(samples)
    kept = kept_segments_secs(samples)
    sess = HybridSession(stem, pace, interval)
    n_full, n_rem, _ = await sess.run(int16, kept)
    wer = score_clip(sess)
    ca = commit_analysis(sess)
    return dict(stem=stem, pace=pace, interval=interval, wer=wer, commit=ca,
                n_partials=sess.n_partials,
                empty_hyp=(not wer["hyp"].strip()),
                server_errors=[e[0] for e in sess.server_errors],
                unexpected_types=sess.unexpected_types,
                saw_with_timestamps=sess.saw_with_timestamps,
                n_full_chunks=n_full, n_remainder=n_rem, n_kept_segs=len(kept),
                clip_dur=len(samples) / SAMPLE_RATE)


def run_clip(stem, pace, interval):
    """Run one clip; retry ONCE on a transient WS failure or empty hypothesis."""
    try:
        r = asyncio.run(run_clip_once(stem, pace, interval))
        if r["empty_hyp"]:
            print(f"    [warn] {stem}: empty committed hypothesis, retrying once")
            r2 = asyncio.run(run_clip_once(stem, pace, interval))
            r2["retried"] = True
            return r2
        return r
    except Exception as e:
        print(f"    [warn] {stem}: WS run failed ({type(e).__name__}), retrying once")
        r = asyncio.run(run_clip_once(stem, pace, interval))
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
                wer=r["wer"], commit=r["commit"], n_partials=r["n_partials"],
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
    return {
        "strategy": "hybrid",
        "interval": interval,
        "pace": pace,
        "pooled_wer": pm,
        "SDIN": [tS, tD, tI, tN],
        "mean_client_commits_per_clip": mean_client,
        "total_server_autocommits": sum(c["commit"]["n_server_autocommits"] for c in dump),
        "cadence_audio_median": statistics.median(all_cad) if all_cad else None,
        "cadence_audio_max": max(all_cad) if all_cad else None,
        "turnaround_median_of_clip_medians": statistics.median(all_turn) if all_turn else None,
        "clips": dump,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=float, required=True,
                    help="audio-seconds between periodic commits")
    ap.add_argument("--pace", choices=["real", "4x"], default="4x")
    ap.add_argument("--clips", nargs="+", help="explicit stems (default clip_11..16)")
    ap.add_argument("--merge", action="store_true",
                    help="merge rerun clips into the existing metrics JSON (replace "
                         "matching stems, keep the rest), then recompute aggregates")
    args = ap.parse_args()
    stems = args.clips or NEW_CLIPS
    interval = args.interval
    itag = int(interval) if float(interval).is_integer() else interval

    print(f"Hybrid-strategy realtime WER harness  interval={interval}s  "
          f"pace={args.pace}  clips={stems}")
    print(f"Events -> {EVENTS_DIR}")
    rows = []
    for stem in stems:
        r = run_clip(stem, args.pace, interval)
        rows.append(r)
        w, cm = r["wer"], r["commit"]
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
    if out["cadence_audio_median"] is not None:
        print(f"Audio-time commit cadence: median={out['cadence_audio_median']:.2f}s  "
              f"max={out['cadence_audio_max']:.2f}s")
    print(f"Metrics -> {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
