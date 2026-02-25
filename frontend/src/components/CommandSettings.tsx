// F018: Commands & Skills settings tab — view built-in commands and create/edit/delete custom ones.
'use client';

import React, { useState, useEffect } from 'react';
import { Plus, Pencil, Trash2, RotateCcw, Zap, ChevronDown, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import {
  SlashCommand,
  BUILT_IN_COMMANDS,
  loadCustomCommands,
  saveCustomCommands,
} from '@/lib/slashCommands';

// ─── Editor Modal ───────────────────────────────────────────────────────────

function CommandEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial?: SlashCommand;
  onSave: (cmd: SlashCommand) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [promptTemplate, setPromptTemplate] = useState(
    initial?.promptTemplate ?? `Analyze the following conversation.

{user_input_section}

## Conversation
{transcript_context}`,
  );
  const [error, setError] = useState<string | null>(null);

  const handleSave = () => {
    const trimmedName = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!trimmedName) {
      setError('Command name is required');
      return;
    }
    if (!promptTemplate.includes('{transcript_context}')) {
      setError('Prompt template must include {transcript_context} placeholder');
      return;
    }
    onSave({
      name: trimmedName,
      description: description.trim() || `Custom command: ${trimmedName}`,
      icon: 'Zap',
      promptTemplate,
      isBuiltIn: false,
    });
  };

  return (
    <div className="border border-blue-200 dark:border-blue-800/40 rounded-lg p-4 bg-blue-50/50 dark:bg-blue-900/10 space-y-4">
      <div className="text-sm font-medium text-foreground">
        {initial ? 'Edit Command' : 'New Command'}
      </div>

      {/* Name */}
      <div>
        <label className="block text-xs text-muted-foreground mb-1">
          Command name (used as <code className="bg-muted px-1 rounded">/name</code>)
        </label>
        <input
          value={name}
          onChange={e => { setName(e.target.value); setError(null); }}
          placeholder="e.g. competitors"
          className="w-full border border-border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Description */}
      <div>
        <label className="block text-xs text-muted-foreground mb-1">
          Description (shown in autocomplete)
        </label>
        <input
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="e.g. Identify competitive mentions"
          className="w-full border border-border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Prompt Template */}
      <div>
        <label className="block text-xs text-muted-foreground mb-1">
          Prompt template
        </label>
        <p className="text-[11px] text-muted-foreground mb-2">
          Use <code className="bg-muted px-1 rounded">{'{transcript_context}'}</code> where live transcript should be inserted,
          and <code className="bg-muted px-1 rounded">{'{user_input_section}'}</code> for any extra text the user types after the command.
        </p>
        <textarea
          value={promptTemplate}
          onChange={e => { setPromptTemplate(e.target.value); setError(null); }}
          rows={8}
          className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
        />
      </div>

      {error && (
        <div className="text-xs text-red-500">{error}</div>
      )}

      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded-md"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-700 rounded-md"
        >
          {initial ? 'Save Changes' : 'Create Command'}
        </button>
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function CommandSettings() {
  const [customCommands, setCustomCommands] = useState<SlashCommand[]>([]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null); // index in customCommands, or -1 for "new"
  const [showBuiltIn, setShowBuiltIn] = useState(false);

  useEffect(() => {
    setCustomCommands(loadCustomCommands());
  }, []);

  const persist = (cmds: SlashCommand[]) => {
    setCustomCommands(cmds);
    saveCustomCommands(cmds);
  };

  const handleSave = (cmd: SlashCommand) => {
    if (editingIndex === -1) {
      // New command — check for name collision with existing custom commands
      if (customCommands.some(c => c.name === cmd.name)) {
        toast.error(`A custom command named /${cmd.name} already exists`);
        return;
      }
      persist([...customCommands, cmd]);
      toast.success(`Command /${cmd.name} created`);
    } else if (editingIndex !== null) {
      // Edit existing
      const updated = [...customCommands];
      updated[editingIndex] = cmd;
      persist(updated);
      toast.success(`Command /${cmd.name} updated`);
    }
    setEditingIndex(null);
  };

  const handleDelete = (index: number) => {
    const cmd = customCommands[index];
    persist(customCommands.filter((_, i) => i !== index));
    toast.success(`Command /${cmd.name} deleted`);
    if (editingIndex === index) setEditingIndex(null);
  };

  return (
    <div className="space-y-6 mt-6">
      {/* Custom Commands Section */}
      <div className="bg-background rounded-lg border border-border p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold text-foreground">Custom Commands</h3>
            <p className="text-sm text-muted-foreground">
              Create slash commands that trigger AI workflows during meetings.
              Type <code className="bg-muted px-1 rounded text-xs">/name</code> in the AI panel to use them.
            </p>
          </div>
          <button
            onClick={() => setEditingIndex(-1)}
            disabled={editingIndex !== null}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-md"
          >
            <Plus className="w-3.5 h-3.5" />
            New Command
          </button>
        </div>

        {/* New command editor */}
        {editingIndex === -1 && (
          <div className="mb-4">
            <CommandEditor
              onSave={handleSave}
              onCancel={() => setEditingIndex(null)}
            />
          </div>
        )}

        {/* Custom command list */}
        {customCommands.length === 0 && editingIndex !== -1 && (
          <div className="text-sm text-muted-foreground py-4 text-center border border-dashed border-border rounded-md">
            No custom commands yet. Click "New Command" to create one.
          </div>
        )}

        <div className="space-y-2">
          {customCommands.map((cmd, i) => (
            <div key={cmd.name}>
              {editingIndex === i ? (
                <CommandEditor
                  initial={cmd}
                  onSave={handleSave}
                  onCancel={() => setEditingIndex(null)}
                />
              ) : (
                <div className="flex items-center justify-between px-3 py-2.5 rounded-md border border-border bg-muted/30 hover:bg-muted/50">
                  <div className="flex items-center gap-3 min-w-0">
                    <Zap className="w-4 h-4 text-blue-500 flex-shrink-0" />
                    <div className="min-w-0">
                      <span className="font-mono text-sm font-medium">/{cmd.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground truncate">{cmd.description}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => setEditingIndex(i)}
                      className="p-1 text-muted-foreground hover:text-foreground"
                      title="Edit"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(i)}
                      className="p-1 text-muted-foreground hover:text-red-500"
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
      </div>

      {/* Built-in Commands Reference */}
      <div className="bg-background rounded-lg border border-border p-6 shadow-sm">
        <button
          onClick={() => setShowBuiltIn(!showBuiltIn)}
          className="flex items-center gap-2 w-full text-left"
        >
          {showBuiltIn ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          <h3 className="text-lg font-semibold text-foreground">Built-in Commands</h3>
          <span className="text-xs text-muted-foreground">({BUILT_IN_COMMANDS.length})</span>
        </button>
        {showBuiltIn && (
          <div className="mt-4 space-y-2">
            <p className="text-sm text-muted-foreground mb-3">
              These commands are always available. Create a custom command with the same name to override one.
            </p>
            {BUILT_IN_COMMANDS.map(cmd => (
              <div
                key={cmd.name}
                className="flex items-center gap-3 px-3 py-2 rounded-md border border-border bg-muted/20"
              >
                <div className="min-w-0 flex-1">
                  <span className="font-mono text-sm font-medium">/{cmd.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{cmd.description}</span>
                </div>
                <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded flex-shrink-0">built-in</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* How it works */}
      <div className="bg-background rounded-lg border border-border p-6 shadow-sm">
        <h3 className="text-lg font-semibold text-foreground mb-2">How Slash Commands Work</h3>
        <div className="text-sm text-muted-foreground space-y-2">
          <p>1. Open the AI panel during a meeting and type <code className="bg-muted px-1 rounded">/</code> to see available commands.</p>
          <p>2. Select a command — from that moment, live transcript is captured as context.</p>
          <p>3. Optionally type additional instructions after the command name.</p>
          <p>4. Press Enter — the AI receives the command's prompt template filled with the captured transcript.</p>
          <p className="text-xs mt-3">
            <strong>Template placeholders:</strong>{' '}
            <code className="bg-muted px-1 rounded">{'{transcript_context}'}</code> = live transcript captured since command activation,{' '}
            <code className="bg-muted px-1 rounded">{'{user_input_section}'}</code> = any text typed after the command name.
          </p>
        </div>
      </div>
    </div>
  );
}