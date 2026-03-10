import React, { useState, useRef, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X, Send, Trash2, AlertCircle, Square, ChevronUp, Check, Shield, Paperclip, Mic, FolderOpen } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { useClaude, MODEL_OPTIONS } from '@/contexts/ClaudeContext';
import { ContextBasket } from './ContextBasket';
import { ConversationView } from './ConversationView';
import { ProjectDirModal } from './ProjectDirModal';
import { EntityMapViewer } from './EntityMapViewer';
import { SlashCommandAutocomplete } from './SlashCommandAutocomplete';
import { useDropZone, useDragActive } from '@/hooks/useDragAndDrop';
import { useSelection } from '@/contexts/SelectionContext';
import { useSlashCommand } from '@/hooks/useSlashCommand';
import { useVoiceCommand, VoiceCommandResult } from '@/hooks/useVoiceCommand';
import { TEXTAREA_MAX_HEIGHT_PX } from '@/lib/constants';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { parseDocument, isSupportedDocument } from '@/services/claudeService';
import type { ContextBasketItem } from '@/contexts/ContextBasketContext';

export function ClaudePanel() {
  const {
    isPanelOpen,
    isStreaming,
    sessionId,
    projectDir,
    meetingId,
    meetingTitle,
    conversation,
    contextBasket,
    apiKey,
    closePanel,
    addToBasket,
    removeFromBasket,
    clearBasket,
    sendMessage,
    clearSession,
    cancelStream,
    openPanel,
    selectedModel,
    setModel,
    anonymizationEnabled,
    entityMap,
    toggleAnonymization,
    toggleItemAnonymization,
    clearEntityMap,
    piiAvailable,
    updateMeetingTitle,
    panelWidth,
    setPanelWidth,
  } = useClaude();

  const [inputText, setInputText] = useState('');
  const [isResizing, setIsResizing] = useState(false);
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [pendingFirstMessage, setPendingFirstMessage] = useState<string | null>(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editingTitleValue, setEditingTitleValue] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;

  const hasApiKey = !!apiKey;
  const isDragActive = useDragActive();
  const { clearSelection } = useSelection();
  const dragListenersRef = useRef<{ move: (e: MouseEvent) => void; up: () => void } | null>(null);

  // ── Resize drag handler ──────────────────────────────────────────────────
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);

    const onMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = window.innerWidth - moveEvent.clientX;
      setPanelWidth(newWidth); // clamping happens inside setPanelWidth
    };

    const onMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      dragListenersRef.current = null;
    };

    dragListenersRef.current = { move: onMouseMove, up: onMouseUp };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [setPanelWidth]);

  // Clean up drag listeners on unmount (if mid-drag when panel closes)
  useEffect(() => {
    return () => {
      if (dragListenersRef.current) {
        document.removeEventListener('mousemove', dragListenersRef.current.move);
        document.removeEventListener('mouseup', dragListenersRef.current.up);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        dragListenersRef.current = null;
      }
    };
  }, []);
  const { setCurrentMeeting, setMeetings, meetings: sidebarMeetings } = useSidebar();

  // Title editing handlers
  const handleTitleDoubleClick = () => {
    setEditingTitleValue(meetingTitle || '');
    setIsEditingTitle(true);
    setTimeout(() => titleInputRef.current?.select(), 0);
  };

  const handleTitleSave = async () => {
    setIsEditingTitle(false);
    const newTitle = editingTitleValue.trim();
    if (!newTitle || newTitle === meetingTitle || !meetingId) return;
    updateMeetingTitle(newTitle);
    try {
      await invoke('api_save_meeting_title', { meetingId, title: newTitle });
      const updated = sidebarMeetings.map(m => m.id === meetingId ? { ...m, title: newTitle } : m);
      setMeetings(updated);
      setCurrentMeeting({ id: meetingId, title: newTitle });
    } catch (err) {
      console.error('Failed to save meeting title:', err);
      toast.error('Failed to save meeting title');
    }
  };
  const { isOver: isDropOver, dropHandlers: overlayDropHandlers } = useDropZone(addToBasket, clearSelection);
  const recordingState = useRecordingState();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isParsingFile, setIsParsingFile] = useState(false);

  // F044: Handle file selection (from button or OS drop)
  const handleFileUpload = async (file: File) => {
    if (!isSupportedDocument(file.name)) {
      toast.error(`Unsupported file type. Supported: PDF, DOCX, TXT, MD, CSV`);
      return;
    }
    setIsParsingFile(true);
    try {
      const result = await parseDocument(file);
      const pageInfo = result.pages ? ` (${result.pages} pages)` : '';
      const item: ContextBasketItem = {
        id: `doc-${Date.now()}-${file.name}`,
        type: 'document',
        label: result.filename,
        preview: `${result.format}${pageInfo} — ${result.preview.slice(0, 60)}`,
        fullContent: `[Document: ${result.filename}]\nFormat: ${result.format}${pageInfo}\n\n${result.text}`,
      };
      addToBasket(item);
      toast.success(`Added "${result.filename}" to context`);
    } catch (err) {
      toast.error(`Failed to parse "${file.name}": ${(err as Error).message}`);
    } finally {
      setIsParsingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // F044: Handle OS file drops on the panel
  const handleFileDrop = (e: React.DragEvent) => {
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    for (let i = 0; i < files.length; i++) {
      handleFileUpload(files[i]);
    }
  };

  // F018: Slash command state
  const {
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
  } = useSlashCommand();

  // F047: Voice command handler — sends captured speech to the AI panel.
  // Uses the same pendingFirstMessage pattern as manual sends to avoid
  // the race condition where openPanel's setState hasn't propagated to
  // stateRef.current before sendMessage reads it.
  const handleVoiceCommand = React.useCallback(async (result: VoiceCommandResult) => {
    const message = result.args || result.transcript;
    if (!message?.trim()) {
      toast.warning('Voice command not recognized — no text was captured');
      return;
    }
    if (isStreaming) {
      toast.warning('AI is busy — please wait for the current response to finish');
      return;
    }

    console.log('[VoiceCommand] handleVoiceCommand — message:', message.slice(0, 80));

    try {
      // Ensure the panel is open with meeting context
      if (!projectDir || !meetingId || !isPanelOpen) {
        let folder = projectDir || '';
        if (!folder) {
          try { folder = await invoke<string | null>('get_meeting_folder_path') || ''; } catch { /* ok */ }
        }
        await openPanel(meetingId || 'live-recording', meetingTitle || 'Live Recording', folder);
        // Use pendingFirstMessage so the send waits for state to propagate
        setPendingFirstMessage(message);
        return;
      }
      await sendMessage(message);
    } catch (err) {
      console.error('Voice command failed:', err);
      toast.error('Voice command failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  }, [isStreaming, sendMessage, openPanel, isPanelOpen, meetingId, meetingTitle, projectDir]);

  const { isListening, isHotkeyListening, cancelListening, feedTranscript, capturedText: voiceCapturedText } = useVoiceCommand({
    enabled: recordingState.isRecording,
    onCommand: handleVoiceCommand,
  });

  // F047: Feed new transcript segments into voice command capture while listening
  const { transcripts } = useTranscripts();
  const lastFedTranscriptIdRef = useRef<string | null>(null);
  const prevIsListeningRef = useRef(false);

  // Snapshot the current latest transcript as "already seen" when listening starts,
  // so we never retroactively feed transcripts that arrived before the user triggered listening.
  useEffect(() => {
    if (isListening && !prevIsListeningRef.current && transcripts.length > 0) {
      const latest = transcripts[transcripts.length - 1];
      lastFedTranscriptIdRef.current = `${latest.timestamp}-${latest.text}`;
    }
    prevIsListeningRef.current = isListening;
  }, [isListening, transcripts]);

  // Feed only transcripts that arrive AFTER listening started.
  useEffect(() => {
    if (!isListening || transcripts.length === 0) return;
    const latest = transcripts[transcripts.length - 1];
    const latestId = `${latest.timestamp}-${latest.text}`;
    if (latestId !== lastFedTranscriptIdRef.current) {
      lastFedTranscriptIdRef.current = latestId;
      feedTranscript(latest.text);
    }
  }, [isListening, transcripts, feedTranscript]);

  // Auto-focus input when panel opens
  useEffect(() => {
    if (isPanelOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isPanelOpen]);

  // Auto-resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInputText(value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX) + 'px';

    // F018: Detect slash commands for autocomplete
    handleInputForCommands(value);
  };

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text) return;

    // If streaming, cancel first then send after a brief settle
    if (isStreaming) {
      cancelStream();
      await new Promise(r => setTimeout(r, 150));
    }

    // F020: If this is an action command, dispatch locally instead of sending to AI
    if (activeCommand?.type === 'action' && activeCommand.action === 'handoff') {
      cancelCommand();
      setInputText('');
      // Trigger handoff via window function (registered by useHandoffExport in page.tsx)
      const folderPath = await invoke<string | null>('get_meeting_folder_path').catch(() => null);
      if (folderPath && window.triggerHandoff) {
        window.triggerHandoff(folderPath, meetingTitle || 'Meeting');
      } else if (window.triggerHandoff) {
        toast.error('No active recording folder. Start a recording first.');
      }
      return;
    }

    // F018: If a slash command is active, build the expanded message
    let messageToSend = text;
    if (activeCommand) {
      const { message, capturedBasketItem } = buildCommandMessage(text);
      messageToSend = message;
      // Add captured transcript as a basket item before sending
      if (capturedBasketItem) {
        addToBasket(capturedBasketItem);
      }
      cancelCommand();
    }

    // Show setup modal if no session yet, API key missing, or projectDir empty
    if ((!sessionId && meetingId && meetingTitle) || !hasApiKey || !projectDir) {
      setPendingFirstMessage(messageToSend);
      setShowProjectModal(true);
      return;
    }

    setInputText('');
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }

    try {
      await sendMessage(messageToSend);
    } catch (err) {
      console.error('Failed to send message:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to send message');
    }
  };

  // Send pending message once projectDir is available (replaces setTimeout race)
  useEffect(() => {
    if (pendingFirstMessage && projectDir) {
      const msg = pendingFirstMessage;
      setPendingFirstMessage(null);
      setInputText('');
      sendMessageRef.current(msg).catch(err => {
        console.error('Failed to send first message:', err);
        toast.error(err instanceof Error ? err.message : 'Failed to send message');
      });
    }
  }, [pendingFirstMessage, projectDir]);

  const handleProjectDirConfirm = (dir: string) => {
    setShowProjectModal(false);
    if (meetingId && meetingTitle) {
      openPanel(meetingId, meetingTitle, dir);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // F018: Slash command autocomplete navigation
    if (showAutocomplete) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectPrev();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectNext();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const cmd = getSelectedCommand();
        if (cmd) {
          // F020: Action commands execute immediately on selection
          if (cmd.type === 'action' && cmd.action === 'handoff') {
            dismissAutocomplete();
            setInputText('');
            invoke<string | null>('get_meeting_folder_path').then(folderPath => {
              if (folderPath && window.triggerHandoff) {
                window.triggerHandoff(folderPath, meetingTitle || 'Meeting');
              } else if (window.triggerHandoff) {
                toast.error('No active recording folder. Start a recording first.');
              }
            }).catch(() => {
              toast.error('Failed to get meeting folder path');
            });
            return;
          }
          const newText = activateCommand(cmd);
          setInputText(newText);
        }
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const cmd = getSelectedCommand();
        if (cmd) {
          // F020: Action commands execute immediately on selection
          if (cmd.type === 'action' && cmd.action === 'handoff') {
            dismissAutocomplete();
            setInputText('');
            invoke<string | null>('get_meeting_folder_path').then(folderPath => {
              if (folderPath && window.triggerHandoff) {
                window.triggerHandoff(folderPath, meetingTitle || 'Meeting');
              } else if (window.triggerHandoff) {
                toast.error('No active recording folder. Start a recording first.');
              }
            }).catch(() => {
              toast.error('Failed to get meeting folder path');
            });
            return;
          }
          // Select the command (don't send yet)
          const newText = activateCommand(cmd);
          setInputText(newText);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissAutocomplete();
        return;
      }
    }

    // F047: Escape cancels voice command listening
    if (isListening && e.key === 'Escape') {
      e.preventDefault();
      cancelListening();
      return;
    }

    // F018: Escape cancels active command
    if (activeCommand && e.key === 'Escape') {
      e.preventDefault();
      cancelCommand();
      setInputText('');
      return;
    }

    // Normal Enter to send
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <>
      {/* Edge drop strip — visible when panel is CLOSED and a drag is active.
          Gives the user a visible target on the right edge to drop items into. */}
      {isDragActive && !isPanelOpen && (
        <div
          {...overlayDropHandlers}
          className={`fixed right-0 top-0 bottom-0 z-50 flex items-center justify-center transition-all duration-150 ${
            isDropOver
              ? 'w-48 bg-blue-500/20 dark:bg-blue-500/15 border-l-2 border-blue-400'
              : 'w-14 bg-blue-500/10 dark:bg-blue-500/5 border-l-2 border-dashed border-blue-400/50'
          }`}
        >
          <div className="flex flex-col items-center gap-1 pointer-events-none">
            <span className={`text-[10px] font-medium transition-colors ${isDropOver ? 'text-blue-400' : 'text-blue-400/70'}`}>
              {isDropOver ? 'Drop to add to AI' : 'AI'}
            </span>
          </div>
        </div>
      )}

      <div
        className={`fixed right-0 top-0 bottom-0 bg-background border-l border-border shadow-lg z-40 flex flex-col ${isResizing ? '' : 'transition-transform duration-200'} ${isPanelOpen ? 'translate-x-0' : 'translate-x-full pointer-events-none'}`}
        style={{ width: panelWidth }}
        onDragOver={(e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
        onDrop={(e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); handleFileDrop(e); } }}
      >
        {/* Resize drag handle — left edge */}
        <div
          onMouseDown={handleResizeStart}
          className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-50 group hover:bg-blue-500/30 active:bg-blue-500/50 transition-colors"
          title="Drag to resize"
        >
          <div className="absolute left-0 top-0 bottom-0 w-3 -translate-x-1" />
        </div>
        {/* Full-panel drop overlay — shown while an internal drag is active.
            Always visible with a subtle tint so user knows where to drop. */}
        {isDragActive && isPanelOpen && (
          <div
            {...overlayDropHandlers}
            className={`absolute inset-0 z-50 transition-colors ${
              isDropOver
                ? 'bg-blue-500/20 dark:bg-blue-400/10 ring-2 ring-blue-400 ring-inset'
                : 'bg-blue-500/5 dark:bg-blue-400/5 ring-1 ring-blue-400/30 ring-inset'
            }`}
          >
            <div className="flex items-center justify-center h-full pointer-events-none">
              <span className={`text-sm font-medium px-3 py-1.5 rounded-full shadow-sm transition-colors ${
                isDropOver
                  ? 'text-blue-500 bg-white/90 dark:bg-slate-800/90 dark:text-blue-300'
                  : 'text-blue-400/60 bg-white/50 dark:bg-slate-800/50 dark:text-blue-400/50'
              }`}>
                {isDropOver ? 'Drop to add to context' : 'Drop items here'}
              </span>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted flex-shrink-0">
          <div className="flex-1 min-w-0">
            {isEditingTitle ? (
              <input
                ref={titleInputRef}
                value={editingTitleValue}
                onChange={(e) => setEditingTitleValue(e.target.value)}
                onBlur={handleTitleSave}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); handleTitleSave(); }
                  if (e.key === 'Escape') { setIsEditingTitle(false); }
                }}
                className="font-semibold text-sm w-full bg-background border border-border rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                autoFocus
              />
            ) : (
              <div
                className="font-semibold text-sm truncate cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1"
                onDoubleClick={handleTitleDoubleClick}
                title="Double-click to rename"
              >
                {meetingTitle || 'AI Assistant'}
              </div>
            )}
            {projectDir && (
              <button
                onClick={() => invoke('show_in_folder', { path: projectDir }).catch(() => toast.error('Failed to open folder'))}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-blue-500 dark:hover:text-blue-400 max-w-full overflow-hidden transition-colors group"
                title={projectDir}
              >
                <FolderOpen className="w-3 h-3 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                <span className="truncate min-w-0">{projectDir}</span>
              </button>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {sessionId && (
              <button
                onClick={clearSession}
                className="p-1 text-muted-foreground hover:text-red-500"
                title="Clear session"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={closePanel}
              className="p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* API key not set warning */}
        {!hasApiKey && (
          <div className="px-3 py-2 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800/30 flex items-start gap-2 flex-shrink-0">
            <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-amber-700 dark:text-amber-300">
              Anthropic API key not set. It will be requested when you send your first message.
            </div>
          </div>
        )}

        {/* F005: PII service unavailable warning */}
        {anonymizationEnabled && piiAvailable === false && (
          <div className="px-3 py-2 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800/30 flex items-start gap-2 flex-shrink-0">
            <Shield className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-amber-700 dark:text-amber-300">
              PII anonymization is enabled but the backend service is unavailable. Context will be sent without anonymization.
            </div>
          </div>
        )}

        {/* Entity Map Viewer (F005) */}
        {Object.keys(entityMap).length > 0 && (
          <div className="flex-shrink-0">
            <EntityMapViewer
              entityMap={entityMap}
              onClear={clearEntityMap}
            />
          </div>
        )}

        {/* Context Basket */}
        <div className="flex-shrink-0">
          <ContextBasket
            items={contextBasket}
            onRemove={removeFromBasket}
            onClear={clearBasket}
            anonymizationEnabled={anonymizationEnabled}
            onToggleItemAnonymization={toggleItemAnonymization}
          />
        </div>

        {/* Conversation */}
        <ConversationView
          messages={conversation}
          isStreaming={isStreaming}
          onAnswer={(answer) => { if (!isStreaming) sendMessage(answer).catch(console.error); }}
        />

        {/* Input */}
        <div className="border-t border-border p-3 flex-shrink-0">
          {/* F047: Voice command listening indicator */}
          {isListening && (
            <div className="flex items-center justify-between mb-2 px-2 py-1.5 rounded-md bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800/30 text-xs animate-pulse">
              <div className="flex items-center gap-2 min-w-0">
                <Mic className="w-3.5 h-3.5 text-purple-500 flex-shrink-0" />
                <span className="font-medium text-purple-700 dark:text-purple-300 truncate">
                  {isHotkeyListening
                    ? 'Recording\u2026 release Ctrl+Space to send'
                    : voiceCapturedText
                      ? `Captured: "${voiceCapturedText.slice(0, 60)}${voiceCapturedText.length > 60 ? '\u2026' : ''}"`
                      : 'Waiting for transcription\u2026'}
                </span>
              </div>
              <button
                onClick={cancelListening}
                className="text-muted-foreground hover:text-red-500 ml-2 flex-shrink-0"
                title="Cancel (Esc)"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* F018: Active command capture indicator */}
          {activeCommand && (
            <div className="flex items-center justify-between mb-2 px-2 py-1.5 rounded-md bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/30 text-xs">
              <div className="flex items-center gap-2">
                {recordingState.isRecording && (
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                  </span>
                )}
                <span className="font-mono font-medium text-blue-700 dark:text-blue-300">
                  /{activeCommand.name}
                </span>
                {recordingState.isRecording ? (
                  <span className="text-blue-600 dark:text-blue-400">
                    Capturing live transcript ({capturedSegmentCount} segment{capturedSegmentCount !== 1 ? 's' : ''})
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    No active recording
                  </span>
                )}
              </div>
              <button
                onClick={() => { cancelCommand(); setInputText(''); }}
                className="text-muted-foreground hover:text-red-500 ml-2"
                title="Cancel command"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <div className="relative flex items-end gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <button
                  className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground pb-2 flex-shrink-0"
                  title="Select model"
                >
                  <ChevronUp className="w-3 h-3" />
                  <span className="max-w-[60px] truncate">{MODEL_OPTIONS.find(m => m.id === selectedModel)?.label ?? 'Model'}</span>
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" side="top" className="w-48 p-1">
                {MODEL_OPTIONS.map(m => (
                  <button
                    key={m.id}
                    onClick={() => setModel(m.id)}
                    className="flex items-center justify-between w-full px-2 py-1.5 text-xs rounded hover:bg-muted"
                  >
                    <span>{m.label}</span>
                    {m.id === selectedModel && <Check className="w-3 h-3 text-blue-500" />}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
            {/* F005: PII Anonymization toggle */}
            <button
              onClick={toggleAnonymization}
              className={`flex items-center gap-0.5 text-[10px] pb-2 flex-shrink-0 transition-colors ${
                anonymizationEnabled && piiAvailable !== false
                  ? 'text-emerald-500 hover:text-emerald-600'
                  : anonymizationEnabled && piiAvailable === false
                    ? 'text-amber-500 hover:text-amber-600'
                    : 'text-muted-foreground/50 hover:text-muted-foreground'
              }`}
              title={
                anonymizationEnabled && piiAvailable === false
                  ? 'PII anonymization ON but service unavailable'
                  : anonymizationEnabled
                    ? 'PII anonymization ON — click to disable'
                    : 'PII anonymization OFF — click to enable'
              }
            >
              <Shield className="w-3 h-3" />
              <span>PII</span>
            </button>
            {/* F044: Document attachment button */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.txt,.md,.markdown,.csv"
              className="hidden"
              onChange={(e) => { if (e.target.files?.[0]) handleFileUpload(e.target.files[0]); }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isParsingFile}
              className="flex items-center gap-0.5 text-[10px] pb-2 flex-shrink-0 text-muted-foreground/50 hover:text-muted-foreground transition-colors disabled:animate-pulse"
              title={isParsingFile ? 'Parsing document...' : 'Attach document (PDF, DOCX, TXT, MD, CSV)'}
            >
              <Paperclip className="w-3 h-3" />
            </button>
            <div className="relative flex-1">
              {/* F018: Slash command autocomplete dropdown */}
              {showAutocomplete && (
                <SlashCommandAutocomplete
                  commands={filteredCommands}
                  selectedIndex={selectedIndex}
                  onSelect={(cmd) => {
                    const newText = activateCommand(cmd);
                    setInputText(newText);
                    inputRef.current?.focus();
                  }}
                />
              )}
              <textarea
                ref={inputRef}
                value={inputText}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder={activeCommand ? `Type additional context for /${activeCommand.name}...` : 'Ask anything... (type / for commands)'}
                rows={1}
                className="w-full resize-none border border-border rounded-lg px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            {isStreaming && (
              <Button
                size="sm"
                variant="destructive"
                onClick={cancelStream}
                className="flex-shrink-0"
                title="Stop"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
              </Button>
            )}
            <Button
              size="sm"
              onClick={handleSend}
              disabled={!inputText.trim()}
              className="flex-shrink-0"
              title={isStreaming ? 'Stop and send' : 'Send'}
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
          {isStreaming && (
            <div className="text-xs text-muted-foreground mt-1 animate-pulse">AI is thinking...</div>
          )}
        </div>
      </div>

      {/* Project Dir Modal */}
      {showProjectModal && meetingTitle && (
        <ProjectDirModal
          defaultDir={projectDir || ''}
          meetingTitle={meetingTitle}
          onConfirm={handleProjectDirConfirm}
          onCancel={() => {
            setShowProjectModal(false);
            setPendingFirstMessage(null);
          }}
        />
      )}
    </>
  );
}
