'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { connectNotificationStream, NotificationEvent } from '@/services/notificationService';

// When set to '1', in-app notifications are muted: popup toasts are suppressed and the OS
// taskbar/dock is not flashed. Incoming events are STILL collected in the bell list. Default
// (unset or '0') = unmuted. This governs only the in-app toast/taskbar layer, not the native
// OS NotificationManager or the separate "AI panel notifications" toggle.
export const NOTIFICATIONS_MUTED_STORAGE_KEY = 'tandem.notifications.muted';

async function pingTaskbar() {
  try {
    const { getCurrentWindow, UserAttentionType } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    if (await win.isFocused()) return;
    await win.requestUserAttention(UserAttentionType.Informational);
  } catch {
    // Not running under Tauri, or window API unavailable — ignore.
  }
}

/** Split body text into plain segments and clickable <a> links for URLs. */
function renderBodyWithLinks(body: string): React.ReactNode {
  const parts = body.split(/(https?:\/\/[^\s]+)/);
  if (parts.length === 1) return body;
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\/[^\s]+$/.test(part)
          ? <a key={i} href={part} target="_blank" rel="noreferrer" className="underline text-blue-400 break-all">{part}</a>
          : part
      )}
    </>
  );
}

interface NotificationContextValue {
  isConnected: boolean;
  recentNotifications: NotificationEvent[];
  clearNotifications: () => void;
  notificationsMuted: boolean;
  setNotificationsMuted: (muted: boolean) => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

const MAX_RECENT = 50;

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const [isConnected, setIsConnected] = useState(false);
  const [recentNotifications, setRecentNotifications] = useState<NotificationEvent[]>([]);
  const [notificationsMuted, setMutedState] = useState(false);

  // Mirror the muted flag in a ref so the long-lived SSE handler (mounted once) always reads the
  // current value without having to tear down and reconnect the stream when the toggle flips.
  const mutedRef = useRef(false);

  const clearNotifications = useCallback(() => {
    setRecentNotifications([]);
  }, []);

  const setNotificationsMuted = useCallback((muted: boolean) => {
    setMutedState(muted);
    mutedRef.current = muted;
    try {
      localStorage.setItem(NOTIFICATIONS_MUTED_STORAGE_KEY, muted ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);

  // Hydrate the muted flag from localStorage after mount (SSR-safe: no localStorage read during
  // render, mirroring how PANEL_NOTIFICATIONS_STORAGE_KEY is hydrated in PreferenceSettings).
  useEffect(() => {
    try {
      const muted = localStorage.getItem(NOTIFICATIONS_MUTED_STORAGE_KEY) === '1';
      setMutedState(muted);
      mutedRef.current = muted;
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const cleanup = connectNotificationStream(
      (event) => {
        // Store in recent list (capped) — the bell keeps collecting even while muted.
        setRecentNotifications(prev => {
          const next = [event, ...prev];
          return next.length > MAX_RECENT ? next.slice(0, MAX_RECENT) : next;
        });

        // When muted, suppress the popup toast and taskbar flash but keep collecting above and
        // keep forwarding panel events below (that layer has its own toggle).
        if (mutedRef.current) {
          if (event.show_in_panel) {
            window.dispatchEvent(
              new CustomEvent('tandem-notification', { detail: event }),
            );
          }
          return;
        }

        // Flash the OS taskbar/dock icon when the app isn't focused.
        pingTaskbar();

        // Show toast based on level
        // If there's a title, show it as the heading and put body (with clickable links) in description.
        // If no title, body becomes the heading (plain text — usually short).
        const toastMsg = event.title || event.body;
        const toastOpts = {
          description: event.title ? renderBodyWithLinks(event.body)
            : (event.source && event.source !== 'unknown' ? `from ${event.source}` : undefined),
          duration: event.duration_ms ?? undefined,
        };

        switch (event.level) {
          case 'success':
            toast.success(toastMsg, toastOpts);
            break;
          case 'warning':
            toast.warning(toastMsg, toastOpts);
            break;
          case 'error':
            toast.error(toastMsg, toastOpts);
            break;
          default:
            toast.info(toastMsg, toastOpts);
            break;
        }

        // Dispatch custom event for ClaudeContext to pick up (panel messages)
        if (event.show_in_panel) {
          window.dispatchEvent(
            new CustomEvent('tandem-notification', { detail: event }),
          );
        }
      },
      (connected) => setIsConnected(connected),
    );

    return cleanup;
  }, []);

  return (
    <NotificationContext.Provider value={{ isConnected, recentNotifications, clearNotifications, notificationsMuted, setNotificationsMuted }}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error('useNotifications must be used within NotificationProvider');
  return ctx;
}
