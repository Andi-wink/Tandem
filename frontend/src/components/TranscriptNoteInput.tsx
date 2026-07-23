'use client';

import { useState, useCallback, KeyboardEvent } from 'react';
import { StickyNote } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useTranscripts } from '@/contexts/TranscriptContext';

/**
 * Compact, keyboard-first input for dropping a typed note (text or a link) INTO
 * the live transcript during a recording/solo session. Enter adds the note as a
 * transcript segment marked as a note, so it flows everywhere the transcript
 * goes (live view, saved meeting, `.tandem/live-transcript.md`, summaries).
 */
export function TranscriptNoteInput() {
  const { addNote } = useTranscripts();
  const [value, setValue] = useState('');

  const submit = useCallback(() => {
    const text = value.trim();
    if (!text) return;
    const added = addNote(text);
    if (added) setValue('');
  }, [value, addNote]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    },
    [submit],
  );

  return (
    <div className="relative w-full">
      <StickyNote
        className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Add a note or link to the transcript…"
        aria-label="Add a note or link to the transcript"
        spellCheck={false}
        autoComplete="off"
        className="h-8 pl-8 text-sm"
      />
    </div>
  );
}
