/**
 * AI conversation persistence — saves the AI side-panel conversation into the meeting folder so it
 * can be reviewed later, the same way transcripts/screenshots/whiteboards are. One file per meeting:
 * `<meeting folder>/ai-conversation.json`.
 */

import { invoke } from '@tauri-apps/api/core';

const FILE = 'ai-conversation.json';
const join = (folder: string) => `${folder}${folder.includes('\\') ? '\\' : '/'}${FILE}`;

/** Persist the conversation messages to the meeting folder (no-op for an empty/blank folder). */
export async function saveConversation(folderPath: string, messages: unknown[]): Promise<void> {
  if (!folderPath || !messages?.length) return;
  await invoke('save_transcript', { filePath: join(folderPath), content: JSON.stringify(messages) });
}

/** Load a meeting's saved conversation, or null if none. */
export async function loadConversation<T = unknown>(folderPath: string): Promise<T[] | null> {
  if (!folderPath) return null;
  const raw = await invoke<string | null>('read_file_if_exists', { path: join(folderPath) });
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}
