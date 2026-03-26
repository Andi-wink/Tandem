import React, { useState, useEffect } from 'react';
import { FolderOpen, Key, ExternalLink } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
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
          if (path) {
            setSelectedDir(path);
          } else {
            // Pre-recording: no active meeting yet — use base recordings dir as default
            invoke<string | null>('get_recordings_base_dir')
              .then(base => { if (base) setSelectedDir(base); })
              .catch(() => {});
          }
        })
        .catch(() => {});
    }
  }, [defaultDir]);

  const isKeyValid = keyInput.trim().startsWith('sk-ant-') && keyInput.trim().length > 20;
  const keyAlreadySet = !!(apiKey && apiKey.startsWith('sk-ant-') && apiKey.length > 20);
  const hasDirSelected = selectedDir.trim().length > 0;
  const canConfirm = (isKeyValid || keyAlreadySet) && hasDirSelected;

  const handleBrowse = async () => {
    try {
      const result = await invoke<string | null>('select_recording_folder', {
        startingDir: selectedDir || null,
      });
      if (result) {
        setSelectedDir(result);
        setUseDefault(false);
      }
    } catch (err) {
      console.error('Failed to open folder picker:', err);
    }
  };

  const handleConfirm = () => {
    if (!isKeyValid && !keyAlreadySet) return;
    if (!keyAlreadySet) setApiKey(keyInput.trim());
    onConfirm(selectedDir);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="max-w-[500px] gap-0 p-0">
        <DialogHeader className="px-4 py-3 border-b border-border">
          <DialogTitle className="text-sm">AI Assistant — Setup</DialogTitle>
          <DialogDescription className="sr-only">
            Configure API key and project directory for the AI assistant
          </DialogDescription>
        </DialogHeader>

        <div className="px-4 py-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            Set up the AI assistant for <strong>{meetingTitle}</strong>.
          </p>

          {/* API Key input — hidden when key is already saved */}
          {!keyAlreadySet && (
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
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-brand"
                autoFocus
              />
              {keyInput && !isKeyValid && (
                <p className="text-xs text-warning">API key should start with &quot;sk-ant-&quot;</p>
              )}
              <button
                onClick={() => invoke('open_external_url', { url: 'https://console.anthropic.com/' }).catch(console.error)}
                className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
              >
                Get an API key <ExternalLink className="w-3 h-3" />
              </button>
            </div>
          )}

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
                onChange={() => { setUseDefault(true); if (defaultDir) setSelectedDir(defaultDir); }}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">Meeting folder (default)</div>
                {useDefault && selectedDir ? (
                  <div className="text-xs text-muted-foreground truncate">{selectedDir}</div>
                ) : !useDefault && defaultDir ? (
                  <div className="text-xs text-muted-foreground truncate">{defaultDir}</div>
                ) : (
                  <div className="text-xs text-warning">Waiting for meeting folder...</div>
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
                <div className="flex items-center gap-2 mt-1 min-w-0">
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

        <DialogFooter className="px-4 py-3 border-t border-border">
          <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={handleConfirm} disabled={!canConfirm}>Start Session</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
