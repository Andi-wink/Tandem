import React, { useState, useEffect } from 'react';
import { FolderOpen, X, Key, ExternalLink } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useClaude } from '@/contexts/ClaudeContext';
import { listProjects, createProject } from '@/services/projectService';

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
  const [registerForSolo, setRegisterForSolo] = useState(false);
  const [alreadyRegistered, setAlreadyRegistered] = useState(false);

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

  // Check if the selected directory is already registered as a Solo project
  useEffect(() => {
    if (!selectedDir.trim()) {
      setAlreadyRegistered(false);
      return;
    }
    listProjects()
      .then(projects => {
        const norm = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
        setAlreadyRegistered(projects.some(p => norm(p.path) === norm(selectedDir)));
      })
      .catch(() => setAlreadyRegistered(false));
  }, [selectedDir]);

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

  const handleConfirm = async () => {
    if (!isKeyValid && !keyAlreadySet) return;
    if (!keyAlreadySet) setApiKey(keyInput.trim());

    if (registerForSolo && !alreadyRegistered && selectedDir.trim()) {
      const name = selectedDir.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || 'Project';
      try {
        await createProject(name, selectedDir, []);
        toast.success(`Registered "${name}" for Solo mode`);
      } catch (err) {
        toast.error('Failed to register for Solo mode', { description: String(err) });
        // Don't block the meeting flow — continue to onConfirm
      }
    }

    onConfirm(selectedDir);
  };

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

            {/* Solo mode registration opt-in */}
            {hasDirSelected && !alreadyRegistered && (
              <label className="flex items-start gap-2 px-1 pt-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={registerForSolo}
                  onChange={(e) => setRegisterForSolo(e.target.checked)}
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-foreground">Also register for Solo Mode</div>
                  <div className="text-xs text-muted-foreground">Route tasks here by voice in future solo sessions.</div>
                </div>
              </label>
            )}
            {hasDirSelected && alreadyRegistered && (
              <div className="text-xs text-muted-foreground px-1 pt-1">
                ✓ Already registered for Solo Mode
              </div>
            )}
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
