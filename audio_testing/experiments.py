"""
Experiment harness: load Parakeet once, A/B test transcription variants against
ElevenLabs ground truth. Each variant is (model, samples, segs) -> hypothesis.

Usage: python experiments.py [variant1 variant2 ...]   (default: all registered)
"""
import sys
import numpy as np

from run_tandem_parakeet import (
    ParakeetModel, MODEL_DIR, CLIPS, CLIPS_DIR, REF_DIR,
    read_wav_16k_mono, normalize, wer_align, postprocess,
)
from silero_vad import vad_segments_for_clip, assemble_buffers
from run_ablation import VAD_SENSITIVE

SHIPPED_VAD = VAD_SENSITIVE
MIN_S = 12 * 16000
GAP_MS = 1200


class ParakeetTDT(ParakeetModel):
    """Adds E5: duration-aware TDT greedy decode (uses the duration logits the
    shipped decode discards) alongside the inherited greedy decode."""

    def transcribe_tdt(self, samples):
        wav = np.asarray(samples, dtype=np.float32).reshape(1, -1)
        wl = np.array([wav.shape[1]], dtype=np.int64)
        feats, fl = self.preprocessor.run(["features", "features_lens"],
                                          {"waveforms": wav, "waveforms_lens": wl})
        enc, el = self.encoder.run(["outputs", "encoded_lengths"],
                                   {"audio_signal": feats, "length": fl})
        enc = np.transpose(enc, (0, 2, 1))[0]
        tokens, ts = self._decode_tdt(enc, int(el[0]))
        return self._decode_tokens(tokens, ts)[0]

    def _decode_tdt(self, encodings, n):
        s1 = self._zero_state("input_states_1")
        s2 = self._zero_state("input_states_2")
        tokens, ts = [], []
        t = 0
        while t < n:
            enc = encodings[t].reshape(1, -1, 1).astype(np.float32)
            target = self._np("targets", [[tokens[-1] if tokens else self.blank_idx]], "int32")
            tlen = self._np("target_length", [1], "int32")
            logits, n1, n2 = self.decoder.run(
                ["outputs", "output_states_1", "output_states_2"],
                {"encoder_outputs": enc, "targets": target, "target_length": tlen,
                 "input_states_1": s1, "input_states_2": s2})
            flat = np.asarray(logits).reshape(-1)
            vlog = flat[: self.vocab_size]
            dlog = flat[self.vocab_size:]
            token = int(np.argmax(vlog))
            skip = int(np.argmax(dlog)) if dlog.size else 1
            if token != self.blank_idx:
                s1, s2 = n1, n2
                tokens.append(token)
                ts.append(t)
                # emit-and-stay (duration 0) is allowed but capped to avoid loops
                if skip == 0:
                    # peek: force progress after a short run handled by cap below
                    pass
            else:
                if skip == 0:
                    skip = 1
            t += skip if skip > 0 else (0 if token != self.blank_idx else 1)
            # hard progress guard: never allow > 10 emissions without advancing
            if skip == 0 and token != self.blank_idx:
                # count consecutive same-frame emissions
                if len(ts) >= 10 and len(set(ts[-10:])) == 1:
                    t += 1
        return tokens, ts


def _join(parts):
    return " ".join(p.strip() for p in parts if p.strip())


# ---- buffer builders ----
def buffers_concat(samples, segs):
    """Shipped: concat VAD segment samples (internal silence removed)."""
    return assemble_buffers(segs, min_samples=MIN_S, gap_ms=GAP_MS)


def buffers_contiguous(samples, segs):
    """E1: contiguous audio span [first.start .. last.end], silences kept."""
    out = []
    cur_s = cur_e = None
    last_end = None
    for (s_ms, e_ms, _) in segs:
        if cur_s is not None and (s_ms - last_end) >= GAP_MS:
            out.append(samples[cur_s:cur_e]); cur_s = None
        s_idx, e_idx = int(s_ms * 16), min(len(samples), int(e_ms * 16))
        if cur_s is None:
            cur_s = s_idx
        cur_e = e_idx
        last_end = e_ms
        if cur_e - cur_s >= MIN_S:
            out.append(samples[cur_s:cur_e]); cur_s = None
    if cur_s is not None:
        out.append(samples[cur_s:cur_e])
    return out


# ---- variants ----
def variant_baseline(model, samples, segs):
    return _join(postprocess(model.transcribe(np.asarray(b, dtype=np.float32))[0])
                 for b in buffers_concat(samples, segs))


def variant_e1_contiguous(model, samples, segs):
    return _join(postprocess(model.transcribe(np.asarray(b, dtype=np.float32))[0])
                 for b in buffers_contiguous(samples, segs))


OVERLAP = int(1.5 * 16000)


def variant_e2_overlap(model, samples, segs):
    """E2: prepend ~1.5s of the previous buffer as left context, dedup the join."""
    acc = []
    prev_tail = None
    for b in buffers_concat(samples, segs):
        b = np.asarray(b, dtype=np.float32)
        inp = np.concatenate([prev_tail, b]) if prev_tail is not None else b
        words = postprocess(model.transcribe(inp)[0]).split()
        if acc and words:
            k = 0
            for kk in range(min(10, len(words), len(acc)), 0, -1):
                if [w.lower() for w in acc[-kk:]] == [w.lower() for w in words[:kk]]:
                    k = kk
                    break
            words = words[k:]
        acc.extend(words)
        prev_tail = b[-OVERLAP:] if len(b) > OVERLAP else b
    return " ".join(acc)


def variant_e5_durations(model, samples, segs):
    """E5: duration-aware TDT decode instead of always-advance-1 greedy."""
    return _join(postprocess(model.transcribe_tdt(np.asarray(b, dtype=np.float32)))
                 for b in buffers_concat(samples, segs))


VARIANTS = {
    "baseline": variant_baseline,
    "e1_contiguous": variant_e1_contiguous,
    "e2_overlap": variant_e2_overlap,
    "e5_durations": variant_e5_durations,
}


def run(names):
    model = ParakeetTDT(MODEL_DIR)
    data = {stem: (read_wav_16k_mono(CLIPS_DIR / f"{stem}.wav"),
                   vad_segments_for_clip(read_wav_16k_mono(CLIPS_DIR / f"{stem}.wav"), SHIPPED_VAD),
                   normalize((REF_DIR / f"{stem}.txt").read_text(encoding="utf-8")))
            for stem in CLIPS}

    print(f"{'variant':18} {'pooled':>7}  per-clip WER")
    results = {}
    for name in names:
        fn = VARIANTS[name]
        tS = tD = tI = tN = 0
        per = []
        for stem in CLIPS:
            samples, segs, ref = data[stem]
            hyp = fn(model, samples, segs)
            S, D, I, N = wer_align(ref, normalize(hyp))
            per.append((stem, (S + D + I) / max(N, 1)))
            tS += S; tD += D; tI += I; tN += N
        pooled = (tS + tD + tI) / max(tN, 1)
        results[name] = pooled
        pc = " ".join(f"{s.split('_')[1]}:{w*100:.1f}" for s, w in per)
        print(f"{name:18} {pooled*100:6.2f}%  {pc}  (S{tS} D{tD} I{tI})")
    return results


if __name__ == "__main__":
    names = sys.argv[1:] or list(VARIANTS)
    run(names)
