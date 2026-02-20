/**
 * Claude AI Assistant service — communicates with the FastAPI backend
 * via fetch() + ReadableStream (SSE) instead of Tauri invoke/events.
 */

const BACKEND = 'http://localhost:5167';

// ---------------------------------------------------------------------------
// Types (unchanged from before, kept for compat)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// SSE streaming helper
// ---------------------------------------------------------------------------

/**
 * POST to an SSE endpoint and call `onEvent` for each parsed SSE line.
 * Returns an AbortController so the caller can cancel mid-stream.
 */
export function streamClaudeSession(
  endpoint: '/api/claude/start' | '/api/claude/message',
  body: Record<string, unknown>,
  onEvent: (event: ClaudeFrontendEvent) => void,
  onError?: (err: Error) => void,
): AbortController {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`${BACKEND}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Backend returned ${res.status}: ${res.statusText}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines (each ends with \n\n)
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // keep the incomplete tail

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const jsonStr = trimmed.slice(6); // strip "data: "
          try {
            const event: ClaudeFrontendEvent = JSON.parse(jsonStr);
            onEvent(event);
          } catch {
            // ignore malformed lines
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return; // expected on cancel
      onError?.(err as Error);
    }
  })();

  return controller;
}

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

export async function getClaudeSession(
  meetingId: string,
): Promise<ClaudeSessionState | null> {
  const res = await fetch(`${BACKEND}/api/claude/session/${encodeURIComponent(meetingId)}`);
  if (!res.ok) return null;
  return res.json();
}

export async function clearClaudeSession(meetingId: string): Promise<void> {
  await fetch(`${BACKEND}/api/claude/session/${encodeURIComponent(meetingId)}`, {
    method: 'DELETE',
  });
}

export async function cancelClaudeSession(meetingId: string): Promise<void> {
  await fetch(`${BACKEND}/api/claude/cancel/${encodeURIComponent(meetingId)}`, {
    method: 'POST',
  });
}
