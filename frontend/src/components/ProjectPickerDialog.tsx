'use client';

import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { ProjectPicker, ProjectPickerSelection } from '@/components/ProjectPicker';

interface ProjectPickerDialogProps {
  open: boolean;
  title?: string;
  meetingTitle?: string | null;
  onSelect: (sel: ProjectPickerSelection) => void;
  onClose: () => void;
}

/**
 * Thin modal host for the user-initiated "Move to project" / "Change" flow. This modal is only ever
 * opened by an explicit user action (the toast's Change button, a spoken-name miss, or the header
 * Move action), so it does not violate the no-modal-mid-call rule — the user asked for it.
 */
export function ProjectPickerDialog({
  open,
  title = 'Move to project',
  meetingTitle,
  onSelect,
  onClose,
}: ProjectPickerDialogProps) {
  // Close on Escape from anywhere (the picker input also wires Escape -> onClose).
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-background rounded-lg shadow-xl w-[440px] max-w-[90vw]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="font-semibold text-sm text-foreground">{title}</h3>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-4 py-4">
          <p className="text-xs text-muted-foreground mb-2">
            Pick where this meeting&apos;s notes and AI work should be filed.
          </p>
          <ProjectPicker
            allowBrowse
            meetingTitle={meetingTitle}
            onSelect={onSelect}
            onEscape={onClose}
          />
        </div>
      </div>
    </div>
  );
}
