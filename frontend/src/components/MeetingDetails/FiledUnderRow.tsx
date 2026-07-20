'use client';

/**
 * FiledUnderRow — the meeting-details "Filed under" bar. Shows where a saved meeting physically
 * lives (its project, or the default recordings location) and lets the user fix a misfiled meeting
 * in two clicks: Move to another project, or Unfile back to the default location.
 *
 * Every folder move goes through the Rust `relocate_meeting_folder` command (verified move, then it
 * updates SQLite folder_path). We NEVER touch folder_path from the frontend directly, and we never
 * delete artifacts — the dated meeting folder (and its leaf name, which keys the whiteboard mirror)
 * is preserved by the command. Actions are disabled while this meeting is the live recording, and
 * when the meeting has no folder on disk yet.
 */

import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Folder, FolderInput, FolderUp, FolderOpen } from 'lucide-react';
import { ProjectPickerDialog } from '@/components/ProjectPickerDialog';
import { ProjectPickerSelection } from '@/components/ProjectPicker';
import { createProject, listProjects, Project } from '@/services/projectService';
import { getMatchPool, isDiscoveredStub } from '@/services/clientFolderDiscovery';
import { recordProjectDirUse, forgetProjectDirUse, normalizeDir } from '@/lib/projectDirHistory';
import { resolveFiledUnder } from '@/lib/filedUnder';
import { useRecordingState } from '@/contexts/RecordingStateContext';

interface FiledUnderRowProps {
  meetingId: string;
  meetingTitle: string;
  folderPath?: string | null;
  /** Notified with the new folder path after a successful move/unfile/undo, so the page can refresh. */
  onRelocated?: (newFolderPath: string) => void;
}

/** Build `<project>/.tandem` with the platform separator of the project path. */
function tandemPathFor(projectPath: string): string {
  const sep = projectPath.includes('\\') ? '\\' : '/';
  return `${projectPath}${sep}.tandem`;
}

/** Parent directory of a folder path (used to move a folder back on undo). */
function parentOf(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx > 0 ? trimmed.slice(0, idx) : trimmed;
}

export function FiledUnderRow({ meetingId, meetingTitle, folderPath, onRelocated }: FiledUnderRowProps) {
  // The current folder is owned locally so the row re-resolves immediately after a move without
  // waiting on a parent refetch (which does not re-issue metadata for the same meeting id).
  const [folder, setFolder] = useState<string | null>(folderPath ?? null);
  useEffect(() => { setFolder(folderPath ?? null); }, [folderPath]);

  const [pool, setPool] = useState<Project[]>([]);
  const [discovered, setDiscovered] = useState<Project[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { pool } = await getMatchPool();
        if (cancelled) return;
        setPool(pool);
        setDiscovered(pool.filter(isDiscoveredStub));
      } catch {
        // Degrade to registered-only; never block the row.
        try {
          const projects = await listProjects();
          if (!cancelled) setPool(projects);
        } catch { /* leave empty */ }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Is THIS meeting the one currently being recorded? The Rust command refuses to move a live
  // folder; the UI mirrors that by disabling the actions with a clear reason. The live recording
  // has no DB-persisted id yet, so we compare on physical folder path (the same identity Rust's
  // `is_folder_recording_active` uses) rather than a meeting id that can never overlap the route's.
  const { isRecording } = useRecordingState();
  const [liveFolder, setLiveFolder] = useState<string | null>(null);
  useEffect(() => {
    if (!isRecording) { setLiveFolder(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const p = await invoke<string | null>('get_meeting_folder_path');
        if (!cancelled) setLiveFolder(p ?? null);
      } catch {
        if (!cancelled) setLiveFolder(null);
      }
    })();
    return () => { cancelled = true; };
  }, [isRecording]);
  const isLive =
    isRecording && !!folder && !!liveFolder && normalizeDir(liveFolder) === normalizeDir(folder);
  const hasFolder = !!folder;
  const canModify = hasFolder && !isLive;

  const disabledReason = isLive
    ? 'This meeting is still recording. Filing completes automatically once the recording finishes saving.'
    : !hasFolder
      ? 'This meeting has no folder on disk yet, so there is nothing to move. It will file once it finishes saving.'
      : undefined;

  const filed = useMemo(
    () => resolveFiledUnder(folder, pool.map((p) => ({ name: p.name, path: p.path }))),
    [folder, pool],
  );

  // ── Relocation core: every move is a verified Rust move with an Undo that moves it back ──
  async function relocateWithUndo(
    destParentDir: string,
    opts: { successMsg: string; learn?: { path: string; name: string } },
  ): Promise<void> {
    if (!folder || busy) return;
    const prevParent = parentOf(folder);
    setBusy(true);
    try {
      const newPath = await invoke<string>('relocate_meeting_folder', {
        meetingId,
        destParentDir,
      });
      setFolder(newPath);
      onRelocated?.(newPath);
      // A manual correction is the strongest routing signal there is — teach the frecency store.
      if (opts.learn) recordProjectDirUse(opts.learn.path, opts.learn.name, meetingTitle);
      toast.success(opts.successMsg, {
        duration: 15000,
        action: {
          label: 'Undo',
          onClick: () => { void undoRelocate(prevParent, opts.learn); },
        },
      });
    } catch (e) {
      toast.error('Could not move the meeting', {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  async function undoRelocate(
    prevParent: string,
    learn?: { path: string; name: string },
  ): Promise<void> {
    setBusy(true);
    try {
      const back = await invoke<string>('relocate_meeting_folder', {
        meetingId,
        destParentDir: prevParent,
      });
      setFolder(back);
      onRelocated?.(back);
      // Unlearn the frecency bump the forward move recorded, so undoing a mistaken Move does not
      // leave a permanent boost on the wrong folder.
      if (learn) forgetProjectDirUse(learn.path);
      toast.success('Move undone');
    } catch (e) {
      toast.error('Could not undo the move', {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  async function handlePick(sel: ProjectPickerSelection): Promise<void> {
    setPickerOpen(false);
    let project = sel.project;
    // A browsed folder or a discovered client folder is adopted as a first-class project (same path
    // page.tsx's Move flow uses), so it carries an id/aliases going forward.
    if (!project || isDiscoveredStub(project)) {
      if (!sel.dir) { toast.error('No folder to file under'); return; }
      try {
        project = await createProject(sel.name, sel.dir, []);
      } catch (err) {
        toast.error('Failed to set project', { description: String(err) });
        return;
      }
    }
    await relocateWithUndo(tandemPathFor(project.path), {
      successMsg: `Moved to ${project.name}`,
      learn: { path: project.path, name: project.name },
    });
  }

  async function handleUnfile(): Promise<void> {
    const base = await invoke<string | null>('get_recordings_base_dir').catch(() => null);
    if (!base) { toast.error('Could not find the default recordings folder'); return; }
    await relocateWithUndo(base, { successMsg: 'Unfiled to the default recordings folder' });
  }

  async function handleReveal(): Promise<void> {
    if (!folder) return;
    try {
      await invoke('show_in_folder', { path: folder });
    } catch (e) {
      toast.error('Could not open the folder', {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <div
      data-testid="filed-under-row"
      className="flex flex-col gap-2 border-b border-border bg-muted/30 px-4 py-2"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Folder className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
        <button
          type="button"
          data-testid="filed-under-toggle"
          onClick={() => setExpanded((x) => !x)}
          aria-expanded={expanded}
          className="flex items-center gap-1.5 text-sm rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          <span className="text-muted-foreground">Filed under</span>
          {filed.filed ? (
            <span data-testid="filed-under-project" className="font-semibold text-foreground">
              {filed.projectName}
            </span>
          ) : (
            <span data-testid="filed-under-unfiled" className="font-medium text-foreground">
              Unfiled (default location)
            </span>
          )}
        </button>

        {hasFolder && (
          <button
            type="button"
            data-testid="filed-under-reveal"
            onClick={handleReveal}
            title="Show in Explorer"
            className="flex-shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <FolderOpen className="w-4 h-4" />
          </button>
        )}

        {/* Non-interactive path last: it truncates harmlessly under the floating AI/whiteboard
            buttons (fixed top-right), so no clickable control sits beneath them. */}
        <span
          data-testid="filed-under-path"
          title={folder ?? undefined}
          className="flex-1 min-w-0 truncate text-xs text-muted-foreground pr-20"
        >
          {folder ?? 'No folder on disk yet'}
        </span>
      </div>

      {expanded && (
        <div data-testid="filed-under-actions" className="flex items-center gap-2 pl-6">
          <button
            type="button"
            data-testid="filed-under-move"
            onClick={() => setPickerOpen(true)}
            disabled={!canModify || busy}
            title={disabledReason}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <FolderInput className="w-3.5 h-3.5" />
            Move to another project
          </button>

          {filed.filed && (
            <button
              type="button"
              data-testid="filed-under-unfile"
              onClick={handleUnfile}
              disabled={!canModify || busy}
              title={disabledReason}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <FolderUp className="w-3.5 h-3.5" />
              Unfile
            </button>
          )}
        </div>
      )}

      <ProjectPickerDialog
        open={pickerOpen}
        title="Move to another project"
        meetingTitle={meetingTitle}
        extraProjects={discovered}
        onClose={() => setPickerOpen(false)}
        onSelect={handlePick}
      />
    </div>
  );
}
