'use client';

import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getSpeakerColor, formatSpeakerLabel } from '@/lib/speakerColors';
import { updateSpeakerNames } from '@/services/diarizationService';
import { toast } from 'sonner';

interface SpeakerNamingModalProps {
  open: boolean;
  onClose: () => void;
  meetingId: string;
  speakerLabels: string[];
  /** First transcript quote per speaker for identification help */
  sampleQuotes?: Record<string, string>;
  initialNames?: Record<string, string>;
  onSave: (names: Record<string, string>) => void;
}

export function SpeakerNamingModal({
  open,
  onClose,
  meetingId,
  speakerLabels,
  sampleQuotes = {},
  initialNames = {},
  onSave,
}: SpeakerNamingModalProps) {
  const [names, setNames] = useState<Record<string, string>>(initialNames);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    // Filter out empty names
    const filtered: Record<string, string> = {};
    for (const [label, name] of Object.entries(names)) {
      if (name.trim()) filtered[label] = name.trim();
    }

    setSaving(true);
    try {
      await updateSpeakerNames(meetingId, filtered);
      onSave(filtered);
      toast.success('Speaker names saved');
      onClose();
    } catch (err) {
      toast.error(`Failed to save speaker names: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Name Speakers</DialogTitle>
          <DialogDescription>
            {speakerLabels.length} speaker{speakerLabels.length !== 1 ? 's' : ''} detected.
            Assign names to identify who said what.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {speakerLabels.map((label) => (
            <div key={label} className="space-y-1">
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold flex-shrink-0 ${getSpeakerColor(label)}`}>
                  {formatSpeakerLabel(label)}
                </span>
                <Input
                  placeholder={`Name for ${formatSpeakerLabel(label)}`}
                  value={names[label] || ''}
                  onChange={(e) => setNames(prev => ({ ...prev, [label]: e.target.value }))}
                  className="h-8 text-sm"
                />
              </div>
              {sampleQuotes[label] && (
                <p className="text-xs text-muted-foreground italic pl-1 truncate">
                  &ldquo;{sampleQuotes[label]}&rdquo;
                </p>
              )}
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save Names'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
