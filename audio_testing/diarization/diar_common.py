"""
Shared data layer for the diarization harness.

Confidential client audio (clips, ElevenLabs transcripts) is gitignored and
lives only in a local `audio_testing/` checkout, so this module RESOLVES the
data directory rather than assuming it sits next to the code (the harness code
lives in the feature/speaker-diarization worktree, the data in the main
checkout).

Resolution order for the data dir:
    1. $TANDEM_AUDIO_TESTING
    2. <this-file>/..                      (worktree-local, if you copy data in)
    3. D:/Dev-projects/Tandem/audio_testing (main checkout on this machine)

Layout under the data dir:
    clips/clip_XX.wav              mixed mic+system 60s clips
    elevenlabs/clip_XX.json        raw ElevenLabs transcript (no speakers)
    diarization/refs/clip_XX.diar.json   GROUND TRUTH: words w/ speaker labels
"""
from __future__ import annotations

import json
import os
import wave
from pathlib import Path

import numpy as np

from diar_metrics import Word

# The five clips that have ElevenLabs reference transcripts (see clips_index.json).
CLIPS = ["clip_02", "clip_04", "clip_06", "clip_07", "clip_10"]


def data_dir() -> Path:
    env = os.environ.get("TANDEM_AUDIO_TESTING")
    candidates = [
        Path(env) if env else None,
        Path(__file__).resolve().parent.parent,          # worktree audio_testing/
        Path("D:/Dev-projects/Tandem/audio_testing"),    # main checkout
    ]
    for c in candidates:
        if c and (c / "clips").is_dir():
            return c
    # Fall back to worktree parent even if empty, so error messages are useful.
    return Path(__file__).resolve().parent.parent


DATA = data_dir()
CLIPS_DIR = DATA / "clips"
ELEVENLABS_DIR = DATA / "elevenlabs"
REFS_DIR = Path(__file__).resolve().parent / "refs"   # ground truth (gitignored)


def clip_wav(clip: str) -> Path:
    return CLIPS_DIR / f"{clip}.wav"


def read_wav_16k_mono(path: Path) -> np.ndarray:
    """Load a wav as mono float32 in [-1,1] (no resample; clips are already 16k)."""
    with wave.open(str(path), "rb") as w:
        n = w.getnframes()
        ch = w.getnchannels()
        raw = w.readframes(n)
    data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1)
    return data


# ---------------------------------------------------------------------------
# ElevenLabs transcripts
# ---------------------------------------------------------------------------

def load_elevenlabs_words(clip: str, with_speakers: bool = False) -> list[Word]:
    """Parse the raw ElevenLabs JSON into Word objects.

    with_speakers=True reads the `speaker_id` ElevenLabs adds when diarize=true.
    with_speakers=False leaves speaker=None (plain transcript timing only).
    """
    path = ELEVENLABS_DIR / f"{clip}.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    words: list[Word] = []
    for w in doc.get("words", []):
        if w.get("type") != "word":
            continue
        words.append(Word(
            text=w["text"],
            start=float(w["start"]),
            end=float(w["end"]),
            speaker=(w.get("speaker_id") if with_speakers else None),
        ))
    return words


# ---------------------------------------------------------------------------
# Ground-truth reference words (the "perfect examples")
# ---------------------------------------------------------------------------

def ref_path(clip: str) -> Path:
    return REFS_DIR / f"{clip}.diar.json"


def load_reference_words(clip: str) -> list[Word]:
    """Load the corrected ground-truth words with speaker labels.

    Format (list of objects): [{"text","start","end","speaker"}, ...]
    Produced by fetch_elevenlabs_refs.py then hand-corrected by the user.
    """
    path = ref_path(clip)
    if not path.exists():
        raise FileNotFoundError(
            f"No ground truth for {clip} at {path}.\n"
            f"Run fetch_elevenlabs_refs.py to bootstrap it, then correct it."
        )
    doc = json.loads(path.read_text(encoding="utf-8"))
    words = doc["words"] if isinstance(doc, dict) else doc
    return [
        Word(text=w["text"], start=float(w["start"]), end=float(w["end"]),
             speaker=w.get("speaker"))
        for w in words
    ]


def save_reference(clip: str, words: list[Word], meta: dict | None = None) -> Path:
    REFS_DIR.mkdir(parents=True, exist_ok=True)
    doc = {
        "clip": clip,
        "meta": meta or {},
        "words": [
            {"text": w.text, "start": w.start, "end": w.end, "speaker": w.speaker}
            for w in words
        ],
    }
    path = ref_path(clip)
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def words_to_turns(words: list[Word]) -> list[tuple[str, str]]:
    """Collapse consecutive same-speaker words into (speaker, text) turns
    for a human-readable, correctable transcript."""
    turns: list[tuple[str, str]] = []
    cur_spk = None
    cur: list[str] = []
    for w in words:
        spk = w.speaker or "UNKNOWN"
        if spk != cur_spk and cur:
            turns.append((cur_spk, " ".join(cur)))
            cur = []
        cur_spk = spk
        cur.append(w.text)
    if cur:
        turns.append((cur_spk, " ".join(cur)))
    return turns
