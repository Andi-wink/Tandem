'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { connectNotificationStream, NotificationEvent } from '@/services/notificationService';

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
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

const MAX_RECENT = 50;

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const [isConnected, setIsConnected] = useState(false);
  const [recentNotifications, setRecentNotifications] = useState<NotificationEvent[]>([]);

  const clearNotifications = useCallback(() => {
    setRecentNotifications([]);
  }, []);

  useEffect(() => {
    const cleanup = connectNotificationStream(
      (event) => {
        // Store in recent list (capped)
        setRecentNotifications(prev => {
          const next = [event, ...prev];
          return next.length > MAX_RECENT ? next.slice(0, MAX_RECENT) : next;
        });

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
    <NotificationContext.Provider value={{ isConnected, recentNotifications, clearNotifications }}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error('useNotifications must be used within NotificationProvider');
  return ctx;
}
