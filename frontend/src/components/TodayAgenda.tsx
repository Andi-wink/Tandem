'use client';

/**
 * TodayAgenda — a calm, read-only card of today's calls on the home view.
 *
 * Invisible-when-active: the parent only renders this while NOT recording. It never blocks and
 * never surfaces the (secret) ICS URL in any error state. Data comes from CalendarContext, which
 * polls the Rust `fetch_calendar_ics` command on the stored interval.
 */

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { CalendarDays, RefreshCw, Video, ExternalLink } from 'lucide-react';
import { useCalendar } from '@/contexts/CalendarContext';
import type { CalendarEvent } from '@/lib/ics';

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtAgo(ms: number | null): string | null {
  if (ms == null) return null;
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins <= 0) return 'just now';
  if (mins === 1) return '1m ago';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

function AgendaRow({ ev, now }: { ev: CalendarEvent; now: number }) {
  const inProgress = ev.startMs <= now && ev.endMs > now;
  return (
    <div
      data-testid="agenda-row"
      className={`flex items-start gap-3 py-2 pl-3 pr-2 rounded-md ${
        inProgress ? 'border-l-2 border-brand bg-muted/40' : 'border-l-2 border-transparent'
      }`}
    >
      <div className="w-24 shrink-0 pt-0.5 text-sm tabular-nums text-muted-foreground">
        {ev.allDay ? 'All day' : `${fmtTime(ev.startMs)}–${fmtTime(ev.endMs)}`}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{ev.summary}</div>
        {ev.location && !ev.joinUrl && (
          <div className="truncate text-xs text-muted-foreground">{ev.location}</div>
        )}
      </div>
      {ev.joinUrl && (
        <a
          href={ev.joinUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          <Video className="h-3.5 w-3.5" />
          Join
        </a>
      )}
    </div>
  );
}

export function TodayAgenda() {
  const {
    todayEvents, configured, isRefreshing, error, lastRefreshedMs, refresh,
  } = useCalendar();

  const rootRef = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState(false);
  const now = Date.now();

  // Palette "Show today's agenda" command scrolls to and briefly highlights the card.
  useEffect(() => {
    const onShow = () => {
      rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setHighlight(true);
      const t = setTimeout(() => setHighlight(false), 1200);
      return () => clearTimeout(t);
    };
    window.addEventListener('tandem:show-agenda', onShow);
    return () => window.removeEventListener('tandem:show-agenda', onShow);
  }, []);

  const ago = fmtAgo(lastRefreshedMs);

  return (
    <div
      ref={rootRef}
      data-testid="today-agenda"
      className={`mt-4 rounded-lg border bg-card p-4 shadow-sm transition-[box-shadow] duration-300 ${
        highlight ? 'ring-2 ring-brand' : 'border-border'
      }`}
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Today</h2>
        </div>
        {configured && (
          <button
            type="button"
            onClick={() => { void refresh(); }}
            disabled={isRefreshing}
            title="Refresh calendar"
            aria-label="Refresh calendar"
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            {ago ? <span className="tabular-nums">{ago}</span> : 'Refresh'}
          </button>
        )}
      </div>

      {!configured ? (
        <div className="py-2">
          <p className="text-sm text-foreground">Connect your calendar</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            See today&apos;s calls here. In Outlook: Settings → Calendar → Shared calendars → Publish,
            then paste the ICS link in{' '}
            <Link href="/settings" className="text-brand hover:underline">Settings</Link>.
            Proton share-via-link also works (same-day changes can lag a few hours).
          </p>
        </div>
      ) : error ? (
        <div className="py-2">
          <p className="text-sm font-medium text-foreground">Couldn&apos;t load your calendar</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {error} Check the calendar URL in{' '}
            <Link href="/settings" className="text-brand hover:underline">Settings</Link>{' '}
            and that the calendar is still published.
          </p>
        </div>
      ) : todayEvents.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">No calls scheduled today.</p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {todayEvents.map((ev) => (
            <AgendaRow key={`${ev.uid}-${ev.startMs}`} ev={ev} now={now} />
          ))}
          <div className="mt-2 flex items-center justify-end">
            <Link
              href="/settings"
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              Calendar settings <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
