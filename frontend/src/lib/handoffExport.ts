/**
 * F020: Meeting Handoff Export — Pure markdown generation utility
 * F048: Enhanced with structured task YAML block for Claude Code pipeline
 *
 * Generates a HANDOFF.md with a unified chronological timeline that interleaves
 * transcript segments, screenshots, clipboard items, and AI conversation messages.
 * Optionally includes a machine-readable YAML task section extracted via Anthropic API.
 */

import { Transcript, ScreenshotData, ClipboardData } from '@/types';
import { ExtractedTask } from '@/types/handoff';
import { ClaudeMessage } from '@/contexts/ClaudeContext';

// ─── Timeline Types ──────────────────────────────────────────────────────────

export type TimelineItemType = 'transcript' | 'screenshot' | 'clipboard' | 'ai_user' | 'ai_assistant';

export interface TimelineItem {
  elapsedSecs: number;
  type: TimelineItemType;
  text: string;
  filePath?: string;
  captureMode?: string;
  contentType?: string;
}

export interface HandoffData {
  meetingName: string;
  date: string;
  durationSeconds: number | null;
  timeline: TimelineItem[];
  anonymized: boolean;
  tasks?: ExtractedTask[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatSecs(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

// ─── Build Timeline ──────────────────────────────────────────────────────────

export function buildTimeline(
  transcripts: Transcript[],
  screenshots: ScreenshotData[],
  clipboardItems: ClipboardData[],
  conversation: ClaudeMessage[],
): TimelineItem[] {
  const items: TimelineItem[] = [];

  for (const t of transcripts) {
    if (!t.text.trim()) continue;
    items.push({
      elapsedSecs: t.audio_start_time ?? 0,
      type: 'transcript',
      text: t.text.trim(),
    });
  }

  for (const s of screenshots) {
    items.push({
      elapsedSecs: s.recording_elapsed_secs ?? 0,
      type: 'screenshot',
      text: s.file_path,
      filePath: s.file_path,
      captureMode: s.capture_mode,
    });
  }

  for (const c of clipboardItems) {
    items.push({
      elapsedSecs: c.recording_elapsed_secs ?? 0,
      type: 'clipboard',
      text: c.content_type === 'image' ? (c.file_path ?? 'image') : (c.text ?? ''),
      filePath: c.file_path,
      contentType: c.content_type,
    });
  }

  for (const msg of conversation) {
    items.push({
      elapsedSecs: msg.recording_elapsed_secs ?? 0,
      type: msg.role === 'user' ? 'ai_user' : 'ai_assistant',
      text: msg.text.trim(),
    });
  }

  items.sort((a, b) => a.elapsedSecs - b.elapsedSecs);
  return items;
}

// ─── Generate Markdown ───────────────────────────────────────────────────────

export function generateHandoffMarkdown(data: HandoffData): string {
  const lines: string[] = [];

  // Header
  lines.push(`# Meeting Handoff: ${data.meetingName}`);
  lines.push('');
  lines.push(`**Date:** ${new Date(data.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`);
  if (data.durationSeconds != null) {
    lines.push(`**Duration:** ${formatDuration(data.durationSeconds)}`);
  }
  lines.push(`**PII Anonymized:** ${data.anonymized ? 'Yes' : 'No'}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Timeline
  lines.push('## Timeline');
  lines.push('');

  if (data.timeline.length === 0) {
    lines.push('*No items recorded.*');
  }

  for (const item of data.timeline) {
    const ts = `[${formatSecs(item.elapsedSecs)}]`;

    switch (item.type) {
      case 'transcript':
        lines.push(`${ts} ${item.text}`);
        break;

      case 'screenshot': {
        const mode = item.captureMode ? ` (${item.captureMode})` : '';
        lines.push(`📷 ${ts} Screenshot: \`${item.filePath ?? item.text}\`${mode}`);
        break;
      }

      case 'clipboard': {
        if (item.contentType === 'image') {
          lines.push(`📋 ${ts} Clipboard image: \`${item.filePath ?? 'image'}\``);
        } else {
          lines.push(`📋 ${ts} Clipboard: ${item.text}`);
        }
        break;
      }

      case 'ai_user':
        lines.push(`🤖 ${ts} **User → AI:** ${item.text}`);
        break;

      case 'ai_assistant':
        // Indent multi-line AI responses
        const responseLines = item.text.split('\n');
        lines.push(`🤖 ${ts} **AI → User:** ${responseLines[0]}`);
        for (let i = 1; i < responseLines.length; i++) {
          lines.push(`   ${responseLines[i]}`);
        }
        break;
    }
  }

  // F048: Extracted Tasks (YAML block for Claude Code)
  if (data.tasks && data.tasks.length > 0) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Extracted Tasks');
    lines.push('');
    lines.push('<!-- TASKS_YAML_START -->');
    lines.push('tasks:');
    for (const task of data.tasks) {
      lines.push(`  - id: "${task.id}"`);
      lines.push(`    description: "${escapeYamlString(task.description)}"`);
      lines.push(`    autonomy: ${task.autonomy}`);
      lines.push(`    category: ${task.category}`);
      lines.push(`    context: "${escapeYamlString(task.context)}"`);
      lines.push(`    priority: ${task.priority}`);
    }
    lines.push('<!-- TASKS_YAML_END -->');
  }

  // Footer
  lines.push('');
  lines.push('---');
  lines.push(`*Generated by Tandem · PII anonymized: ${data.anonymized ? 'yes' : 'no'}*`);

  return lines.join('\n');
}

/** Escape double quotes and newlines for YAML string values. */
function escapeYamlString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
