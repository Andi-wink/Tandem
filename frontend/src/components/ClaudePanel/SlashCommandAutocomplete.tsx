// F018: Autocomplete dropdown for slash commands
import React, { useEffect, useRef } from 'react';
import { Search, FileText, ListChecks, ShieldAlert, AlertTriangle, ClipboardList, Download } from 'lucide-react';
import type { SlashCommand } from '@/lib/slashCommands';

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Search,
  FileText,
  ListChecks,
  ShieldAlert,
  AlertTriangle,
  ClipboardList,
  Download, // F020: handoff command icon
};

interface SlashCommandAutocompleteProps {
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (cmd: SlashCommand) => void;
}

export function SlashCommandAutocomplete({
  commands,
  selectedIndex,
  onSelect,
}: SlashCommandAutocompleteProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (commands.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1 bg-popover border border-border rounded-lg shadow-lg overflow-hidden z-50 max-h-64 overflow-y-auto"
    >
      {commands.map((cmd, i) => {
        const Icon = ICON_MAP[cmd.icon] || Search;
        const isSelected = i === selectedIndex;
        return (
          <button
            key={cmd.name}
            onMouseDown={(e) => {
              // mouseDown (not click) so it fires before textarea blur
              e.preventDefault();
              onSelect(cmd);
            }}
            className={`flex items-center gap-3 w-full px-3 py-2 text-left text-sm transition-colors ${
              isSelected
                ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                : 'hover:bg-muted text-foreground'
            }`}
          >
            <Icon className="w-4 h-4 flex-shrink-0 opacity-60" />
            <div className="flex-1 min-w-0">
              <span className="font-mono font-medium">/{cmd.name}</span>
              <span className="ml-2 text-muted-foreground text-xs">{cmd.description}</span>
            </div>
          </button>
        );
      })}
      <div className="px-3 py-1.5 text-[10px] text-muted-foreground border-t border-border bg-muted/50">
        <kbd className="font-mono">↑↓</kbd> navigate &middot; <kbd className="font-mono">Tab</kbd> select &middot; <kbd className="font-mono">Esc</kbd> dismiss
      </div>
    </div>
  );
}