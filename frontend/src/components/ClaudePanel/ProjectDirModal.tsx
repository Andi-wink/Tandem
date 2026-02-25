import React, { useState, useEffect } from 'react';
import { FolderOpen, X, Key, ExternalLink } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import { useClaude } from '@/contexts/ClaudeContext';

interface ProjectDirModalProps {
  defaultDir: string;
  meetingTitle: string;
  onConfirm: (dir: string) => void;
  onCancel: () => void;
}

export function ProjectDirModal({ defaultDir, meetingTitle, onConfirm, onCancel }: ProjectDirModalProps) {
  const { apiKey, setApiKey } = useClaude();
  const [selectedDir, setSelectedDir] = useState(defaultDir);
  const [useDefault, setUseDefault] = useState(true);
  const [keyInput, setKeyInput] = useState(apiKey || '');

  // Resolve actual meeting folder path when no defaultDir is provided
  useEffect(() => {
    if (!defaultDir) {
      invoke<string | null>('get_meeting_folder_path')
        .then(path => {
          if (path) setSelectedDir(path);
        })
        .catch(() => {});
    }
  }, [defaultDir]);

  const handleBrowse = async () => {
    try {
      const result = await invoke<string | null>('select_recording_folder');
      if (result) {
        setSelectedDir(result);
        setUseDefault(false);
      }
    } catch (err) {
      console.error('Failed to open folder picker:', err);
    }
  };

  const handleConfirm = () => {
    if (!isKeyValid) return;
    setApiKey(keyInput.trim());
    onConfirm(selectedDir);
  };

  const isKeyValid = keyInput.trim().startsWith('sk-ant-') && keyInput.trim().length > 20;
  const hasDirSelected = selectedDir.trim().length > 0;
  const canConfirm = isKeyValid && hasDirSelected;

  // B026: Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  return (
    // B027: Close on backdrop click
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div className="bg-background rounded-lg shadow-xl w-[420px] max-w-[90vw]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="font-semibold text-sm">AI Assistant — Setup</h3>
          <button onClick={onCancel} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            Set up the AI assistant for <strong>{meetingTitle}</strong>.
          </p>

          {/* API Key input */}
          <div className="space-y-2">
            <label className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <Key className="w-3.5 h-3.5" />
              Anthropic API Key
            </label>
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="sk-ant-..."
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {keyInput && !isKeyValid && (
              <p className="text-xs text-amber-600">API key should start with &quot;sk-ant-&quot;</p>
            )}
            <a
              href="https://console.anthropic.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
            >
              Get an API key <ExternalLink className="w-3 h-3" />
            </a>
          </div>

          {/* Project directory selection */}
          <div className="space-y-2">
            <div className="text-sm font-medium text-foreground">Project Directory</div>
            <p className="text-xs text-muted-foreground">
              Where the AI assistant will work. A CLAUDE.md with meeting context will be created here.
            </p>

            {/* Default: meeting folder */}
            <label className="flex items-start gap-2 p-3 rounded border border-border cursor-pointer hover:bg-muted">
              <input
                type="radio"
                name="dir"
                checked={useDefault}
                onChange={() => { setUseDefault(true); setSelectedDir(defaultDir); }}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">Meeting folder (default)</div>
                {useDefault && selectedDir ? (
                  <div className="text-xs text-muted-foreground truncate">{selectedDir}</div>
                ) : !useDefault && defaultDir ? (
                  <div className="text-xs text-muted-foreground truncate">{defaultDir}</div>
                ) : (
                  <div className="text-xs text-amber-500">Waiting for meeting folder...</div>
                )}
              </div>
            </label>

            {/* Custom: existing repo */}
            <label className="flex items-start gap-2 p-3 rounded border border-border cursor-pointer hover:bg-muted">
              <input
                type="radio"
                name="dir"
                checked={!useDefault}
                onChange={() => setUseDefault(false)}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">Existing repository</div>
                <div className="flex items-center gap-2 mt-1">
                  <div className="text-xs text-muted-foreground truncate flex-1">
                    {!useDefault ? selectedDir : 'Select a folder...'}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleBrowse}
                    disabled={useDefault}
                    className="flex-shrink-0"
                  >
                    <FolderOpen className="w-3 h-3 mr-1" />
                    Browse
                  </Button>
                </div>
              </div>
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
          <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={handleConfirm} disabled={!canConfirm}>Start Session</Button>
        </div>
      </div>
    </div>
  );
}
