import React, { useState, useEffect, useRef } from 'react';
import { X, Key, ExternalLink } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useClaude } from '@/contexts/ClaudeContext';
import { listProjects, createProject } from '@/services/projectService';
import { ProjectPicker, ProjectPickerSelection } from '@/components/ProjectPicker';
import { recordProjectDirUse, bestHistoryMatch, normalizeDir } from '@/lib/projectDirHistory';

interface ProjectDirModalProps {
  defaultDir: string;
  meetingTitle: string;
  onConfirm: (dir: string) => void;
  onCancel: () => void;
}

export function ProjectDirModal({ defaultDir, meetingTitle, onConfirm, onCancel }: ProjectDirModalProps) {
  const { apiKey, setApiKey } = useClaude();
  const [meetingDir, setMeetingDir] = useState(defaultDir);
  const [selectedDir, setSelectedDir] = useState(defaultDir);
  const [keyInput, setKeyInput] = useState(apiKey || '');
  const [registerForSolo, setRegisterForSolo] = useState(false);
  const [alreadyRegistered, setAlreadyRegistered] = useState(false);
  const keyInputRef = useRef<HTMLInputElement>(null);
  // True once the user has actively picked a row (not just the seeded default), so a
  // freshly-picked unregistered folder is STAGED first — giving the "register for Solo"
  // checkbox a window — and a repeat pick (Enter/Enter, or Start Session) confirms.
  const stagedRef = useRef(false);

  // Resolve actual meeting folder path when no defaultDir is provided.
  useEffect(() => {
    if (defaultDir) {
      setMeetingDir(defaultDir);
      return;
    }
    invoke<string | null>('get_meeting_folder_path')
      .then(path => {
        if (path) {
          setMeetingDir(path);
        } else {
          // Pre-recording: no active meeting yet — use base recordings dir as default.
          invoke<string | null>('get_recordings_base_dir')
            .then(base => { if (base) setMeetingDir(base); })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, [defaultDir]);

  // Seed the initial selection from the best history match for this meeting title,
  // else fall back to the meeting folder — so a repeat client opens pre-selected.
  useEffect(() => {
    const best = bestHistoryMatch(meetingTitle);
    if (best) setSelectedDir(best.dir);
    else if (meetingDir) setSelectedDir(meetingDir);
  }, [meetingTitle, meetingDir]);

  // Check if the selected directory is already registered as a Solo project.
  useEffect(() => {
    if (!selectedDir.trim()) {
      setAlreadyRegistered(false);
      return;
    }
    listProjects()
      .then(projects => {
        setAlreadyRegistered(projects.some(p => normalizeDir(p.path) === normalizeDir(selectedDir)));
      })
      .catch(() => setAlreadyRegistered(false));
  }, [selectedDir]);

  const isKeyValid = keyInput.trim().startsWith('sk-ant-') && keyInput.trim().length > 20;
  const keyAlreadySet = !!(apiKey && apiKey.startsWith('sk-ant-') && apiKey.length > 20);
  const hasDirSelected = selectedDir.trim().length > 0;
  const canConfirm = (isKeyValid || keyAlreadySet) && hasDirSelected;

  const handleConfirm = async (dirOverride?: string) => {
    const dir = (dirOverride ?? selectedDir).trim();
    // Key must be valid before we can start; if not, focus the key input instead of silently failing.
    if (!isKeyValid && !keyAlreadySet) {
      keyInputRef.current?.focus();
      return;
    }
    if (!dir) return;
    if (!keyAlreadySet) setApiKey(keyInput.trim());

    const name = dir.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || 'Project';

    if (registerForSolo && !alreadyRegistered) {
      try {
        await createProject(name, dir, []);
        toast.success(`Registered "${name}" for Solo mode`);
      } catch (err) {
        toast.error('Failed to register for Solo mode', { description: String(err) });
        // Don't block the meeting flow — continue to onConfirm
      }
    }

    recordProjectDirUse(dir, name, meetingTitle);
    onConfirm(dir);
  };

  // B026: Close on Escape from anywhere in the modal (the picker input also wires Escape->onCancel).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  // Picker selection. If the key is missing, just stage the dir and focus the key input.
  // Otherwise:
  //   - A registered Solo project needs no opt-in — confirm immediately (one Enter).
  //   - A new/unregistered folder is STAGED on first pick so the "register for Solo"
  //     checkbox is reachable; a repeat pick of the same folder (Enter/Enter, click/click,
  //     or the Start Session button) then confirms.
  const handlePickerSelect = (sel: ProjectPickerSelection) => {
    if (!(isKeyValid || keyAlreadySet)) {
      setSelectedDir(sel.dir);
      keyInputRef.current?.focus();
      return;
    }
    const isRegisteredProject = sel.source === 'project';
    const repeatPick = stagedRef.current && normalizeDir(sel.dir) === normalizeDir(selectedDir);
    setSelectedDir(sel.dir);
    stagedRef.current = true;
    if (isRegisteredProject || repeatPick) {
      handleConfirm(sel.dir);
    }
  };

  return (
    // B027: Close on backdrop click
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div className="bg-background rounded-lg shadow-xl w-[440px] max-w-[90vw]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="font-semibold text-sm">AI Assistant — Setup</h3>
          <button
            onClick={onCancel}
            className="text-muted-foreground hover:text-foreground rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
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
                ref={keyInputRef}
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder="sk-ant-..."
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              />
              {keyInput && !isKeyValid && (
                <p className="text-xs text-warning">API key should start with &quot;sk-ant-&quot;</p>
              )}
              <a
                href="https://console.anthropic.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
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

            <ProjectPicker
              defaultDir={meetingDir}
              defaultLabel="Meeting folder (default)"
              meetingTitle={meetingTitle}
              onSelect={handlePickerSelect}
              onEscape={onCancel}
            />

            {/* Show exactly what Enter / Start Session will use */}
            {hasDirSelected && (
              <div className="text-xs text-muted-foreground truncate" title={selectedDir}>
                Selected: {selectedDir}
              </div>
            )}

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
          <Button size="sm" onClick={() => handleConfirm()} disabled={!canConfirm}>Start Session</Button>
        </div>
      </div>
    </div>
  );
}
