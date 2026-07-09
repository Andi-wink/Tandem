// F047: Push-to-talk voice command handling (Alt+Shift+Q).
//
// Wake-word detection has been disabled — it caused commands to fire on any
// speech during recording. Voice commands are push-to-talk only (Alt+Shift+Q).
//
// Uses the OS-level Tauri global-shortcut plugin (registered in lib.rs) rather than webview
// keydown/keyup — the previous Ctrl+Space binding was a webview-level listener, and Windows can
// intercept Ctrl+Space as an IME toggle and swallow the key-up before the webview ever sees it,
// leaving the hotkey stuck in "listening" forever. The global shortcut fires reliably regardless
// of focus/IME state.

import { useState, useEffect, useRef, useCallback } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface VoiceCommandResult {
  /** The raw transcript text captured after wake word */
  transcript: string;
  /** Parsed command name (e.g. 'summarize', 'actions', 'ask') */
  command: string;
  /** Arguments for the command */
  args: string;
}

export interface UseVoiceCommandOptions {
  /** Whether voice commands are enabled (default: true) */
  enabled?: boolean;
  /** Timeout in ms to auto-cancel listening if no command heard (default: 5000) */
  listenTimeout?: number;
  /** Callback when a voice command is parsed and ready to execute */
  onCommand?: (result: VoiceCommandResult) => void;
}

/**
 * Parse a voice transcript into a command + args.
 * Returns a recognized slash command or falls back to a free-form AI query.
 */
export function parseVoiceCommand(transcript: string): VoiceCommandResult {
  // Always send as a free-form AI query. The AI is much better at understanding
  // intent ("summarize", "action items", etc.) than fragile keyword matching,
  // which previously caused false positives — e.g. "stop" or "cancel" appearing
  // anywhere in normal speech would silently discard the entire command.
  return { transcript, command: 'ask', args: transcript };
}

export function useVoiceCommand(options: UseVoiceCommandOptions = {}) {
  const {
    enabled = true,
    listenTimeout = 5000,
    onCommand,
  } = options;

  const [isListening, setIsListening] = useState(false);
  const [isHotkeyListening, setIsHotkeyListening] = useState(false);
  const [capturedText, setCapturedText] = useState('');

  // Refs to avoid stale closures in timer callbacks
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const capturedTextRef = useRef('');
  const isListeningRef = useRef(false);
  const isHotkeyListeningRef = useRef(false);
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;

  const clearTimers = useCallback(() => {
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    if (activityTimerRef.current) { clearTimeout(activityTimerRef.current); activityTimerRef.current = null; }
  }, []);

  // Cancel listening and reset state
  const cancelListening = useCallback(() => {
    isListeningRef.current = false;
    isHotkeyListeningRef.current = false;
    capturedTextRef.current = '';
    setIsListening(false);
    setIsHotkeyListening(false);
    setCapturedText('');
    clearTimers();
  }, [clearTimers]);

  // Process the captured text as a voice command
  const executeCommand = useCallback((text: string) => {
    if (!text.trim()) { cancelListening(); return; }
    const result = parseVoiceCommand(text);
    console.log('[VoiceCommand] Executing command:', result.command, '— text:', text.slice(0, 80));
    isListeningRef.current = false;
    capturedTextRef.current = '';
    setIsListening(false);
    setCapturedText('');
    clearTimers();
    onCommandRef.current?.(result);
  }, [cancelListening, clearTimers]);

  // Push-to-talk hotkey: hold Alt+Shift+Q to start, release to execute.
  useEffect(() => {
    if (!enabled || !inTauri()) return;
    let cancelled = false;
    const unlistens: UnlistenFn[] = [];

    const handlePressed = () => {
      if (isListeningRef.current) return; // already listening — ignore a duplicate Pressed
      console.log('[VoiceCommand] Hotkey pressed — starting push-to-talk');
      isHotkeyListeningRef.current = true;
      isListeningRef.current = true;
      capturedTextRef.current = '';
      setIsHotkeyListening(true);
      setIsListening(true);
      setCapturedText('');
      clearTimers();
      // Safety net: if the release is never detected (e.g. the app loses focus without a
      // matching Released event), don't sit there forever — after 15s, send whatever was
      // captured instead of silently discarding it.
      timeoutRef.current = setTimeout(() => {
        console.log('[VoiceCommand] Hotkey safety timeout — finishing with whatever was captured');
        isHotkeyListeningRef.current = false;
        setIsHotkeyListening(false);
        const captured = capturedTextRef.current.trim();
        if (captured) executeCommand(captured);
        else cancelListening();
      }, 15000);
    };

    const handleReleased = () => {
      if (!isHotkeyListeningRef.current) return;
      console.log('[VoiceCommand] Hotkey released — entering grace period for final transcripts');
      isHotkeyListeningRef.current = false;
      setIsHotkeyListening(false);
      // feedTranscript now runs in activity-timer mode (isHotkeyListeningRef is false).
      // Use a longer grace period when no text has been captured yet, because Whisper
      // transcription has significant latency (3-10s). If some text was already captured,
      // a shorter wait suffices. Once transcripts start arriving, feedTranscript's own
      // 2s activity timer takes over.
      if (activityTimerRef.current) clearTimeout(activityTimerRef.current);
      const hasCapturedText = capturedTextRef.current.trim().length > 0;
      const graceMs = hasCapturedText ? 1500 : 8000;
      activityTimerRef.current = setTimeout(() => {
        if (!isListeningRef.current) return;
        const captured = capturedTextRef.current.trim();
        console.log('[VoiceCommand] Hotkey grace period done — executing with:', captured);
        if (captured) executeCommand(captured);
        else cancelListening();
      }, graceMs);
    };

    listen('voice-command-start', handlePressed).then((fn) => (cancelled ? fn() : unlistens.push(fn)));
    listen('voice-command-stop', handleReleased).then((fn) => (cancelled ? fn() : unlistens.push(fn)));

    return () => {
      cancelled = true;
      unlistens.forEach((fn) => fn());
      // If this effect tears down (enabled flipped false, e.g. recording stopped) while a hotkey
      // hold was in flight, the listeners above go away with it — reset state instead of leaving
      // isListening/isHotkeyListening stuck true with nothing left to ever clear them.
      if (isHotkeyListeningRef.current || isListeningRef.current) cancelListening();
    };
  }, [enabled, executeCommand, cancelListening, clearTimers]);

  return {
    /** Whether the system is currently listening for a voice command */
    isListening,
    /** Whether listening was triggered by the push-to-talk hotkey (Alt+Shift+Q) */
    isHotkeyListening,
    /** Text captured so far while listening */
    capturedText,
    /** Manually cancel listening mode */
    cancelListening,
    /** Feed transcript text to the voice command system (call when new transcript arrives while listening) */
    feedTranscript: useCallback((text: string) => {
      if (!isListeningRef.current) return;

      // Append raw text — no stripping. The AI prompt instructs Claude to ignore wake word prefixes.
      const updated = capturedTextRef.current ? `${capturedTextRef.current} ${text}` : text;
      capturedTextRef.current = updated;
      setCapturedText(updated);

      // In hotkey mode the user controls when to stop (key release).
      // The grace-period timer in handleKeyUp handles execution after release.
    }, [executeCommand]),
    /** Manually trigger command execution with the currently captured text */
    executeCommand,
    /** Parse a transcript into a voice command (utility, no side effects) */
    parseVoiceCommand,
  };
}