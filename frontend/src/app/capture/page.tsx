'use client';

/**
 * Global quick-capture bar (Alt+Shift+N)
 * ------------------------------------------------------------------
 * Runs in a SEPARATE frameless, always-on-top Tauri window labeled `quick-capture`
 * (created on demand in src-tauri/src/quick_capture). It has its OWN minimal React
 * tree (see layout.tsx) and talks to Rust only through commands:
 *   - get_quick_capture_clips  -> the rolling buffer of the last 3 copied text items
 *   - save_quick_capture       -> writes a dated note into <project>/.tandem/notes
 *   - quick_capture_send_to_ai -> focuses the main window + opens the AI panel with the content
 *   - quick_capture_close      -> dismiss (Esc); blur-dismiss is handled in Rust
 *
 * Actions: Enter saves silently and closes; Ctrl+Enter saves and hands the content to the AI
 * panel; Esc (or clicking away) dismisses and saves nothing. Tab cycles the routing suggestion.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { getMatchPool, listClientFolders, type ClientFolder } from '@/services/clientFolderDiscovery';
import { routeMeetingToProject } from '@/services/projectRouter';
import { recordProjectDirUse } from '@/lib/projectDirHistory';
import { createProject, type Project } from '@/services/projectService';
import {
  buildInquiryAppend,
  buildInquiryBrief,
  buildInquiryClaudeMd,
  buildNoteMarkdown,
  buildRouterInput,
  cycleIndex,
  defaultSelection,
  deriveInquiryName,
  isNewInquiryCandidate,
  orderRouteCandidates,
  quickCaptureFilename,
  sanitizeFolderName,
  selectedClips,
  toggleChip,
  NEW_INQUIRY_PREFIX,
  type QuickClip,
} from '@/lib/quickCapture';

const UNFILED_ID = '__unfiled__';

/** What Rust's `create_inquiry` hands back. */
interface InquiryResult {
  path: string;
  created: boolean;
  written: string[];
}

/**
 * Clients-root subfolders offered first as a destination for a new inquiry, mirroring
 * new-client.ps1's `-In` choices so the bar and the terminal agree on where things go.
 * Anything not listed still appears, alphabetically, after these.
 */
const PREFERRED_BASES = ['Claude', 'Sales Demos'];

/** Cap on the "+ New in X" entries so the Tab cycle stays short. */
const MAX_BASES = 3;

/** Order the clients-root subfolders: preferred names first, then the rest. Pure. */
function orderBases(folders: ClientFolder[]): ClientFolder[] {
  const rank = (f: ClientFolder) => {
    const i = PREFERRED_BASES.findIndex(p => p.toLowerCase() === f.name.toLowerCase());
    return i === -1 ? PREFERRED_BASES.length : i;
  };
  return [...folders]
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .slice(0, MAX_BASES);
}

/** First ~80 chars of a clip for the preview chip, whitespace collapsed. */
function preview(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 80 ? collapsed.slice(0, 80) + '…' : collapsed;
}

export default function CapturePage() {
  const [buffer, setBuffer] = useState<QuickClip[]>([]);
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [note, setNote] = useState('');
  const [pool, setPool] = useState<Project[]>([]);
  const [candidates, setCandidates] = useState<Project[]>([]);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [defaultDir, setDefaultDir] = useState('');
  const [saving, setSaving] = useState(false);
  const [bases, setBases] = useState<ClientFolder[]>([]);
  const [inquiryName, setInquiryName] = useState('');
  // Once the user edits the name we stop re-deriving it from the capture, otherwise
  // every keystroke in the note would overwrite what they just typed.
  const [nameTouched, setNameTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const savedRef = useRef(false); // guard against double-save (Enter + blur race)

  // ── Load the clipboard buffer + routing pool + fallback dir on mount ──────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const clips = (await invoke<QuickClip[]>('get_quick_capture_clips')) ?? [];
        if (cancelled) return;
        setBuffer(clips);
        setSelection(defaultSelection(clips));
      } catch {
        /* no clips: a note-only capture is still valid */
      }
      try {
        const dir = await invoke<string>('get_default_recordings_folder_path');
        if (!cancelled) setDefaultDir(dir);
      } catch {
        /* fallback dir unavailable: Unfiled saves stay disabled until it loads */
      }
      try {
        const { pool } = await getMatchPool();
        if (!cancelled) setPool(pool);
      } catch {
        /* no projects: routing degrades to Unfiled */
      }
      try {
        const folders = await listClientFolders();
        if (!cancelled) setBases(orderBases(folders));
      } catch {
        /* no clients root: the "+ New in X" entries simply never appear */
      }
    })();
    // Focus the note input so the hotkey feels live.
    inputRef.current?.focus();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Re-route whenever the note or attached clips change (debounced) ───────
  useEffect(() => {
    const unfiled: Project = {
      id: UNFILED_ID,
      name: 'Unfiled',
      path: defaultDir,
      aliases: [],
      auto_discovered: false,
      // F061: plain (non-session) stub — no chat session scope, no DB row timestamp.
      session_id: null,
      created_at: '',
    };
    // "+ New in <base>" entries, appended after every real destination: creating a folder
    // is the last resort in the cycle, never something you land on by pressing Tab once.
    const newInquiries: Project[] = bases.map(b => ({
      id: `${NEW_INQUIRY_PREFIX}${b.path}`,
      name: `New in ${b.name}`,
      path: b.path,
      aliases: [],
      auto_discovered: false,
      session_id: null,
      created_at: '',
    }));

    if (pool.length === 0) {
      setCandidates([unfiled, ...newInquiries]);
      setCandidateIndex(0);
      return;
    }
    let cancelled = false;
    const attached = selectedClips(buffer, selection);
    const { meetingTitle, transcriptText } = buildRouterInput(note, attached);
    const timer = setTimeout(async () => {
      let routed: Project | null = null;
      try {
        const result = await routeMeetingToProject({
          meetingTitle,
          transcriptText,
          projects: pool,
          anthropicKey: null, // deterministic heuristic only in the bar (offline-friendly)
        });
        routed = result?.project ?? null;
      } catch {
        routed = null;
      }
      if (cancelled) return;
      const ordered = routed
        ? [...orderRouteCandidates(routed, pool, 3), unfiled]
        : [unfiled, ...orderRouteCandidates(null, pool, 3)];
      setCandidates([...ordered, ...newInquiries]);
      setCandidateIndex(0);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [note, selection, buffer, pool, defaultDir, bases]);

  const routed = candidates[candidateIndex] ?? null;
  const isUnfiled = !routed || routed.id === UNFILED_ID;
  const isNewInquiry = !!routed && isNewInquiryCandidate(routed);

  // Keep the name field prefilled from the capture until the user takes it over.
  useEffect(() => {
    if (nameTouched) return;
    setInquiryName(deriveInquiryName(note, selectedClips(buffer, selection)));
  }, [note, buffer, selection, nameTouched]);

  // Switching in or out of inquiry mode swaps one input element for another, so the
  // focused node is unmounted and focus falls back to <body>. The key handler lives on
  // the container, so without this the bar would stop responding to Enter/Tab/Esc.
  useEffect(() => {
    inputRef.current?.focus();
  }, [isNewInquiry]);

  const safeName = useMemo(() => sanitizeFolderName(inquiryName), [inquiryName]);
  const previewPath = routed && safeName ? `${routed.path}\\${safeName}` : '';

  const dismiss = useCallback(() => {
    invoke('quick_capture_close').catch(() => {});
  }, []);

  const persist = useCallback(async (): Promise<{ project: Project; attached: QuickClip[] } | null> => {
    if (savedRef.current || saving) return null;
    const project = candidates[candidateIndex] ?? null;
    const attached = selectedClips(buffer, selection);
    // Nothing to save (no note and no clips): just dismiss.
    if (!note.trim() && attached.length === 0) return null;
    if (!project || !project.path) return null; // fallback dir not ready yet
    savedRef.current = true;
    setSaving(true);
    const projectName = project.id === UNFILED_ID ? null : project.name;
    try {
      await invoke<string>('save_quick_capture', {
        projectPath: project.path,
        projectName,
        filename: quickCaptureFilename(),
        content: buildNoteMarkdown({ note, clips: attached, projectName: project.name }),
      });
      // Record the pick in frecency history like other filings (skip the synthetic Unfiled row).
      // Deliberately pass NO note text: a quick-capture note can be sensitive (client details),
      // and the frecency store is unencrypted localStorage that is not cleared when Quick Capture
      // is disabled. We only persist the destination (path + name), never the note content.
      if (project.id !== UNFILED_ID) {
        recordProjectDirUse(project.path, project.name, null);
      }
      return { project, attached };
    } catch (err) {
      // Let the user retry: undo the guard so Enter works again.
      savedRef.current = false;
      setSaving(false);
      console.error('[QuickCapture] save failed:', err);
      return null;
    }
  }, [candidates, candidateIndex, buffer, selection, note, saving]);

  /**
   * Commit a "+ New in <base>" capture: create the folder, seed brief.md + CLAUDE.md,
   * register it as a project, and hand the main window a toast with Undo.
   *
   * The captured text goes into brief.md and nowhere else. Writing a .tandem note too
   * would file the same job post twice in one folder, which reads as a bug the first
   * time you open it.
   */
  const createInquiry = useCallback(
    async (openIde: boolean) => {
      if (savedRef.current || saving) return;
      const base = candidates[candidateIndex] ?? null;
      if (!base || !isNewInquiryCandidate(base)) return;
      const finalName = sanitizeFolderName(inquiryName);
      if (!finalName) {
        setError('Enter a name for the folder');
        return;
      }
      const attached = selectedClips(buffer, selection);
      const body = attached.map(c => c.text).join('\n\n');
      savedRef.current = true;
      setSaving(true);
      setError(null);
      try {
        const result = await invoke<InquiryResult>('create_inquiry', {
          basePath: base.path,
          name: finalName,
          brief: buildInquiryBrief({ name: finalName, body, note }),
          briefAppend: buildInquiryAppend({ body, note }),
          claudeMd: buildInquiryClaudeMd(finalName),
        });

        // Register it so it routes on its own next time. A failure here is not fatal:
        // the folder and the brief exist, which is the part that cannot be redone by hand.
        let projectId: string | null = null;
        try {
          projectId = (await createProject(finalName, result.path, [])).id;
        } catch (err) {
          console.error('[QuickCapture] inquiry project registration failed:', err);
        }
        recordProjectDirUse(result.path, finalName, null);

        if (openIde) {
          try {
            await invoke('open_in_antigravity', { path: result.path });
          } catch (err) {
            // Report it rather than swallowing: the user pressed Ctrl+Enter precisely
            // because they wanted the IDE, and the folder still got created.
            console.error('[QuickCapture] open in Antigravity failed:', err);
            await emit('inquiry-ide-failed', { message: String(err) });
          }
        }

        await emit('inquiry-created', {
          name: finalName,
          path: result.path,
          created: result.created,
          written: result.written,
          projectId,
        });
        dismiss();
      } catch (err) {
        savedRef.current = false;
        setSaving(false);
        console.error('[QuickCapture] create inquiry failed:', err);
        setError(String(err).replace(/^Error:\s*/, ''));
      }
    },
    [candidates, candidateIndex, inquiryName, buffer, selection, note, saving, dismiss],
  );

  const saveAndClose = useCallback(async () => {
    const result = await persist();
    if (result) dismiss();
  }, [persist, dismiss]);

  const saveAndAsk = useCallback(async () => {
    const result = await persist();
    if (!result) return;
    const { project, attached } = result;
    const clipText = attached.map(c => c.text).join('\n\n');
    const content = [note.trim(), clipText].filter(Boolean).join('\n\n');
    try {
      await invoke('quick_capture_send_to_ai', {
        content,
        projectName: project.id === UNFILED_ID ? null : project.name,
      });
    } catch (err) {
      console.error('[QuickCapture] send-to-ai failed:', err);
    }
    dismiss();
  }, [persist, note, dismiss]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismiss();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        // On a "+ New in X" destination the same two keys mean create, and create+open,
        // so the muscle memory carries over: Enter commits, Ctrl+Enter commits and goes deeper.
        if (isNewInquiry) void createInquiry(e.ctrlKey || e.metaKey);
        else if (e.ctrlKey || e.metaKey) void saveAndAsk();
        else void saveAndClose();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        if (candidates.length > 1) {
          setCandidateIndex(i => cycleIndex(i, candidates.length, e.shiftKey ? -1 : 1));
        }
        return;
      }
      // Bare digit toggles the matching clip chip, but only while that chip exists (so the note
      // can still contain digits when there are fewer clips than the pressed number).
      // Suppressed while naming a new folder: there the field is a name, and "Project 2"
      // must be typeable without the 2 silently detaching a clip.
      if (
        !isNewInquiry &&
        (e.key === '1' || e.key === '2' || e.key === '3') &&
        !e.ctrlKey && !e.altKey && !e.metaKey
      ) {
        const idx = Number(e.key) - 1;
        if (idx < buffer.length) {
          e.preventDefault();
          setSelection(s => toggleChip(s, idx));
        }
      }
    },
    [dismiss, saveAndAsk, saveAndClose, createInquiry, isNewInquiry, candidates.length, buffer.length],
  );

  return (
    <div
      data-testid="quick-capture-bar"
      onKeyDown={handleKeyDown}
      className="flex h-screen w-screen flex-col gap-3 overflow-hidden bg-background p-4 text-foreground
                 border border-border rounded-xl shadow-2xl"
    >
      {/* Clipboard chips */}
      <div className="flex flex-wrap items-center gap-2" data-testid="clip-chips">
        {buffer.length === 0 ? (
          <span className="text-xs text-muted-foreground">Nothing on the clipboard yet</span>
        ) : (
          buffer.map((clip, i) => {
            const on = selection.has(i);
            return (
              <button
                key={clip.id}
                type="button"
                data-testid={`clip-chip-${i}`}
                aria-pressed={on}
                onClick={() => setSelection(s => toggleChip(s, i))}
                title={clip.text}
                className={`group flex max-w-[16rem] items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs
                            transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                            ${
                              on
                                ? 'border-brand/60 bg-brand/10 text-foreground'
                                : 'border-border bg-muted/40 text-muted-foreground hover:text-foreground'
                            }`}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums
                              ${on ? 'bg-brand text-white' : 'bg-muted text-muted-foreground'}`}
                >
                  {i + 1}
                </span>
                <span className="truncate">{preview(clip.text)}</span>
              </button>
            );
          })
        )}
      </div>

      {/* Note input + routing chip */}
      <div className="flex items-center gap-2">
        {isNewInquiry ? (
          <input
            ref={inputRef}
            data-testid="inquiry-name"
            type="text"
            value={inquiryName}
            onChange={e => {
              setInquiryName(e.target.value);
              setNameTouched(true);
              setError(null);
            }}
            placeholder="Client or project name…"
            aria-label="New folder name"
            className="flex-1 rounded-lg border border-brand/60 bg-background px-3 py-2 text-sm text-foreground
                       placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        ) : (
          <input
            ref={inputRef}
            data-testid="capture-note"
            type="text"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Add a note (optional)…"
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground
                       placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        )}
        <button
          type="button"
          data-testid="route-chip"
          onClick={() => {
            if (candidates.length > 1) setCandidateIndex(i => cycleIndex(i, candidates.length, 1));
          }}
          title="Tab to change destination"
          className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                      ${
                        isNewInquiry
                          ? 'border-dashed border-brand/60 bg-brand/5 text-foreground'
                          : isUnfiled
                            ? 'border-border bg-muted/40 text-muted-foreground'
                            : 'border-brand/60 bg-brand/10 text-foreground'
                      }`}
        >
          {/* A dashed border and a "+" mark the one destination that does not exist yet. */}
          {isNewInquiry ? (
            <span className="text-brand" aria-hidden>+</span>
          ) : (
            <span className={`h-1.5 w-1.5 rounded-full ${isUnfiled ? 'bg-muted-foreground/60' : 'bg-brand'}`} />
          )}
          <span className="max-w-[10rem] truncate" data-testid="route-name">
            {isUnfiled ? 'Unfiled' : routed?.name}
          </span>
        </button>
      </div>

      {/* Hint row — in inquiry mode the left side shows where the folder will land, which
          matters more than the hints: it is the last chance to notice a wrong base. */}
      <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        {isNewInquiry ? (
          <span className="flex min-w-0 items-center gap-3">
            {error ? (
              <span className="truncate text-destructive" data-testid="inquiry-error">{error}</span>
            ) : (
              <span className="truncate font-mono" data-testid="inquiry-path" title={previewPath}>
                {previewPath || 'Enter a name…'}
              </span>
            )}
          </span>
        ) : (
          <span className="flex items-center gap-3">
            <Hint keys="Enter" label="save" />
            <Hint keys="Ctrl+Enter" label="save + ask AI" />
            <Hint keys="Tab" label="reroute" />
            <Hint keys="Esc" label="dismiss" />
          </span>
        )}
        {isNewInquiry && !saving && (
          <span className="flex shrink-0 items-center gap-3">
            <Hint keys="Enter" label="create" />
            <Hint keys="Ctrl+Enter" label="create + open" />
            <Hint keys="Tab" label="change" />
          </span>
        )}
        {saving && <span className="shrink-0 text-brand">{isNewInquiry ? 'Creating…' : 'Saving…'}</span>}
      </div>
    </div>
  );
}

function Hint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-medium text-foreground">{keys}</kbd>
      <span>{label}</span>
    </span>
  );
}
