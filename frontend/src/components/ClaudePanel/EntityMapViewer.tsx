import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';

interface EntityMapViewerProps {
  entityMap: Record<string, string>;
  onClear: () => void;
}

export function EntityMapViewer({ entityMap, onClear }: EntityMapViewerProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const entries = Object.entries(entityMap);

  if (entries.length === 0) return null;

  return (
    <div className="border-b border-border bg-muted">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-3 py-1.5 flex items-center justify-between text-xs text-muted-foreground hover:text-foreground"
      >
        <span className="flex items-center gap-1">
          {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          <span className="font-medium">Entity Map ({entries.length} replacements)</span>
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); onClear(); }}
          className="text-muted-foreground hover:text-red-500 p-0.5"
          title="Clear entity map"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </button>

      {isExpanded && (
        <div className="px-3 pb-2 max-h-[150px] overflow-y-auto">
          <div className="space-y-0.5">
            {entries.map(([real, surrogate]) => (
              <div key={real} className="flex items-center gap-2 text-[11px] py-0.5">
                <span className="text-red-400 line-through truncate flex-1 min-w-0">{real}</span>
                <span className="text-muted-foreground flex-shrink-0">&rarr;</span>
                <span className="text-emerald-500 truncate flex-1 min-w-0">{surrogate}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
