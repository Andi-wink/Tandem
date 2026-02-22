import React from 'react';
import { FileText, Plus, Check } from 'lucide-react';
import { TranscriptChunk } from '@/types';
import { useClaude, ContextBasketItem } from '@/contexts/ClaudeContext';

interface TranscriptChunksProps {
  chunks: TranscriptChunk[];
}

export function TranscriptChunks({ chunks }: TranscriptChunksProps) {
  const { addToBasket, contextBasket, isPanelOpen } = useClaude();

  if (!isPanelOpen || chunks.length === 0) return null;

  const basketIds = new Set(contextBasket.map(b => b.id));

  const handleAdd = (chunk: TranscriptChunk) => {
    const item: ContextBasketItem = {
      id: chunk.id,
      type: 'transcript_chunk',
      label: chunk.label,
      preview: chunk.preview,
      fullContent: chunk.fullText,
      timestamp: chunk.startSecs,
    };
    addToBasket(item);
  };

  return (
    <div className="px-3 py-2 border-b border-gray-200 bg-gray-50">
      <div className="text-xs font-medium text-gray-500 mb-1.5">
        Transcript chunks ({chunks.length})
      </div>
      <div className="flex flex-wrap gap-1.5">
        {chunks.map(chunk => {
          const inBasket = basketIds.has(chunk.id);
          return (
            <button
              key={chunk.id}
              onClick={() => !inBasket && handleAdd(chunk)}
              disabled={inBasket}
              className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs border transition-colors ${
                inBasket
                  ? 'bg-blue-50 border-blue-200 text-blue-600 cursor-default'
                  : 'bg-white border-gray-200 text-gray-700 hover:border-blue-300 hover:bg-blue-50'
              }`}
              title={inBasket ? 'Already in context' : `Add ${chunk.label} (${chunk.segmentCount} segments) to AI context`}
            >
              <FileText className="w-3 h-3 flex-shrink-0" />
              <span className="font-medium">{chunk.label}</span>
              <span className="text-gray-400">({chunk.segmentCount})</span>
              {inBasket ? (
                <Check className="w-3 h-3 text-blue-500" />
              ) : (
                <Plus className="w-3 h-3 text-gray-400" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
