import { invoke } from '@tauri-apps/api/core';
import { ClipboardData } from '@/types';

export async function readClipboardContent(): Promise<ClipboardData> {
  return invoke<ClipboardData>('read_clipboard_content');
}

export async function saveClipboardJson(
  folderPath: string,
  items: ClipboardData[],
): Promise<void> {
  return invoke<void>('save_clipboard_json', { folderPath, items });
}

export async function loadClipboardJson(folderPath: string): Promise<ClipboardData[]> {
  return invoke<ClipboardData[]>('load_clipboard_json', { folderPath });
}
