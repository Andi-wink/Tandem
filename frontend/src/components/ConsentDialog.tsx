'use client';

/**
 * Pre-record consent gate.
 *
 * Opens BEFORE `start_recording` and blocks it until consent is recorded. That ordering is the
 * whole point: § 201 Abs. 1 Nr. 1 StGB is complete at the moment of fixation, so consent obtained
 * after capture has begun does not cure the offence and deleting the audio does not undo it. The
 * thing this replaces was a dismissible toast fired *after* the backend had already started.
 *
 * The gate is enforced in Rust (see `src-tauri/src/consent.rs`); this dialog is how the user
 * satisfies it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Plus, ShieldCheck, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  ConsentMethod,
  JURISDICTION_OPTIONS,
  jurisdictionWarning,
  recordConsent,
} from '@/services/consentService';

interface ConsentDialogProps {
  open: boolean;
  /** Called with false when the user backs out without consenting. */
  onOpenChange: (open: boolean) => void;
  /** Title of the meeting about to start, for the log record. */
  meetingTitle?: string | null;
  /** Fired once consent is recorded and the Rust gate is armed. Start recording here. */
  onConsentRecorded: (consentId: string) => void;
}

const METHOD_OPTIONS: { value: ConsentMethod; label: string; hint: string }[] = [
  {
    value: 'verbal',
    label: 'Spoken yes, on the call',
    hint: 'Each person said yes out loud before recording started.',
  },
  {
    value: 'written',
    label: 'Written, in advance',
    hint: 'Email or chat reply agreeing to be recorded.',
  },
  {
    value: 'prior_written',
    label: 'Engagement letter or invite notice',
    hint: 'Standing agreement accepted before this call.',
  },
];

export function ConsentDialog({
  open,
  onOpenChange,
  meetingTitle,
  onConsentRecorded,
}: ConsentDialogProps) {
  const [participants, setParticipants] = useState<string[]>(['']);
  const [method, setMethod] = useState<ConsentMethod>('verbal');
  const [jurisdiction, setJurisdiction] = useState('');
  const [notes, setNotes] = useState('');
  const [warning, setWarning] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset each time the dialog opens: consent is per call, never carried over from the last one.
  useEffect(() => {
    if (open) {
      setParticipants(['']);
      setMethod('verbal');
      setNotes('');
      setError(null);
      setSaving(false);
    }
  }, [open]);

  useEffect(() => {
    let cancelled = false;
    jurisdictionWarning(jurisdiction).then((w) => {
      if (!cancelled) setWarning(w);
    });
    return () => {
      cancelled = true;
    };
  }, [jurisdiction]);

  const namedParticipants = useMemo(
    () => participants.map((p) => p.trim()).filter(Boolean),
    [participants],
  );

  // At least one name. The record has to say who consented, or it is not evidence of anything.
  const canSubmit = namedParticipants.length > 0 && !saving;

  const updateParticipant = useCallback((index: number, value: string) => {
    setParticipants((prev) => prev.map((p, i) => (i === index ? value : p)));
  }, []);

  const removeParticipant = useCallback((index: number) => {
    setParticipants((prev) => (prev.length === 1 ? [''] : prev.filter((_, i) => i !== index)));
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const consentId = await recordConsent({
        meetingTitle: meetingTitle ?? null,
        participants: namedParticipants,
        method,
        jurisdiction: jurisdiction || null,
        notes: notes.trim() || null,
      });
      onOpenChange(false);
      onConsentRecorded(consentId);
    } catch (err) {
      // Fail closed. If the record could not be written there is no provable consent
      // (GDPR Art 7(1)), so the gate must stay shut rather than wave the recording through.
      console.error('Failed to record consent:', err);
      setError(
        err instanceof Error
          ? `Consent could not be saved: ${err.message}`
          : 'Consent could not be saved. Recording has not started.',
      );
      setSaving(false);
    }
  }, [
    canSubmit,
    meetingTitle,
    namedParticipants,
    method,
    jurisdiction,
    notes,
    onConsentRecorded,
    onOpenChange,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
            Confirm consent before recording
          </DialogTitle>
          <DialogDescription>
            Recording has not started yet. Ask everyone on the call, wait for a yes, then confirm
            here.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Jurisdiction first: it changes what the rest of the dialog is asking for. */}
          <div className="space-y-1.5">
            <Label htmlFor="consent-jurisdiction">Where is the other party?</Label>
            <select
              id="consent-jurisdiction"
              value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {JURISDICTION_OPTIONS.map((opt) => (
                <option key={opt.code || 'none'} value={opt.code}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {warning && (
            <div
              role="alert"
              className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-small"
            >
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500"
                aria-hidden="true"
              />
              <div className="space-y-1">
                <p className="font-medium text-foreground">
                  Every participant must agree, not just be told.
                </p>
                <p className="text-muted-foreground">{warning}</p>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Who consented?</Label>
            <p className="text-caption text-muted-foreground">
              Name each person. One participant cannot agree on behalf of the others.
            </p>
            <div className="space-y-2">
              {participants.map((participant, index) => (
                <div key={index} className="flex gap-2">
                  <Input
                    value={participant}
                    onChange={(e) => updateParticipant(index, e.target.value)}
                    placeholder={index === 0 ? 'e.g. Andrew (me)' : 'e.g. Frau Müller'}
                    aria-label={`Participant ${index + 1}`}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeParticipant(index)}
                    aria-label={`Remove participant ${index + 1}`}
                    disabled={participants.length === 1 && !participant}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setParticipants((prev) => [...prev, ''])}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add participant
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label>How was consent given?</Label>
            <div className="space-y-1.5">
              {METHOD_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border p-2.5 transition-colors hover:bg-muted/50 has-[:checked]:border-primary has-[:checked]:bg-primary/5"
                >
                  <input
                    type="radio"
                    name="consent-method"
                    value={opt.value}
                    checked={method === opt.value}
                    onChange={() => setMethod(opt.value)}
                    className="mt-0.5"
                  />
                  <span className="space-y-0.5">
                    <span className="block text-small font-medium text-foreground">{opt.label}</span>
                    <span className="block text-caption text-muted-foreground">{opt.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="consent-notes">Notes (optional)</Label>
            <Input
              id="consent-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything worth recording about how consent was given"
            />
          </div>

          {error && (
            <p role="alert" className="text-small text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!canSubmit}>
            {saving ? 'Saving…' : 'Consent given, start recording'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ConsentDialog;
