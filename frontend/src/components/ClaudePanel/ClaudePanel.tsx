import React, { useState, useRef, useEffect } from 'react';
import { X, Send, Trash2, AlertCircle, Square, ChevronUp, Check, Shield } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { useClaude, MODEL_OPTIONS } from '@/contexts/ClaudeContext';
import { ContextBasket } from './ContextBasket';
import { ConversationView } from './ConversationView';
import { ProjectDirModal } from './ProjectDirModal';
import { EntityMapViewer } from './EntityMapViewer';
import { useDropZone, useDragActive } from '@/hooks/useDragAndDrop';
import { useSelection } from '@/contexts/SelectionContext';

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
  } = useClaude();

  const [inputText, setInputText] = useState('');
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [pendingFirstMessage, setPendingFirstMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;

  const hasApiKey = !!apiKey;
  const isDragActive = useDragActive();
  const { clearSelection } = useSelection();
  const { isOver: isDropOver, dropHandlers: overlayDropHandlers } = useDropZone(addToBasket, clearSelection);

  // Auto-focus input when panel opens
  useEffect(() => {
    if (isPanelOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isPanelOpen]);

  // Auto-resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputText(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  };

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || isStreaming) return;

    // Show setup modal if no session yet or API key missing
    if ((!sessionId && meetingId && meetingTitle) || !hasApiKey) {
      setPendingFirstMessage(text);
      setShowProjectModal(true);
      return;
    }

    setInputText('');
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }

    try {
      await sendMessage(text);
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
        className={`fixed right-0 top-0 bottom-0 w-[420px] bg-background border-l border-border shadow-lg z-40 flex flex-col transition-transform duration-200 ${isPanelOpen ? 'translate-x-0' : 'translate-x-full pointer-events-none'}`}
      >
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
            <div className="font-semibold text-sm truncate">{meetingTitle || 'AI Assistant'}</div>
            {projectDir && (
              <div className="text-xs text-muted-foreground truncate">{projectDir}</div>
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
        />

        {/* Input */}
        <div className="border-t border-border p-3 flex-shrink-0">
          <div className="flex items-end gap-2">
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
                anonymizationEnabled
                  ? 'text-emerald-500 hover:text-emerald-600'
                  : 'text-muted-foreground/50 hover:text-muted-foreground'
              }`}
              title={anonymizationEnabled ? 'PII anonymization ON — click to disable' : 'PII anonymization OFF — click to enable'}
            >
              <Shield className="w-3 h-3" />
              <span>{anonymizationEnabled ? 'PII' : 'PII'}</span>
            </button>
            <textarea
              ref={inputRef}
              value={inputText}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Ask about this meeting..."
              disabled={isStreaming}
              rows={1}
              className="flex-1 resize-none border border-border rounded-lg px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:bg-muted"
            />
            {isStreaming ? (
              <Button
                size="sm"
                variant="outline"
                onClick={cancelStream}
                className="flex-shrink-0"
                title="Stop"
              >
                <Square className="w-4 h-4" />
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={handleSend}
                disabled={!inputText.trim()}
                className="flex-shrink-0"
              >
                <Send className="w-4 h-4" />
              </Button>
            )}
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
