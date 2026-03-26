'use client';

import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Shield, Download, Loader2 } from 'lucide-react';

interface HandoffDialogProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  anonymizeChecked: boolean;
  onAnonymizeChange: (checked: boolean) => void;
  piiAvailable: boolean | null;
  isGenerating: boolean;
}

export function HandoffDialog({
  open,
  onConfirm,
  onCancel,
  anonymizeChecked,
  onAnonymizeChange,
  piiAvailable,
  isGenerating,
}: HandoffDialogProps) {
  const canAnonymize = piiAvailable === true;
  const isChecking = piiAvailable === null;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            Generate Meeting Handoff
          </DialogTitle>
          <DialogDescription>
            A HANDOFF.md file will be saved to the meeting folder for use in Claude Code.
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <label
            className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
              canAnonymize
                ? 'hover:bg-accent'
                : 'opacity-60 cursor-not-allowed'
            }`}
          >
            <input
              type="checkbox"
              checked={anonymizeChecked && canAnonymize}
              onChange={(e) => onAnonymizeChange(e.target.checked)}
              disabled={!canAnonymize || isGenerating}
              className="mt-0.5 h-4 w-4 rounded border-input"
            />
            <div className="flex-1 space-y-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Shield className={`h-4 w-4 ${anonymizeChecked && canAnonymize ? 'text-success' : 'text-muted-foreground'}`} />
                Anonymize PII before exporting
              </div>
              <p className="text-xs text-muted-foreground">
                Names, emails, phone numbers, and other personal data will be replaced with realistic surrogates.
              </p>
              {isChecking && (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Checking PII service...
                </p>
              )}
              {piiAvailable === false && (
                <p className="text-xs text-destructive">
                  PII service unavailable — backend not running
                </p>
              )}
            </div>
          </label>
        </div>

        <DialogFooter>
          <button
            onClick={onCancel}
            disabled={isGenerating}
            className="inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isGenerating || isChecking}
            className="inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {isChecking ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Checking PII...
              </>
            ) : isGenerating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Download className="h-4 w-4" />
                Generate Handoff
              </>
            )}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
