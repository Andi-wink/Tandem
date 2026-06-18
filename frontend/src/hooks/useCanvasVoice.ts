'use client';

/**
 * useCanvasVoice — push-to-talk voice control for the canvas (global hotkey Alt+Shift+A).
 *
 * The Rust shell registers Alt+Shift+A as a GLOBAL shortcut (works while Tandem is backgrounded) and
 * emits `canvas-voice-start` on press and `canvas-voice-stop` on release. This hook:
 *   1. captures a short mic clip in the renderer while the key is held (raw PCM via Web Audio),
 *   2. on release, transcribes it with a FAST dedicated STT (`canvas_transcribe_clip`, the configured
 *      provider) — independent of the laggy ~30s note transcript,
 *   3. optionally prepends the rolling transcript window as CONTEXT (so "build the last discussed
 *      automation" resolves) — gated behind an explicit privacy opt-in,
 *   4. sends the composed instruction to the canvas agent (which draws / edits / streams).
 *
 * Returns `{ listening }` so a small indicator can show the user we're capturing audio.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { useCanvas } from '@/contexts/CanvasContext';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { getRecentTranscripts } from '@/services/handoffService';
import { logger } from '@/lib/logger';

/** How much of the rolling transcript (seconds) to attach as context when opted in. */
const CONTEXT_WINDOW_SECS = 300;
const TARGET_SAMPLE_RATE = 16000;

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Linear-resample mono Float32 PCM to 16 kHz (good enough for STT, dependency-free). */
function resampleTo16k(input: Float32Array, inRate: number): Float32Array {
  if (inRate === TARGET_SAMPLE_RATE || input.length === 0) return input;
  const ratio = inRate / TARGET_SAMPLE_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = idx - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

interface Capture {
  stream: MediaStream;
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  chunks: Float32Array[];
}

export function useCanvasVoice() {
  const { sendPrompt, transcriptOptIn } = useCanvas();
  const { transcripts } = useTranscripts();

  const [listening, setListening] = useState(false);
  const captureRef = useRef<Capture | null>(null);
  const startingRef = useRef(false);
  const transcriptsRef = useRef(transcripts);
  transcriptsRef.current = transcripts;
  const optInRef = useRef(transcriptOptIn);
  optInRef.current = transcriptOptIn;

  const teardown = useCallback((): { samples: Float32Array; sampleRate: number } | null => {
    const cap = captureRef.current;
    captureRef.current = null;
    setListening(false);
    if (!cap) return null;
    try {
      cap.processor.disconnect();
      cap.source.disconnect();
    } catch {
      /* ignore */
    }
    const sampleRate = cap.ctx.sampleRate;
    cap.stream.getTracks().forEach((t) => t.stop());
    void cap.ctx.close().catch(() => {});
    const total = cap.chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of cap.chunks) {
      merged.set(c, off);
      off += c.length;
    }
    return { samples: merged, sampleRate };
  }, []);

  const startCapture = useCallback(async () => {
    if (captureRef.current || startingRef.current) return;
    startingRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      const AC: typeof AudioContext =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      processor.onaudioprocess = (e) => {
        chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(ctx.destination);
      captureRef.current = { stream, ctx, source, processor, chunks };
      setListening(true);
    } catch (e) {
      logger.error('[CanvasVoice] mic capture failed', e);
      // Distinguish "another app/the recorder holds the mic" from "permission denied" so the user
      // knows what to do (the recording pipeline + this capture share the device under WASAPI).
      const name = e instanceof DOMException ? e.name : '';
      if (name === 'NotReadableError' || name === 'AbortError') {
        toast.error('Canvas voice: the microphone is in use by another app and could not be shared.');
      } else if (name === 'NotAllowedError' || name === 'SecurityError') {
        toast.error('Canvas voice: microphone permission denied.');
      } else {
        toast.error('Canvas voice: could not access the microphone.');
      }
    } finally {
      startingRef.current = false;
    }
  }, []);

  const stopAndSend = useCallback(async () => {
    const captured = teardown();
    if (!captured || captured.samples.length === 0) return;

    const pcm16k = resampleTo16k(captured.samples, captured.sampleRate);
    // Ignore sub-300ms clips — almost certainly an accidental tap, not a command.
    if (pcm16k.length < TARGET_SAMPLE_RATE * 0.3) return;

    let instruction = '';
    try {
      instruction = await invoke<string>('canvas_transcribe_clip', {
        samples: Array.from(pcm16k),
        language: null,
      });
    } catch (e) {
      logger.error('[CanvasVoice] transcription failed', e);
      toast.error('Canvas voice: transcription failed.');
      return;
    }

    instruction = instruction.trim();
    if (!instruction) {
      toast.warning("Canvas voice: couldn't make out a command.");
      return;
    }

    // Compose: optional rolling-transcript context + the spoken instruction.
    let message = instruction;
    if (optInRef.current) {
      const ctxText = getRecentTranscripts(transcriptsRef.current, CONTEXT_WINDOW_SECS)
        .map((t) => t.text)
        .join(' ')
        .trim();
      if (ctxText) {
        message = `Context from the call so far:\n${ctxText}\n\nNow do this on the canvas: ${instruction}`;
      }
    }

    toast.info(`Canvas: "${instruction.slice(0, 60)}${instruction.length > 60 ? '…' : ''}"`);
    await sendPrompt(message);
  }, [teardown, sendPrompt]);

  useEffect(() => {
    if (!inTauri()) return;
    let cancelled = false;
    const unlistens: UnlistenFn[] = [];

    listen('canvas-voice-start', () => {
      void startCapture();
    }).then((fn) => (cancelled ? fn() : unlistens.push(fn)));

    listen('canvas-voice-stop', () => {
      void stopAndSend();
    }).then((fn) => (cancelled ? fn() : unlistens.push(fn)));

    return () => {
      cancelled = true;
      unlistens.forEach((fn) => fn());
      // Stop any in-flight capture on unmount.
      const cap = captureRef.current;
      if (cap) {
        try {
          cap.processor.disconnect();
          cap.source.disconnect();
          cap.stream.getTracks().forEach((t) => t.stop());
          void cap.ctx.close().catch(() => {});
        } catch {
          /* ignore */
        }
        captureRef.current = null;
      }
    };
  }, [startCapture, stopAndSend]);

  return { listening };
}
