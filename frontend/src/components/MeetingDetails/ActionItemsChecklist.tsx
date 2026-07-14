"use client";

import { useEffect, useState } from 'react';
import { Check, Copy, Send, ListChecks } from 'lucide-react';
import { toast } from 'sonner';
import { invoke } from '@tauri-apps/api/core';
import {
  actionItemId,
  actionItemsToMarkdown,
  loadCheckedState,
  saveCheckedState,
} from '@/lib/actionItems';
import Analytics from '@/lib/analytics';

interface ActionItemsChecklistProps {
  meetingId: string;
  meetingTitle?: string;
  folderPath?: string;
  items: string[];
}

/**
 * Renders the summary's action items as a persisted checklist (I4). Checkbox state
 * is stored in localStorage keyed by meeting id (no schema change). Includes a
 * "Copy action items" button and a "Send to handoff" button that writes the items
 * to the meeting folder via the same save_transcript command the handoff export uses.
 */
export function ActionItemsChecklist({ meetingId, meetingTitle, folderPath, items }: ActionItemsChecklistProps) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  // Load persisted checkbox state when the meeting changes.
  useEffect(() => {
    setChecked(loadCheckedState(meetingId));
  }, [meetingId]);

  if (!items.length) return null;

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      saveCheckedState(meetingId, next);
      return next;
    });
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(actionItemsToMarkdown(items, checked));
      toast.success('Action items copied to clipboard');
      void Analytics.trackFeatureUsedEnhanced('copy_action_items', { meeting_id: meetingId, count: items.length.toString() });
    } catch (err) {
      console.error('Failed to copy action items:', err);
      toast.error('Could not copy action items');
    }
  };

  const handleSendToHandoff = async () => {
    if (!folderPath) {
      toast.info('No meeting folder available for handoff', {
        description: 'This meeting has no folder on disk, so the action items cannot be written out.',
      });
      return;
    }
    try {
      const sep = folderPath.includes('\\') ? '\\' : '/';
      const filePath = `${folderPath}${sep}action-items.md`;
      const heading = `# Action items — ${meetingTitle || 'Meeting'}\n\n`;
      const content = heading + actionItemsToMarkdown(items, checked) + '\n';
      await invoke('save_transcript', { filePath, content });
      toast.success('Action items sent to handoff', {
        description: `${filePath}`,
        action: {
          label: 'Show File',
          onClick: () => { void invoke('show_in_folder', { path: filePath }); },
        },
        duration: 8000,
      });
      Analytics.trackFeatureUsed('action_items_handoff');
    } catch (err) {
      console.error('Failed to send action items to handoff:', err);
      toast.error('Could not send action items to handoff', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div
      data-testid="action-items-checklist"
      className="mb-6 rounded-lg border border-border bg-card p-4 shadow-sm"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ListChecks className="h-4 w-4 text-muted-foreground" />
          Action Items
        </h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            data-testid="copy-action-items"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy action items
          </button>
          <button
            type="button"
            onClick={handleSendToHandoff}
            data-testid="send-action-items-handoff"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <Send className="h-3.5 w-3.5" />
            Send to handoff
          </button>
        </div>
      </div>

      <ul className="space-y-1.5">
        {items.map((text, i) => {
          const id = actionItemId(i, text);
          const isChecked = !!checked[id];
          return (
            <li key={id} data-testid="action-item" className="flex items-start gap-2.5">
              <button
                type="button"
                role="checkbox"
                aria-checked={isChecked}
                aria-label={text}
                data-testid="action-item-checkbox"
                onClick={() => toggle(id)}
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                  isChecked
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border bg-background hover:border-foreground/50'
                }`}
              >
                {isChecked && <Check className="h-3 w-3" strokeWidth={3} />}
              </button>
              <span
                className={`text-sm leading-relaxed ${
                  isChecked ? 'text-muted-foreground line-through' : 'text-foreground'
                }`}
              >
                {text}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
