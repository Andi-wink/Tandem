// F056: Custom Transcription Dictionary settings tab.
//
// CRUD over the terms that speech-to-text keeps getting wrong. Each entry is a
// correct term plus the mistranscriptions ("aliases") that should be rewritten
// into it. The Rust side uses the terms twice: to bias the Whisper decoder via
// initial_prompt, and to run a deterministic post-correction pass over every
// transcript segment from any provider.
'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { BookMarked, Plus, Pencil, Trash2, X, Upload, Download, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';

export interface DictionaryEntry {
  id: string;
  term: string;
  aliases: string[];
  enabled: boolean;
  created_at?: string;
  updated_at?: string;
}

/** Split the alias input on commas or newlines, so a user can paste either shape. */
function parseAliases(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map(a => a.trim())
    .filter(a => a.length > 0);
}

// ─── Editor ─────────────────────────────────────────────────────────────────

function EntryEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial?: DictionaryEntry;
  onSave: (entry: { id?: string; term: string; aliases: string[]; enabled: boolean }) => void;
  onCancel: () => void;
}) {
  const [term, setTerm] = useState(initial?.term ?? '');
  const [aliasText, setAliasText] = useState((initial?.aliases ?? []).join(', '));
  const [error, setError] = useState<string | null>(null);

  const preview = useMemo(() => parseAliases(aliasText), [aliasText]);

  const handleSave = () => {
    const trimmed = term.trim();
    if (!trimmed) {
      setError('Enter the word as it should appear in the transcript.');
      return;
    }
    onSave({
      id: initial?.id,
      term: trimmed,
      aliases: preview,
      enabled: initial?.enabled ?? true,
    });
  };

  return (
    <div className="border border-blue-200 dark:border-blue-800/40 rounded-lg p-4 bg-blue-50/50 dark:bg-blue-900/10 space-y-4">
      <div className="text-sm font-medium text-foreground">
        {initial ? 'Edit Term' : 'New Term'}
      </div>

      <div>
        <label className="block text-xs text-muted-foreground mb-1">
          Correct spelling
        </label>
        <input
          value={term}
          onChange={e => { setTerm(e.target.value); setError(null); }}
          placeholder="e.g. n8n"
          className="w-full border border-border rounded-md px-3 py-1.5 text-sm bg-background text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        />
      </div>

      <div>
        <label className="block text-xs text-muted-foreground mb-1">
          Heard as (comma or line separated)
        </label>
        <textarea
          value={aliasText}
          onChange={e => setAliasText(e.target.value)}
          rows={3}
          placeholder="n eight n, innate, and eight n"
          className="w-full border border-border rounded-md px-3 py-1.5 text-sm bg-background text-foreground font-mono focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Matching ignores case and only fires on whole words, so &quot;tandum&quot; never
          rewrites part of &quot;tandums&quot;.
        </p>
      </div>

      {preview.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Will correct:</span>
          {preview.map(alias => (
            <span
              key={alias}
              className="text-xs font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
            >
              {alias}
            </span>
          ))}
          <span className="text-xs text-muted-foreground">&rarr;</span>
          <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
            {term.trim() || '?'}
          </span>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
        >
          <Check className="w-3.5 h-3.5" />
          Save
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground rounded-md transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Import / Export ────────────────────────────────────────────────────────

function TransferPanel({
  mode,
  value,
  onChange,
  onConfirm,
  onClose,
}: {
  mode: 'import' | 'export';
  value: string;
  onChange: (v: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Dictionary copied to clipboard');
    } catch {
      toast.error('Could not reach the clipboard. Select the text and copy it manually.');
    }
  };

  return (
    <div className="border border-border rounded-lg p-4 bg-muted/30 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">
          {mode === 'import' ? 'Paste a dictionary JSON array' : 'Copy your dictionary'}
        </span>
        <button
          onClick={onClose}
          className="p-1 text-muted-foreground hover:text-foreground transition-colors"
          title="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        readOnly={mode === 'export'}
        rows={8}
        spellCheck={false}
        placeholder={'[\n  { "term": "n8n", "aliases": ["n eight n"] }\n]'}
        className="w-full border border-border rounded-md px-3 py-2 text-xs font-mono bg-background text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      />
      {mode === 'import' ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Terms that already exist are updated rather than duplicated, so importing
            the same list twice is safe.
          </p>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
          >
            Import
          </button>
        </div>
      ) : (
        <button
          onClick={copy}
          className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
        >
          Copy to clipboard
        </button>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function DictionarySettings() {
  const [entries, setEntries] = useState<DictionaryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null); // entry id, or '__new__'
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<'import' | 'export' | null>(null);
  const [transferText, setTransferText] = useState('');

  const reload = useCallback(async () => {
    try {
      const rows = await invoke<DictionaryEntry[]>('list_dictionary_entries');
      setEntries(rows);
    } catch (e) {
      console.error('Failed to load dictionary:', e);
      toast.error(`Could not load the dictionary: ${e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const handleSave = async (entry: { id?: string; term: string; aliases: string[]; enabled: boolean }) => {
    try {
      await invoke('upsert_dictionary_entry', {
        id: entry.id ?? null,
        term: entry.term,
        aliases: entry.aliases,
        enabled: entry.enabled,
      });
      setEditingId(null);
      await reload();
      toast.success(`"${entry.term}" saved`);
    } catch (e) {
      toast.error(`Could not save "${entry.term}": ${e}`);
    }
  };

  const handleToggle = async (entry: DictionaryEntry, enabled: boolean) => {
    // Optimistic: the switch should not lag behind the click.
    setEntries(prev => prev.map(x => (x.id === entry.id ? { ...x, enabled } : x)));
    try {
      await invoke('upsert_dictionary_entry', {
        id: entry.id,
        term: entry.term,
        aliases: entry.aliases,
        enabled,
      });
    } catch (e) {
      setEntries(prev => prev.map(x => (x.id === entry.id ? { ...x, enabled: !enabled } : x)));
      toast.error(`Could not update "${entry.term}": ${e}`);
    }
  };

  const handleDelete = async (entry: DictionaryEntry) => {
    try {
      await invoke('delete_dictionary_entry', { id: entry.id });
      setConfirmDeleteId(null);
      await reload();
      toast.success(`"${entry.term}" deleted`);
    } catch (e) {
      toast.error(`Could not delete "${entry.term}": ${e}`);
    }
  };

  const openExport = async () => {
    try {
      const json = await invoke<string>('export_dictionary');
      setTransferText(json);
      setTransfer('export');
    } catch (e) {
      toast.error(`Could not export the dictionary: ${e}`);
    }
  };

  const openImport = () => {
    setTransferText('');
    setTransfer('import');
  };

  const runImport = async () => {
    try {
      const result = await invoke<{ imported: number; skipped: number }>('import_dictionary', {
        json: transferText,
      });
      setTransfer(null);
      await reload();
      toast.success(
        `Imported ${result.imported} term${result.imported === 1 ? '' : 's'}` +
          (result.skipped > 0 ? `, skipped ${result.skipped} without a term` : ''),
      );
    } catch (e) {
      toast.error(`Import failed: ${e}`);
    }
  };

  const enabledCount = entries.filter(e => e.enabled).length;

  return (
    <div className="space-y-6 mt-6">
      <div className="bg-background rounded-lg border border-border p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h3 className="text-lg font-semibold text-foreground">Transcription Dictionary</h3>
            <p className="text-sm text-muted-foreground">
              Teach Tandem the words it keeps mishearing. Terms bias the transcription
              model up front, and any listed mistranscription is corrected in the
              transcript afterwards.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={openImport}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded-md transition-colors"
            >
              <Upload className="w-3.5 h-3.5" />
              Import
            </button>
            <button
              onClick={openExport}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded-md transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Export
            </button>
            <button
              onClick={() => { setEditingId('__new__'); setTransfer(null); }}
              disabled={editingId !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:pointer-events-none rounded-md transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              New Term
            </button>
          </div>
        </div>

        {transfer && (
          <div className="mb-4">
            <TransferPanel
              mode={transfer}
              value={transferText}
              onChange={setTransferText}
              onConfirm={runImport}
              onClose={() => setTransfer(null)}
            />
          </div>
        )}

        {editingId === '__new__' && (
          <div className="mb-4">
            <EntryEditor onSave={handleSave} onCancel={() => setEditingId(null)} />
          </div>
        )}

        {loading ? (
          <div className="space-y-2" aria-hidden>
            {[0, 1, 2].map(i => (
              <div key={i} className="h-12 rounded-md bg-muted/50 animate-pulse" />
            ))}
          </div>
        ) : entries.length === 0 && editingId !== '__new__' ? (
          <div className="py-10 text-center border border-dashed border-border rounded-md">
            <BookMarked className="w-6 h-6 mx-auto mb-3 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">
              No terms yet
            </p>
            <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
              Add the product names, jargon and acronyms your calls are full of, and
              they will stop coming back as nonsense in the transcript.
            </p>
            <button
              onClick={() => setEditingId('__new__')}
              className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Add your first term
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {entries.map(entry => (
              <div key={entry.id}>
                {editingId === entry.id ? (
                  <EntryEditor
                    initial={entry}
                    onSave={handleSave}
                    onCancel={() => setEditingId(null)}
                  />
                ) : confirmDeleteId === entry.id ? (
                  <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-md border border-destructive/40 bg-destructive/5">
                    <span className="text-sm text-foreground">
                      Delete &quot;{entry.term}&quot; from the dictionary?
                    </span>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => handleDelete(entry)}
                        className="px-2.5 py-1 text-xs text-white bg-destructive hover:opacity-90 rounded-md transition-opacity"
                      >
                        Delete
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        className="px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-md border border-border bg-muted/30 hover:bg-muted/50 transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                      <Switch
                        checked={entry.enabled}
                        onCheckedChange={checked => handleToggle(entry, checked)}
                        aria-label={`Enable ${entry.term}`}
                      />
                      <div className="min-w-0">
                        <span
                          className={`font-mono text-sm font-medium ${
                            entry.enabled ? 'text-foreground' : 'text-muted-foreground line-through'
                          }`}
                        >
                          {entry.term}
                        </span>
                        <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
                          {entry.aliases.length === 0 ? (
                            <span className="text-xs text-muted-foreground">
                              prompt hint only
                            </span>
                          ) : (
                            entry.aliases.map(alias => (
                              <span
                                key={alias}
                                className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-background border border-border text-muted-foreground"
                              >
                                {alias}
                              </span>
                            ))
                          )}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => { setEditingId(entry.id); setTransfer(null); }}
                        className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                        title="Edit"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(entry.id)}
                        className="p-1 text-muted-foreground hover:text-destructive transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {!loading && entries.length > 0 && (
          <p className="text-xs text-muted-foreground mt-4">
            {enabledCount} of {entries.length} term{entries.length === 1 ? '' : 's'} active.
            Changes apply to the next transcribed audio, no restart needed.
          </p>
        )}
      </div>

      <div className="bg-background rounded-lg border border-border p-6 shadow-sm">
        <h3 className="text-lg font-semibold text-foreground mb-2">How the dictionary is used</h3>
        <div className="text-sm text-muted-foreground space-y-2">
          <p>
            1. <strong className="text-foreground">Before transcription.</strong> Your terms are
            appended to the vocabulary hint given to the local Whisper decoder, so it is more
            likely to get the spelling right the first time.
          </p>
          <p>
            2. <strong className="text-foreground">After transcription.</strong> Every segment,
            from any transcription provider, is scanned for the mistranscriptions you listed and
            rewritten to the correct term.
          </p>
          <p className="text-xs mt-3">
            Matching is case-insensitive and whole-word only. Cloud providers that expose no
            vocabulary field still get step 2, which is why listing the mishearings matters more
            than listing the term alone.
          </p>
        </div>
      </div>
    </div>
  );
}
