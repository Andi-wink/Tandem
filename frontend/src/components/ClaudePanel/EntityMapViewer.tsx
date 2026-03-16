import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Trash2, Eye, EyeOff } from 'lucide-react';

interface EntityMapViewerProps {
  entityMap: Record<string, string>;
  onClear: () => void;
}

export function EntityMapViewer({ entityMap, onClear }: EntityMapViewerProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showReal, setShowReal] = useState(false);
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
        <span className="flex items-center gap-1">
          {isExpanded && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowReal(!showReal); }}
              className="text-muted-foreground hover:text-foreground p-0.5"
              title={showReal ? 'Hide original values' : 'Reveal original values'}
            >
              {showReal ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            className="text-muted-foreground hover:text-destructive p-0.5"
            title="Clear entity map"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </span>
      </button>

      {isExpanded && (
        <div className="px-3 pb-2 max-h-[150px] overflow-y-auto">
          <div className="space-y-0.5">
            {entries.map(([real, surrogate]) => (
              <div key={real} className="flex items-center gap-2 text-[11px] py-0.5">
                {showReal ? (
                  <>
                    <span className="text-destructive/70 line-through truncate flex-1 min-w-0">{real}</span>
                    <span className="text-muted-foreground flex-shrink-0">&rarr;</span>
                    <span className="text-success truncate flex-1 min-w-0">{surrogate}</span>
                  </>
                ) : (
                  <>
                    <span className="text-success truncate flex-1 min-w-0">{surrogate}</span>
                    <span className="text-muted-foreground/60 flex-shrink-0 text-[10px]">(redacted)</span>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
