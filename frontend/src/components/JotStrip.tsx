'use client';

/**
 * JotStrip: the single live capture box for typed input during a recording.
 *
 * One line, two destinations, chosen by a quiet dropdown that reads as a prefix to the input:
 *   - "Transcript" (the default): the text is dropped straight into the live transcript via addNote,
 *     so it flows everywhere the transcript goes (live view, saved meeting, `.tandem/live-transcript.md`,
 *     summaries). The input only clears when addNote reports the note was added.
 *   - "Note": the "Enhance my notes" jot behaviour, a timestamped chip held in the jot store and
 *     folded into the enhanced notes at stop.
 * Chips for the jots sit above the input. Visible only while a recording is active; deliberately
 * low-chrome so it never competes with the call for attention ("invisible when active"). Keyboard-only
 * usable: Enter commits, click a chip to edit, x to delete, Escape cancels an edit. Editing a chip
 * always commits as a jot edit, whatever the selected destination.
 *
 * Solo mode: the strip renders, but the destination is locked to Transcript and no chips are shown.
 * Solo has its own flow and never files jots.
 *
 * The digit-toggle lesson (quick-capture): a bare keystroke inside this input must never reach a global
 * shortcut handler, so typing "1", "2", "3" only edits the note. But that guard is scoped to UNMODIFIED
 * keys: modifier combos (Ctrl+K palette, Ctrl+. AI panel, Ctrl+, canvas, which are window keydown
 * listeners, not OS-level) must still bubble through so those shortcuts keep working while the input is
 * focused. Blanket-stopping every keydown would swallow them, which is itself the "strip steals
 * shortcuts" failure this feature is meant to avoid. Alt+Shift globals are OS-level and unaffected. The
 * destination dropdown gets the same guard (its trigger and its portalled menu), so menu typeahead and
 * arrow keys cannot leak to global bare-key shortcuts either.
 */

import { useMemo, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { useClaude } from '@/contexts/ClaudeContext';
import { useMeetingJots } from '@/hooks/useMeetingJots';
import { formatStamp } from '@/lib/meetingJots';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** Where an Enter-committed line goes: into the transcript, or into the jot store. */
type JotDestination = 'transcript' | 'note';

const DESTINATION_LABEL: Record<JotDestination, string> = {
  transcript: 'Transcript',
  note: 'Note',
};

export function JotStrip() {
  const { isRecording, recordingMode } = useRecordingState();
  const { transcriptsRef, addNote } = useTranscripts();
  const { isCollapsed: sidebarCollapsed } = useSidebar();
  const { isPanelOpen, panelWidth } = useClaude();
  const { jots, add, edit, remove } = useMeetingJots();

  const [value, setValue] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [destination, setDestination] = useState<JotDestination>('transcript');
  const inputRef = useRef<HTMLInputElement>(null);

  const isSolo = recordingMode === 'solo';
  // Solo never files jots, so the destination is pinned regardless of what was picked in meeting mode.
  const activeDestination: JotDestination = isSolo ? 'transcript' : destination;

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
      // An in-flight chip edit is always a jot edit: the destination selector does not apply to it.
      edit(editingId, text);
      setEditingId(null);
      setValue('');
      return;
    }
    if (activeDestination === 'transcript') {
      // Keep the text in the box if the transcript refused it, so nothing is silently lost.
      if (addNote(text)) setValue('');
      return;
    }
    add(text, currentAudioMs());
    setValue('');
  };

  // Same scoping as the input guard: swallow bare keys, let modifier combos reach global shortcuts.
  const stopBareKeys = (e: React.KeyboardEvent) => {
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      e.stopPropagation();
    }
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

  const placeholder = editingId
    ? 'Edit note... (Enter)'
    : activeDestination === 'transcript'
      ? 'Add to transcript... (Enter)'
      : 'Jot a note... (Enter)';
  const inputLabel = editingId
    ? 'Edit note'
    : activeDestination === 'transcript'
      ? 'Add to transcript'
      : 'Jot a note';

  const rightOffset = useMemo(() => (isPanelOpen ? `${panelWidth}px` : '0'), [isPanelOpen, panelWidth]);

  // Invisible unless a recording is active.
  if (!isRecording) return null;

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
            {!isSolo && jots.length > 0 && (
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
            <div className="flex items-center gap-2">
              {/* Destination picker: a quiet prefix to the input, never a control that draws the eye. */}
              {isSolo ? (
                <span
                  className="shrink-0 border-r border-border pr-2 py-0.5 text-caption text-muted-foreground"
                  data-testid="jot-destination"
                  data-destination="transcript"
                >
                  {DESTINATION_LABEL.transcript}
                </span>
              ) : (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      onKeyDown={stopBareKeys}
                      aria-label={`Destination: ${DESTINATION_LABEL[activeDestination]}`}
                      data-testid="jot-destination"
                      data-destination={activeDestination}
                      className="shrink-0 inline-flex items-center gap-1 border-r border-border pr-2 py-0.5 text-caption text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:text-foreground transition-colors"
                    >
                      {DESTINATION_LABEL[activeDestination]}
                      <ChevronDown className="w-3 h-3 opacity-60" aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    onKeyDown={stopBareKeys}
                    className="min-w-[9rem]"
                  >
                    <DropdownMenuItem
                      onSelect={() => setDestination('transcript')}
                      data-testid="jot-destination-transcript"
                      className="text-small"
                    >
                      {DESTINATION_LABEL.transcript}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => setDestination('note')}
                      data-testid="jot-destination-note"
                      className="text-small"
                    >
                      {DESTINATION_LABEL.note}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <input
                ref={inputRef}
                type="text"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                aria-label={inputLabel}
                data-testid="jot-input"
                className="flex-1 min-w-0 bg-transparent px-1 py-1 text-body text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
