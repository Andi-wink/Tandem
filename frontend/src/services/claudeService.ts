import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

export interface ClaudeSessionState {
  meeting_id: string;
  session_id: string | null;
  project_dir: string;
}

export interface ClaudeFrontendEvent {
  event_type: 'text_delta' | 'tool_call' | 'tool_result' | 'done' | 'error' | 'session_init';
  text: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_output: string | null;
  session_id: string | null;
  cost_usd: number | null;
  meeting_id: string;
}

export async function startClaudeSession(
  meetingId: string,
  meetingTitle: string,
  projectDir: string,
  message: string,
  contextBlock?: string,
): Promise<void> {
  return invoke<void>('start_claude_session', {
    meetingId,
    meetingTitle,
    projectDir,
    contextBlock: contextBlock || null,
    message,
  });
}

export async function sendClaudeMessage(
  meetingId: string,
  projectDir: string,
  message: string,
  contextBlock?: string,
): Promise<void> {
  return invoke<void>('send_claude_message', {
    meetingId,
    projectDir,
    contextBlock: contextBlock || null,
    message,
  });
}

export async function getClaudeSession(
  projectDir: string,
): Promise<ClaudeSessionState | null> {
  return invoke<ClaudeSessionState | null>('get_claude_session', { projectDir });
}

export async function clearClaudeSession(projectDir: string): Promise<void> {
  return invoke<void>('clear_claude_session', { projectDir });
}

export async function checkClaudeCliAvailable(): Promise<boolean> {
  return invoke<boolean>('check_claude_cli_available');
}

export function listenClaudeStreamEvent(
  callback: (event: ClaudeFrontendEvent) => void,
): Promise<UnlistenFn> {
  return listen<ClaudeFrontendEvent>('claude-stream-event', (e) => callback(e.payload));
}

export function listenClaudeSessionReady(
  callback: (data: { meeting_id: string; project_dir: string; resuming: boolean }) => void,
): Promise<UnlistenFn> {
  return listen('claude-session-ready', (e) => callback(e.payload as any));
}
