// F018: Hook managing slash command state, live transcript capture, and message building

import { useState, useRef, useCallback, useMemo } from 'react';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { SlashCommand, matchCommands, expandTemplate, parseCommandInput } from '@/lib/slashCommands';
import { ContextBasketItem } from '@/contexts/ClaudeContext';

export interface SlashCommandState {
  /** The currently active (selected) command, or null if none */
  activeCommand: SlashCommand | null;
  /** Whether the autocomplete dropdown should be visible */
  showAutocomplete: boolean;
  /** Filtered commands matching the current input */
  filteredCommands: SlashCommand[];
  /** Index of the highlighted item in the autocomplete dropdown */
  selectedIndex: number;
  /** Number of transcript segments captured since command activation */
  capturedSegmentCount: number;
}

export interface SlashCommandActions {
  /** Called on every input change to detect "/" and filter commands */
  handleInputForCommands: (value: string) => void;
  /** Select a command from the autocomplete dropdown */
  activateCommand: (cmd: SlashCommand) => string;
  /** Cancel the active command and reset state */
  cancelCommand: () => void;
  /** Move selection up in autocomplete */
  selectPrev: () => void;
  /** Move selection down in autocomplete */
  selectNext: () => void;
  /** Get the currently highlighted command (if any) */
  getSelectedCommand: () => SlashCommand | undefined;
  /** Build the final message + basket item when Enter is pressed with an active command */
  buildCommandMessage: (inputText: string) => {
    message: string;
    capturedBasketItem: ContextBasketItem | null;
  };
  /** Dismiss the autocomplete without canceling an active command */
  dismissAutocomplete: () => void;
}

export function useSlashCommand(): SlashCommandState & SlashCommandActions {
  const { transcripts } = useTranscripts();

  const [activeCommand, setActiveCommand] = useState<SlashCommand | null>(null);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Snapshot of transcripts.length at the moment a command is activated
  const captureStartIndexRef = useRef<number | null>(null);

  // Derived: segments captured since command activation
  const capturedSegmentCount = useMemo(() => {
    if (activeCommand === null || captureStartIndexRef.current === null) return 0;
    return Math.max(0, transcripts.length - captureStartIndexRef.current);
  }, [activeCommand, transcripts.length]);

  const handleInputForCommands = useCallback((value: string) => {
    // Only show autocomplete when input starts with "/" and no command is active yet
    if (!activeCommand && value.startsWith('/')) {
      const matches = matchCommands(value);
      setFilteredCommands(matches);
      setShowAutocomplete(matches.length > 0);
      setSelectedIndex(0);
    } else if (!activeCommand) {
      setShowAutocomplete(false);
      setFilteredCommands([]);
    }
    // When a command is active, autocomplete stays hidden (user is typing args)
  }, [activeCommand]);

  const activateCommand = useCallback((cmd: SlashCommand): string => {
    setActiveCommand(cmd);
    setShowAutocomplete(false);
    setFilteredCommands([]);
    setSelectedIndex(0);
    // Snapshot the current transcript length as the capture start point
    captureStartIndexRef.current = transcripts.length;
    // Return the new input text to set in the textarea
    return `/${cmd.name} `;
  }, [transcripts.length]);

  const cancelCommand = useCallback(() => {
    setActiveCommand(null);
    setShowAutocomplete(false);
    setFilteredCommands([]);
    setSelectedIndex(0);
    captureStartIndexRef.current = null;
  }, []);

  const selectPrev = useCallback(() => {
    setSelectedIndex(prev => Math.max(0, prev - 1));
  }, []);

  const selectNext = useCallback(() => {
    setSelectedIndex(prev => Math.min(filteredCommands.length - 1, prev + 1));
  }, [filteredCommands.length]);

  const getSelectedCommand = useCallback(() => {
    return filteredCommands[selectedIndex];
  }, [filteredCommands, selectedIndex]);

  const dismissAutocomplete = useCallback(() => {
    setShowAutocomplete(false);
  }, []);

  const buildCommandMessage = useCallback((inputText: string): {
    message: string;
    capturedBasketItem: ContextBasketItem | null;
  } => {
    if (!activeCommand) {
      return { message: inputText, capturedBasketItem: null };
    }

    // Extract user input (everything after "/commandname ")
    const parsed = parseCommandInput(inputText);
    const userInput = parsed?.userInput || '';

    // Gather transcript segments: captured window first, fall back to all transcripts
    const startIdx = captureStartIndexRef.current ?? transcripts.length;
    const capturedSegments = transcripts.slice(startIdx);
    // If no new segments arrived since activation, use all available transcript as context
    const segmentsToUse = capturedSegments.length > 0 ? capturedSegments : transcripts;
    const capturedText = segmentsToUse.map(s => {
      const time = s.audio_start_time !== undefined
        ? `[${formatSecs(s.audio_start_time)}]`
        : `[${s.timestamp}]`;
      return `${time} ${s.text}`;
    }).join('\n');

    // Expand the prompt template
    const message = expandTemplate(activeCommand, capturedText, userInput);

    // Create a basket item for the captured transcript (if any segments were used)
    let capturedBasketItem: ContextBasketItem | null = null;
    if (segmentsToUse.length > 0) {
      const label = capturedSegments.length > 0
        ? `/${activeCommand.name} capture (${capturedSegments.length} new segments)`
        : `/${activeCommand.name} context (${segmentsToUse.length} segments)`;
      capturedBasketItem = {
        id: `slash-capture-${Date.now()}`,
        type: 'transcript_chunk',
        label,
        preview: capturedText.slice(0, 80) + (capturedText.length > 80 ? '...' : ''),
        fullContent: capturedText,
        timestamp: segmentsToUse[0]?.audio_start_time,
      };
    }

    return { message, capturedBasketItem };
  }, [activeCommand, transcripts]);

  return {
    activeCommand,
    showAutocomplete,
    filteredCommands,
    selectedIndex,
    capturedSegmentCount,
    handleInputForCommands,
    activateCommand,
    cancelCommand,
    selectPrev,
    selectNext,
    getSelectedCommand,
    buildCommandMessage,
    dismissAutocomplete,
  };
}

function formatSecs(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}
