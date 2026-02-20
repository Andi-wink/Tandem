import React, { useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';

interface ProjectDirModalProps {
  defaultDir: string;
  meetingTitle: string;
  onConfirm: (dir: string) => void;
  onCancel: () => void;
}

export function ProjectDirModal({ defaultDir, meetingTitle, onConfirm, onCancel }: ProjectDirModalProps) {
  const [selectedDir, setSelectedDir] = useState(defaultDir);
  const [useDefault, setUseDefault] = useState(true);

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-[420px] max-w-[90vw]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h3 className="font-semibold text-sm">Claude Code — Project Directory</h3>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-4 space-y-4">
          <p className="text-sm text-gray-600">
            Choose where Claude Code will work for <strong>{meetingTitle}</strong>.
            A CLAUDE.md with meeting context will be created here.
          </p>

          {/* Default: meeting folder */}
          <label className="flex items-start gap-2 p-3 rounded border border-gray-200 cursor-pointer hover:bg-gray-50">
            <input
              type="radio"
              name="dir"
              checked={useDefault}
              onChange={() => { setUseDefault(true); setSelectedDir(defaultDir); }}
              className="mt-0.5"
            />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">Meeting folder (default)</div>
              <div className="text-xs text-gray-400 truncate">{defaultDir}</div>
            </div>
          </label>

          {/* Custom: existing repo */}
          <label className="flex items-start gap-2 p-3 rounded border border-gray-200 cursor-pointer hover:bg-gray-50">
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
                <div className="text-xs text-gray-400 truncate flex-1">
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

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-200">
          <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={() => onConfirm(selectedDir)}>Start Session</Button>
        </div>
      </div>
    </div>
  );
}
