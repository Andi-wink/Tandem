// F047: Hook for wake word detection and voice command handling.
//
// Listens for 'wake-word-detected' Tauri events from the Rust KWS engine,
// enters "listening" mode, captures the next transcript segments as a voice
// command, parses it into a slash command or AI query, and executes it.

import { useState, useEffect, useRef, useCallback } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

export interface WakeWordEvent {
  confidence: number;
  timestamp: number;
}

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
  const lower = transcript.toLowerCase().trim();

  if (lower.includes('summarize') || lower.includes('summary')) {
    return { transcript, command: 'summarize', args: '' };
  }
  if (lower.includes('action') || lower.includes('next steps') || lower.includes('to do') || lower.includes('todo')) {
    return { transcript, command: 'actions', args: '' };
  }
  if (lower.includes('screenshot') || lower.includes('screen capture')) {
    return { transcript, command: 'screenshot', args: '' };
  }
  if (lower.includes('key points') || lower.includes('highlights')) {
    return { transcript, command: 'key_points', args: '' };
  }
  if (lower.includes('stop') || lower.includes('cancel') || lower.includes('never mind')) {
    return { transcript, command: 'cancel', args: '' };
  }

  // Fallback: treat entire transcript as a free-form AI query
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
  const [lastWakeWord, setLastWakeWord] = useState<WakeWordEvent | null>(null);
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
    if (result.command === 'cancel') { cancelListening(); return; }
    isListeningRef.current = false;
    capturedTextRef.current = '';
    setIsListening(false);
    setCapturedText('');
    clearTimers();
    onCommandRef.current?.(result);
  }, [cancelListening, clearTimers]);

  // Listen for wake-word-detected events from Rust
  useEffect(() => {
    if (!enabled) return;

    let unlisten: UnlistenFn | null = null;
    const abortController = new AbortController();

    const setup = async () => {
      if (abortController.signal.aborted) return;

      unlisten = await listen<WakeWordEvent>('wake-word-detected', (event) => {
        if (abortController.signal.aborted) return;

        console.log('[VoiceCommand] Wake word detected:', event.payload);
        setLastWakeWord(event.payload);
        isListeningRef.current = true;
        capturedTextRef.current = '';
        setIsListening(true);
        setCapturedText('');

        // Safety fallback: cancel after listenTimeout if nothing was captured
        clearTimers();
        timeoutRef.current = setTimeout(() => {
          if (!isListeningRef.current) return;
          const text = capturedTextRef.current.trim();
          if (text) {
            console.log('[VoiceCommand] Fallback timeout — executing with:', text);
            executeCommand(text);
          } else {
            console.log('[VoiceCommand] Listen timeout — no command captured, cancelling');
            cancelListening();
          }
        }, listenTimeout);
      });
    };

    setup();

    return () => {
      abortController.abort();
      unlisten?.();
      clearTimers();
    };
  }, [enabled, listenTimeout, executeCommand, cancelListening, clearTimers]);

  // Push-to-talk hotkey: Alt+Space to start, release Space to execute
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'Space' && !e.repeat && !isListeningRef.current) {
        e.preventDefault();
        console.log('[VoiceCommand] Hotkey pressed — starting push-to-talk');
        isHotkeyListeningRef.current = true;
        isListeningRef.current = true;
        capturedTextRef.current = '';
        setIsHotkeyListening(true);
        setIsListening(true);
        setCapturedText('');
        clearTimers();
        // Safety timeout: auto-cancel after 15s if key somehow stays held
        timeoutRef.current = setTimeout(() => {
          console.log('[VoiceCommand] Hotkey safety timeout — cancelling');
          isHotkeyListeningRef.current = false;
          setIsHotkeyListening(false);
          cancelListening();
        }, 15000);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      // Detect Space release (Ctrl may be released first, so just check Space + active flag)
      if (e.code === 'Space' && isHotkeyListeningRef.current) {
        e.preventDefault();
        console.log('[VoiceCommand] Hotkey released — entering grace period for final transcripts');
        isHotkeyListeningRef.current = false;
        setIsHotkeyListening(false);
        // feedTranscript now runs in activity-timer mode (isHotkeyListeningRef is false).
        // Start a 1.5s grace period: if no new transcripts arrive, execute with what we have.
        // If transcripts DO arrive, feedTranscript will replace this timer with its own 2s timer.
        if (activityTimerRef.current) clearTimeout(activityTimerRef.current);
        activityTimerRef.current = setTimeout(() => {
          if (!isListeningRef.current) return;
          const captured = capturedTextRef.current.trim();
          console.log('[VoiceCommand] Hotkey grace period done — executing with:', captured);
          if (captured) executeCommand(captured);
          else cancelListening();
        }, 1500);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [enabled, executeCommand, cancelListening, clearTimers]);

  return {
    /** Whether the system is currently listening for a voice command */
    isListening,
    /** Whether listening was triggered by the push-to-talk hotkey (Alt+Space) */
    isHotkeyListening,
    /** The last wake word detection event */
    lastWakeWord,
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

      // In hotkey mode the user controls when to stop (key release) — skip the activity timer
      if (!isHotkeyListeningRef.current) {
        // Wake-word mode: execute 2s after last transcript segment (silence detection)
        if (activityTimerRef.current) clearTimeout(activityTimerRef.current);
        activityTimerRef.current = setTimeout(() => {
          if (!isListeningRef.current) return;
          const captured = capturedTextRef.current.trim();
          console.log('[VoiceCommand] Activity silence — executing with:', captured);
          executeCommand(captured);
        }, 2000);
      }
    }, [executeCommand]),
    /** Manually trigger command execution with the currently captured text */
    executeCommand,
    /** Parse a transcript into a voice command (utility, no side effects) */
    parseVoiceCommand,
  };
}