#!/usr/bin/env python
"""Build held-out benchmark clips + ElevenLabs ground truth for the WER harness.

Repeatable helper: given a source meeting recording (audio.mp4), it
  1. streams the audio through ffmpeg computing per-frame RMS energy,
  2. picks a speech-dense 60s window (high energy, few long silences,
     skipping the first 30s),
  3. extracts that window to a 16kHz mono PCM_s16le WAV (matching existing clips),
  4. POSTs the WAV to ElevenLabs speech-to-text (model scribe_v1) for ground truth,
  5. saves raw JSON to elevenlabs/clip_NN.json and plain text to clip_NN.txt.

Secrets: the ElevenLabs API key is read from the Tandem SQLite DB at runtime.
It is never written to disk or printed.

Usage:
  python make_ground_truth.py --clip 11 \
      --meeting "Meeting 2026-07-10_14-36-53_2026-07-10_13-36"

  # or supply an explicit source path / start second:
  python make_ground_truth.py --clip 11 --source "C:\\...\\audio.mp4" --start 120

Requires: ffmpeg + ffprobe on PATH, numpy, requests.
"""
import argparse
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import numpy as np
import requests

HERE = Path(__file__).resolve().parent
CLIPS_DIR = HERE / "clips"
EL_DIR = HERE / "elevenlabs"
RECORDINGS_ROOT = Path(os.path.expandvars(r"%USERPROFILE%")) / "Music" / "tandem-recordings"

SR = 16000
CLIP_SECONDS = 60.0
FRAME_SAMPLES = 1600          # 100ms frames at 16kHz
SKIP_START_SEC = 30.0         # never start a clip in the first 30s
WINDOW_STEP_SEC = 2.0         # granularity of the window search
SILENCE_RMS = 0.010          # normalized RMS below this = "silent" frame


def get_api_key() -> str:
    """Read the ElevenLabs API key from the Tandem frontend SQLite DB."""
    db = Path(os.path.expandvars(r"%APPDATA%")) / "com.tandem.ai" / "meeting_minutes.sqlite"
    con = sqlite3.connect(str(db))
    try:
        row = con.execute("SELECT elevenLabsApiKey FROM transcript_settings").fetchone()
    finally:
        con.close()
    if not row or not row[0]:
        raise RuntimeError("No ElevenLabs API key found in transcript_settings")
    return row[0]


def frame_rms(mp4: Path) -> np.ndarray:
    """Stream-decode audio via ffmpeg, return per-100ms-frame normalized RMS."""
    cmd = [
        "ffmpeg", "-v", "error", "-i", str(mp4),
        "-ac", "1", "-ar", str(SR), "-f", "s16le", "-",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    rms_vals = []
    leftover = b""
    bytes_per_frame = FRAME_SAMPLES * 2
    read_size = bytes_per_frame * 256
    while True:
        chunk = proc.stdout.read(read_size)
        if not chunk:
            break
        buf = leftover + chunk
        n_frames = len(buf) // bytes_per_frame
        usable = n_frames * bytes_per_frame
        if n_frames:
            arr = np.frombuffer(buf[:usable], dtype=np.int16).astype(np.float32) / 32768.0
            arr = arr.reshape(n_frames, FRAME_SAMPLES)
            rms = np.sqrt(np.mean(arr * arr, axis=1))
            rms_vals.append(rms)
        leftover = buf[usable:]
    proc.stdout.close()
    proc.wait()
    if not rms_vals:
        raise RuntimeError(f"ffmpeg produced no audio for {mp4}")
    return np.concatenate(rms_vals)


def pick_window(rms: np.ndarray) -> float:
    """Pick the best 60s window start (seconds) by energy minus silence penalty."""
    fps = SR / FRAME_SAMPLES                      # frames per second (10)
    win_frames = int(round(CLIP_SECONDS * fps))
    step_frames = max(1, int(round(WINDOW_STEP_SEC * fps)))
    skip_frames = int(round(SKIP_START_SEC * fps))

    best_start_frame, best_score = None, -1.0
    last_start = len(rms) - win_frames
    if last_start <= skip_frames:
        # Recording barely longer than a clip: take the densest legal start.
        skip_frames = min(skip_frames, max(0, last_start))
    for start in range(skip_frames, last_start + 1, step_frames):
        w = rms[start:start + win_frames]
        if len(w) < win_frames:
            break
        mean_rms = float(np.mean(w))
        silence_frac = float(np.mean(w < SILENCE_RMS))
        # Reward energy, penalize windows that are mostly silence.
        score = mean_rms * (1.0 - silence_frac)
        if score > best_score:
            best_score, best_start_frame = score, start
    if best_start_frame is None:
        best_start_frame = skip_frames
    return best_start_frame / fps


def extract_clip(mp4: Path, start_sec: float, out_wav: Path) -> None:
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-ss", f"{start_sec:.3f}", "-i", str(mp4),
        "-t", f"{CLIP_SECONDS:.3f}",
        "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le",
        str(out_wav),
    ]
    subprocess.run(cmd, check=True)


def transcribe(wav: Path, api_key: str) -> dict:
    """POST WAV to ElevenLabs speech-to-text; return parsed JSON response."""
    url = "https://api.elevenlabs.io/v1/speech-to-text"
    headers = {"xi-api-key": api_key}
    last_err = None
    for model_id in ("scribe_v1", "scribe_v2"):
        with open(wav, "rb") as fh:
            files = {"file": (wav.name, fh, "audio/wav")}
            data = {"model_id": model_id, "timestamps_granularity": "word"}
            resp = requests.post(url, headers=headers, files=files, data=data, timeout=300)
        if resp.status_code == 200:
            return resp.json()
        last_err = f"{model_id}: HTTP {resp.status_code} {resp.text[:300]}"
        # Only fall through to the next model on a model-related 4xx.
        if resp.status_code not in (400, 404, 422):
            break
    raise RuntimeError(f"ElevenLabs STT failed: {last_err}")


def resolve_source(args) -> Path:
    if args.source:
        return Path(args.source)
    if args.meeting:
        return RECORDINGS_ROOT / args.meeting / "audio.mp4"
    raise SystemExit("Provide --meeting or --source")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", type=int, required=True, help="clip number, e.g. 11")
    ap.add_argument("--meeting", help="meeting folder name under tandem-recordings")
    ap.add_argument("--source", help="explicit path to audio.mp4")
    ap.add_argument("--start", type=float, default=None,
                    help="explicit window start (sec); default = auto RMS pick")
    ap.add_argument("--no-transcribe", action="store_true",
                    help="only extract the WAV, skip the API call")
    args = ap.parse_args()

    CLIPS_DIR.mkdir(exist_ok=True)
    EL_DIR.mkdir(exist_ok=True)

    mp4 = resolve_source(args)
    if not mp4.is_file():
        raise SystemExit(f"Source not found: {mp4}")

    name = f"clip_{args.clip:02d}"
    out_wav = CLIPS_DIR / f"{name}.wav"

    if args.start is not None:
        start_sec = args.start
        print(f"[{name}] using explicit start {start_sec:.2f}s")
    else:
        print(f"[{name}] scanning RMS energy of {mp4.name} ...")
        rms = frame_rms(mp4)
        start_sec = pick_window(rms)
        print(f"[{name}] picked window start {start_sec:.2f}s "
              f"(total {len(rms) / (SR / FRAME_SAMPLES):.1f}s)")

    extract_clip(mp4, start_sec, out_wav)
    print(f"[{name}] wrote {out_wav}")

    result = {"clip": name, "start_sec": round(start_sec, 2)}
    if not args.no_transcribe:
        api_key = get_api_key()
        data = transcribe(out_wav, api_key)
        (EL_DIR / f"{name}.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        text = data.get("text", "")
        (EL_DIR / f"{name}.txt").write_text(text, encoding="utf-8")
        # ElevenLabs interleaves type=="spacing" tokens; count only real words.
        n_words = sum(1 for w in (data.get("words") or []) if w.get("type") == "word")
        wpm = n_words / (CLIP_SECONDS / 60.0)
        result.update({
            "language_code": data.get("language_code"),
            "language_probability": data.get("language_probability"),
            "n_words": n_words,
            "wpm": round(wpm, 1),
            "chars": len(text),
        })
        print(f"[{name}] transcript: {n_words} words, {wpm:.0f} wpm, "
              f"lang={data.get('language_code')} ({data.get('language_probability')})")
    print("RESULT " + json.dumps(result))


if __name__ == "__main__":
    main()
