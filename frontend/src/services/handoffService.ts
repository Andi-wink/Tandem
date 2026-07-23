/**
 * F054: Handoff Service — writes task files and live transcript for Claude Code /loop
 *
 * Two outputs:
 * 1. Task files (~/tandem-tasks/task-{timestamp}.md) — created by @code tag in AI panel
 * 2. Live transcript ({projectDir}/.tandem/live-transcript.md) — updated every 10s during recording
 */

import { invoke } from '@tauri-apps/api/core';
import { Transcript, ScreenshotData, ClipboardData } from '@/types';
import { ContextBasketItem } from '@/contexts/ContextBasketContext';
import { resolveSpeaker, getLocalSpeakerName } from '@/lib/speakerNames';
import { getGitBranch } from '@/services/claudeSessionService';

/** Prefix a transcript line's body with its resolved speaker ("Andrew: ..." / "Client: ..."). */
function withSpeaker(t: Transcript, localName: string): string {
  const speaker = resolveSpeaker({ speaker_label: t.speaker_label, source: t.source ?? t.speaker }, localName);
  return speaker ? `${speaker}: ${t.text.trim()}` : t.text.trim();
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** How many seconds of transcript to include in @code task files */
export const HANDOFF_TRANSCRIPT_WINDOW_SECS = 300; // 5 minutes

/** Rolling window for live transcript file */
export const LIVE_TRANSCRIPT_WINDOW_SECS = 1800; // 30 minutes

/** Debounce interval for live transcript writes */
export const LIVE_TRANSCRIPT_DEBOUNCE_MS = 10_000; // 10 seconds

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatSecs(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatTimestamp(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Build the directory where Solo Mode artifacts live for a project + session.
 * - With sessionFolder: `{projectDir}/.tandem/{sessionFolder}` — per-session subdir,
 *   intended to be archivable as a unit when the session ends.
 * - Without sessionFolder (legacy / Meeting mode): `{projectDir}/.tandem`.
 *
 * F061: sessionFolder may be a MULTI-segment path (e.g. `sessions/<session_id>`
 * for a virtual sub-project). Any `/` or `\` inside it is re-split and re-joined
 * with the project's own separator so the result never mixes separators on
 * Windows (`…\.tandem\sessions\<id>`, not `…\.tandem\sessions/<id>`).
 */
export function tandemDirFor(projectDir: string, sessionFolder?: string | null): string {
  const sep = projectDir.includes('\\') ? '\\' : '/';
  const base = `${projectDir}${sep}.tandem`;
  if (!sessionFolder) return base;
  const segments = sessionFolder.split(/[/\\]+/).filter(Boolean);
  return segments.length > 0 ? [base, ...segments].join(sep) : base;
}

/**
 * F061: the `.tandem`-relative filing subfolder for a virtual sub-project keyed
 * by a chat session id: `sessions/<session_id>`. Passed as the `sessionFolder`
 * argument to any handoff writer so all its artifacts are scoped to that chat.
 */
export function sessionScopeFolder(sessionId: string): string {
  return `sessions/${sessionId}`;
}

/**
 * Build a session folder name: `{sanitized-meeting-title}_{YYYY-MM-DD_HH-mm-ss}`.
 * Sanitizes characters disallowed on Windows filesystems.
 */
export function buildSessionFolderName(meetingTitle: string, when: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    `_${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`;
  const cleanTitle = (meetingTitle ?? '').trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
  const prefix = cleanTitle.length > 0 ? cleanTitle : 'Solo';
  return `${prefix}_${stamp}`;
}

/**
 * Filter transcripts to a rolling window ending at the latest segment.
 * If no segments have audio_start_time, returns all transcripts.
 */
export function getRecentTranscripts(
  transcripts: Transcript[],
  windowSecs: number,
): Transcript[] {
  if (transcripts.length === 0) return [];
  const latestTime = transcripts[transcripts.length - 1].audio_start_time;
  if (latestTime == null) return transcripts;
  const cutoff = latestTime - windowSecs;
  return transcripts.filter(t => (t.audio_start_time ?? 0) >= cutoff);
}

// ─── Task Handoff File (@code) ──────────────────────────────────────────────

export interface TaskHandoffData {
  taskDescription: string;
  meetingTitle: string;
  meetingId: string;
  transcripts: Transcript[];
  contextItems: ContextBasketItem[];
  timestamp: Date;
  /** F055: git branch of the target project checkout ("unknown" when null). */
  branch?: string | null;
}

export function generateTaskMarkdown(data: TaskHandoffData): string {
  const lines: string[] = [];

  // Header
  lines.push(`# Task: ${data.taskDescription.slice(0, 80)}`);
  lines.push(`Meeting: ${data.meetingTitle} | ${data.timestamp.toLocaleString()}`);
  lines.push(`**Branch:** ${data.branch ?? 'unknown'}`);
  lines.push('');

  // Instructions
  lines.push('## Instructions');
  lines.push(data.taskDescription);
  lines.push('');

  // Recent transcript
  if (data.transcripts.length > 0) {
    lines.push(`## Recent Transcript (last ${Math.round(HANDOFF_TRANSCRIPT_WINDOW_SECS / 60)} min)`);
    const localName = getLocalSpeakerName();
    for (const t of data.transcripts) {
      if (!t.text.trim()) continue;
      const ts = t.audio_start_time != null ? `[${formatTimestamp(t.audio_start_time)}]` : `[${t.timestamp}]`;
      lines.push(`${ts} ${withSpeaker(t, localName)}`);
    }
    lines.push('');
  }

  // Context items (basket)
  const contentItems = data.contextItems.filter(item => item.fullContent.trim());
  if (contentItems.length > 0) {
    lines.push('## Context Items');
    for (const item of contentItems) {
      lines.push(`### ${item.type}: ${item.label}`);
      lines.push(item.fullContent);
      lines.push('');
    }
  }

  // Footer
  lines.push('---');
  lines.push(`*Generated by Tandem · ${data.timestamp.toISOString()}*`);

  return lines.join('\n');
}

/**
 * Write a task handoff file to {tandemDir}/tasks/task-{timestamp}.md
 * Returns the written file path.
 */
export async function writeTaskHandoff(
  projectDir: string,
  data: TaskHandoffData,
  sessionFolder?: string | null,
): Promise<string> {
  const sep = projectDir.includes('\\') ? '\\' : '/';
  const tandemDir = tandemDirFor(projectDir, sessionFolder);
  const tasksDir = `${tandemDir}${sep}tasks`;
  const filename = `task-${Date.now()}.md`;
  const filePath = `${tasksDir}${sep}${filename}`;

  // Stamp the target checkout's branch. Best-effort: a branch lookup must never
  // block or delay the handoff, so a caller-supplied branch wins and a failed
  // lookup falls back to null (rendered as "unknown").
  const branch = data.branch !== undefined ? data.branch : await getGitBranch(projectDir);
  const content = generateTaskMarkdown({ ...data, branch });

  await invoke('save_transcript', { filePath, content });
  return filePath;
}

// ─── Tandem CLAUDE.md (written once per project dir) ────────────────────────

const TANDEM_CLAUDE_MD = `# Tandem Integration (Solo Mode)

Tandem streams everything happening in a session — transcript, screenshots, clipboard, project switches — into a single append-only feed. You decide what's actionable.

All files for this session live in \`__SESSION_DIR__/\` so the entire session can be archived as one folder when it ends.

## The Feed (\`__SESSION_DIR__/feed.md\`)
Chronological entries, newest appended at the bottom. Entry types:

- \`intent\` — Gemma-classified actionable speech (task requests, decisions, plans)
- \`note\` — substantive talk worth remembering but not actionable on its own
- \`screenshot\` — file path, dimensions, and an embedded image reference. **Use your Read tool on the \`file:\` path to view the actual image** (annotations are baked in). Don't treat it as "a screenshot happened" — look at what's on screen.
- \`clipboard\` — text or image reference captured via Alt+Shift+V
- \`project_switch\` — user switched active project mid-session
- \`revoke\` — the user retracted the most recent intent ("ignore that"). **When you see this, treat the nearest preceding \`intent\` entry as cancelled** — do not act on it and do not queue it as a task.
- \`transcript\` — raw speech chunks (context only, don't act on these)

Related events cluster together in time. If you see an \`intent\` followed by a \`screenshot\` within a minute, they're almost certainly the same request — use the screenshot as reference material.

## Cursor (\`__SESSION_DIR__/loop-state.json\`)
Tandem seeds this file with \`{ "last_processed_line": 0 }\` when a Solo session starts, so it always exists when you run /loop. Read it, process feed entries after that line, then overwrite the file with the new line count. Example after processing up to line 247:
\`\`\`json
{ "last_processed_line": 247 }
\`\`\`

## Your Job

1. Read \`__SESSION_DIR__/feed.md\` from your last cursor position.
2. Cluster related entries (an \`intent\` plus any \`screenshot\`/\`clipboard\` within ~60s on either side).
3. For each actionable cluster, decide:
   - **Act now** if it's clear and self-contained → do the work, write result to \`__SESSION_DIR__/response.md\`.
   - **Queue for later** if it needs more context, more speech, or you're mid-task → create \`__SESSION_DIR__/tasks/task-{timestamp}.md\` with the cluster contents.
   - **Ignore** if it's just narration, a dead-end idea, or already covered.
4. Update \`__SESSION_DIR__/loop-state.json\` with the new line count.

## Screenshots (\`__SESSION_DIR__/screenshots/\`)
PNG files copied from the meeting folder into the session directory.
\`__SESSION_DIR__/screenshots.md\` is an index with timestamps, dimensions, and relative file paths.
Use the Read tool to view any \`__SESSION_DIR__/screenshots/*.png\` image file.

## Clipboard Captures (\`__SESSION_DIR__/clipboard.md\` + \`__SESSION_DIR__/clipboard/\`)
Text clips are inlined in \`__SESSION_DIR__/clipboard.md\`. Image clips are saved as PNGs in \`__SESSION_DIR__/clipboard/\`.
The markdown file indexes both text and image captures with timestamps.

## Response File (\`__SESSION_DIR__/response.md\`)
Short (1–3 sentence) summary of what you did. Tandem polls every 10s and shows it to the user. Clear after writing.

## What NOT to do

- Don't act on raw \`transcript\` entries. Gemma already filtered them into \`intent\`/\`note\` — trust that.
- Don't reprocess entries before your cursor.
- Don't treat every \`intent\` as a must-do; some are brainstorms. Use judgment.

## Quick Start
\`\`\`
/loop 1m Read __SESSION_DIR__/feed.md from the line after __SESSION_DIR__/loop-state.json's last_processed_line. Cluster related entries by time. For any screenshot entries in the cluster, Read the file path to actually view the image. Act on clear tasks immediately (write to __SESSION_DIR__/response.md); queue ambiguous ones as __SESSION_DIR__/tasks/task-{timestamp}.md. Update __SESSION_DIR__/loop-state.json with the new line count.
\`\`\`
`;

/**
 * Write CLAUDE.md with integration instructions for Claude Code into the
 * session folder (or .tandem root if no session folder). Path placeholders in
 * the template are replaced with the actual session-relative paths so the
 * /loop quickstart is copy-pasteable.
 */
export async function ensureTandemClaudeMd(
  projectDir: string,
  sessionFolder?: string | null,
): Promise<void> {
  const sep = projectDir.includes('\\') ? '\\' : '/';
  const tandemDir = tandemDirFor(projectDir, sessionFolder);
  const filePath = `${tandemDir}${sep}CLAUDE.md`;
  // Substitute __SESSION_DIR__ with the project-root-relative dir so /loop
  // commands work from project root regardless of session folder name.
  const sessionRel = sessionFolder ? `.tandem/${sessionFolder}` : '.tandem';
  const content = TANDEM_CLAUDE_MD.replace(/__SESSION_DIR__/g, sessionRel);
  await invoke('save_transcript', { filePath, content });
}

// ─── Live Screenshots File ──────────────────────────────────────────────────

export function generateLiveScreenshotsMarkdown(screenshots: ScreenshotData[]): string {
  const lines: string[] = [];

  lines.push('# Live Screenshots');
  lines.push(`Updated: ${new Date().toISOString()}`);
  lines.push('');

  if (screenshots.length === 0) {
    lines.push('*(No screenshots captured yet)*');
    return lines.join('\n');
  }

  for (const ss of screenshots) {
    const ts = ss.recording_elapsed_secs != null
      ? `[${formatTimestamp(ss.recording_elapsed_secs)}]`
      : `[${ss.timestamp}]`;
    const filename = ss.file_path.split(/[/\\]/).pop() || 'screenshot.png';
    lines.push(`## ${ts} ${ss.capture_mode === 'region' ? 'Region' : 'Fullscreen'} — ${ss.width}×${ss.height}`);
    lines.push(`File: .tandem/screenshots/${filename}`);
    lines.push(`Original: ${ss.file_path}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Write screenshots index to {tandemDir}/screenshots.md
 */
export async function writeLiveScreenshots(
  projectDir: string,
  screenshots: ScreenshotData[],
  sessionFolder?: string | null,
): Promise<void> {
  if (screenshots.length === 0) return;
  const sep = projectDir.includes('\\') ? '\\' : '/';
  const tandemDir = tandemDirFor(projectDir, sessionFolder);
  const filePath = `${tandemDir}${sep}screenshots.md`;
  const content = generateLiveScreenshotsMarkdown(screenshots);
  await invoke('save_transcript', { filePath, content });
}

// ─── Live Transcript File ───────────────────────────────────────────────────

function basenameOf(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return idx >= 0 ? filePath.slice(idx + 1) : filePath;
}

export function generateLiveTranscriptMarkdown(
  transcripts: Transcript[],
  meetingTitle: string,
  screenshots: ScreenshotData[] = [],
): string {
  const lines: string[] = [];

  lines.push(`# Live Transcript — ${meetingTitle}`);
  lines.push(`Updated: ${new Date().toISOString()}`);
  lines.push('');

  if (transcripts.length === 0) {
    lines.push('*(No transcript segments yet)*');
    return lines.join('\n');
  }

  // Time range covered by this transcript window
  const startTimes = transcripts
    .map(t => t.audio_start_time)
    .filter((t): t is number => t != null);
  const minTime = startTimes.length > 0 ? Math.min(...startTimes) : 0;
  const maxTime = startTimes.length > 0 ? Math.max(...startTimes) : Number.POSITIVE_INFINITY;

  // Only include screenshots that fall inside this transcript's time window
  // (small ±5s slack so screenshots taken right at the edge don't get dropped).
  const relevantScreenshots = screenshots.filter(ss =>
    ss.recording_elapsed_secs != null &&
    ss.recording_elapsed_secs >= minTime - 5 &&
    ss.recording_elapsed_secs <= maxTime + 60,
  );

  type TimelineEntry =
    | { kind: 'transcript'; time: number; line: string }
    | { kind: 'screenshot'; time: number; line: string };

  const timeline: TimelineEntry[] = [];
  const localName = getLocalSpeakerName();

  for (const t of transcripts) {
    if (!t.text.trim()) continue;
    const time = t.audio_start_time ?? 0;
    const ts = t.audio_start_time != null
      ? `[${formatTimestamp(t.audio_start_time)}]`
      : `[${t.timestamp}]`;
    timeline.push({ kind: 'transcript', time, line: `${ts} ${withSpeaker(t, localName)}` });
  }

  for (const ss of relevantScreenshots) {
    const time = ss.recording_elapsed_secs ?? 0;
    const filename = basenameOf(ss.file_path);
    const label = ss.capture_mode === 'region' ? 'Region' : 'Fullscreen';
    timeline.push({
      kind: 'screenshot',
      time,
      line: `[${formatTimestamp(time)}] 📸 ${filename} — ${label} ${ss.width}×${ss.height}`,
    });
  }

  // Sort by time; on ties, screenshot precedes the transcript line
  // (most natural reading: "snapshot of screen" then "what was being said").
  timeline.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    if (a.kind === b.kind) return 0;
    return a.kind === 'screenshot' ? -1 : 1;
  });

  for (const entry of timeline) {
    lines.push(entry.line);
  }

  return lines.join('\n');
}

/**
 * Write the live transcript to {projectDir}/.tandem/live-transcript.md.
 * Screenshots taken during the transcript window are interleaved by time so a
 * post-meeting reader can see which screenshot belongs to which moment.
 */
export async function writeLiveTranscript(
  projectDir: string,
  transcripts: Transcript[],
  meetingTitle: string,
  screenshots: ScreenshotData[] = [],
  sessionFolder?: string | null,
): Promise<void> {
  const sep = projectDir.includes('\\') ? '\\' : '/';
  const tandemDir = tandemDirFor(projectDir, sessionFolder);
  const filePath = `${tandemDir}${sep}live-transcript.md`;
  const content = generateLiveTranscriptMarkdown(transcripts, meetingTitle, screenshots);

  await invoke('save_transcript', { filePath, content });
}

// ─── File Copy (for mirroring media into .tandem/) ──────────────────────────

async function copyFile(source: string, destination: string): Promise<void> {
  await invoke('copy_file', { source, destination });
}

/**
 * Copy screenshot PNGs into {tandemDir}/screenshots/ so Claude Code
 * can access them without leaving the project directory.
 */
export async function syncScreenshotsToTandemDir(
  projectDir: string,
  screenshots: ScreenshotData[],
  sessionFolder?: string | null,
): Promise<void> {
  if (screenshots.length === 0) return;
  const sep = projectDir.includes('\\') ? '\\' : '/';
  const tandemDir = tandemDirFor(projectDir, sessionFolder);
  const destDir = `${tandemDir}${sep}screenshots`;

  for (const ss of screenshots) {
    // Skip if the source is already inside .tandem
    if (ss.file_path.includes('.tandem')) continue;
    const filename = ss.file_path.split(/[/\\]/).pop();
    if (!filename) continue;
    const destPath = `${destDir}${sep}${filename}`;
    try {
      await copyFile(ss.file_path, destPath);
    } catch {
      console.warn('[F054] Failed to copy screenshot:', ss.file_path);
    }
  }
}

// ─── Live Clipboard File ───────────────────────────────────────────────────

export function generateLiveClipboardMarkdown(clipboardItems: ClipboardData[]): string {
  const lines: string[] = [];

  lines.push('# Clipboard Captures');
  lines.push(`Updated: ${new Date().toISOString()}`);
  lines.push('');

  if (clipboardItems.length === 0) {
    lines.push('*(No clipboard captures yet)*');
    return lines.join('\n');
  }

  for (const clip of clipboardItems) {
    const ts = clip.recording_elapsed_secs != null
      ? `[${formatTimestamp(clip.recording_elapsed_secs)}]`
      : `[${clip.timestamp}]`;

    if (clip.content_type === 'text' && clip.text) {
      lines.push(`## ${ts} Text Clip`);
      lines.push(clip.text);
      lines.push('');
    } else if (clip.content_type === 'image') {
      const filename = (clip.file_path || '').split(/[/\\]/).pop() || 'image.png';
      const dims = clip.width && clip.height ? ` — ${clip.width}x${clip.height}` : '';
      lines.push(`## ${ts} Image Clip${dims}`);
      lines.push(`File: .tandem/clipboard/${filename}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ─── Feed (append-only chronological event stream) ──────────────────────────

export type FeedEntryType =
  | 'intent'
  | 'note'
  | 'screenshot'
  | 'clipboard'
  | 'project_switch'
  | 'session_start'
  | 'session_end'
  | 'revoke';

export interface FeedEntry {
  type: FeedEntryType;
  timestamp: Date;
  /** Human-readable body — markdown, 1-N lines */
  body: string;
  /** Optional metadata rendered as a details block */
  meta?: Record<string, string | number | boolean>;
}

function formatFeedEntry(entry: FeedEntry): string {
  const ts = entry.timestamp.toISOString();
  const lines: string[] = [];
  lines.push(`## ${ts} — ${entry.type}`);
  lines.push(entry.body.trim());
  if (entry.meta && Object.keys(entry.meta).length > 0) {
    lines.push('');
    for (const [k, v] of Object.entries(entry.meta)) {
      lines.push(`- ${k}: ${v}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Write clipboard.md and copy image PNGs to {tandemDir}/clipboard/
 */
export async function writeLiveClipboard(
  projectDir: string,
  clipboardItems: ClipboardData[],
  sessionFolder?: string | null,
): Promise<void> {
  if (clipboardItems.length === 0) return;
  const sep = projectDir.includes('\\') ? '\\' : '/';
  const tandemDir = tandemDirFor(projectDir, sessionFolder);

  // Write the clipboard index markdown
  const filePath = `${tandemDir}${sep}clipboard.md`;
  const content = generateLiveClipboardMarkdown(clipboardItems);
  await invoke('save_transcript', { filePath, content });

  // Copy image PNGs into clipboard/ next to clipboard.md
  const destDir = `${tandemDir}${sep}clipboard`;
  for (const clip of clipboardItems) {
    if (clip.content_type !== 'image' || !clip.file_path) continue;
    if (clip.file_path.includes('.tandem')) continue;
    const filename = clip.file_path.split(/[/\\]/).pop();
    if (!filename) continue;
    const destPath = `${destDir}${sep}${filename}`;
    try {
      await copyFile(clip.file_path, destPath);
    } catch {
      console.warn('[F054] Failed to copy clipboard image:', clip.file_path);
    }
  }
}

/**
 * Append one entry to {tandemDir}/feed.md.
 * Creates the file with a header if it doesn't exist.
 */
export async function appendFeedEntry(
  projectDir: string,
  entry: FeedEntry,
  sessionFolder?: string | null,
): Promise<void> {
  const sep = projectDir.includes('\\') ? '\\' : '/';
  const tandemDir = tandemDirFor(projectDir, sessionFolder);
  const filePath = `${tandemDir}${sep}feed.md`;
  const chunk = formatFeedEntry(entry);
  const existing = await invoke<string | null>('read_file_if_exists', { path: filePath });
  const next = existing && existing.length > 0
    ? `${existing.trimEnd()}\n\n${chunk}`
    : `# Tandem Feed\n\n${chunk}`;
  await invoke('save_transcript', { filePath, content: next });
}

/**
 * Initialize {tandemDir}/loop-state.json with a zeroed cursor.
 * Called when a Solo session starts for a project so Claude Code's /loop
 * can always read-then-update the file without a missing-file code path.
 * No-op if the file already exists (preserves cursor across sessions).
 */
export async function ensureLoopState(
  projectDir: string,
  sessionFolder?: string | null,
): Promise<void> {
  const sep = projectDir.includes('\\') ? '\\' : '/';
  const tandemDir = tandemDirFor(projectDir, sessionFolder);
  const filePath = `${tandemDir}${sep}loop-state.json`;
  const existing = await invoke<string | null>('read_file_if_exists', { path: filePath });
  if (existing && existing.trim().length > 0) return;
  const content = JSON.stringify({ last_processed_line: 0 }, null, 2);
  await invoke('save_transcript', { filePath, content });
}

export function buildScreenshotFeedEntry(ss: ScreenshotData): FeedEntry {
  // Normalize to forward-slash path so markdown image syntax works on Windows
  const normalized = ss.file_path.replace(/\\/g, '/');
  const label = ss.capture_mode === 'region' ? 'Region' : 'Fullscreen';
  return {
    type: 'screenshot',
    timestamp: new Date(),
    body: `${label} screenshot — ${ss.width}×${ss.height}\n\n![screenshot](${normalized})`,
    meta: {
      file: ss.file_path,
      recording_elapsed_secs: ss.recording_elapsed_secs ?? 'n/a',
    },
  };
}

export function buildClipboardFeedEntry(clip: ClipboardData): FeedEntry {
  const preview = clip.content_type === 'text'
    ? (clip.text ?? '').slice(0, 400)
    : `[image ${clip.width ?? '?'}×${clip.height ?? '?'}]`;
  return {
    type: 'clipboard',
    timestamp: new Date(),
    body: preview,
    meta: {
      content_type: clip.content_type,
      ...(clip.file_path ? { file: clip.file_path } : {}),
      recording_elapsed_secs: clip.recording_elapsed_secs ?? 'n/a',
    },
  };
}