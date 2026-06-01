"""
Run the test clips through Tandem's CURRENT transcription engine
(NVIDIA Parakeet TDT 0.6b v3, int8 ONNX) and compute Word Error Rate
against the ElevenLabs ground-truth transcripts.

This is a faithful Python replica of the Rust engine in
frontend/src-tauri/src/parakeet_engine/model.rs:
  - same three ONNX graphs (nemo128 preprocessor, encoder int8, decoder_joint int8)
  - same vocab.txt + <blk> blank handling
  - same greedy TDT decode loop (MAX_TOKENS_PER_STEP=10, vocab/duration split)
  - same spacing post-process regex

It uses the exact model files Tandem loaded at runtime:
  %APPDATA%\\com.tandem.ai\\models\\parakeet\\parakeet-tdt-0.6b-v3-int8

Output:
  audio_testing/parakeet_out/clip_NN.txt   - Tandem hypothesis transcript
  audio_testing/parakeet_out/wer_report.md - per-clip + aggregate WER
"""

import os
import re
import sys
import wave
import array
from pathlib import Path

import numpy as np
import onnxruntime as ort

HERE = Path(__file__).parent
CLIPS_DIR = HERE / "clips"
REF_DIR = HERE / "elevenlabs"
OUT_DIR = HERE / "parakeet_out"

MODEL_DIR = Path(
    os.environ.get("APPDATA", r"C:\Users\andre\AppData\Roaming")
) / "com.tandem.ai" / "models" / "parakeet" / "parakeet-tdt-0.6b-v3-int8"

CLIPS = ["clip_02", "clip_04", "clip_06", "clip_07", "clip_10"]

# Constants mirrored from model.rs
SUBSAMPLING_FACTOR = 8
WINDOW_SIZE = 0.01
MAX_TOKENS_PER_STEP = 10

# Spacing cleanup regex, mirrored from model.rs DECODE_SPACE_RE
DECODE_SPACE_RE = re.compile(r"\A\s|\s\B|(\s)\b")


def _spacing_sub(m):
    return " " if m.group(1) is not None else ""


# ───────────────────────── engine ─────────────────────────

class ParakeetModel:
    def __init__(self, model_dir: Path):
        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED  # Level2
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL  # parallel_execution(false)
        providers = ["CPUExecutionProvider"]

        self.preprocessor = ort.InferenceSession(
            str(model_dir / "nemo128.onnx"), so, providers=providers)
        self.encoder = ort.InferenceSession(
            str(model_dir / "encoder-model.int8.onnx"), so, providers=providers)
        self.decoder = ort.InferenceSession(
            str(model_dir / "decoder_joint-model.int8.onnx"), so, providers=providers)

        self.vocab, self.blank_idx = self._load_vocab(model_dir / "vocab.txt")
        self.vocab_size = len(self.vocab)

        # Decoder state input dtypes/shapes
        self._dec_inputs = {i.name: i for i in self.decoder.get_inputs()}
        print(f"[init] vocab_size={self.vocab_size} blank_idx={self.blank_idx}")
        print(f"[init] decoder inputs: "
              f"{[(i.name, i.type, i.shape) for i in self.decoder.get_inputs()]}")

    @staticmethod
    def _load_vocab(path: Path):
        tokens_with_ids = []
        blank_idx = None
        max_id = 0
        for line in path.read_text(encoding="utf-8").splitlines():
            parts = line.rstrip().split(" ")
            if len(parts) >= 2:
                token = parts[0]
                try:
                    idx = int(parts[1])
                except ValueError:
                    continue
                if token == "<blk>":
                    blank_idx = idx
                tokens_with_ids.append((token, idx))
                max_id = max(max_id, idx)
        vocab = [""] * (max_id + 1)
        for token, idx in tokens_with_ids:
            vocab[idx] = token.replace("▁", " ")
        if blank_idx is None:
            raise ValueError("Missing <blk> token in vocabulary")
        return vocab, blank_idx

    def _np(self, name, value, default_dtype):
        """Build a numpy array matching the decoder input's declared dtype."""
        t = self._dec_inputs[name].type  # e.g. 'tensor(int32)'
        m = re.search(r"\((\w+)\)", t)
        dt = m.group(1) if m else default_dtype
        npdt = {
            "float": np.float32, "float32": np.float32,
            "int32": np.int32, "int64": np.int64,
            "double": np.float64,
        }.get(dt, np.dtype(default_dtype))
        return np.asarray(value, dtype=npdt)

    def _zero_state(self, name):
        info = self._dec_inputs[name]
        shape = list(info.shape)
        # dims may be strings (dynamic); batch dim -> 1
        dims = []
        for d in shape:
            dims.append(d if isinstance(d, int) and d > 0 else 1)
        m = re.search(r"\((\w+)\)", info.type)
        npdt = np.float32 if (not m or m.group(1).startswith("float")) else np.int64
        return np.zeros(dims, dtype=npdt)

    def transcribe(self, samples: np.ndarray):
        # samples: float32 [num_samples] at 16kHz
        waveforms = samples.reshape(1, -1).astype(np.float32)
        waveforms_lens = np.array([samples.shape[0]], dtype=np.int64)

        feats, feats_lens = self.preprocessor.run(
            ["features", "features_lens"],
            {"waveforms": waveforms, "waveforms_lens": waveforms_lens},
        )
        enc_out, enc_lens = self.encoder.run(
            ["outputs", "encoded_lengths"],
            {"audio_signal": feats, "length": feats_lens.astype(feats_lens.dtype)},
        )
        # NeMo encoder output [B, D, T] -> [B, T, D]
        enc_out = np.transpose(enc_out, (0, 2, 1))

        tokens, timestamps = self._decode_sequence(enc_out[0], int(enc_lens[0]))
        return self._decode_tokens(tokens, timestamps)

    def _decode_sequence(self, encodings: np.ndarray, encodings_len: int):
        # encodings: [time_steps, 1024]
        state1 = self._zero_state("input_states_1")
        state2 = self._zero_state("input_states_2")
        tokens = []
        timestamps = []
        t = 0
        emitted = 0
        while t < encodings_len:
            enc_step = encodings[t, :]  # [1024]
            target_token = tokens[-1] if tokens else self.blank_idx

            encoder_outputs = enc_step.reshape(1, -1, 1).astype(np.float32)  # [1,1024,1]
            targets = self._np("targets", [[target_token]], "int32")          # [1,1]
            target_length = self._np("target_length", [1], "int32")           # [1]

            outs = self.decoder.run(
                ["outputs", "output_states_1", "output_states_2"],
                {
                    "encoder_outputs": encoder_outputs,
                    "targets": targets,
                    "target_length": target_length,
                    "input_states_1": state1,
                    "input_states_2": state2,
                },
            )
            logits, new_s1, new_s2 = outs
            flat = np.asarray(logits).reshape(-1)
            vocab_logits = flat[: self.vocab_size] if flat.shape[0] > self.vocab_size else flat
            token = int(np.argmax(vocab_logits))

            if token != self.blank_idx:
                state1, state2 = new_s1, new_s2
                tokens.append(token)
                timestamps.append(t)
                emitted += 1

            if token == self.blank_idx or emitted == MAX_TOKENS_PER_STEP:
                t += 1
                emitted = 0
        return tokens, timestamps

    def _decode_tokens(self, ids, timestamps):
        toks = [self.vocab[i] for i in ids if 0 <= i < len(self.vocab)]
        joined = "".join(toks)
        text = DECODE_SPACE_RE.sub(_spacing_sub, joined)
        ts = [WINDOW_SIZE * SUBSAMPLING_FACTOR * t for t in timestamps]
        return text, ts


# ───────────────────────── audio io ─────────────────────────

def segment_by_silence(samples: np.ndarray, sr: int = 16000):
    """Approximate Tandem's live pipeline: split into VAD-ish speech segments.

    Mirrors the intent of pipeline.rs constants:
      - flush a segment after >=1.2s of silence (SILENCE_GAP_FLUSH_SECS)
      - merge so segments carry >=1.5s of speech where possible
      - pre/post speech padding (~300ms / 200ms)
    Uses a simple energy VAD (Tandem uses Silero; this is an approximation).
    """
    frame = int(0.01 * sr)  # 10ms
    n = len(samples) // frame
    if n == 0:
        return [samples]
    rms = np.sqrt(np.mean(
        samples[: n * frame].reshape(n, frame) ** 2, axis=1) + 1e-12)
    noise = np.percentile(rms, 20)
    thresh = max(noise * 3.0, 0.005)
    speech = rms > thresh

    gap_frames = int(1.2 / 0.01)     # 1.2s silence flush
    pre = int(0.30 / 0.01)
    post = int(0.20 / 0.01)
    min_speech = int(1.5 / 0.01)     # min speech frames to keep a segment

    # find speech runs
    segs = []
    i = 0
    while i < n:
        if speech[i]:
            j = i
            silence = 0
            last_speech = i
            while j < n:
                if speech[j]:
                    last_speech = j
                    silence = 0
                else:
                    silence += 1
                    if silence >= gap_frames:
                        break
                j += 1
            start = max(0, i - pre)
            end = min(n, last_speech + 1 + post)
            if (last_speech - i + 1) >= 1:  # has speech
                segs.append([start, end])
            i = j + 1
        else:
            i += 1

    # merge adjacent segments closer than the gap and grow short ones
    merged = []
    for s in segs:
        if merged and s[0] - merged[-1][1] < gap_frames and \
                (merged[-1][1] - merged[-1][0]) < min_speech:
            merged[-1][1] = s[1]
        else:
            merged.append(s)

    out = []
    for s, e in merged:
        a, b = s * frame, min(len(samples), e * frame)
        if b - a >= int(0.25 * sr):  # drop <250ms fragments
            out.append(samples[a:b])
    return out or [samples]


def read_wav_16k_mono(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        assert w.getframerate() == 16000, f"{path}: expected 16k, got {w.getframerate()}"
        assert w.getnchannels() == 1, f"{path}: expected mono"
        assert w.getsampwidth() == 2, f"{path}: expected 16-bit PCM"
        raw = w.readframes(w.getnframes())
    a = array.array("h")
    a.frombytes(raw)
    return np.asarray(a, dtype=np.float32) / 32768.0


# ──────────────── post-processing (mirrors Rust engine fixes) ────────────────

_MEANINGLESS = [
    "thank you for watching", "thanks for watching", "like and subscribe",
    "music playing", "applause", "laughter", "um um um", "uh uh uh", "ah ah ah",
]


def _is_meaningless(text: str) -> bool:
    tl = text.lower()
    if any(p in tl for p in _MEANINGLESS):
        return True
    if len(set(text)) <= 3 and len(text) > 10:
        return True
    return False


def _remove_word_reps(words):
    out = []
    i = 0
    while i < len(words):
        w = words[i]
        j = i + 1
        while j < len(words) and words[j] == w:
            j += 1
        out.append(w)  # collapse 2+ consecutive identical to one
        i = j
    return out


def _remove_phrase_reps(words):
    if len(words) < 4:
        return words
    out = []
    i = 0
    while i < len(words):
        found = False
        for plen in range(2, min(5, (len(words) - i) // 2) + 1):
            if i + plen * 2 <= len(words) and words[i:i + plen] == words[i + plen:i + plen * 2]:
                out.extend(words[i:i + plen])
                i += plen * 2
                found = True
                break
        if not found:
            out.append(words[i])
            i += 1
    return out


def _rep_ratio(words):
    if len(words) < 4:
        return 0.0
    from collections import Counter
    c = Counter(w.lower() for w in words)
    repeated = sum(v - 1 for v in c.values() if v > 1)
    return repeated / len(words)


def clean_repetitive_text(text: str) -> str:
    """Port of WhisperEngine::clean_repetitive_text (whisper_engine.rs:390)."""
    if not text:
        return ""
    if _is_meaningless(text):
        return ""
    words = text.split()
    if len(words) < 3:
        return text
    words = _remove_word_reps(words)
    words = _remove_phrase_reps(words)
    final = " ".join(words)
    if _rep_ratio(final.split()) > 0.7:
        return ""
    return final


# Domain vocabulary correction (#3). Conservative: explicit aliases for known
# misfires + tight fuzzy match against a domain wordlist.
DOMAIN_TERMS = [
    "n8n", "tandem", "excalidraw", "meetily", "anthropic", "claude", "powershell",
    "shopify", "webhook", "workflow", "json", "ollama", "parakeet", "whisper",
    "coworker", "github", "api",
]
DOMAIN_ALIASES = {
    "nan": "n8n", "n8n": "n8n", "anan": "n8n",
    "excalidor": "excalidraw", "excalidra": "excalidraw",
    "meetly": "meetily", "meetilly": "meetily",
}


def _difflib_ratio(a, b):
    import difflib
    return difflib.SequenceMatcher(None, a, b).ratio()


def apply_domain_corrections(text: str) -> str:
    out = []
    for w in text.split():
        core = w.strip(".,!?;:").lower()
        tail = w[len(w.rstrip(".,!?;:")):]
        if core in DOMAIN_ALIASES:
            out.append(DOMAIN_ALIASES[core] + tail)
            continue
        if len(core) >= 4:
            best = max(DOMAIN_TERMS, key=lambda t: _difflib_ratio(core, t))
            if _difflib_ratio(core, best) >= 0.86 and core != best:
                out.append(best + tail)
                continue
        out.append(w)
    return " ".join(out)


def collapse_runaways(text: str, min_run: int = 3) -> str:
    """Gentle de-stutter: collapse only consecutive identical tokens repeated
    >= min_run times (the TDT runaway, e.g. 'a a a a' / 'st st st' / 'in in in').
    Leaves natural doublings ('I I', 'the the') and real content untouched —
    unlike the whisper cleaner which also drops whole high-repetition segments.
    """
    words = text.split()
    out = []
    i = 0
    while i < len(words):
        j = i + 1
        while j < len(words) and words[j].lower() == words[i].lower():
            j += 1
        run = j - i
        if run >= min_run:
            out.append(words[i])           # collapse runaway to a single token
        else:
            out.extend(words[i:j])         # keep natural short repeats
        i = j
    return " ".join(out)


def postprocess(text: str, do_reps=True, do_domain=True, gentle=True) -> str:
    if do_reps:
        text = collapse_runaways(text) if gentle else clean_repetitive_text(text)
    if do_domain:
        text = apply_domain_corrections(text)
    return text


# ───────────────────────── WER ─────────────────────────

_BRACKETS = re.compile(r"[\(\[][^\)\]]*[\)\]]")  # (laughs), (computer mouse clicking)
_NONWORD = re.compile(r"[^\w'\s]")               # keep apostrophes inside words


def normalize(text: str) -> list[str]:
    t = text.lower()
    t = t.replace("...", " ")
    t = _BRACKETS.sub(" ", t)        # drop non-speech event annotations
    t = _NONWORD.sub(" ", t)
    t = re.sub(r"\s+", " ", t).strip()
    # strip standalone apostrophes / leading-trailing apostrophes
    return [w.strip("'") for w in t.split() if w.strip("'")]


def wer_align(ref: list[str], hyp: list[str]):
    """Levenshtein on word lists -> (S, D, I, N)."""
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
    # backtrack for S/D/I
    i, j = n, m
    S = D = I = 0
    while i > 0 or j > 0:
        if i > 0 and j > 0 and dp[i][j] == dp[i - 1][j - 1] + (0 if ref[i - 1] == hyp[j - 1] else 1):
            if ref[i - 1] != hyp[j - 1]:
                S += 1
            i -= 1
            j -= 1
        elif i > 0 and dp[i][j] == dp[i - 1][j] + 1:
            D += 1
            i -= 1
        else:
            I += 1
            j -= 1
    return S, D, I, n


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Model dir: {MODEL_DIR}")
    if not MODEL_DIR.exists():
        print("ERROR: model dir not found", file=sys.stderr)
        return 1

    model = ParakeetModel(MODEL_DIR)

    rows = []
    tot = {"full": [0, 0, 0, 0], "chunk": [0, 0, 0, 0]}  # S,D,I,N
    for stem in CLIPS:
        wav = CLIPS_DIR / f"{stem}.wav"
        ref_txt = (REF_DIR / f"{stem}.txt").read_text(encoding="utf-8")
        samples = read_wav_16k_mono(wav)
        ref_words = normalize(ref_txt)
        print(f"\n=== {stem} ({samples.shape[0]/16000:.1f}s, ref {len(ref_words)} words) ===")

        # Mode 1: full clip (engine ceiling / transcribe_samples)
        hyp_full, _ = model.transcribe(samples)
        (OUT_DIR / f"{stem}.full.txt").write_text(hyp_full, encoding="utf-8")

        # Mode 2: chunked, approximating the live meeting VAD pipeline
        segs = segment_by_silence(samples)
        parts = [model.transcribe(s)[0] for s in segs]
        hyp_chunk = " ".join(p.strip() for p in parts if p.strip())
        (OUT_DIR / f"{stem}.chunk.txt").write_text(hyp_chunk, encoding="utf-8")

        Sf, Df, If, Nf = wer_align(ref_words, normalize(hyp_full))
        Sc, Dc, Ic, _ = wer_align(ref_words, normalize(hyp_chunk))
        werf = (Sf + Df + If) / max(Nf, 1)
        werc = (Sc + Dc + Ic) / max(Nf, 1)
        rows.append((stem, Nf, werf, Sf, Df, If, werc, Sc, Dc, Ic, len(segs)))
        for k, (S, D, I) in (("full", (Sf, Df, If)), ("chunk", (Sc, Dc, Ic))):
            tot[k][0] += S; tot[k][1] += D; tot[k][2] += I; tot[k][3] += Nf
        print(f"  full : WER={werf*100:5.1f}%  (S={Sf} D={Df} I={If})")
        print(f"  chunk: WER={werc*100:5.1f}%  (S={Sc} D={Dc} I={Ic}, {len(segs)} segs)")

    agg_full = sum(tot["full"][:3]) / max(tot["full"][3], 1)
    agg_chunk = sum(tot["chunk"][:3]) / max(tot["chunk"][3], 1)

    # ── report ──
    lines = []
    lines.append("# Tandem current-engine transcription baseline (WER)\n")
    lines.append("**Engine:** NVIDIA Parakeet TDT 0.6b v3 (int8 ONNX) — the configured "
                 "`transcript_settings` provider in Tandem.\n")
    lines.append("**Reference:** ElevenLabs Scribe v1 transcripts (human-QC'd), in "
                 "`audio_testing/elevenlabs/`.\n")
    lines.append("**Engine replica:** same three ONNX graphs (nemo128 preprocessor, "
                 "encoder.int8, decoder_joint.int8) + same vocab + same greedy TDT decode "
                 "as `frontend/src-tauri/src/parakeet_engine/model.rs`.\n")
    lines.append("**Two modes:** `full` = whole 60s clip in one pass (`transcribe_samples`); "
                 "`chunk` = clip split into VAD-ish speech segments to approximate the live "
                 "meeting pipeline (silence-gap flush ~1.2s, energy VAD approximation of Silero).\n")
    lines.append("**WER normalization:** lowercase, drop bracketed non-speech events "
                 "e.g. (laughs), strip punctuation, collapse whitespace.\n")
    lines.append("\n| Clip | Ref words | WER (full) | S/D/I | WER (chunk) | S/D/I | segs |")
    lines.append("|------|-----------|-----------|-------|-------------|-------|------|")
    for (stem, N, werf, Sf, Df, If, werc, Sc, Dc, Ic, nseg) in rows:
        lines.append(f"| {stem} | {N} | **{werf*100:.1f}%** | {Sf}/{Df}/{If} | "
                     f"**{werc*100:.1f}%** | {Sc}/{Dc}/{Ic} | {nseg} |")
    lines.append(f"| **POOLED** | {tot['full'][3]} | **{agg_full*100:.1f}%** | "
                 f"{tot['full'][0]}/{tot['full'][1]}/{tot['full'][2]} | "
                 f"**{agg_chunk*100:.1f}%** | "
                 f"{tot['chunk'][0]}/{tot['chunk'][1]}/{tot['chunk'][2]} | — |")
    lines.append(f"\n**Pooled WER (full-clip): {agg_full*100:.1f}%**")
    lines.append(f"**Pooled WER (chunked / meeting-like): {agg_chunk*100:.1f}%**\n")
    lines.append("\nNotes:")
    lines.append("- clip_07 is German; Parakeet v3 auto-detects and transcribes it but "
                 "quality is much lower than English — a real weakness, not a measurement error.")
    lines.append("- S/D/I = substitutions / deletions / insertions against the reference.")
    (OUT_DIR / "wer_report.md").write_text("\n".join(lines), encoding="utf-8")

    print("\n" + "=" * 60)
    print(f"POOLED WER  full-clip: {agg_full*100:.1f}%   chunked: {agg_chunk*100:.1f}%")
    print(f"Report: {OUT_DIR / 'wer_report.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
