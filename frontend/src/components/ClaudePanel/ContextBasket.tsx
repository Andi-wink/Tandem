import React from 'react';
import { X, FileText, Camera, Clipboard, Quote, StickyNote, Shield } from 'lucide-react';
import { ContextBasketItem } from '@/contexts/ClaudeContext';

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
};

export function ContextBasket({ items, onRemove, onClear, anonymizationEnabled, onToggleItemAnonymization }: ContextBasketProps) {
  if (items.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-gray-400 italic border-b border-gray-100">
        Use the &quot;Add to AI&quot; buttons on transcript chunks, screenshots, or clips to add context
      </div>
    );
  }

  const totalChars = items.reduce((sum, i) => sum + i.fullContent.length, 0);
  const approxTokens = Math.round(totalChars / 4);

  return (
    <div className="border-b border-gray-200">
      <div className="px-3 py-1.5 flex items-center justify-between bg-gray-50 border-b border-gray-100">
        <span className="text-xs font-medium text-gray-500">
          Context ({items.length} items, ~{approxTokens.toLocaleString()} tokens)
        </span>
        <button
          onClick={onClear}
          className="text-xs text-gray-400 hover:text-gray-600"
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
              className="flex items-start gap-1.5 p-1.5 rounded bg-blue-50 border border-blue-100 text-xs group"
            >
              {/* F005: Per-item anonymization shield */}
              {onToggleItemAnonymization && (
                <button
                  onClick={() => onToggleItemAnonymization(item.id)}
                  className={`mt-0.5 flex-shrink-0 transition-colors ${
                    willAnonymize
                      ? 'text-emerald-500 hover:text-emerald-600'
                      : 'text-gray-300 hover:text-gray-400'
                  }`}
                  title={willAnonymize ? 'PII will be anonymized (click to send raw)' : 'Sending raw (click to anonymize)'}
                >
                  <Shield className="w-3 h-3" />
                </button>
              )}
              <Icon className="w-3.5 h-3.5 mt-0.5 text-blue-500 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-blue-700 truncate">{item.label}</div>
                <div className="text-gray-500 truncate">{item.preview}</div>
                {isOverridden && (
                  <div className="text-[10px] text-gray-400 italic">
                    {willAnonymize ? 'Anonymization ON (overridden)' : 'Anonymization OFF (overridden)'}
                  </div>
                )}
              </div>
              <button
                onClick={() => onRemove(item.id)}
                className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-gray-600 flex-shrink-0"
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
