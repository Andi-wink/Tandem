'use client';

/**
 * Solo Mode Routing Hook
 *
 * Runs during Solo recording. Every ~30 seconds (or when 5+ new transcript
 * segments arrive), calls Gemma via Ollama to classify transcript into
 * intents/notes and detect project switches.
 *
 * All events (intents, notes, screenshots, clipboard, project switches) are
 * appended to {project}/.tandem/feed.md — a single chronological stream that
 * Claude Code's /loop consumes.
 */

import { useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useSoloMode } from '@/contexts/SoloModeContext';
import { listProjects, Project } from '@/services/projectService';
import { analyzeTranscript, matchProjectByName, warmupModel, detectProjectSwitchFastPath } from '@/services/soloRoutingService';
import {
  writeLiveTranscript,
  writeLiveScreenshots,
  getRecentTranscripts,
  LIVE_TRANSCRIPT_WINDOW_SECS,
  ensureTandemClaudeMd,
  appendFeedEntry,
  buildScreenshotFeedEntry,
  buildClipboardFeedEntry,
  ensureLoopState,
  buildSessionFolderName,
} from '@/services/handoffService';
import { invoke } from '@tauri-apps/api/core';
import { useScreenshots } from '@/contexts/ScreenshotContext';
import { useClipboard } from '@/contexts/ClipboardContext';

const ROUTING_INTERVAL_MS = 30_000;
const MIN_NEW_SEGMENTS = 5;
const TRANSCRIPT_WRITE_DEBOUNCE_MS = 10_000;
const RESPONSE_POLL_MS = 10_000;
const PROJECT_REFRESH_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const INTENT_DEDUP_WINDOW_MS = 5 * 60_000; // 5 min

function normalizeIntent(s: string): string {
  return s.trim().toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').slice(0, 120);
}

export function useSoloModeRouter() {
  const { transcripts, meetingTitle } = useTranscripts();
  const { isRecording } = useRecordingState();
  const { screenshots } = useScreenshots();
  const { clipboardItems } = useClipboard();
  const {
    isActive,
    activeProject,
    routingModel,
    projectHistory,
    sessionFolder,
    switchProject,
    setSessionFolder,
    addTask,
    getActiveProjectHistory,
  } = useSoloMode();

  // ── Refs for volatile state (stable callback identity) ──────────────
  const transcriptsRef = useRef(transcripts);
  transcriptsRef.current = transcripts;

  const activeProjectRef = useRef(activeProject);
  activeProjectRef.current = activeProject;

  const sessionFolderRef = useRef(sessionFolder);
  sessionFolderRef.current = sessionFolder;

  const routingModelRef = useRef(routingModel);
  routingModelRef.current = routingModel;

  const screenshotsRef = useRef(screenshots);
  screenshotsRef.current = screenshots;

  const meetingTitleRef = useRef(meetingTitle);
  meetingTitleRef.current = meetingTitle;

  // ── Internal refs ───────────────────────────────────────────────────
  const lastProcessedIndexRef = useRef<number>(0);
  const routingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcriptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTranscriptCountRef = useRef<number>(0);
  const projectsRef = useRef<Project[]>([]);
  const responsePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const projectRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const consecutiveFailuresRef = useRef<number>(0);
  const failureToastShownRef = useRef<boolean>(false);
  const isRoutingRef = useRef<boolean>(false);
  const lastScreenshotCountRef = useRef<number>(0);
  const lastClipboardCountRef = useRef<number>(0);
  const recentIntentsRef = useRef<Array<{ hash: string; ts: number }>>([]);
  const lastIntentRef = useRef<{ description: string; projectPath: string } | null>(null);

  // ── Load projects on session start + periodic refresh ───────────────
  useEffect(() => {
    if (!isActive) return;

    const fetchProjects = () => {
      listProjects().then(projects => {
        projectsRef.current = projects;
        console.log(`[SoloRouter] Loaded ${projects.length} projects`);
      }).catch(err => {
        console.error('[SoloRouter] Failed to load projects:', err);
      });
    };

    fetchProjects();
    projectRefreshRef.current = setInterval(fetchProjects, PROJECT_REFRESH_MS);

    // Pre-warm the routing model into VRAM so the first cycle doesn't cold-start
    warmupModel(routingModelRef.current);

    return () => {
      if (projectRefreshRef.current) clearInterval(projectRefreshRef.current);
    };
  }, [isActive]);

  // ── Shared project-switch side-effects ──────────────────────────────
  // Both the auto-router (LLM-detected switch) and the manual HUD correction
  // go through this so a manual switch behaves IDENTICALLY to an auto-switch:
  // update solo state, lazily compute the session folder, ensure CLAUDE.md +
  // loop state, append a session_start feed entry, and toast.
  // Returns the resolved session folder (so the caller's current cycle can keep
  // appending to the freshly-switched project in the same folder).
  const performProjectSwitch = useCallback(
    async (matched: Project, transcriptIndex: number): Promise<string> => {
      const previousProject = activeProjectRef.current;
      switchProject(matched, transcriptIndex);

      let activeSessionFolder = sessionFolderRef.current;
      if (!activeSessionFolder) {
        activeSessionFolder = buildSessionFolderName(meetingTitleRef.current || 'Solo');
        setSessionFolder(activeSessionFolder);
        sessionFolderRef.current = activeSessionFolder;
        toast.info(`Session folder: .tandem/${activeSessionFolder}`, { duration: 6000 });
      }

      toast.success(`Switched to ${matched.name}`);
      await ensureTandemClaudeMd(matched.path, activeSessionFolder);
      await ensureLoopState(matched.path, activeSessionFolder);

      try {
        await appendFeedEntry(matched.path, {
          type: 'session_start',
          timestamp: new Date(),
          body: `Solo session active on ${matched.name}`,
          meta: previousProject ? { switched_from: previousProject.name } : {},
        }, activeSessionFolder);
      } catch (err) {
        console.warn('[SoloRouter] Failed to append session_start entry:', err);
      }

      return activeSessionFolder;
    },
    [switchProject, setSessionFolder],
  );

  // ── Core routing (stable — reads everything from refs) ──────────────
  const runRouting = useCallback(async (requireMinSegments = false) => {
    if (isRoutingRef.current) return;

    const projects = projectsRef.current;
    if (projects.length === 0) {
      console.log('[SoloRouter] No projects registered, skipping');
      return;
    }

    const currentTranscripts = transcriptsRef.current;
    const newSegments = currentTranscripts.slice(lastProcessedIndexRef.current);
    if (newSegments.length === 0) return;
    if (requireMinSegments && newSegments.length < MIN_NEW_SEGMENTS) return;

    isRoutingRef.current = true;
    console.log(`[SoloRouter] Analyzing ${newSegments.length} new segments`);
    lastProcessedIndexRef.current = currentTranscripts.length;

    // Carries the project switched-to THIS cycle (fast-path or LLM) so later
    // appends in this cycle attribute to it, and so we never double-switch.
    let switchedTo: Project | null = null;
    let activeSessionFolder = sessionFolderRef.current;

    try {
      // ── Fast-path switch (no LLM) ─────────────────────────────────────
      // Explicit declarations ("I'm working on the X project", "switch to X")
      // switch instantly and deterministically — even if Ollama is slow/cold/
      // down. Only matches REGISTERED projects; everything else falls through to
      // the LLM below, so coverage never drops.
      const fastMatch = detectProjectSwitchFastPath(
        newSegments.map(s => s.text).join(' '),
        projects,
      );
      if (fastMatch && fastMatch.id !== activeProjectRef.current?.id) {
        console.log(`[SoloRouter] Fast-path switch → ${fastMatch.name} (no LLM)`);
        activeSessionFolder = await performProjectSwitch(fastMatch, currentTranscripts.length);
        switchedTo = fastMatch;
      }

      const decision = await analyzeTranscript(
        newSegments,
        projects,
        activeProjectRef.current,
        routingModelRef.current,
      );

      if (!decision) {
        consecutiveFailuresRef.current++;
        if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_FAILURES && !failureToastShownRef.current) {
          failureToastShownRef.current = true;
          toast.warning('Solo routing paused — Ollama not responding', {
            description: 'Check that Ollama is running and the routing model is available.',
            duration: 10000,
          });
        }
        return;
      }

      consecutiveFailuresRef.current = 0;
      if (failureToastShownRef.current) {
        failureToastShownRef.current = false;
        toast.success('Solo routing reconnected');
      }

      console.log('[SoloRouter] Decision:', {
        switch_detected: decision.project_switch.detected,
        switch_name: decision.project_switch.project_name,
        switch_confidence: decision.project_switch.confidence,
        intents: decision.intents.length,
        notes: decision.notes.length,
        revoke_last: decision.revoke_last,
        stop: decision.stop_detected,
      });

      // Compute / resolve the per-session subfolder name. Lazy-init on the first
      // project switch so meetingTitle has a chance to be set first. Once set,
      // it's reused across the rest of this Solo session — even if the user
      // switches projects, each project's `.tandem/{folder}/` mirrors the same
      // session folder name so the user can grep / archive by name.
      activeSessionFolder = sessionFolderRef.current ?? activeSessionFolder;

      // Project switch — only if the fast-path didn't already switch this cycle.
      if (!switchedTo && decision.project_switch.detected && decision.project_switch.project_name) {
        const matched = matchProjectByName(decision.project_switch.project_name, projects);
        if (matched && matched.id !== activeProjectRef.current?.id) {
          activeSessionFolder = await performProjectSwitch(matched, currentTranscripts.length);
          switchedTo = matched;
        } else if (!matched) {
          toast.warning(
            `Didn't recognize "${decision.project_switch.project_name}". Add it in Settings > Projects.`,
          );
        }
      }

      // Use the just-switched project if we did switch this cycle; setState hasn't propagated to the ref yet
      const currentActive = switchedTo ?? activeProjectRef.current;

      // Revocation — write a revoke entry referencing the last intent
      if (decision.revoke_last && lastIntentRef.current) {
        const revokeTarget = lastIntentRef.current;
        try {
          await appendFeedEntry(revokeTarget.projectPath, {
            type: 'revoke',
            timestamp: new Date(),
            body: `User retracted the most recent intent: "${revokeTarget.description}"`,
          }, activeSessionFolder);
          toast.info(`Revoked: ${revokeTarget.description.slice(0, 60)}`);
        } catch (err) {
          console.error('[SoloRouter] Failed to append revoke entry:', err);
        }
        lastIntentRef.current = null;
      }
      if (!currentActive) {
        if (decision.intents.length > 0) {
          toast.info('Say which project you\'re working on first');
        }
      } else {
        // Append intents (actionable) — with 5-min dedup
        const now = Date.now();
        recentIntentsRef.current = recentIntentsRef.current.filter(
          e => now - e.ts < INTENT_DEDUP_WINDOW_MS,
        );
        for (const intent of decision.intents) {
          const hash = normalizeIntent(intent.description);
          if (recentIntentsRef.current.some(e => e.hash === hash)) {
            console.log('[SoloRouter] Skipping duplicate intent:', intent.description.slice(0, 60));
            continue;
          }
          recentIntentsRef.current.push({ hash, ts: now });
          try {
            await appendFeedEntry(currentActive.path, {
              type: 'intent',
              timestamp: new Date(),
              body: intent.description,
              meta: { confidence: intent.confidence.toFixed(2) },
            }, activeSessionFolder);
            lastIntentRef.current = { description: intent.description, projectPath: currentActive.path };
            addTask({
              id: `solo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              description: intent.description,
              projectName: currentActive.name,
              projectPath: currentActive.path,
              timestamp: Date.now(),
              routed: true,
            });
            toast.success(`Intent → ${currentActive.name}: ${intent.description.slice(0, 60)}`);
          } catch (err) {
            console.error('[SoloRouter] Failed to append intent:', err);
          }
        }

        // Append notes (context only)
        for (const note of decision.notes) {
          try {
            await appendFeedEntry(currentActive.path, {
              type: 'note',
              timestamp: new Date(),
              body: note.description,
              meta: { confidence: note.confidence.toFixed(2) },
            }, activeSessionFolder);
          } catch (err) {
            console.error('[SoloRouter] Failed to append note:', err);
          }
        }
      }

      if (decision.stop_detected) {
        toast.info('Solo session: stop detected in transcript');
      }
    } finally {
      isRoutingRef.current = false;
    }
  }, [performProjectSwitch, addTask]);

  // ── HUD manual correction → apply same switch as the auto-router ──────
  useEffect(() => {
    if (!isActive) return;

    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    listen<{ projectId: string }>('solo-hud-switch', async event => {
      const projectId = event.payload?.projectId;
      if (!projectId) return;
      console.log('[SoloRouter] HUD switch requested:', projectId);

      let matched = projectsRef.current.find(p => p.id === projectId);
      if (!matched) {
        // The project cache may not have loaded yet (or is stale) — re-fetch
        // once and retry before giving up, so a manual pick never silently no-ops.
        try {
          const fresh = await listProjects();
          projectsRef.current = fresh;
          matched = fresh.find(p => p.id === projectId);
        } catch (err) {
          console.warn('[SoloRouter] HUD switch: project re-fetch failed', err);
        }
      }
      if (!matched) {
        console.warn('[SoloRouter] HUD switch: unknown project id', projectId);
        return;
      }
      if (matched.id === activeProjectRef.current?.id) return; // already active

      try {
        await performProjectSwitch(matched, transcriptsRef.current.length);
      } catch (err) {
        console.error('[SoloRouter] HUD switch failed:', err);
      }
    }).then(fn => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [isActive, performProjectSwitch]);

  // ── Routing interval ────────────────────────────────────────────────
  useEffect(() => {
    if (!isActive || !isRecording) {
      if (routingTimerRef.current) {
        clearInterval(routingTimerRef.current);
        routingTimerRef.current = null;
      }
      return;
    }

    console.log('[SoloRouter] Starting routing interval (30s)');
    routingTimerRef.current = setInterval(runRouting, ROUTING_INTERVAL_MS);

    return () => {
      if (routingTimerRef.current) clearInterval(routingTimerRef.current);
    };
  }, [isActive, isRecording, runRouting]);

  // ── Segment trigger — fire early when enough segments arrive ────────
  useEffect(() => {
    if (!isActive || !isRecording) return;
    const newCount = transcripts.length - lastProcessedIndexRef.current;
    if (newCount >= MIN_NEW_SEGMENTS) {
      runRouting(true);
    }
  }, [transcripts.length, isActive, isRecording, runRouting]);

  // ── Screenshot watcher → feed ───────────────────────────────────────
  useEffect(() => {
    if (!isActive || !isRecording || !activeProject) return;
    if (screenshots.length <= lastScreenshotCountRef.current) return;

    const newOnes = screenshots.slice(lastScreenshotCountRef.current);
    lastScreenshotCountRef.current = screenshots.length;
    const projectPath = activeProject.path;

    const folder = sessionFolderRef.current;
    (async () => {
      for (const ss of newOnes) {
        try {
          await appendFeedEntry(projectPath, buildScreenshotFeedEntry(ss), folder);
        } catch (err) {
          console.warn('[SoloRouter] Failed to append screenshot entry:', err);
        }
      }
    })();
  }, [screenshots, isActive, isRecording, activeProject]);

  // ── Clipboard watcher → feed ────────────────────────────────────────
  useEffect(() => {
    if (!isActive || !isRecording || !activeProject) return;
    if (clipboardItems.length <= lastClipboardCountRef.current) return;

    const newOnes = clipboardItems.slice(lastClipboardCountRef.current);
    lastClipboardCountRef.current = clipboardItems.length;
    const projectPath = activeProject.path;

    const folder = sessionFolderRef.current;
    (async () => {
      for (const clip of newOnes) {
        try {
          await appendFeedEntry(projectPath, buildClipboardFeedEntry(clip), folder);
        } catch (err) {
          console.warn('[SoloRouter] Failed to append clipboard entry:', err);
        }
      }
    })();
  }, [clipboardItems, isActive, isRecording, activeProject]);

  // ── Per-project live transcript writing ─────────────────────────────
  useEffect(() => {
    if (!isActive || !isRecording || !activeProject || transcripts.length === 0) return;
    if (transcripts.length === lastTranscriptCountRef.current) return;

    if (transcriptTimerRef.current) clearTimeout(transcriptTimerRef.current);

    transcriptTimerRef.current = setTimeout(async () => {
      try {
        const entry = getActiveProjectHistory();
        if (!entry) return;

        const projectTranscripts = transcriptsRef.current.slice(entry.startIndex);
        const recent = getRecentTranscripts(projectTranscripts, LIVE_TRANSCRIPT_WINDOW_SECS);

        const folder = sessionFolderRef.current;
        await writeLiveTranscript(
          activeProject.path,
          recent,
          meetingTitleRef.current || 'Solo Session',
          screenshotsRef.current,
          folder,
        );
        await writeLiveScreenshots(activeProject.path, screenshotsRef.current, folder);
        lastTranscriptCountRef.current = transcriptsRef.current.length;
      } catch (err) {
        console.warn('[SoloRouter] Live transcript write failed:', err);
      }
    }, TRANSCRIPT_WRITE_DEBOUNCE_MS);

    return () => {
      if (transcriptTimerRef.current) clearTimeout(transcriptTimerRef.current);
    };
  }, [transcripts.length, isActive, isRecording, activeProject, getActiveProjectHistory]);

  // ── Final flush + session_end marker when recording stops ───────────
  useEffect(() => {
    if (isActive && !isRecording && activeProject && transcriptsRef.current.length > 0) {
      const folder = sessionFolderRef.current;
      const entry = getActiveProjectHistory();
      if (entry) {
        const projectTranscripts = transcriptsRef.current.slice(entry.startIndex);
        const recent = getRecentTranscripts(projectTranscripts, LIVE_TRANSCRIPT_WINDOW_SECS);
        if (recent.length > 0) {
          writeLiveTranscript(
            activeProject.path,
            recent,
            meetingTitleRef.current || 'Solo Session',
            screenshotsRef.current,
            folder,
          ).catch(() => {});
        }
      }
      appendFeedEntry(activeProject.path, {
        type: 'session_end',
        timestamp: new Date(),
        body: `Solo session ended on ${activeProject.name}`,
      }, folder).catch(() => {});
      lastTranscriptCountRef.current = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording]);

  // ── Poll response.md for each active project ───────────────────────
  useEffect(() => {
    if (!isActive || projectHistory.length === 0) return;

    responsePollRef.current = setInterval(async () => {
      for (const entry of projectHistory) {
        const sep = entry.project.path.includes('\\') ? '\\' : '/';
        const responsePath = `${entry.project.path}${sep}.tandem${sep}response.md`;

        try {
          const content = await invoke<string | null>('read_file_if_exists', { path: responsePath });
          if (content) {
            toast.info(`Response from ${entry.project.name}`, {
              description: content.slice(0, 200),
            });
            await invoke('save_transcript', { filePath: responsePath, content: '' });
          }
        } catch {
          // File doesn't exist yet
        }
      }
    }, RESPONSE_POLL_MS);

    return () => {
      if (responsePollRef.current) clearInterval(responsePollRef.current);
    };
  }, [isActive, projectHistory]);
}
