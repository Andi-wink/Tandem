'use client';

import { useState, useRef, useEffect } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { useNotifications } from '@/contexts/NotificationContext';
import type { NotificationEvent } from '@/services/notificationService';

function levelIcon(level: string) {
  switch (level) {
    case 'success': return '✓';
    case 'warning': return '⚠';
    case 'error': return '✕';
    default: return 'ℹ';
  }
}

function levelColor(level: string) {
  switch (level) {
    case 'success': return 'text-green-500';
    case 'warning': return 'text-amber-500';
    case 'error': return 'text-red-500';
    default: return 'text-blue-500';
  }
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor(Date.now() / 1000 - timestamp);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function NotificationItem({ event }: { event: NotificationEvent }) {
  return (
    <div className="flex items-start gap-2 px-3 py-2 border-b border-border last:border-b-0 hover:bg-accent/50 transition-colors">
      <span className={`text-sm font-bold mt-0.5 ${levelColor(event.level)}`}>
        {levelIcon(event.level)}
      </span>
      <div className="min-w-0 flex-1">
        {event.title && (
          <p className="text-sm font-medium text-foreground truncate">{event.title}</p>
        )}
        <p className="text-xs text-muted-foreground line-clamp-2">{event.body}</p>
        <p className="text-[10px] text-muted-foreground/60 mt-0.5">
          {timeAgo(event.timestamp)}
          {event.source && event.source !== 'unknown' && ` · ${event.source}`}
        </p>
      </div>
    </div>
  );
}

export function NotificationBell({ isCollapsed = false }: { isCollapsed?: boolean }) {
  const { recentNotifications, clearNotifications, isConnected, notificationsMuted, setNotificationsMuted } = useNotifications();
  const [isOpen, setIsOpen] = useState(false);
  const [lastSeenCount, setLastSeenCount] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const unreadCount = recentNotifications.length - lastSeenCount;
  const hasUnread = unreadCount > 0;

  // Close dropdown on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  const handleOpen = () => {
    setIsOpen(prev => !prev);
    if (!isOpen) {
      setLastSeenCount(recentNotifications.length);
    }
  };

  const handleClear = () => {
    clearNotifications();
    setLastSeenCount(0);
    setIsOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={handleOpen}
        className={`relative flex items-center justify-center rounded-lg transition-colors hover:bg-accent ${
          isCollapsed ? 'p-2' : 'w-full px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground'
        }`}
        aria-label={`Notifications${notificationsMuted ? ' (muted)' : ''}${hasUnread ? ` (${unreadCount} new)` : ''}`}
        title={notificationsMuted ? 'Notifications muted' : undefined}
      >
        {notificationsMuted
          ? <BellOff className="w-4 h-4 text-muted-foreground" />
          : <Bell className="w-4 h-4" />}
        {hasUnread && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
        {!isCollapsed && <span className="ml-2">Notifications</span>}
      </button>

      {isOpen && (
        <div className={`absolute z-50 bg-popover border border-border rounded-lg shadow-lg overflow-hidden ${
          isCollapsed ? 'left-full ml-2 bottom-0' : 'bottom-full mb-2 left-0 right-0'
        }`}
          style={{ width: isCollapsed ? '300px' : undefined, minWidth: '280px' }}
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-sm font-semibold text-foreground">Notifications</span>
            <div className="flex items-center gap-2">
              {!isConnected && (
                <span className="text-[10px] text-amber-500">disconnected</span>
              )}
              <button
                onClick={() => setNotificationsMuted(!notificationsMuted)}
                className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors ${
                  notificationsMuted
                    ? 'text-amber-600 dark:text-amber-500 hover:bg-accent'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                }`}
                role="switch"
                aria-checked={notificationsMuted}
                aria-label="Mute notifications"
                title={
                  notificationsMuted
                    ? 'Notifications muted — pause popup toasts; the bell keeps collecting'
                    : 'Mute notifications — pause popup toasts; the bell keeps collecting'
                }
              >
                {notificationsMuted
                  ? <BellOff className="w-3.5 h-3.5" />
                  : <Bell className="w-3.5 h-3.5" />}
                <span>{notificationsMuted ? 'Muted' : 'Mute'}</span>
              </button>
              {recentNotifications.length > 0 && (
                <button
                  onClick={handleClear}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Clear all
                </button>
              )}
            </div>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {recentNotifications.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                No notifications
              </div>
            ) : (
              recentNotifications.map((event) => (
                <NotificationItem key={event.id} event={event} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
