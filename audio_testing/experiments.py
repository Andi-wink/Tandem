"""
Experiment harness: load Parakeet once, A/B test transcription variants against
ElevenLabs ground truth. Each variant is (model, samples, segs) -> hypothesis.

Usage: python experiments.py [variant1 variant2 ...]   (default: all registered)
"""
import re
import sys
import numpy as np

from run_tandem_parakeet import (
    ParakeetModel, MODEL_DIR, CLIPS, CLIPS_DIR, REF_DIR,
    read_wav_16k_mono, normalize, wer_align, postprocess,
)
from silero_vad import vad_segments_for_clip, assemble_buffers
from run_ablation import VAD_SENSITIVE

SHIPPED_VAD = VAD_SENSITIVE
MIN_S = 25 * 16000   # current shipped window (E6)
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

    # ---- E4: time-synchronous RNNT/TDT beam search ----
    def _joint_logprobs(self, enc_frame, last_token, s1, s2):
        enc = enc_frame.reshape(1, -1, 1).astype(np.float32)
        target = self._np("targets", [[last_token]], "int32")
        tlen = self._np("target_length", [1], "int32")
        logits, n1, n2 = self.decoder.run(
            ["outputs", "output_states_1", "output_states_2"],
            {"encoder_outputs": enc, "targets": target, "target_length": tlen,
             "input_states_1": s1, "input_states_2": s2})
        v = np.asarray(logits).reshape(-1)[: self.vocab_size].astype(np.float64)
        v -= v.max()
        lp = v - np.log(np.exp(v).sum())
        return lp, n1, n2

    def transcribe_beam(self, samples, beam=4, max_symbols=3, bp=0.0, length_norm=False):
        wav = np.asarray(samples, dtype=np.float32).reshape(1, -1)
        wl = np.array([wav.shape[1]], dtype=np.int64)
        feats, fl = self.preprocessor.run(["features", "features_lens"],
                                          {"waveforms": wav, "waveforms_lens": wl})
        enc, el = self.encoder.run(["outputs", "encoded_lengths"],
                                   {"audio_signal": feats, "length": fl})
        enc = np.transpose(enc, (0, 2, 1))[0]
        n = int(el[0])
        blank = self.blank_idx
        z1, z2 = self._zero_state("input_states_1"), self._zero_state("input_states_2")
        # hyp = (score, tokens, ts, last_token, s1, s2)
        hyps = [(0.0, [], [], blank, z1, z2)]
        for t in range(n):
            ef = enc[t]
            kept = []        # took blank at t -> advance to t+1
            live = list(hyps)
            for _ in range(max_symbols):
                cand = []
                for (sc, toks, ts, last, s1, s2) in live:
                    lp, nn1, nn2 = self._joint_logprobs(ef, last, s1, s2)
                    blank_lp = lp[blank] - bp           # penalize the blank path
                    kept.append((sc + blank_lp, toks, ts, last, s1, s2))
                    order = np.argsort(lp)[::-1]
                    taken = 0
                    for tok in order:
                        if tok == blank:
                            continue
                        cand.append((sc + lp[tok], toks + [int(tok)], ts + [t],
                                     int(tok), nn1, nn2))
                        taken += 1
                        if taken >= beam:
                            break
                if not cand:
                    break
                cand.sort(key=lambda h: h[0], reverse=True)
                live = cand[:beam]
            for (sc, toks, ts, last, s1, s2) in live:  # force blank after cap
                lp, _, _ = self._joint_logprobs(ef, last, s1, s2)
                kept.append((sc + lp[blank] - bp, toks, ts, last, s1, s2))
            kept.sort(key=lambda h: h[0], reverse=True)
            hyps = kept[:beam]
        if length_norm:
            best = max(hyps, key=lambda h: h[0] / max(len(h[1]), 1))
        else:
            best = max(hyps, key=lambda h: h[0])
        return self._decode_tokens(best[1], best[2])[0]

    def transcribe_bp_conf(self, samples, bp=1.25, conf=0.0):
        """Greedy + blank penalty, but suppress a non-blank emission whose softmax
        confidence (over the un-penalized logits) is below `conf` (treat as blank)."""
        wav = np.asarray(samples, dtype=np.float32).reshape(1, -1)
        wl = np.array([wav.shape[1]], dtype=np.int64)
        feats, fl = self.preprocessor.run(["features", "features_lens"],
                                          {"waveforms": wav, "waveforms_lens": wl})
        enc, el = self.encoder.run(["outputs", "encoded_lengths"],
                                   {"audio_signal": feats, "length": fl})
        enc = np.transpose(enc, (0, 2, 1))[0]
        n = int(el[0])
        s1, s2 = self._zero_state("input_states_1"), self._zero_state("input_states_2")
        tokens, ts = [], []
        t = 0
        emitted = 0
        while t < n:
            target = self._np("targets", [[tokens[-1] if tokens else self.blank_idx]], "int32")
            tlen = self._np("target_length", [1], "int32")
            logits, n1, n2 = self.decoder.run(
                ["outputs", "output_states_1", "output_states_2"],
                {"encoder_outputs": enc[t].reshape(1, -1, 1).astype(np.float32),
                 "targets": target, "target_length": tlen,
                 "input_states_1": s1, "input_states_2": s2})
            raw = np.asarray(logits).reshape(-1)[: self.vocab_size].astype(np.float64)
            vlog = raw.copy()
            vlog[self.blank_idx] -= bp
            token = int(np.argmax(vlog))
            if token != self.blank_idx and conf > 0.0:
                p = np.exp(raw - raw.max())
                prob = p[token] / p.sum()
                if prob < conf:
                    token = self.blank_idx  # too uncertain -> suppress emission
            if token != self.blank_idx:
                s1, s2 = n1, n2
                tokens.append(token)
                ts.append(t)
                emitted += 1
            if token == self.blank_idx or emitted == 10:
                t += 1
                emitted = 0
        return self._decode_tokens(tokens, ts)[0]

    def transcribe_bp(self, samples, bp=0.0, max_sym=10):
        """Greedy decode with a blank penalty: subtract `bp` from the blank
        logit before argmax. Higher bp -> more emissions -> fewer deletions."""
        wav = np.asarray(samples, dtype=np.float32).reshape(1, -1)
        wl = np.array([wav.shape[1]], dtype=np.int64)
        feats, fl = self.preprocessor.run(["features", "features_lens"],
                                          {"waveforms": wav, "waveforms_lens": wl})
        enc, el = self.encoder.run(["outputs", "encoded_lengths"],
                                   {"audio_signal": feats, "length": fl})
        enc = np.transpose(enc, (0, 2, 1))[0]
        n = int(el[0])
        s1, s2 = self._zero_state("input_states_1"), self._zero_state("input_states_2")
        tokens, ts = [], []
        t = 0
        emitted = 0
        while t < n:
            target = self._np("targets", [[tokens[-1] if tokens else self.blank_idx]], "int32")
            tlen = self._np("target_length", [1], "int32")
            logits, n1, n2 = self.decoder.run(
                ["outputs", "output_states_1", "output_states_2"],
                {"encoder_outputs": enc[t].reshape(1, -1, 1).astype(np.float32),
                 "targets": target, "target_length": tlen,
                 "input_states_1": s1, "input_states_2": s2})
            vlog = np.asarray(logits).reshape(-1)[: self.vocab_size].astype(np.float64).copy()
            vlog[self.blank_idx] -= bp
            token = int(np.argmax(vlog))
            if token != self.blank_idx:
                s1, s2 = n1, n2
                tokens.append(token)
                ts.append(t)
                emitted += 1
            if token == self.blank_idx or emitted == max_sym:
                t += 1
                emitted = 0
        return self._decode_tokens(tokens, ts)[0]


# ---- audio preprocessing (applied per buffer before the model) ----
def dsp_peak_norm(x, peak=0.95):
    m = np.max(np.abs(x)) + 1e-9
    return (x / m * peak).astype(np.float32)


def dsp_rms_norm(x, target=0.06, max_gain=8.0):
    rms = np.sqrt(np.mean(x ** 2) + 1e-12)
    g = min(target / (rms + 1e-9), max_gain)
    return np.clip(x * g, -1.0, 1.0).astype(np.float32)


def dsp_preemph(x, a=0.97):
    y = np.empty_like(x)
    y[0] = x[0]
    y[1:] = x[1:] - a * x[:-1]
    return y.astype(np.float32)


def dsp_pad(x, ms=250):
    pad = np.zeros(int(ms * 16), dtype=np.float32)
    return np.concatenate([pad, x, pad])


def dsp_compress(x, power=0.6):
    """#13: power companding to lift quiet speech, then peak-renormalize."""
    y = np.sign(x) * (np.abs(x) ** power)
    return dsp_peak_norm(y, 0.95)


def dsp_highpass(x, cutoff=80.0, sr=16000):
    """#11: 1st-order high-pass to remove low rumble below `cutoff` Hz."""
    rc = 1.0 / (2 * np.pi * cutoff)
    a = rc / (rc + 1.0 / sr)
    y = np.empty_like(x)
    y[0] = x[0]
    for n in range(1, len(x)):
        y[n] = a * (y[n - 1] + x[n] - x[n - 1])
    return y.astype(np.float32)


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


def variant_e4_beam(model, samples, segs):
    """E4: time-synchronous beam search (beam=4) instead of greedy argmax."""
    return _join(postprocess(model.transcribe_beam(np.asarray(b, dtype=np.float32)))
                 for b in buffers_concat(samples, segs))


def _bp_variant(bp):
    def v(model, samples, segs):
        return _join(postprocess(model.transcribe_bp(np.asarray(b, dtype=np.float32), bp=bp))
                     for b in buffers_concat(samples, segs))
    return v


def _dsp_variant(fn):
    def v(model, samples, segs):
        return _join(postprocess(model.transcribe(fn(np.asarray(b, dtype=np.float32)))[0])
                     for b in buffers_concat(samples, segs))
    return v


def _conf_variant(conf):
    def v(model, samples, segs):
        return _join(postprocess(model.transcribe_bp_conf(np.asarray(b, dtype=np.float32),
                                                          bp=1.25, conf=conf))
                     for b in buffers_concat(samples, segs))
    return v


def variant_beam_bp(model, samples, segs):
    """E4 retry: beam search WITH blank penalty + length normalization."""
    return _join(postprocess(model.transcribe_beam(np.asarray(b, dtype=np.float32),
                                                    bp=1.25, length_norm=True))
                 for b in buffers_concat(samples, segs))


def _short_collapse(text):
    """#19: collapse consecutive identical short tokens (len<=2) repeated >=2x."""
    words = text.split()
    out = []
    i = 0
    while i < len(words):
        j = i + 1
        while j < len(words) and words[j].lower() == words[i].lower():
            j += 1
        core = words[i].strip(".,!?;:")
        if (j - i) >= 2 and len(core) <= 2:
            out.append(words[i])
        else:
            out.extend(words[i:j])
        i = j
    return " ".join(out)


def variant_short_destutter(model, samples, segs):
    return _short_collapse(variant_baseline(model, samples, segs))


_PHON = [(r"\bn eight n\b", "n8n"), (r"\bn 8 n\b", "n8n"), (r"\bco[- ]worker\b", "coworker"),
         (r"\bpower shell\b", "powershell"), (r"\bn and n\b", "n8n")]


def variant_phonetic(model, samples, segs):
    t = variant_baseline(model, samples, segs)
    for pat, rep in _PHON:
        t = re.sub(pat, rep, t, flags=re.I)
    return t


def variant_merge_sub2s(model, samples, segs):
    """#16: merge a buffer shorter than 2s into the previous one."""
    bufs = [np.asarray(b, dtype=np.float32) for b in buffers_concat(samples, segs)]
    merged = []
    for b in bufs:
        if merged and len(merged[-1]) / 16000 < 2.0:
            merged[-1] = np.concatenate([merged[-1], b])
        else:
            merged.append(b)
    return _join(postprocess(model.transcribe(b)[0]) for b in merged)


VARIANTS = {
    "baseline": variant_baseline,
    "e1_contiguous": variant_e1_contiguous,
    "e2_overlap": variant_e2_overlap,
    "e5_durations": variant_e5_durations,
    "e4_beam": variant_e4_beam,
    # E_bp: blank-penalty sweep (targets deletions)
    "bp0.5": _bp_variant(0.5),
    "bp0.75": _bp_variant(0.75),
    "bp1.0": _bp_variant(1.0),
    "bp1.25": _bp_variant(1.25),
    "bp1.5": _bp_variant(1.5),
    "bp2.0": _bp_variant(2.0),
    "bp3.0": _bp_variant(3.0),
    # audio preprocessing
    "rms_norm": _dsp_variant(dsp_rms_norm),
    "peak_norm": _dsp_variant(dsp_peak_norm),
    "preemph": _dsp_variant(dsp_preemph),
    "pad_silence": _dsp_variant(dsp_pad),
    # confidence suppression sweep (on top of bp=1.25)
    "conf0.1": _conf_variant(0.10),
    "conf0.2": _conf_variant(0.20),
    "conf0.3": _conf_variant(0.30),
    "conf0.4": _conf_variant(0.40),
    "beam_bp": variant_beam_bp,
    "short_destutter": variant_short_destutter,
    "phonetic": variant_phonetic,
    "merge_sub2s": variant_merge_sub2s,
    "compress": _dsp_variant(dsp_compress),
    "highpass": _dsp_variant(dsp_highpass),
    "maxsym3": lambda m, s, g: _join(postprocess(m.transcribe_bp(np.asarray(b, dtype=np.float32), bp=1.25, max_sym=3)) for b in buffers_concat(s, g)),
    "maxsym5": lambda m, s, g: _join(postprocess(m.transcribe_bp(np.asarray(b, dtype=np.float32), bp=1.25, max_sym=5)) for b in buffers_concat(s, g)),
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
