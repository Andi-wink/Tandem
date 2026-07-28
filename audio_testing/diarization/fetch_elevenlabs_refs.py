"""
Bootstrap diarization ground truth from ElevenLabs Scribe.

ElevenLabs Scribe returns per-word `speaker_id` when diarize=true. We use that
as a FIRST DRAFT of ground truth, then you hand-correct it into the "perfect
examples" the harness scores against.

Usage:
    set ELEVENLABS_API_KEY=...            # PowerShell: $env:ELEVENLABS_API_KEY="..."
    python fetch_elevenlabs_refs.py                 # all clips
    python fetch_elevenlabs_refs.py clip_02 clip_07 # specific clips
    python fetch_elevenlabs_refs.py --num-speakers 2

For each clip it writes (into ./refs/, gitignored):
    <clip>.diar.json   machine-readable ground truth (words w/ speaker) -> EDIT THIS
    <clip>.turns.txt   human-readable turns for eyeballing / correcting

Correcting workflow:
    1. Read <clip>.turns.txt, listen to clips/<clip>.wav, fix any wrong speaker
       tags and turn boundaries.
    2. Apply the same corrections to <clip>.diar.json (or re-derive it; the
       harness scores the .json). Keep speaker labels consistent per clip
       (e.g. always "SPEAKER_0" = the consultant).
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from diar_common import CLIPS, clip_wav, REFS_DIR, save_reference, words_to_turns  # noqa: E402
from diar_metrics import Word  # noqa: E402

API_URL = "https://api.elevenlabs.io/v1/speech-to-text"
MODEL_ID = "scribe_v1"


def fetch_clip(clip: str, api_key: str, num_speakers: int | None) -> list[Word]:
    try:
        import requests
    except ImportError:
        sys.exit("The `requests` package is required: pip install requests")

    wav = clip_wav(clip)
    if not wav.exists():
        raise FileNotFoundError(f"Clip audio not found: {wav}")

    data = {
        "model_id": MODEL_ID,
        "diarize": "true",
        "timestamps_granularity": "word",
    }
    if num_speakers:
        data["num_speakers"] = str(num_speakers)

    with open(wav, "rb") as fh:
        resp = requests.post(
            API_URL,
            headers={"xi-api-key": api_key},
            data=data,
            files={"file": (wav.name, fh, "audio/wav")},
            timeout=300,
        )
    if resp.status_code != 200:
        raise RuntimeError(f"ElevenLabs {resp.status_code}: {resp.text[:400]}")

    doc = resp.json()
    words: list[Word] = []
    for w in doc.get("words", []):
        if w.get("type") != "word":
            continue
        words.append(Word(
            text=w["text"],
            start=float(w["start"]),
            end=float(w["end"]),
            speaker=w.get("speaker_id", "speaker_0"),
        ))
    return words


def write_turns_txt(clip: str, words: list[Word]) -> Path:
    lines = [
        f"# Ground-truth turns for {clip} (ElevenLabs diarize draft — CORRECT ME).",
        "# Format: SPEAKER\\tstart-end\\ttext.  Fix speaker tags/boundaries by ear.",
        "",
    ]
    turns = words_to_turns(words)
    # attach rough time spans by walking words in parallel
    idx = 0
    for spk, text in turns:
        n = len(text.split())
        span_words = words[idx: idx + n]
        idx += n
        if span_words:
            t0, t1 = span_words[0].start, span_words[-1].end
            lines.append(f"{spk}\t{t0:7.2f}-{t1:7.2f}\t{text}")
        else:
            lines.append(f"{spk}\t\t{text}")
    path = REFS_DIR / f"{clip}.turns.txt"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def main() -> None:
    ap = argparse.ArgumentParser(description="Bootstrap diarization ground truth from ElevenLabs.")
    ap.add_argument("clips", nargs="*", default=None, help="clip ids (default: all)")
    ap.add_argument("--num-speakers", type=int, default=None,
                    help="hint ElevenLabs with a fixed speaker count")
    args = ap.parse_args()

    api_key = os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        sys.exit("Set ELEVENLABS_API_KEY in the environment first.")

    clips = args.clips or CLIPS
    REFS_DIR.mkdir(parents=True, exist_ok=True)
    for clip in clips:
        print(f"[{clip}] requesting ElevenLabs diarization ...", flush=True)
        try:
            words = fetch_clip(clip, api_key, args.num_speakers)
        except Exception as e:
            print(f"[{clip}] FAILED: {e}")
            continue
        n_spk = len({w.speaker for w in words})
        jpath = save_reference(clip, words, meta={
            "source": "elevenlabs_scribe_v1",
            "diarize": True,
            "num_speakers_hint": args.num_speakers,
            "status": "DRAFT — needs human correction",
        })
        tpath = write_turns_txt(clip, words)
        print(f"[{clip}] {len(words)} words, {n_spk} speakers -> {jpath.name}, {tpath.name}")

    print("\nNext: correct the .turns.txt / .diar.json files, then run run_diarization.py")


if __name__ == "__main__":
    main()
