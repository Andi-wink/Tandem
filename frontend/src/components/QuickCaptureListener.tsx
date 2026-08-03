'use client';

/**
 * QuickCaptureListener: the main-window half of the global quick-capture feature
 * (the bar itself lives in its own window at /capture). Mounted once in the app shell.
 *
 * Responsibilities:
 *   1. Sync the "Quick capture enabled" preference to Rust on startup so the clipboard
 *      watcher matches the user's choice (the watcher only records while enabled).
 *   2. Toast a confirmation when a note is saved (naming the destination, so a misroute
 *      is visible).
 *   3. On Ctrl+Enter in the bar, inject the captured content into the AI panel context
 *      and reveal it.
 */

import { useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { useClaude } from '@/contexts/ClaudeContext';
import { deleteProject } from '@/services/projectService';
import { forgetProjectDirUse } from '@/lib/projectDirHistory';

/** localStorage flag for the Quick capture toggle. Default on when unset. */
export const QUICK_CAPTURE_ENABLED_KEY = 'tandem.quickCapture.enabled';

export function QuickCaptureListener() {
  const { captureIntoPanel } = useClaude();

  // Sync the stored preference to Rust once on mount.
  useEffect(() => {
    let enabled = true;
    try {
      enabled = localStorage.getItem(QUICK_CAPTURE_ENABLED_KEY) !== '0';
    } catch {
      /* ignore */
    }
    invoke('set_quick_capture_enabled', { enabled }).catch(() => {});
  }, []);

  // Wire up the Rust -> main-window events.
  useEffect(() => {
    let mounted = true;
    const unlisteners: UnlistenFn[] = [];
    const track = (fn: UnlistenFn) => {
      if (!mounted) fn();
      else unlisteners.push(fn);
    };

    listen<{ path: string; project: string | null }>('quick-capture-saved', event => {
      const project = event.payload?.project;
      toast.success(project ? `Captured to ${project}` : 'Captured to Unfiled');
    }).then(track);

    listen<{ content: string; project: string | null }>('quick-capture-to-ai', event => {
      const content = event.payload?.content ?? '';
      if (content.trim()) {
        captureIntoPanel(content, 'Quick capture');
        toast.success('Added to the AI panel');
      }
    }).then(track);

    // A new client folder was created from an unrouted capture. Deliberately does NOT
    // switch the active project: an inquiry arriving mid-recording must not silently
    // re-point where the running meeting's captures are being filed.
    listen<{
      name: string;
      path: string;
      created: boolean;
      written: string[];
      projectId: string | null;
    }>('inquiry-created', event => {
      const p = event.payload;
      if (!p?.name) return;
      const description = p.created
        ? p.projectId
          ? 'brief.md and CLAUDE.md written'
          : 'Folder created, but registering it as a project failed'
        : 'Folder already existed, the capture was appended to brief.md';

      toast.success(p.created ? `Created ${p.name}` : `Added to ${p.name}`, {
        description,
        duration: 15000,
        action: {
          label: 'Open in Antigravity',
          onClick: () => {
            invoke('open_in_antigravity', { path: p.path }).catch(err =>
              toast.error('Could not open Antigravity', { description: String(err) }),
            );
          },
        },
        // Undo only where there is something safe to undo: an adopted folder was not
        // ours to remove, and its brief.md append cannot be reversed by deleting a file.
        cancel: p.created
          ? {
              label: 'Undo',
              onClick: () => {
                void (async () => {
                  // Unregister first: the project row is the part that would otherwise
                  // keep pointing at a folder we are about to remove.
                  if (p.projectId) {
                    try {
                      await deleteProject(p.projectId);
                    } catch (err) {
                      console.error('[QuickCapture] inquiry unregister failed:', err);
                    }
                  }
                  // Unlearn the frecency bump the creation recorded, so an undone
                  // mis-created folder leaves no lasting boost in the picker recents.
                  forgetProjectDirUse(p.path);
                  try {
                    const removed = await invoke<boolean>('undo_inquiry', {
                      path: p.path,
                      written: p.written ?? [],
                    });
                    toast.success(
                      removed ? `Removed ${p.name}` : `Unregistered ${p.name}`,
                      removed
                        ? undefined
                        : { description: 'The folder had other files in it, so it is still on disk.' },
                    );
                  } catch (err) {
                    toast.error('Undo failed', { description: String(err) });
                  }
                })();
              },
            }
          : undefined,
      });
    }).then(track);

    listen<{ message: string }>('inquiry-ide-failed', event => {
      toast.error('Could not open Antigravity', {
        description: `${event.payload?.message ?? ''} The folder was still created.`,
      });
    }).then(track);

    return () => {
      mounted = false;
      unlisteners.forEach(fn => fn());
    };
  }, [captureIntoPanel]);

  return null;
}
