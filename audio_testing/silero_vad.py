"""
Faithful Python port of Tandem's live VAD path:

  silero-rs VadSession  (git emotechlab/silero-rs rev 26a6460, embedded silero_vad.onnx)
    -> frontend/src-tauri/src/audio/vad.rs  ContinuousVadProcessor
    -> frontend/src-tauri/src/audio/pipeline.rs transcription-buffer assembly

The state machine below mirrors VadSession::process / process_internal line-for-line.
The SHIPPED config (VAD_SHIPPED, vad.rs + pipeline.rs as of commit 1d0c869) is:
  positive=0.40, negative=0.20, pre_pad=300ms, post_pad=200ms,
  redemption=800ms (Windows/Linux; 900ms macOS), min_speech=100ms, 30ms frames @ 16kHz.
VAD_CURRENT keeps the pre-1d0c869 values for the ablation/tuning scripts that
compare against them. It is history, not what runs.

Then segments are assembled into transcription buffers like pipeline.rs:
  drop segments <800 samples -> accumulate -> flush at FlushProfile::LOCAL.min_samples
  (192_000 = 12s), or at end of stream
  -> prepend the previous flush's last 1.0s as left context (prepend_overlap).

There is deliberately NO silence-gap flush here; see `assemble_buffers` for why
the Rust's wall-clock gap predicate cannot fire on an offline replay.
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
MIN_TRANSCRIPTION_SAMPLES = 192_000   # FlushProfile::LOCAL.min_samples, 12s @ 16k

# Legacy audio-time gap used by the offline experiment scripts only (see
# `assemble_buffers`). It is NOT a Rust constant and it is NOT what ships:
# nothing in pipeline.rs compares VAD segment timestamps.
LEGACY_AUDIO_GAP_FLUSH_MS = 1200


# pipeline.rs process_stream_vad / flush_remaining_audio drop any completed VAD
# segment shorter than this before it ever reaches a transcription buffer.
MIN_VAD_SEGMENT_SAMPLES = 800


def assemble_buffers(segments, min_samples=MIN_TRANSCRIPTION_SAMPLES,
                     gap_ms=None,
                     min_segment_samples=MIN_VAD_SEGMENT_SAMPLES):
    """Group VAD segments into the chunks Tandem sends to the engine.

    Ports the two partition rules pipeline.rs can reach on an offline replay:
    drop sub-`min_segment_samples` segments (pipeline.rs:1101 / :1239), append
    segment samples to the buffer (:1111), flush at `min_samples`
    (`FlushProfile::LOCAL.min_samples` = 192_000, pipeline.rs:48 reached via the
    `_ =>` arm at :86 and tested at :1125), and flush whatever is left at end of
    stream (`flush_remaining_audio`, :1261).

    NO silence-gap flush, deliberately. pipeline.rs does have a third rule, but
    it cannot fire here:

      * The predicate is at pipeline.rs:1030-1048, inside the `Err(_)` arm of
        `tokio::time::timeout(50ms, receiver.recv())` (:923). It requires the
        audio channel to deliver NOTHING for 50ms, and then asks whether
        `last_activity.elapsed() >= flush_profile.silence_gap_secs` (1.2s),
        where `last_activity` is a wall-clock `Instant` stamped only when a VAD
        segment is appended (:1112). Nothing in pipeline.rs compares VAD
        segment timestamps to each other.
      * Offline, audio is fed to the VAD as fast as the wav can be read, so the
        equivalent channel never idles for 50ms and the wall clock between two
        appends is decode time (milliseconds), never 1.2s. The predicate is
        unreachable and `min_samples` + end-of-stream decide the partition.
      * Live, the same holds for a healthy recording: cpal delivers callbacks
        continuously (no explicit `BufferSize` is set anywhere in `capture/` or
        `devices/`; WASAPI shared-mode default period is ~10ms) and two devices
        feed one channel, so silence still delivers chunks. The gap flush fires
        only when a capture stream actually stalls (device dropout, suspend).

    So this is an approximation of a real-time predicate, not an identity. It
    OVER-estimates buffer length (and therefore decode context) whenever a
    capture stream really does stall mid-recording, and correspondingly
    UNDER-estimates the number of flushes, hence the number of overlap replays
    and dedupe events, in that same case. It is exact for any recording whose
    capture streams never stall, which is the normal case and the only case an
    offline replay can represent.

    `gap_ms` is retained for the offline experiment scripts (experiments.py)
    that swept an audio-time gap. Passing it selects that historical,
    NON-SHIPPED partition rule; the default None is the shipped behaviour.
    """
    buffers = []
    buf = []
    last_end_ms = None
    for (start_ms, end_ms, samples) in segments:
        if len(samples) < min_segment_samples:
            continue
        if gap_ms is not None and buf and last_end_ms is not None \
                and (start_ms - last_end_ms) >= gap_ms:
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


# ── left-context overlap on flush (pipeline.rs flush_transcription_buffer) ──
# PipelineManager::TRANSCRIPTION_OVERLAP_SAMPLES = 16000 (1.0s @ 16k), added by
# commit 1d0c869 (2026-06-03) and applied on EVERY flush regardless of profile.
TRANSCRIPTION_OVERLAP_SAMPLES = 16000


def prepend_overlap(buffers, overlap_samples=TRANSCRIPTION_OVERLAP_SAMPLES):
    """Port of `flush_transcription_buffer`'s left-context overlap.

    For each flushed buffer the Rust:
      1. computes `new_tail` = last `overlap_samples` of THIS buffer, taken
         BEFORE anything is prepended (or the whole buffer when it is not
         longer than `overlap_samples`);
      2. prepends the PREVIOUS flush's tail to the buffer, if there is one;
      3. stores `new_tail` for the next flush.

    Returns a list of `(chunk_samples, overlap_len)`, where `overlap_len` is the
    number of leading samples that are replayed context (`AudioChunk.overlap_samples`).
    The first chunk always has `overlap_len == 0` (no previous tail exists).

    Step 1 running before step 2 is load-bearing: the tail must come from the raw
    buffer, never from the already-overlapped chunk, otherwise a short buffer
    would replay the previous buffer's audio a second time.
    """
    out = []
    prev_tail = []
    for data in buffers:
        data = list(data)
        if overlap_samples > 0 and len(data) > overlap_samples:
            new_tail = data[-overlap_samples:]
        else:
            new_tail = list(data)
        if overlap_samples > 0 and prev_tail:
            chunk = prev_tail + data
            overlap_len = len(prev_tail)
        else:
            chunk = data
            overlap_len = 0
        prev_tail = new_tail
        out.append((chunk, overlap_len))
    return out


# HISTORICAL default: vad.rs as it stood before commit 1d0c869 (2026-06-03).
# Kept because the ablation/tuning scripts compare against it; it is NOT what
# ships. Use VAD_SHIPPED for anything that claims to measure the live pipeline.
VAD_CURRENT = dict(positive=0.50, negative=0.35, pre_pad_ms=300, post_pad_ms=200,
                   redemption_ms=400, min_speech_ms=250)

# The config the app actually runs, as of commit 1d0c869 (2026-06-03):
#   vad.rs ContinuousVadProcessor::new  -> positive .40 / negative .20 /
#                                          pre 300ms / post 200ms / min_speech 100ms
#   pipeline.rs `redemption_time`       -> 800ms on Windows/Linux (900ms on macOS)
# test_shipped_config.py re-reads all six numbers out of the Rust at test time.
VAD_SHIPPED = dict(positive=0.40, negative=0.20, pre_pad_ms=300, post_pad_ms=200,
                   redemption_ms=800, min_speech_ms=100)


def vad_segments_for_clip(samples_16k, vad_cfg=None):
    cfg = dict(VAD_CURRENT)
    if vad_cfg:
        cfg.update(vad_cfg)
    vad = SileroVad(**cfg)
    segs = vad.process(samples_16k)
    segs += vad.finish()
    return segs
