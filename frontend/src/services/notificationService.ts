/**
 * Notification service — connects to the backend SSE stream for push notifications.
 */

import { BACKEND } from './claudeService';

export interface NotificationEvent {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  title: string | null;
  body: string;
  source: string;
  meeting_id: string | null;
  show_in_panel: boolean;
  data: Record<string, unknown> | null;
  duration_ms: number | null;
  timestamp: number;
}

/**
 * Open a persistent SSE connection to /api/notify/stream.
 * Auto-reconnects with exponential backoff (1s → 30s cap).
 * Returns a cleanup function to close the connection.
 */
export function connectNotificationStream(
  onEvent: (event: NotificationEvent) => void,
  onConnectionChange?: (connected: boolean) => void,
): () => void {
  let abortController: AbortController | null = null;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = false;

  async function connect() {
    if (stopped) return;
    abortController = new AbortController();

    try {
      const res = await fetch(`${BACKEND}/api/notify/stream`, {
        signal: abortController.signal,
      });

      if (!res.ok) {
        throw new Error(`Notification stream returned ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      // Connected successfully — reset backoff
      attempt = 0;
      onConnectionChange?.(true);

      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop() || '';

          for (const eventBlock of events) {
            for (const line of eventBlock.split('\n')) {
              const trimmed = line.trim();
              // Skip keepalive comments
              if (!trimmed || trimmed.startsWith(':')) continue;
              if (!trimmed.startsWith('data: ')) continue;
              try {
                const event: NotificationEvent = JSON.parse(trimmed.slice(6));
                onEvent(event);
              } catch {
                console.warn('[notificationService] Malformed SSE data:', trimmed.slice(0, 100));
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      console.warn('[notificationService] Stream disconnected:', (err as Error).message);
    }

    // Disconnected — schedule reconnect with exponential backoff
    onConnectionChange?.(false);
    if (!stopped) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      attempt++;
      reconnectTimeout = setTimeout(connect, delay);
    }
  }

  connect();

  return () => {
    stopped = true;
    abortController?.abort();
    if (reconnectTimeout !== null) clearTimeout(reconnectTimeout);
    onConnectionChange?.(false);
  };
}

/**
 * POST a notification to the backend (useful for testing from frontend).
 */
export async function sendNotification(notification: {
  level?: string;
  title?: string;
  body: string;
  source?: string;
  meeting_id?: string;
  show_in_panel?: boolean;
  data?: Record<string, unknown>;
  duration_ms?: number;
}): Promise<{ status: string; id: string; subscribers: number }> {
  const res = await fetch(`${BACKEND}/api/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(notification),
  });
  if (!res.ok) {
    throw new Error(`sendNotification failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}
