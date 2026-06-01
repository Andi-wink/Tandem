"""
Faithful Python port of Tandem's live VAD path:

  silero-rs VadSession  (git emotechlab/silero-rs rev 26a6460, embedded silero_vad.onnx)
    -> frontend/src-tauri/src/audio/vad.rs  ContinuousVadProcessor
    -> frontend/src-tauri/src/audio/pipeline.rs transcription-buffer assembly

The state machine below mirrors VadSession::process / process_internal line-for-line,
with Tandem's config (vad.rs):
  positive=0.50, negative=0.35, pre_pad=300ms, post_pad=200ms,
  redemption=400ms (Windows), min_speech=250ms, 30ms frames @ 16kHz.

Then segments are assembled into transcription buffers exactly like pipeline.rs:
  accumulate VAD speech segments -> flush at >=1.5s (MIN_TRANSCRIPTION_SAMPLES=24000)
  or after a >=1.2s silence gap (SILENCE_GAP_FLUSH_SECS).
"""

from pathlib import Path

import numpy as np
import onnxruntime as ort

SILERO_ONNX = Path(
    r"C:\Users\andre\.cargo\git\checkouts\silero-rs-16a8cd672fe824c4\26a6460\models\silero_vad.onnx"
)

SR = 16000
MS = SR // 1000            # samples per ms = 16
FRAME = int(0.030 * SR)    # 480 samples (30ms)


class SileroVad:
    """Port of silero-rs VadSession (v4: input, sr, h, c -> output, hn, cn)."""

    def __init__(self, positive=0.50, negative=0.35, pre_pad_ms=300,
                 post_pad_ms=200, redemption_ms=400, min_speech_ms=250):
        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL  # Level3
        so.intra_op_num_threads = 4
        self.sess = ort.InferenceSession(str(SILERO_ONNX), so,
                                         providers=["CPUExecutionProvider"])
        self.pos = positive
        self.neg = negative
        self.pre = pre_pad_ms
        self.post = post_pad_ms
        self.redemption = redemption_ms
        self.min_speech = min_speech_ms

        self._reset_states()
        self.session_audio = []          # raw samples (front-drained as segments complete)
        self.processed_samples = 0
        self.deleted_samples = 0
        self.silent_samples = 0
        self.speech_start_ms = None
        # state: None == Silence, else dict(start_ms, redemption_passed, speech_time_ms)
        self.state = None

    def _reset_states(self):
        self.h = np.zeros((2, 1, 64), dtype=np.float32)
        self.c = np.zeros((2, 1, 64), dtype=np.float32)
        self.sr_t = np.array([SR], dtype=np.int64)

    def _forward(self, frame):
        x = np.asarray(frame, dtype=np.float32).reshape(1, -1)
        out, hn, cn = self.sess.run(
            ["output", "hn", "cn"],
            {"input": x, "sr": self.sr_t, "h": self.h, "c": self.c},
        )
        self.h, self.c = hn, cn
        return float(np.asarray(out).reshape(-1)[0])

    def _dur_to_index(self, ms):
        return ms * MS - self.deleted_samples

    def _get_speech(self, start_ms, end_ms):
        s = self._dur_to_index(start_ms)
        if end_ms is None:
            return list(self.session_audio[s:])
        e = self._dur_to_index(end_ms)
        return list(self.session_audio[s:e])

    def process(self, audio):
        """Feed mono 16k samples; return list of (start_ms, end_ms, samples)."""
        segs = []
        unprocessed = self.deleted_samples + len(self.session_audio) - self.processed_samples
        num_chunks = (unprocessed + len(audio)) // FRAME
        self.session_audio.extend(np.asarray(audio, dtype=np.float32).tolist())

        for _ in range(num_chunks):
            lo = self.processed_samples - self.deleted_samples
            hi = lo + FRAME
            frame = self.session_audio[lo:hi]
            seg = self._process_internal(frame)
            if seg is not None:
                segs.append(seg)
        return segs

    def _process_internal(self, frame):
        samples = len(frame)
        frame_ms = samples // MS
        prob = self._forward(frame)

        if prob < self.neg:
            self.silent_samples += samples
        else:
            self.silent_samples = 0

        current_silence_ms = self.silent_samples // MS
        seg = None

        if self.state is None:  # Silence
            if prob > self.pos:
                start_ms = max(0, self.processed_samples // MS - self.pre)
                self.state = {"start_ms": start_ms, "redemption_passed": False,
                              "speech_time_ms": 0}
        else:  # Speech
            st = self.state
            st["speech_time_ms"] += frame_ms
            if (not st["redemption_passed"]) and st["speech_time_ms"] > self.min_speech:
                st["redemption_passed"] = True
                self.speech_start_ms = st["start_ms"]
                # (SpeechStart emitted here in Rust; we only need SpeechEnd segments)

            if prob < self.neg:
                if not st["redemption_passed"]:
                    self.state = None  # too short, abort
                elif current_silence_ms > self.redemption:
                    speech_end_ms = (self.processed_samples + samples - self.silent_samples) // MS
                    speech_end_pad_ms = speech_end_ms + self.post
                    samples_out = self._get_speech(st["start_ms"], speech_end_pad_ms)
                    seg = (st["start_ms"], speech_end_pad_ms, samples_out)
                    # drain consumed audio from buffer front
                    end_idx = self._dur_to_index(speech_end_ms)
                    del self.session_audio[: end_idx + 1]
                    self.deleted_samples += end_idx + 1
                    self.speech_start_ms = None
                    self.state = None

        self.processed_samples += samples
        return seg

    def finish(self):
        """Force-end ongoing speech at end of stream (ContinuousVadProcessor::flush)."""
        if self.state is not None and self.state["redemption_passed"] \
                and self.speech_start_ms is not None:
            start_ms = self.speech_start_ms
            end_ms = self.processed_samples // MS
            samples_out = self._get_speech(start_ms, None)
            self.speech_start_ms = None
            self.state = None
            if samples_out:
                return [(start_ms, end_ms, samples_out)]
        return []


# ── transcription-buffer assembly (pipeline.rs) ──
MIN_TRANSCRIPTION_SAMPLES = 24000   # 1.5s @ 16k
SILENCE_GAP_FLUSH_MS = 1200         # SILENCE_GAP_FLUSH_SECS


def assemble_buffers(segments, min_samples=MIN_TRANSCRIPTION_SAMPLES,
                     gap_ms=SILENCE_GAP_FLUSH_MS):
    """Group VAD segments into the chunks Tandem actually sends to the engine.

    Mirrors pipeline.rs: append segment samples to a buffer; flush when the
    buffer reaches min_samples, or when the (audio-time) gap to the next segment
    exceeds the silence-flush window. #5 raises min_samples for more context.
    """
    buffers = []
    buf = []
    last_end_ms = None
    for (start_ms, end_ms, samples) in segments:
        if buf and last_end_ms is not None and (start_ms - last_end_ms) >= gap_ms:
            buffers.append(buf)
            buf = []
        buf.extend(samples)
        last_end_ms = end_ms
        if len(buf) >= min_samples:
            buffers.append(buf)
            buf = []
    if buf:
        buffers.append(buf)
    return buffers


# Default config mirrors current vad.rs (Windows redemption 400ms).
VAD_CURRENT = dict(positive=0.50, negative=0.35, pre_pad_ms=300, post_pad_ms=200,
                   redemption_ms=400, min_speech_ms=250)


def vad_segments_for_clip(samples_16k, vad_cfg=None):
    cfg = dict(VAD_CURRENT)
    if vad_cfg:
        cfg.update(vad_cfg)
    vad = SileroVad(**cfg)
    segs = vad.process(samples_16k)
    segs += vad.finish()
    return segs
