'use client';

/**
 * useProjectRouteActions — the single shared "file this meeting under project X" action, used by
 * auto-routing, the typed/voice "file this under X" override, and the Change/Move picker, so the
 * behaviour (re-point projectDir, set active project, learn the correction, toast with Undo) is
 * identical everywhere.
 *
 * No local state lives here: everything mutated is context state, and undo state is captured in the
 * toast closure. That makes it safe to mount more than one instance (page.tsx + ClaudePanel).
 */

import { useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { useClaude } from '@/contexts/ClaudeContext';
import { useSoloMode } from '@/contexts/SoloModeContext';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { listProjects, Project } from '@/services/projectService';
import { matchProjectByName } from '@/services/soloRoutingService';
import { recordProjectDirUse, forgetProjectDirUse, normalizeDir } from '@/lib/projectDirHistory';
import { ensureTandemClaudeMd, sessionScopeFolder, SESSION_SCOPE_PREFIX } from '@/services/handoffService';
import {
  setPendingRelocation,
  clearPendingRelocation,
} from '@/lib/pendingRelocation';

/** Options for fileUnder — opts win over stale context refs (load-bearing at recording-start). */
export interface FileUnderOpts {
  meetingId?: string;
  meetingTitle?: string;
  /** R3: skip the .tandem relocation (the folder was already created inside <project>/.tandem). */
  skipRelocation?: boolean;
}

/** Build a project's `.tandem` directory path with the platform separator of the project path. */
function tandemPathFor(projectPath: string): string {
  const sep = projectPath.includes('\\') ? '\\' : '/';
  return `${projectPath}${sep}.tandem`;
}

/** Parent directory of a folder path (used to move a folder back to where it actually was on undo).
 *  Mirrors FiledUnderRow.parentOf so both undo paths reverse to the true previous parent. */
function parentOf(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx > 0 ? trimmed.slice(0, idx) : trimmed;
}

export function useProjectRouteActions() {
  const { projectDir, meetingId, meetingTitle, openPanel } = useClaude();
  const { activeProject, sessionFolder, switchProject, clearActiveProject, setSessionFolder } = useSoloMode();
  const { transcripts } = useTranscripts();
  const recordingState = useRecordingState();
  const { refetchMeetings } = useSidebar();

  // Read volatile values off refs so the returned callbacks stay stable and never fire on a stale
  // closure (transcripts especially churns on every segment).
  const transcriptsRef = useRef(transcripts);
  transcriptsRef.current = transcripts;
  const projectDirRef = useRef(projectDir);
  projectDirRef.current = projectDir;
  const activeProjectRef = useRef(activeProject);
  activeProjectRef.current = activeProject;
  const meetingIdRef = useRef(meetingId);
  meetingIdRef.current = meetingId;
  const meetingTitleRef = useRef(meetingTitle);
  meetingTitleRef.current = meetingTitle;
  const sessionFolderRef = useRef(sessionFolder);
  sessionFolderRef.current = sessionFolder;
  // Recording state via ref only — reading isRecording directly would churn the callback and, in
  // page.tsx's eslint-disabled isRecording effect, re-fire it mid-call.
  const isRecordingRef = useRef(recordingState.isRecording);
  isRecordingRef.current = recordingState.isRecording;

  const fileUnder = useCallback(
    async (project: Project, signal: string, opts?: FileUnderOpts) => {
      const prev = { dir: projectDirRef.current, active: activeProjectRef.current };
      // opts win over refs (refs are stale in the same tick at recording-start — load-bearing).
      const mId = opts?.meetingId ?? meetingIdRef.current;
      const mTitle = opts?.meetingTitle ?? meetingTitleRef.current;
      const len = transcriptsRef.current.length;
      const projectTandem = tandemPathFor(project.path);

      // Re-scope the session folder to the TARGET project before anything writes.
      // `sessionFolder` state belongs to whatever was active a moment ago, so
      // reusing it here filed project B's feed, live transcript and screenshot
      // index under project A's chat folder (while the PNGs went to B, breaking
      // the links). Mirrors performProjectSwitch's derivation:
      //   - virtual sub-project → its own `sessions/<HH.MM, DD.MM - name>/`
      //   - plain project → the shared per-meeting folder, unless the folder we
      //     are holding is session-scoped (i.e. the previous project's chat), in
      //     which case fall back to the `.tandem` root.
      const targetFolder = project.session_id
        ? sessionScopeFolder(project.session_id, project.name, project.created_at)
        : sessionFolderRef.current?.startsWith(SESSION_SCOPE_PREFIX)
          ? null
          : sessionFolderRef.current;
      setSessionFolder(targetFolder);
      sessionFolderRef.current = targetFolder;

      // Apply: active project drives screenshot/whiteboard/feed routing; projectDir drives the AI
      // panel + live-transcript writer + @code handoff. Same meetingId preserves the conversation.
      switchProject(project, len, undefined, undefined, project.session_id ? targetFolder : null);
      if (mId && mTitle) await openPanel(mId, mTitle, project.path, false);
      recordProjectDirUse(project.path, project.name, mTitle);
      ensureTandemClaudeMd(project.path, targetFolder).catch(() => {});

      // ── R3: physically file the meeting folder into <project>/.tandem ──
      // Three cases:
      //  (a) skipRelocation — the folder was created inside .tandem at recording-start (seed path).
      //  (b) recording active — DEFER: never move under the live writer. Queue for useRecordingStop.
      //  (c) not recording (post-call) — relocate now via the saved meeting's folder_path.
      let relocationRan: { newPath: string; prevParent: string | null } | null = null;
      let deferred = false;
      if (!opts?.skipRelocation) {
        if (isRecordingRef.current) {
          // Bind the deferred relocation to THIS recording session (mId is the live-<ts> token set
          // at recording start). Without a token we cannot prove ownership at stop, so skip deferral
          // rather than risk filing an unrelated meeting — the user can still Move to project.
          if (mId) {
            setPendingRelocation({ meetingId: mId, toProjectPath: projectTandem, projectName: project.name });
            deferred = true;
          }
        } else if (mId && !mId.startsWith('live-')) {
          try {
            // Capture the TRUE previous parent before the move so Undo returns the folder to where
            // it actually was, which may be another project's .tandem (e.g. re-filing an already
            // filed meeting), not the default recordings base.
            let prevParent: string | null = null;
            try {
              const meta = (await invoke('api_get_meeting_metadata', { meetingId: mId })) as
                | { folder_path?: string }
                | null;
              if (meta?.folder_path) prevParent = parentOf(meta.folder_path);
            } catch {
              // Metadata read failed — Undo falls back to the recordings base below.
            }
            const newPath = await invoke<string>('relocate_meeting_folder', {
              meetingId: mId,
              destParentDir: projectTandem,
            });
            // Only treat as a real move when the folder actually landed under the project.
            if (normalizeDir(newPath).startsWith(normalizeDir(projectTandem))) {
              relocationRan = { newPath, prevParent };
            }
          } catch (e) {
            toast.error(`Filed under ${project.name}, but moving the files failed`, {
              description: `${e instanceof Error ? e.message : String(e)} The files stay in the recordings folder; use Move to project to retry.`,
            });
          }
        }
      }

      // Pull the new folder_path into the sidebar's in-memory meetings so the "By project" grouping
      // (and the palette's project chip) reflect the move immediately, without waiting for an
      // unrelated refetch. The sidebar's project registry re-loads off this same meetings change.
      if (relocationRan) void refetchMeetings();

      const undo = () => {
        const revertLen = transcriptsRef.current.length;
        if (prev.active) switchProject(prev.active, revertLen);
        else clearActiveProject();
        if (mId && mTitle) openPanel(mId, mTitle, prev.dir || '', false);
        // Cancel a queued relocation so a dismissed filing never moves anything.
        clearPendingRelocation();
        // Unlearn the frecency bump this filing recorded (recordProjectDirUse ran unconditionally
        // above), so a mis-route the user Undoes does not leave a permanent boost on the wrong
        // folder that would out-rank the correct one in the picker recents.
        forgetProjectDirUse(project.path);
        // If the relocation already ran (post-call), move the folder back to where it actually was
        // (its true previous parent, captured before the move), not blindly to the recordings base,
        // and refetch so the sidebar's "By project" grouping reflects the undo immediately.
        if (relocationRan && mId) {
          const back = relocationRan.prevParent;
          void (async () => {
            try {
              const dest = back ?? (await invoke<string | null>('get_recordings_base_dir'));
              if (dest) {
                await invoke('relocate_meeting_folder', { meetingId: mId, destParentDir: dest });
                void refetchMeetings();
              }
            } catch { /* best-effort */ }
          })();
        }
        toast.success(`Reverted to ${prev.active?.name ?? 'meeting folder'}`);
      };

      const description = relocationRan
        ? `Saved into ${project.name}/.tandem`
        : deferred
          ? `Matched ${signal} — files move into ${project.name}/.tandem when the recording saves`
          : `Matched ${signal}`;

      toast(`Filed under ${project.name}`, {
        description,
        duration: 15000,
        action: { label: 'Undo', onClick: undo },
        cancel: {
          label: 'Change',
          onClick: () => window.dispatchEvent(new CustomEvent('tandem:open-project-picker')),
        },
      });
    },
    [switchProject, openPanel, clearActiveProject, refetchMeetings],
  );

  /** Resolve a spoken/typed project name fuzzily and file under it; on a miss, offer the picker.
   *  Returns true either way (the command is consumed — it must never fall through to the AI). */
  const resolveAndFileUnder = useCallback(
    async (spokenName: string): Promise<boolean> => {
      let matched: Project | null = null;
      try {
        matched = matchProjectByName(spokenName, await listProjects());
      } catch {
        matched = null;
      }
      if (matched) {
        await fileUnder(matched, `"${spokenName}"`);
        return true;
      }
      toast.warning(`No project matching "${spokenName}"`, {
        action: {
          label: 'Pick project',
          onClick: () => window.dispatchEvent(new CustomEvent('tandem:open-project-picker')),
        },
      });
      return true;
    },
    [fileUnder],
  );

  return { fileUnder, resolveAndFileUnder };
}
