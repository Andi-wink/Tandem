"""
F022: Speaker Diarization Service

On-device speaker identification using pyannote.audio.
Post-processing: runs after recording stops on the saved audio file.
Uses speaker-diarization-community-1 (CC-BY-4.0, free, no gating).
"""

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module-level initialization (loaded ONCE at import time)
# ---------------------------------------------------------------------------

_pipeline = None
_diarization_available = False
_device_name = "cpu"

try:
    from pyannote.audio import Pipeline  # noqa: F401
    import torch  # noqa: F401
    _pyannote_installed = True
    logger.info("pyannote.audio package available")
except ImportError as e:
    _pyannote_installed = False
    logger.warning("pyannote.audio not installed: %s. Diarization disabled.", e)


def is_available() -> bool:
    """Check if the diarization model is loaded and ready."""
    return _diarization_available


def is_installed() -> bool:
    """Check if pyannote.audio package is installed (model may not be loaded yet)."""
    return _pyannote_installed


def get_device() -> str:
    """Return the device the model is running on ('cuda' or 'cpu')."""
    return _device_name


def load_model(hf_token: str, use_gpu: bool = True) -> bool:
    """Load the diarization model from HuggingFace (one-time download, ~1GB).

    After the first download the model is cached locally and works offline.
    """
    global _pipeline, _diarization_available, _device_name

    if not _pyannote_installed:
        logger.error("Cannot load model: pyannote.audio is not installed")
        return False

    try:
        import torch
        from pyannote.audio import Pipeline

        logger.info("Downloading / loading speaker-diarization-community-1 ...")
        _pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-community-1",
            use_auth_token=hf_token,
        )

        if use_gpu and torch.cuda.is_available():
            _pipeline.to(torch.device("cuda"))
            _device_name = "cuda"
            logger.info("Diarization pipeline loaded on GPU (CUDA)")
        else:
            _device_name = "cpu"
            logger.info("Diarization pipeline loaded on CPU")

        _diarization_available = True
        return True

    except Exception as e:
        logger.error("Failed to load diarization model: %s", e, exc_info=True)
        _diarization_available = False
        return False


# ---------------------------------------------------------------------------
# Core diarization
# ---------------------------------------------------------------------------

async def diarize_audio(
    audio_path: str,
    num_speakers: Optional[int] = None,
    min_speakers: Optional[int] = None,
    max_speakers: Optional[int] = None,
) -> dict:
    """Run speaker diarization on an audio file.

    Returns dict with:
        segments: list[{speaker, start, end}]
        num_speakers: int
        duration: float (seconds)
    """
    if not _diarization_available or _pipeline is None:
        raise RuntimeError("Diarization model not loaded. Call /api/diarize/setup first.")

    path = Path(audio_path)
    if not path.exists():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    def _run():
        kwargs = {}
        if num_speakers is not None:
            kwargs["num_speakers"] = num_speakers
        if min_speakers is not None:
            kwargs["min_speakers"] = min_speakers
        if max_speakers is not None:
            kwargs["max_speakers"] = max_speakers

        t0 = time.time()
        diarization = _pipeline(str(path), **kwargs)
        elapsed = time.time() - t0
        logger.info("Pyannote inference completed in %.1fs for %s", elapsed, path.name)

        segments = []
        speakers = set()
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            segments.append({
                "speaker": speaker,
                "start": round(turn.start, 3),
                "end": round(turn.end, 3),
            })
            speakers.add(speaker)

        total_duration = max((s["end"] for s in segments), default=0.0)
        return {
            "segments": segments,
            "num_speakers": len(speakers),
            "duration": total_duration,
        }

    # Run synchronous GPU work in a thread so we don't block the event loop
    return await asyncio.to_thread(_run)


# ---------------------------------------------------------------------------
# Alignment: match pyannote speakers to Whisper transcript segments
# ---------------------------------------------------------------------------

def align_with_transcripts(
    diarization_segments: list[dict],
    transcript_segments: list[dict],
) -> list[dict]:
    """Align pyannote speaker segments with Whisper transcript segments.

    For each transcript segment, find the pyannote speaker with greatest
    overlap at the segment's midpoint. Falls back to greatest temporal overlap.

    Args:
        diarization_segments: [{speaker, start, end}, ...]
        transcript_segments:  [{text, audio_start_time, audio_end_time, ...}, ...]

    Returns:
        transcript_segments with added 'speaker_label' field.
    """
    # Pre-sort diarization segments by start time for faster lookup
    sorted_diar = sorted(diarization_segments, key=lambda s: s["start"])

    aligned = []
    for ts in transcript_segments:
        start = ts.get("audio_start_time", 0) or 0
        end = ts.get("audio_end_time", start) or start
        midpoint = (start + end) / 2

        # Strategy 1: find speaker whose segment contains the midpoint
        best_speaker = None
        for ds in sorted_diar:
            if ds["end"] < midpoint - 1:
                continue  # skip segments that ended well before midpoint
            if ds["start"] > midpoint + 1:
                break  # past midpoint, no more candidates
            if ds["start"] <= midpoint <= ds["end"]:
                best_speaker = ds["speaker"]
                break

        # Strategy 2: fallback to greatest temporal overlap
        if best_speaker is None:
            max_overlap = 0.0
            for ds in sorted_diar:
                if ds["end"] < start:
                    continue
                if ds["start"] > end:
                    break
                overlap_start = max(start, ds["start"])
                overlap_end = min(end, ds["end"])
                overlap = max(0.0, overlap_end - overlap_start)
                if overlap > max_overlap:
                    max_overlap = overlap
                    best_speaker = ds["speaker"]

        aligned.append({
            **ts,
            "speaker_label": best_speaker or "UNKNOWN",
        })

    return aligned
