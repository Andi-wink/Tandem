import React, { memo, useMemo } from 'react';
import { FileText, Plus, Check } from 'lucide-react';
import { TranscriptChunk } from '@/types';
import { useClaude, ContextBasketItem } from '@/contexts/ClaudeContext';
import { useDraggableBasketItem } from '@/hooks/useDragAndDrop';
import { useSelection } from '@/contexts/SelectionContext';

interface TranscriptChunksProps {
  chunks: TranscriptChunk[];
}

const DraggableChunkButton = memo(function DraggableChunkButton({
  chunk,
  inBasket,
  isSelected,
  onAdd,
  onSelect,
  selectedItems,
}: {
  chunk: TranscriptChunk;
  inBasket: boolean;
  isSelected: boolean;
  onAdd: (chunk: TranscriptChunk) => void;
  onSelect: (id: string, e: React.MouseEvent) => void;
  selectedItems: ContextBasketItem[];
}) {
  const basketItem: ContextBasketItem | null = inBasket ? null : {
    id: chunk.id,
    type: 'transcript_chunk',
    label: chunk.label,
    preview: chunk.preview,
    fullContent: chunk.fullText,
    timestamp: chunk.startSecs,
  };

  const { isDragging, dragHandlers } = useDraggableBasketItem(basketItem, selectedItems);

  const handleClick = (e: React.MouseEvent) => {
    if (inBasket) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      e.preventDefault();
      onSelect(chunk.id, e);
    } else {
      onAdd(chunk);
    }
  };

  return (
    <button
      {...dragHandlers}
      data-selectable-id={chunk.id}
      onClick={handleClick}
      disabled={inBasket}
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs border select-none transition-all ${
        isDragging ? 'opacity-60 ring-2 ring-blue-400 shadow-[0_0_12px_rgba(59,130,246,0.4)] scale-[0.97]' : ''
      } ${
        isSelected && !inBasket ? 'bg-blue-100 dark:bg-blue-900/40 border-blue-400 ring-1 ring-blue-300' : ''
      } ${
        inBasket
          ? 'bg-blue-50 border-blue-200 text-blue-600 cursor-default'
          : 'bg-background border-border text-foreground hover:border-blue-300 hover:bg-blue-50 cursor-grab'
      }`}
      title={inBasket ? 'Already in context' : `Drag or click to add ${chunk.label} to AI context. Ctrl+click to select.`}
    >
      <FileText className="w-3 h-3 flex-shrink-0" />
      <span className="font-medium">{chunk.label}</span>
      <span className="text-muted-foreground">({chunk.segmentCount})</span>
      {inBasket ? (
        <Check className="w-3 h-3 text-blue-500" />
      ) : (
        <Plus className="w-3 h-3 text-muted-foreground" />
      )}
    </button>
  );
});

export function TranscriptChunks({ chunks }: TranscriptChunksProps) {
  const { addToBasket, contextBasket, isPanelOpen } = useClaude();
  const { selectedIds, toggle, rangeTo, isSelected } = useSelection();

  if (!isPanelOpen || chunks.length === 0) return null;

  const basketIds = new Set(contextBasket.map(b => b.id));
  const chunkIds = chunks.map(c => c.id);

  // Build selected items array for multi-drag
  const selectedItems: ContextBasketItem[] = useMemo(() => {
    return chunks
      .filter(c => selectedIds.has(c.id) && !basketIds.has(c.id))
      .map(c => ({
        id: c.id,
        type: 'transcript_chunk' as const,
        label: c.label,
        preview: c.preview,
        fullContent: c.fullText,
        timestamp: c.startSecs,
      }));
  }, [chunks, selectedIds, basketIds]);

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

  const handleSelect = (id: string, e: React.MouseEvent) => {
    if (e.shiftKey) {
      rangeTo(id, chunkIds);
    } else {
      toggle(id);
    }
  };

  return (
    <div className="px-3 py-2 border-b border-border bg-muted">
      <div className="text-xs font-medium text-muted-foreground mb-1.5">
        Transcript chunks ({chunks.length})
      </div>
      <div className="flex flex-wrap gap-1.5">
        {chunks.map(chunk => (
          <DraggableChunkButton
            key={chunk.id}
            chunk={chunk}
            inBasket={basketIds.has(chunk.id)}
            isSelected={isSelected(chunk.id)}
            onAdd={handleAdd}
            onSelect={handleSelect}
            selectedItems={selectedItems}
          />
        ))}
      </div>
    </div>
  );
}
