/**
 * F048: CLAUDE.md template injection utility.
 *
 * Appends a "Meeting Tasks" section to a project's CLAUDE.md file,
 * teaching Claude Code how to find and process tasks from .tandem/HANDOFF.md.
 */

import { invoke } from '@tauri-apps/api/core';

const MARKER = '<!-- TANDEM_MEETING_TASKS -->';

const TEMPLATE = `
## Meeting Tasks (Tandem Integration)

${MARKER}

Tandem writes meeting handoff files to \`.tandem/HANDOFF.md\`. When asked to
"check meeting tasks" or "work on meeting tasks":

1. Read \`.tandem/HANDOFF.md\`
2. Parse the YAML block between \`<!-- TASKS_YAML_START -->\` and \`<!-- TASKS_YAML_END -->\`
3. Sort tasks by priority (high > medium > low)
4. For each task:
   - Read the description, context, and category
   - Auto-autonomy tasks: execute without confirmation
   - Review-autonomy tasks: show plan and ask before executing
   - Write results/output as appropriate
5. Summarize what was completed

Task categories: research, email, code, document, followup.
`;

/**
 * Inject the meeting tasks section into a project's CLAUDE.md if not already present.
 *
 * @param projectDir - The project directory containing CLAUDE.md.
 * @returns true if the section was injected, false if it already existed.
 */
export async function injectClaudeMdSection(projectDir: string): Promise<boolean> {
  const claudeMdPath = `${projectDir}/CLAUDE.md`;

  // Read existing CLAUDE.md (may not exist)
  let existingContent = '';
  try {
    existingContent = await invoke<string>('read_text_file', { filePath: claudeMdPath });
  } catch {
    // File doesn't exist — we'll create it
  }

  // Check if already injected
  if (existingContent.includes(MARKER)) {
    return false;
  }

  // Append the section
  const newContent = existingContent
    ? `${existingContent}\n${TEMPLATE}`
    : TEMPLATE.trimStart();

  await invoke('save_transcript', { filePath: claudeMdPath, content: newContent });
  return true;
}
