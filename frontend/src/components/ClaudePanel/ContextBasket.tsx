import React, { useState, useCallback, useRef } from 'react';
import { X, FileText, Camera, Clipboard, Quote, StickyNote, Shield, Trash2 } from 'lucide-react';
import { ContextBasketItem } from '@/contexts/ClaudeContext';
import { CHARS_PER_TOKEN } from '@/lib/constants';

interface ContextBasketProps {
  items: ContextBasketItem[];
  onRemove: (id: string) => void;
  onClear: () => void;
  anonymizationEnabled?: boolean;
  onToggleItemAnonymization?: (itemId: string) => void;
}

const typeIcons: Record<string, React.ElementType> = {
  transcript_chunk: FileText,
  screenshot: Camera,
  clipboard: Clipboard,
  highlight: Quote,
  note: StickyNote,
  document: FileText,
};

export function ContextBasket({ items, onRemove, onClear, anonymizationEnabled, onToggleItemAnonymization }: ContextBasketProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastSelectedIdRef = useRef<string | null>(null);

  const toggleItem = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        lastSelectedIdRef.current = id;
      }
      return next;
    });
  }, []);

  const toggleSelect = useCallback((id: string, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      toggleItem(id);
    } else if (e.shiftKey && selectedIds.size > 0) {
      e.preventDefault();
      const lastId = lastSelectedIdRef.current ?? Array.from(selectedIds).pop()!;
      const startIdx = items.findIndex(i => i.id === lastId);
      const endIdx = items.findIndex(i => i.id === id);
      if (startIdx !== -1 && endIdx !== -1) {
        const [min, max] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
        const range = items.slice(min, max + 1).map(i => i.id);
        setSelectedIds(new Set(range));
      }
    }
  }, [selectedIds, items, toggleItem]);

  const handleItemKeyDown = useCallback((id: string, e: React.KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      toggleItem(id);
    }
  }, [toggleItem]);

  const removeSelected = useCallback(() => {
    selectedIds.forEach(id => onRemove(id));
    setSelectedIds(new Set());
  }, [selectedIds, onRemove]);

  if (items.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground italic border-b border-border">
        Drag items here or use &ldquo;Add to AI&rdquo; buttons on transcript chunks, screenshots, or clips
      </div>
    );
  }

  const totalChars = items.reduce((sum, i) => sum + i.fullContent.length, 0);
  const approxTokens = Math.round(totalChars / CHARS_PER_TOKEN);
  const hasSelection = selectedIds.size > 0;

  return (
    <div className="border-b border-border">
      <div className="px-3 py-1.5 flex items-center justify-between bg-muted border-b border-border">
        <span className="text-xs font-medium text-muted-foreground">
          Context ({items.length} items, ~{approxTokens.toLocaleString()} tokens)
        </span>
        <div className="flex items-center gap-2">
          {hasSelection && (
            <button
              onClick={removeSelected}
              className="text-xs text-destructive hover:text-destructive/80 flex items-center gap-0.5"
              title={`Remove ${selectedIds.size} selected items`}
            >
              <Trash2 className="w-3 h-3" />
              Remove {selectedIds.size}
            </button>
          )}
          <button
            onClick={onClear}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Clear all
          </button>
        </div>
      </div>
      <div className="max-h-[200px] overflow-y-auto p-2 space-y-1" role="listbox" aria-label="Context basket items" aria-multiselectable="true">
        {items.map(item => {
          const Icon = typeIcons[item.type] || FileText;
          const willAnonymize = item.anonymize ?? (anonymizationEnabled ?? false);
          const isOverridden = item.anonymize !== undefined;
          const isSelected = selectedIds.has(item.id);
          return (
            <div
              key={item.id}
              role="option"
              aria-selected={isSelected}
              tabIndex={0}
              onClick={(e) => toggleSelect(item.id, e)}
              onKeyDown={(e) => handleItemKeyDown(item.id, e)}
              className={`flex items-start gap-1.5 p-1.5 rounded border text-xs group transition-colors cursor-pointer ${
                isSelected
                  ? 'bg-brand-muted border-brand ring-1 ring-brand/30'
                  : 'bg-brand-muted/50 border-brand/10'
              }`}
            >
              {/* F005: Per-item anonymization shield */}
              {onToggleItemAnonymization && (
                <button
                  onClick={(e) => { e.stopPropagation(); onToggleItemAnonymization(item.id); }}
                  className={`mt-0.5 flex-shrink-0 transition-colors ${
                    willAnonymize
                      ? 'text-success hover:text-success/80'
                      : 'text-muted-foreground/50 hover:text-muted-foreground'
                  }`}
                  title={willAnonymize ? 'PII will be anonymized (click to send raw)' : 'Sending raw (click to anonymize)'}
                >
                  <Shield className="w-3 h-3" />
                </button>
              )}
              <Icon className="w-3.5 h-3.5 mt-0.5 text-brand flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-brand-muted-foreground truncate">{item.label}</div>
                <div className="text-muted-foreground truncate">{item.preview}</div>
                {isOverridden && (
                  <div className="text-[10px] text-muted-foreground italic">
                    {willAnonymize ? 'Anonymization ON (overridden)' : 'Anonymization OFF (overridden)'}
                  </div>
                )}
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); onRemove(item.id); }}
                className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 transition-opacity text-muted-foreground hover:text-foreground flex-shrink-0"
                aria-label={`Remove ${item.label} from context`}
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
