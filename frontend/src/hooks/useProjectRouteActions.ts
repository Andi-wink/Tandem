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
import { toast } from 'sonner';
import { useClaude } from '@/contexts/ClaudeContext';
import { useSoloMode } from '@/contexts/SoloModeContext';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { listProjects, Project } from '@/services/projectService';
import { matchProjectByName } from '@/services/soloRoutingService';
import { recordProjectDirUse } from '@/lib/projectDirHistory';
import { ensureTandemClaudeMd } from '@/services/handoffService';

export function useProjectRouteActions() {
  const { projectDir, meetingId, meetingTitle, openPanel } = useClaude();
  const { activeProject, sessionFolder, switchProject, clearActiveProject } = useSoloMode();
  const { transcripts } = useTranscripts();

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

  const fileUnder = useCallback(
    async (project: Project, signal: string) => {
      const prev = { dir: projectDirRef.current, active: activeProjectRef.current };
      const mId = meetingIdRef.current;
      const mTitle = meetingTitleRef.current;
      const len = transcriptsRef.current.length;

      // Apply: active project drives screenshot/whiteboard/feed routing; projectDir drives the AI
      // panel + live-transcript writer + @code handoff. Same meetingId preserves the conversation.
      switchProject(project, len);
      if (mId && mTitle) await openPanel(mId, mTitle, project.path, false);
      recordProjectDirUse(project.path, project.name, mTitle);
      ensureTandemClaudeMd(project.path, sessionFolderRef.current).catch(() => {});

      const undo = () => {
        const revertLen = transcriptsRef.current.length;
        if (prev.active) switchProject(prev.active, revertLen);
        else clearActiveProject();
        if (mId && mTitle) openPanel(mId, mTitle, prev.dir || '', false);
        toast.success(`Reverted to ${prev.active?.name ?? 'meeting folder'}`);
      };

      toast(`Filed under ${project.name}`, {
        description: `Matched ${signal}`,
        duration: 15000,
        action: { label: 'Undo', onClick: undo },
        cancel: {
          label: 'Change',
          onClick: () => window.dispatchEvent(new CustomEvent('tandem:open-project-picker')),
        },
      });
    },
    [switchProject, openPanel, clearActiveProject],
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
