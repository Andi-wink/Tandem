// F047: Push-to-talk voice command handling (Ctrl+Space).
//
// Wake-word detection has been disabled — it caused commands to fire on any
// speech during recording. Voice commands are push-to-talk only (Ctrl+Space).

import { useState, useEffect, useRef, useCallback } from 'react';

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

  // Push-to-talk hotkey: Ctrl+Space to start, release Space to execute
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip interactive elements only for unmodified keypresses — bare Space has native
      // meaning on buttons/selects/links, but Ctrl+Space is a deliberate hotkey combo
      // that never inserts text, so it should work regardless of focus.
      if (!e.ctrlKey) {
        const target = e.target as HTMLElement;
        const tag = target?.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          tag === 'BUTTON' ||
          tag === 'A' ||
          target?.isContentEditable
        ) return;
      }

      if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.code === 'Space' && !e.repeat && !isListeningRef.current) {
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
    /** Whether listening was triggered by the push-to-talk hotkey (Ctrl+Space) */
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