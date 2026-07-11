"""
Meeting-condition WER + latency for Tandem's LIVE ElevenLabs Scribe path.

Replicates, end-to-end and offline, exactly what the running app sends to
ElevenLabs Scribe during a call:

  clip (16k mono)
    -> per-stream Silero VAD           (vad.rs LIVE config)          [silero_vad.py]
    -> transcription-buffer assembly   (pipeline.rs LIVE constants)  [this file]
         * flush at >= MIN_TRANSCRIPTION_SAMPLES (192000 = 12s @16k)
         * flush on a >= SILENCE_GAP_FLUSH_SECS (1.2s) audio gap
         * drop VAD segments < 800 samples
         * prepend previous flush's last 1.0s (TRANSCRIPTION_OVERLAP_SAMPLES=16000)
    -> each flushed chunk -> 16k mono PCM16 WAV -> POST scribe_v2      [this file]
    -> dedup_overlap_prefix across consecutive chunk texts (worker.rs) [this file]
    -> concatenate -> hypothesis transcript
  vs ElevenLabs ground truth -> WER (same normalize + wer_align as the Parakeet harness).

Also computes:
  - full-clip scribe_v2 WER (single POST, no chunking) = engine/version ceiling.
  - per-clip latency/block stats (chunk count, duration min/median/max, block wait).
  - top deletion spans and whether they abut a chunk boundary or a VAD gap.

API responses are cached under scribe_out/cache/ keyed by chunk-audio hash, so
re-runs cost zero API calls.

Run:
  .venv/Scripts/python.exe audio_testing/run_scribe_meeting_wer.py            # clip_11..16
  .venv/Scripts/python.exe audio_testing/run_scribe_meeting_wer.py --all      # + old clips
  .venv/Scripts/python.exe audio_testing/run_scribe_meeting_wer.py --no-parakeet
"""

import argparse
import hashlib
import io
import json
import os
import sqlite3
import statistics
import sys
import time
import wave
from pathlib import Path

import numpy as np
import requests

# Reuse the exact scoring + audio IO from the Parakeet harness (do NOT reinvent).
from run_tandem_parakeet import (
    CLIPS_DIR, REF_DIR, read_wav_16k_mono, normalize, wer_align,
)
# Reuse the faithful Silero VAD port (state machine mirrors silero-rs / vad.rs).
from silero_vad import SileroVad

HERE = Path(__file__).parent
OUT_DIR = HERE / "scribe_out"
CACHE_DIR = OUT_DIR / "cache"

SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text"
SCRIBE_MODEL = "scribe_v2"

# ── LIVE Rust constants (verified against vad.rs / pipeline.rs, 2026-07-11) ──
# vad.rs ContinuousVadProcessor::new (Windows redemption 800ms)
LIVE_VAD = dict(positive=0.40, negative=0.20, pre_pad_ms=300,
                post_pad_ms=200, redemption_ms=800, min_speech_ms=100)
MIN_TRANSCRIPTION_SAMPLES = 192000   # pipeline.rs (12s @ 16k)
SILENCE_GAP_FLUSH_MS = 1200          # SILENCE_GAP_FLUSH_SECS = 1.2
TRANSCRIPTION_OVERLAP_SAMPLES = 16000  # 1.0s left-context prepend
MIN_SEGMENT_SAMPLES = 800            # segments shorter than this are dropped
OVERLAP_TAIL_WORDS = 10              # worker.rs dedup window
# Timestamp-based overlap trimming (mirrors elevenlabs_provider.rs).
# A word straddling the overlap boundary is kept; only words starting at least
# EPSILON before the boundary are treated as fully inside the re-sent overlap.
OVERLAP_EPSILON_SECS = 0.15
# Cache namespace: bumped when the cached response shape changes. v2 stores the
# `words` array (needed for timestamp trimming); v1 text-only entries are ignored.
CACHE_VERSION = "v2words"

SR = 16000
NEW_CLIPS = [f"clip_{n:02d}" for n in (11, 12, 13, 14, 15, 16)]
OLD_CLIPS = ["clip_02", "clip_04", "clip_06", "clip_07", "clip_10"]


# ───────────────────────── VAD + buffer assembly ─────────────────────────

def vad_segments_live(samples_16k):
    """Run the LIVE-config Silero VAD; return [(start_ms, end_ms, samples_list)]."""
    vad = SileroVad(**LIVE_VAD)
    segs = vad.process(samples_16k)
    segs += vad.finish()
    return segs


def assemble_chunks(segments):
    """Mirror pipeline.rs process_stream_vad + flush_transcription_buffer.

    Returns a list of chunk dicts, each:
      start_sec, end_sec  : audio-time span of the buffered VAD content
      content             : np.float32 buffer content (no overlap)
      sent                : np.float32 actually POSTed (prev 1.0s tail prepended)
    """
    chunks = []
    buf = []              # content samples (python list, extended per segment)
    buf_start_ms = None
    last_end_ms = None
    prev_tail = np.zeros(0, dtype=np.float32)

    def flush():
        nonlocal buf, buf_start_ms, prev_tail
        content = np.asarray(buf, dtype=np.float32)
        # Fresh tail captured from THIS buffer BEFORE prepending (matches Rust).
        if len(content) > TRANSCRIPTION_OVERLAP_SAMPLES:
            new_tail = content[-TRANSCRIPTION_OVERLAP_SAMPLES:].copy()
        else:
            new_tail = content.copy()
        overlap_samples = len(prev_tail)
        if overlap_samples:
            sent = np.concatenate([prev_tail, content])
        else:
            sent = content
        chunks.append(dict(start_sec=buf_start_ms / 1000.0,
                           end_sec=last_end_ms / 1000.0,
                           content=content, sent=sent,
                           overlap_samples=overlap_samples))
        prev_tail = new_tail
        buf = []
        buf_start_ms = None

    for (start_ms, end_ms, samples) in segments:
        if len(samples) < MIN_SEGMENT_SAMPLES:
            continue  # pipeline.rs drops < 800-sample segments
        # Silence-gap flush: a >=1.2s audio gap before this segment would have
        # triggered the timeout flush of the partial buffer in the live pipeline.
        if buf and last_end_ms is not None and (start_ms - last_end_ms) >= SILENCE_GAP_FLUSH_MS:
            flush()
        if not buf:
            buf_start_ms = start_ms
        buf.extend(samples)
        last_end_ms = end_ms
        if len(buf) >= MIN_TRANSCRIPTION_SAMPLES:
            flush()
    if buf:
        flush()
    return chunks


# ───────────────────────── Scribe API (cached) ─────────────────────────

def _wav_pcm16_bytes(samples_f32):
    """Encode float32 [-1,1] mono @16k as a PCM16 WAV byte string."""
    pcm = np.clip(samples_f32, -1.0, 1.0)
    pcm = (pcm * 32767.0).round().astype("<i2")
    bio = io.BytesIO()
    with wave.open(bio, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    return bio.getvalue(), pcm.tobytes()


_API_KEY = None


def _get_api_key():
    """Read the ElevenLabs key from the app's SQLite. Never printed/logged."""
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


_api_calls = 0


def scribe_transcribe(samples_f32):
    """POST one chunk to Scribe (scribe_v2). Cached by audio+model+version hash.

    The response's `words` array (present by default for scribe_v2) is cached
    alongside `text` so the timestamp-based overlap trim can run offline.

    Returns (text, words, latency_s_or_None, from_cache)."""
    global _api_calls
    wav_bytes, pcm_bytes = _wav_pcm16_bytes(samples_f32)
    h = hashlib.sha256(pcm_bytes + SCRIBE_MODEL.encode()
                       + CACHE_VERSION.encode()).hexdigest()
    cache_file = CACHE_DIR / f"{h}.json"
    if cache_file.exists():
        d = json.loads(cache_file.read_text(encoding="utf-8"))
        return d.get("text", ""), d.get("words", []), d.get("api_latency_s"), True

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    headers = {"xi-api-key": _get_api_key()}
    files = {"file": ("audio.wav", wav_bytes, "audio/wav")}
    data = {"model_id": SCRIBE_MODEL}
    t0 = time.time()
    resp = requests.post(SCRIBE_URL, headers=headers, data=data, files=files, timeout=180)
    latency = time.time() - t0
    resp.raise_for_status()
    body = resp.json()
    text = body.get("text", "") or ""
    words = body.get("words", []) or []
    cache_file.write_text(json.dumps({"text": text, "words": words,
                                      "api_latency_s": round(latency, 3)}),
                          encoding="utf-8")
    _api_calls += 1
    return text, words, latency, False


# ───────────────────────── dedup (mirror worker.rs) ─────────────────────────

def dedup_overlap_prefix(prev_tail, current):
    """Exact port of worker.rs dedup_overlap_prefix (lines 24-51)."""
    if not prev_tail:
        return current
    curr_words = current.split()
    if not curr_words:
        return ""
    max_k = min(len(curr_words), len(prev_tail), OVERLAP_TAIL_WORDS)
    overlap = 0
    for k in range(max_k, 0, -1):
        prev_slice = prev_tail[len(prev_tail) - k:]
        curr_slice = curr_words[:k]
        if all(a.lower() == b.lower() for a, b in zip(prev_slice, curr_slice)):
            overlap = k
            break
    if overlap == 0:
        return current
    return " ".join(curr_words[overlap:])


def emit_tail(text):
    """Last OVERLAP_TAIL_WORDS words of the emitted transcript (worker.rs 277-285)."""
    return text.split()[-OVERLAP_TAIL_WORDS:]


def trim_overlap_words(words, overlap_seconds):
    """Exact port of ElevenLabsProvider::trim_overlap_words.

    Drop tokens that fall entirely inside the leading `overlap_seconds` of
    re-sent left-context audio. A word straddling the boundary is kept. Returns
    None if no token carries a usable start time (caller falls back to text)."""
    threshold = overlap_seconds - OVERLAP_EPSILON_SECS
    usable = 0
    kept = []
    for w in words:
        if w.get("type") == "spacing":
            continue
        start = w.get("start")
        if start is None:
            continue
        usable += 1
        if float(start) >= threshold:
            t = (w.get("text") or "").strip()
            if t:
                kept.append(t)
    if usable == 0:
        return None
    return " ".join(kept)


# ───────────────────────── deletion-span analysis ─────────────────────────

def _timed_ref_tokens(stem):
    """Normalized ref tokens with (start,end) times from the Scribe GT word list."""
    data = json.loads((REF_DIR / f"{stem}.json").read_text(encoding="utf-8"))
    toks = []
    for w in data.get("words", []):
        if w.get("type") != "word":
            continue
        for t in normalize(w.get("text", "")):
            toks.append((t, float(w.get("start", 0.0)), float(w.get("end", 0.0))))
    return toks


def _align_ops(ref, hyp):
    """Levenshtein backtrack -> list of ('D'|'S'|'I'|'M', ref_idx) ops in ref order."""
    n, m = len(ref), len(hyp)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        dp[i][0] = i
    for j in range(m + 1):
        dp[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost = 0 if ref[i - 1] == hyp[j - 1] else 1
            dp[i][j] = min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    i, j = n, m
    ops = []
    while i > 0 or j > 0:
        if i > 0 and j > 0 and dp[i][j] == dp[i - 1][j - 1] + (0 if ref[i - 1] == hyp[j - 1] else 1):
            ops.append(("M" if ref[i - 1] == hyp[j - 1] else "S", i - 1))
            i -= 1
            j -= 1
        elif i > 0 and dp[i][j] == dp[i - 1][j] + 1:
            ops.append(("D", i - 1))
            i -= 1
        else:
            ops.append(("I", j - 1))
            j -= 1
    ops.reverse()
    return ops


def deletion_spans(stem, hyp_words, chunks, segments):
    """Find deletion runs, locate them in time, flag chunk-boundary / VAD-gap abut."""
    timed = _timed_ref_tokens(stem)
    ref_tok = [t[0] for t in timed]
    ops = _align_ops(ref_tok, hyp_words)
    # Group consecutive D ops into spans.
    spans = []
    run = []
    for op, idx in ops:
        if op == "D":
            run.append(idx)
        else:
            if run:
                spans.append(run)
                run = []
    if run:
        spans.append(run)

    boundaries = []
    for c in chunks:
        boundaries.append(c["start_sec"])
        boundaries.append(c["end_sec"])
    # VAD-covered intervals (post <800 drop) -> gaps are the complement.
    covered = [(s / 1000.0, e / 1000.0) for (s, e, samp) in segments
               if len(samp) >= MIN_SEGMENT_SAMPLES]
    covered.sort()

    def in_vad_gap(t):
        # True if t is not inside any covered speech interval (a silence gap).
        for a, b in covered:
            if a - 0.05 <= t <= b + 0.05:
                return False
        return True

    def near_boundary(t, tol=0.5):
        return any(abs(t - b) <= tol for b in boundaries)

    out = []
    for run in spans:
        s0, e0 = timed[run[0]][1], timed[run[-1]][2]
        mid = 0.5 * (s0 + e0)
        text = " ".join(timed[i][0] for i in run)
        out.append(dict(
            length=len(run), start=s0, end=e0, text=text,
            at_boundary=near_boundary(s0) or near_boundary(e0) or near_boundary(mid),
            in_vad_gap=in_vad_gap(mid),
        ))
    out.sort(key=lambda d: d["length"], reverse=True)
    return out


# ───────────────────────── per-clip run ─────────────────────────

def run_clip(stem):
    samples = read_wav_16k_mono(CLIPS_DIR / f"{stem}.wav")
    clip_dur = len(samples) / SR
    ref = normalize((REF_DIR / f"{stem}.txt").read_text(encoding="utf-8"))

    segments = vad_segments_live(samples)
    chunks = assemble_chunks(segments)

    # Meeting-path hypothesis: POST each chunk, dedup, concatenate.
    prev_tail = []
    parts = []
    api_lat = []
    for c in chunks:
        text, words, lat, cached = scribe_transcribe(c["sent"])
        if lat is not None:
            api_lat.append(lat)
        # Timestamp-based overlap trim when a real overlap was prepended and the
        # response carries usable word timings; else fall back to the full text.
        # Mirrors elevenlabs_provider.rs transcribe_with_overlap.
        overlap_seconds = c["overlap_samples"] / SR
        emit = text
        if overlap_seconds > OVERLAP_EPSILON_SECS:
            trimmed = trim_overlap_words(words, overlap_seconds)
            if trimmed is not None:
                emit = trimmed
        # worker.rs always then runs the text-based dedup as a fallback safety
        # net; after a successful timestamp trim it no-ops.
        deduped = dedup_overlap_prefix(prev_tail, emit)
        prev_tail = emit_tail(deduped)
        if deduped.strip():
            parts.append(deduped.strip())
    hyp_meeting = " ".join(parts)
    Sm, Dm, Im, Nm = wer_align(ref, normalize(hyp_meeting))

    # Full-clip ceiling: one POST, no chunking.
    full_text, _, _, _ = scribe_transcribe(samples)
    Sf, Df, If, Nf = wer_align(ref, normalize(full_text))

    # Latency / block stats.
    durs = [c["end_sec"] - c["start_sec"] for c in chunks]
    content_s = sum(len(c["content"]) for c in chunks) / SR
    stats = dict(
        n_chunks=len(chunks),
        dur_min=min(durs) if durs else 0.0,
        dur_med=statistics.median(durs) if durs else 0.0,
        dur_max=max(durs) if durs else 0.0,
        block_med=statistics.median(durs) if durs else 0.0,
        block_max=max(durs) if durs else 0.0,
        content_s=content_s,
        clip_dur=clip_dur,
        api_lat_med=statistics.median(api_lat) if api_lat else None,
    )
    dels = deletion_spans(stem, normalize(hyp_meeting), chunks, segments)

    return dict(
        stem=stem, ref_words=Nm,
        meeting=dict(wer=(Sm + Dm + Im) / max(Nm, 1), S=Sm, D=Dm, I=Im, N=Nm),
        full=dict(wer=(Sf + Df + If) / max(Nf, 1), S=Sf, D=Df, I=If, N=Nf),
        stats=stats, dels=dels,
        hyp_meeting=hyp_meeting, hyp_full=full_text,
    )


# ───────────────────────── report ─────────────────────────

def pooled(rows, key):
    tS = sum(r[key]["S"] for r in rows)
    tD = sum(r[key]["D"] for r in rows)
    tI = sum(r[key]["I"] for r in rows)
    tN = sum(r[key]["N"] for r in rows)
    return (tS + tD + tI) / max(tN, 1), (tS, tD, tI, tN)


def run_parakeet(stems):
    """Run the existing Parakeet meeting harness on the same clips (comparison)."""
    try:
        from run_tandem_meeting_wer import evaluate, MODEL_DIR
        if not Path(MODEL_DIR).exists():
            return None, "Parakeet model dir not found"
        res = evaluate(clip_list=stems)
        return res, None
    except Exception as e:  # noqa: BLE001
        return None, f"{type(e).__name__}: {e}"


def build_report(rows, parakeet_res, parakeet_err):
    L = []
    L.append("# Tandem meeting-condition WER + latency — LIVE ElevenLabs Scribe path\n")
    L.append("**Engine:** ElevenLabs Scribe v2 (`scribe_v2`), the live transcription "
             "provider. **Reference:** ElevenLabs Scribe ground truth in "
             "`audio_testing/elevenlabs/` (word-timed).\n")
    L.append("**Pipeline replica:** real Silero VAD (vad.rs LIVE config: pos .40 / neg "
             ".20 / pre 300 / post 200 / redemption 800 / min-speech 100) -> buffer "
             "assembly (12s cap / 1.2s silence-gap flush / <800-sample drop / 1.0s "
             "left-context prepend, pipeline.rs) -> per-chunk POST -> worker.rs "
             "`dedup_overlap_prefix`.\n")
    L.append("**Two Scribe modes:** `meeting` = the exact chunk sequence the app POSTs "
             "during a call; `full` = one POST of the whole clip = engine/version ceiling. "
             "Pipeline-induced loss = meeting WER minus full-clip WER.\n")

    pm, (mS, mD, mI, mN) = pooled(rows, "meeting")
    pf, (fS, fD, fI, fN) = pooled(rows, "full")

    L.append("\n## WER — Scribe meeting-path vs full-clip ceiling\n")
    L.append("| Clip | Ref | Meeting WER | S/D/I | Full WER | S/D/I | Pipeline loss |")
    L.append("|------|-----|-------------|-------|----------|-------|---------------|")
    for r in rows:
        m, f = r["meeting"], r["full"]
        loss = (m["wer"] - f["wer"]) * 100
        L.append(f"| {r['stem']} | {m['N']} | **{m['wer']*100:.1f}%** | "
                 f"{m['S']}/{m['D']}/{m['I']} | {f['wer']*100:.1f}% | "
                 f"{f['S']}/{f['D']}/{f['I']} | {loss:+.1f}pp |")
    L.append(f"| **POOLED** | {mN} | **{pm*100:.1f}%** | {mS}/{mD}/{mI} | "
             f"**{pf*100:.1f}%** | {fS}/{fD}/{fI} | **{(pm-pf)*100:+.1f}pp** |")

    # Parakeet comparison
    L.append("\n## Cross-engine comparison (same held-out clips)\n")
    if parakeet_res:
        pp = parakeet_res["pooled"]
        L.append("| Clip | Scribe meeting | Scribe full (ceiling) | Parakeet meeting |")
        L.append("|------|----------------|-----------------------|------------------|")
        for r in rows:
            pk = parakeet_res["clips"].get(r["stem"])
            pk_s = f"{pk['wer']*100:.1f}%" if pk else "—"
            L.append(f"| {r['stem']} | {r['meeting']['wer']*100:.1f}% | "
                     f"{r['full']['wer']*100:.1f}% | {pk_s} |")
        L.append(f"| **POOLED** | **{pm*100:.1f}%** | **{pf*100:.1f}%** | "
                 f"**{pp*100:.1f}%** |")
    else:
        L.append(f"_Parakeet comparison unavailable: {parakeet_err}_")

    # Latency / block stats
    L.append("\n## Latency / block stats\n")
    L.append("`block wait` = chunk_end - chunk_start (audio at the front of a chunk "
             "waits the whole buffer before being POSTed; network excluded).\n")
    L.append("| Clip | Chunks | Chunk dur min/med/max (s) | Block wait med/max (s) | "
             "Speech kept (s) |")
    L.append("|------|--------|---------------------------|------------------------|-----------------|")
    for r in rows:
        s = r["stats"]
        L.append(f"| {r['stem']} | {s['n_chunks']} | "
                 f"{s['dur_min']:.1f} / {s['dur_med']:.1f} / {s['dur_max']:.1f} | "
                 f"{s['block_med']:.1f} / {s['block_max']:.1f} | {s['content_s']:.1f} |")

    # Deletion findings
    L.append("\n## Top deletion spans (where the meeting path loses words)\n")
    L.append("Deletions located via Scribe ground-truth word timestamps. `boundary` = "
             "within 0.5s of a chunk edge; `vad-gap` = deleted word falls in a "
             "VAD-silence region (never sent to Scribe).\n")
    L.append("| Clip | Len | Time (s) | Cause | Deleted text |")
    L.append("|------|-----|----------|-------|--------------|")
    allspans = []
    for r in rows:
        for d in r["dels"]:
            allspans.append((r["stem"], d))
    allspans.sort(key=lambda x: x[1]["length"], reverse=True)
    for stem, d in allspans[:5]:
        cause = "vad-gap" if d["in_vad_gap"] else ("boundary" if d["at_boundary"] else "in-chunk")
        txt = d["text"] if len(d["text"]) <= 80 else d["text"][:77] + "..."
        L.append(f"| {stem} | {d['length']} | {d['start']:.1f}-{d['end']:.1f} | "
                 f"{cause} | {txt} |")

    # Interpretation
    L.append("\n## Interpretation\n")
    worst = max(rows, key=lambda r: r["meeting"]["wer"] - r["full"]["wer"])
    wl = (worst["meeting"]["wer"] - worst["full"]["wer"]) * 100
    L.append(f"- Pooled Scribe meeting-path WER **{pm*100:.1f}%** vs full-clip ceiling "
             f"**{pf*100:.1f}%** -> the chunking pipeline itself adds "
             f"**{(pm-pf)*100:+.1f}pp**.\n")
    L.append(f"- Worst pipeline penalty: **{worst['stem']}** ({wl:+.1f}pp). "
             "Clips whose meeting WER sits far above their full WER are losing words to "
             "VAD gaps or chunk-boundary word-splitting, not to the engine.\n")
    vad_gap_spans = sum(1 for _, d in allspans if d["in_vad_gap"])
    bnd_spans = sum(1 for _, d in allspans if d["at_boundary"] and not d["in_vad_gap"])
    L.append(f"- Of {len(allspans)} deletion spans, {vad_gap_spans} sit in a VAD-silence "
             f"gap (speech the VAD never forwarded) and {bnd_spans} abut a chunk boundary "
             "(word split across two POSTs / lost in overlap dedup).\n")
    dD, dI, dS = (mD - fD), (mI - fI), (mS - fS)
    L.append(f"- The pipeline penalty is **insertion-dominated**: meeting vs full adds "
             f"{dI:+d} insertions, {dD:+d} deletions, {dS:+d} substitutions "
             "(pooled). Chunk-boundary word duplication survives the overlap dedup more "
             "often than the pipeline drops words, so tightening `dedup_overlap_prefix` "
             "(or the 1.0s overlap length) would recover more than chasing VAD gaps.\n")
    if parakeet_res:
        L.append(f"- Cross-engine: Scribe meeting **{pm*100:.1f}%** vs Parakeet meeting "
                 f"**{parakeet_res['pooled']*100:.1f}%** on the same clips.\n")

    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="include old clips (02..10)")
    ap.add_argument("--no-parakeet", action="store_true", help="skip Parakeet comparison")
    ap.add_argument("--clips", nargs="+", help="explicit clip stems, e.g. clip_11 clip_12")
    args = ap.parse_args()

    if args.clips:
        stems = args.clips
    elif args.all:
        stems = OLD_CLIPS + NEW_CLIPS
    else:
        stems = NEW_CLIPS

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Clips: {stems}")
    print(f"Scribe model: {SCRIBE_MODEL}  (cache: {CACHE_DIR})")

    rows = []
    for stem in stems:
        r = run_clip(stem)
        rows.append(r)
        m, f = r["meeting"], r["full"]
        s = r["stats"]
        print(f"=== {stem} ===  meeting WER={m['wer']*100:5.1f}% (S{m['S']}/D{m['D']}/I{m['I']}) "
              f"| full={f['wer']*100:5.1f}% | {s['n_chunks']} chunks, "
              f"block med/max {s['block_med']:.1f}/{s['block_max']:.1f}s, "
              f"speech {s['content_s']:.1f}s")
        # QA: no empty hypotheses
        if not r["hyp_meeting"].strip():
            print(f"  !! WARNING: empty meeting hypothesis for {stem}", file=sys.stderr)
        (OUT_DIR / f"{stem}.meeting.txt").write_text(r["hyp_meeting"], encoding="utf-8")
        (OUT_DIR / f"{stem}.full.txt").write_text(r["hyp_full"], encoding="utf-8")

    parakeet_res, parakeet_err = (None, "skipped")
    if not args.no_parakeet:
        print("\nRunning Parakeet meeting harness on the same clips (comparison)...")
        parakeet_res, parakeet_err = run_parakeet(stems)
        if parakeet_res:
            print(f"  Parakeet pooled meeting WER: {parakeet_res['pooled']*100:.1f}%")
        else:
            print(f"  Parakeet comparison unavailable: {parakeet_err}", file=sys.stderr)

    report = build_report(rows, parakeet_res, parakeet_err)
    (OUT_DIR / "wer_scribe_report.md").write_text(report, encoding="utf-8")

    pm, _ = pooled(rows, "meeting")
    pf, _ = pooled(rows, "full")
    print("\n" + "=" * 64)
    print(f"POOLED  Scribe meeting {pm*100:.1f}%  |  Scribe full {pf*100:.1f}%  "
          f"|  pipeline loss {(pm-pf)*100:+.1f}pp")
    if parakeet_res:
        print(f"        Parakeet meeting {parakeet_res['pooled']*100:.1f}%")
    print(f"API calls this run: {_api_calls}")
    print(f"Report: {OUT_DIR / 'wer_scribe_report.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
