#!/usr/bin/env python
"""Phase 0 spike: empirically pin the ElevenLabs Scribe v2 Realtime WS contract.

Streams 16kHz mono PCM clips as base64 input_audio_chunk frames and records EVERY
server event with a local monotonic timestamp to spike_out/events_<scenario>.jsonl.

Usage:
    python spike_scribe_realtime.py probe        # tiny connectivity check (~3s audio)
    python spike_scribe_realtime.py a            # real-time pace, manual commit at end
    python spike_scribe_realtime.py b            # server VAD commit strategy
    python spike_scribe_realtime.py c            # 4x faster than real-time
    python spike_scribe_realtime.py d            # gap/idle test (10s, 65s idle, 10s)
    python spike_scribe_realtime.py e            # two concurrent sessions on one key
    python spike_scribe_realtime.py f            # mid-stream explicit commit
    python spike_scribe_realtime.py usage        # snapshot /v1/user/subscription
    python spike_scribe_realtime.py all          # a,b,c,d,e,f in sequence

The API key is read from the app SQLite and NEVER printed/logged.
"""
import asyncio
import base64
import json
import os
import sqlite3
import sys
import time
import wave
from pathlib import Path

import requests
import websockets

HERE = Path(__file__).parent
OUT_DIR = HERE / "spike_out"
OUT_DIR.mkdir(exist_ok=True)
CLIPS = HERE / "clips"

BASE_WSS = "wss://api.elevenlabs.io/v1/speech-to-text/realtime"
SUB_URL = "https://api.elevenlabs.io/v1/user/subscription"
MODEL_ID = "scribe_v2_realtime"
SAMPLE_RATE = 16000
FRAME_MS = 250
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000   # 4000 samples
FRAME_BYTES = FRAME_SAMPLES * 2                   # PCM16 -> 8000 bytes

_API_KEY = None


def get_api_key():
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


def read_pcm16_bytes(path):
    """Return raw PCM16 mono 16kHz bytes for a wav clip."""
    w = wave.open(str(path), "rb")
    assert w.getnchannels() == 1 and w.getframerate() == 16000 and w.getsampwidth() == 2, \
        f"expect 16k mono pcm16, got {w.getnchannels()}ch {w.getframerate()}Hz {w.getsampwidth()*8}bit"
    data = w.readframes(w.getnframes())
    w.close()
    return data


def frames_of(pcm_bytes, frame_bytes=FRAME_BYTES):
    for i in range(0, len(pcm_bytes), frame_bytes):
        yield pcm_bytes[i:i + frame_bytes]


class EventLog:
    def __init__(self, scenario, tag=""):
        self.path = OUT_DIR / f"events_{scenario}{('_'+tag) if tag else ''}.jsonl"
        self.f = open(self.path, "w", encoding="utf-8")
        self.t0 = time.monotonic()
        self.audio_secs_sent = 0.0

    def log(self, direction, obj, note=None):
        rec = {"t": round(time.monotonic() - self.t0, 4), "dir": direction}
        if note:
            rec["note"] = note
        if isinstance(obj, dict):
            # redact anything id-ish
            red = {}
            for k, v in obj.items():
                if k in ("session_id", "request_id") and isinstance(v, str):
                    red[k] = "<redacted len=%d>" % len(v)
                elif k == "audio_base_64":
                    red[k] = "<b64 %d bytes>" % len(v)
                else:
                    red[k] = v
            rec["msg"] = red
        else:
            rec["raw"] = str(obj)[:400]
        self.f.write(json.dumps(rec) + "\n")
        self.f.flush()

    def close(self):
        self.f.close()


def build_url(commit_strategy="manual", extra=None):
    params = [
        f"model_id={MODEL_ID}",
        f"audio_format=pcm_{SAMPLE_RATE}",
        f"commit_strategy={commit_strategy}",
        "include_timestamps=true",
        "include_language_detection=true",
    ]
    if extra:
        params += extra
    return BASE_WSS + "?" + "&".join(params)


async def recv_loop(ws, log, stop_evt, collected):
    """Log every server event. collected accumulates committed text."""
    try:
        async for raw in ws:
            try:
                obj = json.loads(raw)
            except Exception:
                log.log("recv", None, note="non-json")
                log.log("recv", raw)
                continue
            log.log("recv", obj)
            mt = obj.get("message_type") or obj.get("type") or ""
            # Collect ONLY the timestamped commit (the event Phase 2 persists), so we
            # don't double-count committed_transcript + committed_transcript_with_timestamps.
            if mt in ("committed_transcript_with_timestamps", "final_transcript_with_timestamps"):
                txt = obj.get("text", "")
                if txt:
                    collected.setdefault("committed", []).append((mt, txt))
    except websockets.ConnectionClosed as e:
        log.log("recv", {"closed": True, "code": e.code, "reason": str(e.reason)})
    stop_evt.set()


async def send_frames(ws, log, pcm_bytes, pace, commit_at_end=True,
                      commit_every_n=None, gap_after=None, gap_secs=0):
    """pace: seconds to sleep per frame (0 = as fast as possible)."""
    n = 0
    for fr in frames_of(pcm_bytes):
        b64 = base64.b64encode(fr).decode()
        commit_flag = False
        if commit_every_n and (n + 1) % commit_every_n == 0:
            commit_flag = True
        msg = {"message_type": "input_audio_chunk", "audio_base_64": b64,
               "sample_rate": SAMPLE_RATE, "commit": commit_flag}
        await ws.send(json.dumps(msg))
        log.audio_secs_sent += len(fr) / 2 / SAMPLE_RATE
        log.log("send", {"message_type": "input_audio_chunk",
                          "audio_base_64": b64, "sample_rate": SAMPLE_RATE,
                          "commit": commit_flag}, note=f"frame#{n}")
        n += 1
        if gap_after and n == gap_after:
            log.log("send", None, note=f"IDLE START {gap_secs}s")
            await asyncio.sleep(gap_secs)
            log.log("send", None, note="IDLE END")
        if pace:
            await asyncio.sleep(pace)
    if commit_at_end:
        await ws.send(json.dumps({"message_type": "input_audio_chunk",
                                  "audio_base_64": "", "sample_rate": SAMPLE_RATE,
                                  "commit": True}))
        log.log("send", {"message_type": "input_audio_chunk", "commit": True,
                         "audio_base_64": ""}, note="FINAL COMMIT")


async def run_session(scenario, clip="clip_11.wav", commit_strategy="manual",
                      pace=FRAME_MS / 1000.0, commit_at_end=True, commit_every_n=None,
                      gap_after=None, gap_secs=0, tag="", hold_open_after=6.0):
    pcm = read_pcm16_bytes(CLIPS / clip)
    log = EventLog(scenario, tag=tag)
    url = build_url(commit_strategy)
    collected = {}
    headers = {"xi-api-key": get_api_key()}
    log.log("meta", {"scenario": scenario, "clip": clip, "url_no_key": url,
                     "commit_strategy": commit_strategy, "pace_s": pace,
                     "audio_len_s": round(len(pcm) / 2 / SAMPLE_RATE, 2)})
    try:
        async with websockets.connect(url, additional_headers=headers,
                                      max_size=None, ping_interval=None) as ws:
            stop_evt = asyncio.Event()
            recv_task = asyncio.create_task(recv_loop(ws, log, stop_evt, collected))
            await send_frames(ws, log, pcm, pace, commit_at_end=commit_at_end,
                              commit_every_n=commit_every_n, gap_after=gap_after,
                              gap_secs=gap_secs)
            audio_done = time.monotonic() - log.t0
            log.log("meta", {"audio_send_done_t": round(audio_done, 3)})
            # Wait for trailing committed/final events
            try:
                await asyncio.wait_for(stop_evt.wait(), timeout=hold_open_after)
            except asyncio.TimeoutError:
                pass
            recv_task.cancel()
    except Exception as e:
        log.log("error", {"exception": type(e).__name__, "msg": str(e)[:300]})
    log.log("meta", {"audio_secs_sent": round(log.audio_secs_sent, 2)})
    committed = " ".join(t for _, t in collected.get("committed", []))
    (OUT_DIR / f"committed_{scenario}{('_'+tag) if tag else ''}.txt").write_text(
        committed, encoding="utf-8")
    log.close()
    print(f"[{scenario}{('/'+tag) if tag else ''}] audio_sent={log.audio_secs_sent:.1f}s "
          f"committed_chars={len(committed)} -> {log.path.name}")
    return committed, log.audio_secs_sent


def snapshot_usage(label):
    try:
        r = requests.get(SUB_URL, headers={"xi-api-key": get_api_key()}, timeout=30)
        r.raise_for_status()
        d = r.json()
        keep = {k: d.get(k) for k in (
            "tier", "character_count", "character_limit",
            "convai_chars_per_minute", "next_character_count_reset_unix",
        )}
        # capture any stt/scribe usage fields verbatim
        for k, v in d.items():
            if "second" in k or "scribe" in k.lower() or "stt" in k.lower() \
               or "speech" in k.lower():
                keep[k] = v
        out = OUT_DIR / f"usage_{label}.json"
        out.write_text(json.dumps(d, indent=2), encoding="utf-8")
        print(f"[usage:{label}] tier={keep.get('tier')} chars={keep.get('character_count')}/"
              f"{keep.get('character_limit')} -> full dump {out.name}")
        print("  stt-ish fields:", {k: v for k, v in keep.items()
                                     if k not in ("tier", "character_count", "character_limit")})
        return d
    except Exception as e:
        print(f"[usage:{label}] ERROR {type(e).__name__}: {str(e)[:200]}")
        return None


async def scenario_e():
    """Two concurrent sessions on the same key."""
    t1 = run_session("e", clip="clip_11.wav", tag="s1")
    t2 = run_session("e", clip="clip_12.wav", tag="s2")
    await asyncio.gather(t1, t2)


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "probe"
    if which == "usage":
        snapshot_usage(sys.argv[2] if len(sys.argv) > 2 else "manual")
        return
    if which == "probe":
        # ~4s of audio, manual commit -> confirm URL/model/handshake
        pcm = read_pcm16_bytes(CLIPS / "clip_11.wav")[: FRAME_BYTES * 16]
        async def _probe():
            log = EventLog("probe")
            url = build_url("manual")
            collected = {}
            log.log("meta", {"url_no_key": url})
            try:
                async with websockets.connect(url, additional_headers={"xi-api-key": get_api_key()},
                                              max_size=None, ping_interval=None) as ws:
                    stop = asyncio.Event()
                    rt = asyncio.create_task(recv_loop(ws, log, stop, collected))
                    await send_frames(ws, log, pcm, 0.25, commit_at_end=True)
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=8)
                    except asyncio.TimeoutError:
                        pass
                    rt.cancel()
            except Exception as e:
                log.log("error", {"exception": type(e).__name__, "msg": str(e)[:300]})
            log.close()
            print("probe committed:", " ".join(t for _, t in collected.get("committed", [])))
            print("log ->", log.path)
        asyncio.run(_probe())
        return

    runners = {
        "a": lambda: run_session("a", commit_strategy="manual", pace=FRAME_MS/1000.0),
        "b": lambda: run_session("b", commit_strategy="vad", pace=FRAME_MS/1000.0,
                                 commit_at_end=False),
        "c": lambda: run_session("c", commit_strategy="manual", pace=0.0),
        "d": lambda: run_session("d", commit_strategy="manual", pace=FRAME_MS/1000.0,
                                 gap_after=40, gap_secs=65),  # 40 frames = 10s, then idle 65s
        "f": lambda: run_session("f", commit_strategy="manual", pace=FRAME_MS/1000.0,
                                 commit_every_n=80, commit_at_end=True),  # commit ~every 20s
    }
    if which == "e":
        asyncio.run(scenario_e())
    elif which == "all":
        for s in ["a", "b", "c", "d", "f"]:
            asyncio.run(runners[s]())
        asyncio.run(scenario_e())
    elif which in runners:
        asyncio.run(runners[which]())
    else:
        print("unknown scenario", which)


if __name__ == "__main__":
    main()
