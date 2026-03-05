/**
 * Claude AI Assistant service — communicates with the FastAPI backend
 * via fetch() + ReadableStream (SSE) instead of Tauri invoke/events.
 */

export const BACKEND = 'http://localhost:5167';

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
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
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

      reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let receivedDone = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // R003: Split on double-newline (SSE event boundary) to handle
        // payloads that might contain single newlines within data fields
        const events = buffer.split('\n\n');
        buffer = events.pop() || ''; // keep the incomplete tail

        for (const eventBlock of events) {
          for (const line of eventBlock.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const jsonStr = trimmed.slice(6);
            try {
              const event: ClaudeFrontendEvent = JSON.parse(jsonStr);
              if (event.event_type === 'done') receivedDone = true;
              onEvent(event);
            } catch (parseErr) {
              console.warn('[claudeService] Malformed SSE data:', jsonStr.slice(0, 100), parseErr);
            }
          }
        }
      }

      // Flush remaining buffer after stream ends
      if (buffer.trim()) {
        for (const line of buffer.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          try {
            const event: ClaudeFrontendEvent = JSON.parse(trimmed.slice(6));
            if (event.event_type === 'done') receivedDone = true;
            onEvent(event);
          } catch (parseErr) {
            console.warn('[claudeService] Malformed SSE tail:', trimmed.slice(0, 100), parseErr);
          }
        }
      }

      // Safety net: if the stream closed without a 'done' event (e.g. the
      // Claude Agent SDK subprocess exited without producing a ResultMessage),
      // synthesize one so the frontend doesn't get stuck with isStreaming=true.
      if (!receivedDone) {
        onEvent({
          event_type: 'done',
          text: null,
          tool_name: null,
          tool_input: null,
          tool_output: null,
          session_id: null,
          cost_usd: null,
          meeting_id: (body as Record<string, unknown>).meeting_id as string,
        });
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return; // expected on cancel
      onError?.(err as Error);
    } finally {
      // R003: Guarantee reader is released to prevent resource leaks
      reader?.releaseLock();
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
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`getClaudeSession failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function clearClaudeSession(meetingId: string): Promise<void> {
  const res = await fetch(`${BACKEND}/api/claude/session/${encodeURIComponent(meetingId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error(`clearClaudeSession failed: ${res.status} ${res.statusText}`);
  }
}

export async function cancelClaudeSession(meetingId: string): Promise<void> {
  const res = await fetch(`${BACKEND}/api/claude/cancel/${encodeURIComponent(meetingId)}`, {
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error(`cancelClaudeSession failed: ${res.status} ${res.statusText}`);
  }
}

// ---------------------------------------------------------------------------
// Document parsing (F044)
// ---------------------------------------------------------------------------

export interface DocumentParseResult {
  filename: string;
  format: string;
  pages: number | null;
  text: string;
  preview: string;
  truncated: boolean;
}

const SUPPORTED_DOC_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md', '.markdown', '.csv'];

export function isSupportedDocument(filename: string): boolean {
  const ext = '.' + filename.split('.').pop()?.toLowerCase();
  return SUPPORTED_DOC_EXTENSIONS.includes(ext);
}

export async function parseDocument(file: File): Promise<DocumentParseResult> {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(`${BACKEND}/api/documents/parse`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Document parse failed: ${res.status} — ${detail}`);
  }
  return res.json();
}
