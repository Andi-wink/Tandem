'use client';

/**
 * JotStrip: the live, in-call jot box for "Enhance my notes" (phase 1).
 *
 * A single-line input with a compact running list of timestamped chips above it. Visible only while a
 * meeting recording is active; deliberately low-chrome so it never competes with the call for
 * attention ("invisible when active"). Keyboard-only usable: Enter adds, click a chip to edit, x to
 * delete, Escape cancels an edit.
 *
 * The digit-toggle lesson (quick-capture): a bare keystroke inside this input must never reach a global
 * shortcut handler, so typing "1", "2", "3" only edits the note. But that guard is scoped to UNMODIFIED
 * keys: modifier combos (Ctrl+K palette, Ctrl+. AI panel, Ctrl+, canvas, which are window keydown
 * listeners, not OS-level) must still bubble through so those shortcuts keep working while the input is
 * focused. Blanket-stopping every keydown would swallow them, which is itself the "strip steals
 * shortcuts" failure this feature is meant to avoid. Alt+Shift globals are OS-level and unaffected.
 */

import { useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { useClaude } from '@/contexts/ClaudeContext';
import { useMeetingJots } from '@/hooks/useMeetingJots';
import { formatStamp } from '@/lib/meetingJots';

export function JotStrip() {
  const { isRecording, recordingMode } = useRecordingState();
  const { transcriptsRef } = useTranscripts();
  const { isCollapsed: sidebarCollapsed } = useSidebar();
  const { isPanelOpen, panelWidth } = useClaude();
  const { jots, add, edit, remove } = useMeetingJots();

  const [value, setValue] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Recording-relative time of the latest transcript segment, in ms (null when no timing yet).
  const currentAudioMs = (): number | null => {
    const list = transcriptsRef.current;
    for (let i = list.length - 1; i >= 0; i--) {
      const t = list[i];
      const sec = t.audio_end_time ?? t.audio_start_time;
      if (typeof sec === 'number' && Number.isFinite(sec)) return Math.round(sec * 1000);
    }
    return null;
  };

  const commit = () => {
    const text = value.trim();
    if (!text) {
      // An empty commit while editing cancels the edit rather than deleting the chip.
      setEditingId(null);
      setValue('');
      return;
    }
    if (editingId) {
      edit(editingId, text);
      setEditingId(null);
    } else {
      add(text, currentAudioMs());
    }
    setValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Keep only UNMODIFIED keystrokes local (digit-toggle lesson): a bare "1"/"2"/"3" or letter must
    // never reach a global bare-key shortcut. Modifier combos (Ctrl/Meta/Alt) are deliberately let
    // through so Ctrl+K / Ctrl+. / Ctrl+, still reach the command palette / AI panel / canvas toggles.
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      e.stopPropagation();
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (editingId) {
        setEditingId(null);
        setValue('');
      } else if (value) {
        setValue('');
      } else {
        inputRef.current?.blur();
      }
    }
  };

  const startEdit = (id: string, content: string) => {
    setEditingId(id);
    setValue(content);
    inputRef.current?.focus();
  };

  const rightOffset = useMemo(() => (isPanelOpen ? `${panelWidth}px` : '0'), [isPanelOpen, panelWidth]);

  // Invisible unless a meeting recording is active. Solo mode has its own flow and never files jots.
  if (!isRecording || recordingMode === 'solo') return null;

  return (
    <div
      className="fixed bottom-28 left-0 right-0 z-10 transition-[right] duration-200 pointer-events-none"
      style={{ right: rightOffset }}
      data-testid="jot-strip"
    >
      <div
        className="flex justify-center pl-8 transition-[margin] duration-300"
        style={{ marginLeft: sidebarCollapsed ? '4rem' : '16rem' }}
      >
        <div className="w-2/3 max-w-[750px] pointer-events-auto">
          <div className="bg-card/95 backdrop-blur-sm border border-border rounded-2xl shadow-sm px-3 py-2 flex flex-col gap-2">
            {jots.length > 0 && (
              <div
                className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto"
                data-testid="jot-chips"
              >
                {jots.map((jot) => (
                  <span
                    key={jot.id}
                    className={`group inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-small transition-colors ${
                      editingId === jot.id
                        ? 'border-primary/60 bg-primary/10 text-foreground'
                        : 'border-border bg-muted/60 text-foreground hover:bg-muted'
                    }`}
                    data-testid="jot-chip"
                  >
                    <button
                      type="button"
                      onClick={() => startEdit(jot.id, jot.content)}
                      className="inline-flex items-center gap-1.5 text-left"
                      title="Click to edit"
                    >
                      <span className="text-muted-foreground tabular-nums text-caption">
                        {jot.audioMs !== null ? formatStamp(jot.audioMs / 1000) : '[--:--]'}
                      </span>
                      <span className="truncate max-w-[22ch]">{jot.content}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (editingId === jot.id) {
                          setEditingId(null);
                          setValue('');
                        }
                        remove(jot.id);
                      }}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                      aria-label="Delete jot"
                      data-testid="jot-chip-delete"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={editingId ? 'Edit note... (Enter)' : 'Jot a note... (Enter)'}
              aria-label="Jot a note"
              data-testid="jot-input"
              className="w-full bg-transparent px-1 py-1 text-body text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
