import React from 'react';
import { X, FileText, Camera, Clipboard, Quote, StickyNote, Shield } from 'lucide-react';
import { ContextBasketItem } from '@/contexts/ClaudeContext';
import { useDropZone } from '@/hooks/useDragAndDrop';

interface ContextBasketProps {
  items: ContextBasketItem[];
  onRemove: (id: string) => void;
  onClear: () => void;
  anonymizationEnabled?: boolean;
  onToggleItemAnonymization?: (itemId: string) => void;
  onAdd: (item: ContextBasketItem) => void;
}

const typeIcons: Record<string, React.ElementType> = {
  transcript_chunk: FileText,
  screenshot: Camera,
  clipboard: Clipboard,
  highlight: Quote,
  note: StickyNote,
};

export function ContextBasket({ items, onRemove, onClear, anonymizationEnabled, onToggleItemAnonymization, onAdd }: ContextBasketProps) {
  const { isOver, dropHandlers } = useDropZone(onAdd);

  if (items.length === 0) {
    return (
      <div
        {...dropHandlers}
        className={`px-3 py-2 text-xs text-muted-foreground italic border-b transition-colors ${
          isOver
            ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-300 border-dashed border-2'
            : 'border-border'
        }`}
      >
        {isOver
          ? 'Drop here to add to context'
          : 'Drag items here or use \u201cAdd to AI\u201d buttons on transcript chunks, screenshots, or clips'}
      </div>
    );
  }

  const totalChars = items.reduce((sum, i) => sum + i.fullContent.length, 0);
  const approxTokens = Math.round(totalChars / 4);

  return (
    <div
      {...dropHandlers}
      className={`border-b transition-colors ${
        isOver ? 'border-blue-300 bg-blue-50/50 dark:bg-blue-900/10' : 'border-border'
      }`}
    >
      <div className="px-3 py-1.5 flex items-center justify-between bg-muted border-b border-border">
        <span className="text-xs font-medium text-muted-foreground">
          Context ({items.length} items, ~{approxTokens.toLocaleString()} tokens)
        </span>
        <button
          onClick={onClear}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Clear all
        </button>
      </div>
      <div className="max-h-[200px] overflow-y-auto p-2 space-y-1">
        {items.map(item => {
          const Icon = typeIcons[item.type] || FileText;
          const willAnonymize = item.anonymize ?? (anonymizationEnabled ?? false);
          const isOverridden = item.anonymize !== undefined;
          return (
            <div
              key={item.id}
              className="flex items-start gap-1.5 p-1.5 rounded bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800/30 text-xs group"
            >
              {/* F005: Per-item anonymization shield */}
              {onToggleItemAnonymization && (
                <button
                  onClick={() => onToggleItemAnonymization(item.id)}
                  className={`mt-0.5 flex-shrink-0 transition-colors ${
                    willAnonymize
                      ? 'text-emerald-500 hover:text-emerald-600'
                      : 'text-muted-foreground/50 hover:text-muted-foreground'
                  }`}
                  title={willAnonymize ? 'PII will be anonymized (click to send raw)' : 'Sending raw (click to anonymize)'}
                >
                  <Shield className="w-3 h-3" />
                </button>
              )}
              <Icon className="w-3.5 h-3.5 mt-0.5 text-blue-500 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-blue-700 dark:text-blue-300 truncate">{item.label}</div>
                <div className="text-muted-foreground truncate">{item.preview}</div>
                {isOverridden && (
                  <div className="text-[10px] text-muted-foreground italic">
                    {willAnonymize ? 'Anonymization ON (overridden)' : 'Anonymization OFF (overridden)'}
                  </div>
                )}
              </div>
              <button
                onClick={() => onRemove(item.id)}
                className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground flex-shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
