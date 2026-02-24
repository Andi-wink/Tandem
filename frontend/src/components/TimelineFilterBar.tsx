'use client';

import { memo } from 'react';
import { TimelineFilter } from '@/types';
import { Camera, MessageSquare, Layers, Clipboard } from 'lucide-react';

interface TimelineFilterBarProps {
  filter: TimelineFilter;
  onFilterChange: (filter: TimelineFilter) => void;
  screenshotCount: number;
  clipboardCount?: number;
}

export const TimelineFilterBar = memo(function TimelineFilterBar({
  filter,
  onFilterChange,
  screenshotCount,
  clipboardCount = 0,
}: TimelineFilterBarProps) {
  // Only show when there is something beyond transcripts to filter
  if (screenshotCount === 0 && clipboardCount === 0) return null;

  const filters: { value: TimelineFilter; label: string; icon: typeof Layers; count?: number }[] = [
    { value: 'all', label: 'All', icon: Layers },
    { value: 'transcripts', label: 'Transcripts', icon: MessageSquare },
    ...(screenshotCount > 0 ? [{ value: 'screenshots' as TimelineFilter, label: 'Screenshots', icon: Camera, count: screenshotCount }] : []),
    ...(clipboardCount > 0 ? [{ value: 'clipboard' as TimelineFilter, label: 'Clips', icon: Clipboard, count: clipboardCount }] : []),
  ];

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border">
      {filters.map(({ value, label, icon: Icon, count }) => (
        <button
          key={value}
          onClick={() => onFilterChange(value)}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            filter === value
              ? 'bg-blue-600/20 text-blue-300 border border-blue-600/30'
              : 'text-muted-foreground hover:text-muted-foreground/50 hover:bg-muted'
          }`}
        >
          <Icon className="w-3 h-3" />
          {label}
          {count !== undefined && count > 0 && (
            <span className="ml-0.5 text-[10px] bg-blue-600/30 px-1 rounded">
              {count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
});
