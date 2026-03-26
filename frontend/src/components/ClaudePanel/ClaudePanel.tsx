import React, { useState, useRef, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X, Send, Trash2, AlertCircle, Square, ChevronUp, ChevronDown, Check, Shield, Paperclip, Mic, FolderOpen, Code, Pencil, SlidersHorizontal, Plus } from 'lucide-react';
import { toast } from 'sonner';
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
import { writeTaskHandoff, getRecentTranscripts, HANDOFF_TRANSCRIPT_WINDOW_SECS, TaskHandoffData, ensureTandemClaudeMd } from '@/services/handoffService';
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
    setProjectDir,
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

  // F054: Auto-show project dir modal when panel opens during recording without projectDir
  // Wait for apiKey to load (non-null) to avoid making the user re-enter it
  useEffect(() => {
    if (isPanelOpen && recordingState.isRecording && !projectDir && meetingTitle && !showProjectModal && apiKey) {
      setShowProjectModal(true);
    }
  }, [isPanelOpen, recordingState.isRecording, projectDir, meetingTitle, showProjectModal, apiKey]);

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

  // M18: Refs for writeCodeHandoff to avoid stale closures in the useEffect
  const transcriptsRef_handoff = useRef(transcripts);
  transcriptsRef_handoff.current = transcripts;
  const contextBasketRef = useRef(contextBasket);
  contextBasketRef.current = contextBasket;
  const meetingTitleRef = useRef(meetingTitle);
  meetingTitleRef.current = meetingTitle;
  const meetingIdRef = useRef(meetingId);
  meetingIdRef.current = meetingId;
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

  // F020: Shared handoff trigger — extracted from 3 duplicate call sites
  const invokeHandoff = useCallback(async () => {
    const folderPath = await invoke<string | null>('get_meeting_folder_path').catch(() => null);
    if (folderPath && window.triggerHandoff) {
      window.triggerHandoff(folderPath, meetingTitle || 'Meeting');
    } else if (window.triggerHandoff) {
      toast.error('No active recording folder. Start a recording first.');
    }
  }, [meetingTitle]);

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
      invokeHandoff();
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

    // F054: Detect @code / @claude tag — strip it, queue a task file, DON'T send to AI
    const hasCodeTag = /@(?:code|claude)\b/i.test(messageToSend);
    if (hasCodeTag) {
      const taskText = messageToSend.replace(/@(?:code|claude)\b/gi, '').trim();
      if (!projectDir) {
        // Need projectDir first — show modal, save task text as pending
        setPendingFirstMessage(`@code ${taskText}`);
        setShowProjectModal(true);
        return;
      }
      setInputText('');
      if (inputRef.current) inputRef.current.style.height = 'auto';
      writeCodeHandoff(taskText);
      return; // Don't send to AI
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

  // F054: Write task handoff file for Claude Code /loop (fire-and-forget)
  const writeCodeHandoff = async (taskDescription: string) => {
    try {
      const recentTranscripts = getRecentTranscripts(transcriptsRef_handoff.current, HANDOFF_TRANSCRIPT_WINDOW_SECS);
      const data: TaskHandoffData = {
        taskDescription,
        meetingTitle: meetingTitleRef.current || 'Meeting',
        meetingId: meetingIdRef.current || 'unknown',
        transcripts: recentTranscripts,
        contextItems: [...contextBasketRef.current],
        timestamp: new Date(),
      };
      const filePath = await writeTaskHandoff(projectDir!, data);
      toast.success('Task queued for Claude Code', {
        description: filePath.split(/[/\\]/).pop(),
        action: {
          label: 'Show File',
          onClick: () => { invoke('show_in_folder', { path: filePath }); },
        },
        duration: 8000,
      });
    } catch (err) {
      console.error('[F054] Failed to write handoff file:', err);
      toast.error('Failed to queue task for Claude Code');
    }
  };

  // Send pending message once projectDir is available (replaces setTimeout race)
  useEffect(() => {
    if (pendingFirstMessage && projectDir) {
      const msg = pendingFirstMessage;
      setPendingFirstMessage(null);
      setInputText('');

      // F054: If pending message was an @code/@claude task, write handoff instead of sending to AI
      if (/^@(?:code|claude)\b/i.test(msg)) {
        const taskText = msg.replace(/@(?:code|claude)\b/gi, '').trim();
        writeCodeHandoff(taskText);
        return;
      }

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
    // F054: Write .tandem/CLAUDE.md so Claude Code knows about the integration
    ensureTandemClaudeMd(dir).catch(() => {});
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
            invokeHandoff();
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
            invokeHandoff();
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
              ? 'w-48 bg-brand/20 dark:bg-brand/15 border-l-2 border-brand'
              : 'w-14 bg-brand/10 dark:bg-brand/5 border-l-2 border-dashed border-brand/50'          }`}
        >
          <div className="flex flex-col items-center gap-1 pointer-events-none">
            <span className={`text-[10px] font-medium transition-colors ${isDropOver ? 'text-brand' : 'text-brand/70'}`}>
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
          className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize z-50 group hover:bg-brand/30 active:bg-brand/50 transition-colors"          title="Drag to resize"
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
                ? 'bg-brand/20 dark:bg-brand/10 ring-2 ring-brand ring-inset'
                : 'bg-brand/5 dark:bg-brand/5 ring-1 ring-brand/30 ring-inset'            }`}
          >
            <div className="flex items-center justify-center h-full pointer-events-none">
              <span className={`text-sm font-medium px-3 py-1.5 rounded-full shadow-sm transition-colors ${
                isDropOver
                  ? 'text-brand bg-white/90 dark:bg-card/90'
                  : 'text-brand/60 bg-white/50 dark:bg-card/50'              }`}>
                {isDropOver ? 'Drop to add to context' : 'Drop items here'}
              </span>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-1 min-w-0 flex-1">
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
                className="font-semibold text-sm w-full bg-background border border-border rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-brand"                autoFocus
              />
            ) : (
              <button
                className="flex items-center gap-1 min-w-0 hover:bg-muted rounded-md px-1.5 py-0.5 -mx-1.5 transition-colors group"
                onDoubleClick={handleTitleDoubleClick}
                onClick={handleTitleDoubleClick}
                title="Click to rename"
              >
                <span className="font-medium text-sm truncate">
                  {meetingTitle || 'AI Assistant'}
                </span>
                <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-0.5 flex-shrink-0">
            {sessionId && (
              <button
                onClick={clearSession}
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="New session"
              >
                <Plus className="w-4 h-4" />
              </button>
            )}
            <div className="flex items-center gap-1 max-w-full overflow-hidden">
              {projectDir ? (
                <>
                  <button
                    onClick={() => invoke('open_folder', { path: projectDir }).catch(() => toast.error('Failed to open folder'))}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-brand overflow-hidden transition-colors group min-w-0"
                    title={`Open ${projectDir}`}
                  >
                    <FolderOpen className="w-3 h-3 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                    <span className="truncate min-w-0">{projectDir}</span>
                  </button>
                  <button
                    onClick={async () => {
                      try {
                        const result = await invoke<string | null>('select_recording_folder');
                        if (result) setProjectDir(result);
                      } catch { toast.error('Failed to open folder picker'); }
                    }}
                    className="p-0.5 text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                    title="Change project folder"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                </>
              ) : (
                <button
                  onClick={async () => {
                    try {
                      const result = await invoke<string | null>('select_recording_folder');
                      if (result) setProjectDir(result);
                    } catch { toast.error('Failed to open folder picker'); }
                  }}
                  className="flex items-center gap-1 text-xs text-brand hover:text-brand-hover transition-colors"
                >
                  <FolderOpen className="w-3 h-3 flex-shrink-0" />
                  <span>Set project folder...</span>
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {sessionId && (
              <button
                onClick={clearSession}
                className="p-1 text-muted-foreground hover:text-destructive"
                title="Clear session"
              >
                <Trash2 className="w-4 h-4" />              </button>
            )}
            <button
              onClick={closePanel}
              aria-label="Close AI panel"
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* API key not set warning */}
        {!hasApiKey && (
          <div className="px-3 py-2 bg-warning-muted border-b border-warning/20 flex items-start gap-2 flex-shrink-0">
            <AlertCircle className="w-4 h-4 text-warning mt-0.5 flex-shrink-0" />
            <div className="text-xs text-warning-foreground">
              Anthropic API key not set. It will be requested when you send your first message.
            </div>
          </div>
        )}

        {/* F005: PII service unavailable warning */}
        {anonymizationEnabled && piiAvailable === false && (
          <div className="px-3 py-2 bg-warning-muted border-b border-warning/20 flex items-start gap-2 flex-shrink-0">
            <Shield className="w-4 h-4 text-warning mt-0.5 flex-shrink-0" />
            <div className="text-xs text-warning-foreground">
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
        <div className="p-3 flex-shrink-0">
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
                className="text-muted-foreground hover:text-destructive ml-2 flex-shrink-0"
                title="Cancel (Esc)"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* F018: Active command capture indicator */}
          {activeCommand && (
            <div className="flex items-center justify-between mb-2 px-2 py-1.5 rounded-md bg-brand-muted border border-brand/20 text-xs">
              <div className="flex items-center gap-2">
                {recordingState.isRecording && (
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-recording opacity-75" />                    <span className="relative inline-flex rounded-full h-2 w-2 bg-recording" />
                  </span>
                )}
                <span className="font-mono font-medium text-brand-muted-foreground">
                  /{activeCommand.name}
                </span>
                {recordingState.isRecording ? (
                  <span className="text-brand">
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
                className="text-muted-foreground hover:text-destructive ml-2"
                title="Cancel command"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* F054: @code / @claude tag detected indicator */}
          {/@(?:code|claude)\b/i.test(inputText) && !activeCommand && (
            <div className="flex items-center gap-2 mb-2 px-2 py-1.5 rounded-md bg-success/10 border border-success/20 text-xs">
              <Code className="w-3.5 h-3.5 text-success flex-shrink-0" />
              <span className="font-medium text-success">
                @code / @claude — task will be queued for Claude Code              </span>
            </div>
          )}

          <div className="relative flex items-center gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <button
                  className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground flex-shrink-0"
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
                    {m.id === selectedModel && <Check className="w-3 h-3 text-brand" />}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
            {/* F005: PII Anonymization toggle */}
            <button
              onClick={toggleAnonymization}
              className={`flex items-center gap-0.5 text-[10px] flex-shrink-0 transition-colors ${
                anonymizationEnabled && piiAvailable !== false
                  ? 'text-success hover:text-success/80'
                  : anonymizationEnabled && piiAvailable === false
                    ? 'text-warning hover:text-warning/80'
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
            {/* F044: Document attachment button */}            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.txt,.md,.markdown,.csv"
              className="hidden"
              onChange={(e) => { if (e.target.files?.[0]) handleFileUpload(e.target.files[0]); }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isParsingFile}
              className="flex items-center gap-0.5 text-[10px] flex-shrink-0 text-muted-foreground/50 hover:text-muted-foreground transition-colors disabled:animate-pulse"
              title={isParsingFile ? 'Parsing document...' : 'Attach document (PDF, DOCX, TXT, MD, CSV)'}
            >
              <Paperclip className="w-3 h-3" />
            </button>
            <div className="relative flex-1">              {/* F018: Slash command autocomplete dropdown */}
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
                className="w-full resize-none border border-border rounded-lg px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-brand"              />
            </div>

            {/* Bottom toolbar — inside the input container */}
            <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between px-2 pb-2">
              {/* Left: attachment */}
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isParsingFile}
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:animate-pulse"
                title={isParsingFile ? 'Parsing document...' : 'Attach document (PDF, DOCX, TXT, MD, CSV)'}
              >
                <Paperclip className="w-4 h-4" />
              </button>

              {/* Right: settings + send */}
              <div className="flex items-center gap-1">
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                      title="Settings"
                    >
                      <SlidersHorizontal className="w-4 h-4" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="end" side="top" className="w-56 p-2 space-y-2">
                    {/* Model selection */}
                    <div>
                      <div className="text-xs font-medium text-muted-foreground px-1 mb-1">Model</div>
                      {MODEL_OPTIONS.map(m => (
                        <button
                          key={m.id}
                          onClick={() => setModel(m.id)}
                          className={`flex items-center justify-between w-full px-2 py-1.5 text-xs rounded-md transition-colors ${
                            m.id === selectedModel ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                          }`}
                        >
                          <span>{m.label}</span>
                          {m.id === selectedModel && <Check className="w-3 h-3 text-brand" />}
                        </button>
                      ))}
                    </div>
                    {/* Divider */}
                    <div className="border-t border-border" />
                    {/* F005: PII Anonymization toggle */}
                    <button
                      onClick={toggleAnonymization}
                      className="flex items-center justify-between w-full px-2 py-1.5 text-xs rounded-md hover:bg-muted transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <Shield className="w-3.5 h-3.5" />
                        <span>PII Anonymization</span>
                      </div>
                      <div className={`w-7 h-4 rounded-full relative transition-colors ${
                        anonymizationEnabled ? 'bg-success' : 'bg-muted-foreground/30'
                      }`}>
                        <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-[left] duration-150 ${
                          anonymizationEnabled ? 'left-3.5' : 'left-0.5'
                        }`} />
                      </div>
                    </button>
                    {anonymizationEnabled && piiAvailable === false && (
                      <div className="text-[10px] text-warning px-2">Service unavailable</div>
                    )}
                  </PopoverContent>
                </Popover>

                {isStreaming ? (
                  <button
                    onClick={cancelStream}
                    className="p-1.5 rounded-md bg-muted text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    title="Stop generating"
                  >
                    <Square className="w-4 h-4 fill-current" />
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!inputText.trim()}
                    className="p-1.5 rounded-md bg-brand text-brand-foreground hover:bg-brand-hover disabled:opacity-30 disabled:cursor-default transition-colors"
                    title="Send message"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          </div>
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
