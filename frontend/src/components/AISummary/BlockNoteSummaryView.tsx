"use client";

import { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from 'react';
import dynamic from 'next/dynamic';
import { useTheme } from 'next-themes';
import { Summary, SummaryDataResponse, SummaryFormat, BlockNoteBlock } from '@/types';
import {
  stripActionItemsFromMarkdown,
  stripActionItemsFromBlockNote,
  stripActionItemsFromLegacy,
} from '@/lib/actionItems';
import { AISummary } from './index';
import { Block } from '@blocknote/core';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import "@blocknote/shadcn/style.css";

// Dynamically import BlockNote Editor to avoid SSR issues
const Editor = dynamic(() => import('../BlockNoteEditor/Editor'), { ssr: false });

interface BlockNoteSummaryViewProps {
  summaryData: SummaryDataResponse | Summary | null;
  onSave?: (data: { markdown?: string; summary_json?: BlockNoteBlock[] }) => void;
  onSummaryChange?: (summary: Summary) => void;
  status?: 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error';
  error?: string | null;
  onRegenerateSummary?: () => void;
  meeting?: {
    id: string;
    title: string;
    created_at: string;
  };
  onDirtyChange?: (isDirty: boolean) => void;
  /**
   * When true, the action-items section is hidden from the rendered summary body (it is shown
   * as the interactive checklist above). The full unfiltered summary stays the save source: the
   * body renders read-only until the explicit "Edit summary" affordance is used, which reveals
   * the complete editable document (action items included).
   */
  hideActionItems?: boolean;
}

export interface BlockNoteSummaryViewRef {
  saveSummary: () => Promise<void>;
  getMarkdown: () => Promise<string>;
  isDirty: boolean;
}

// Format detection helper
function detectSummaryFormat(data: any): { format: SummaryFormat; data: any } {
  if (!data) {
    return { format: 'legacy', data: null };
  }

  // Priority 1: BlockNote format (has summary_json)
  if (data.summary_json && Array.isArray(data.summary_json)) {
    console.log('✅ FORMAT: BLOCKNOTE (summary_json exists)');
    return { format: 'blocknote', data };
  }

  // Priority 2: Markdown format
  if (data.markdown && typeof data.markdown === 'string') {
    console.log('✅ FORMAT: MARKDOWN (will parse to BlockNote)');
    return { format: 'markdown', data };
  }

  // Priority 3: Legacy JSON
  const hasLegacyStructure = data.MeetingName || Object.keys(data).some(key =>
    typeof data[key] === 'object' && data[key]?.title && data[key]?.blocks
  );

  if (hasLegacyStructure) {
    console.log('✅ FORMAT: LEGACY (custom JSON)');
    return { format: 'legacy', data };
  }

  return { format: 'legacy', data: null };
}

export const BlockNoteSummaryView = forwardRef<BlockNoteSummaryViewRef, BlockNoteSummaryViewProps>(({
  summaryData,
  onSave,
  onSummaryChange,
  status = 'idle',
  error = null,
  onRegenerateSummary,
  meeting,
  onDirtyChange,
  hideActionItems = false
}, ref) => {
  const { resolvedTheme } = useTheme();
  const { format, data } = detectSummaryFormat(summaryData);
  const [isDirty, setIsDirty] = useState(false);
  const [currentBlocks, setCurrentBlocks] = useState<Block[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const isContentLoaded = useRef(false);
  // Explicit edit affordance: while hiding action items, the body renders read-only until the
  // user opts in to edit (which shows the full unfiltered document).
  const [isEditing, setIsEditing] = useState(false);
  const showFiltered = hideActionItems && !isEditing;

  // Create BlockNote editor for markdown parsing
  const editor = useCreateBlockNote({
    initialContent: undefined
  });

  // Parse markdown to blocks when format is markdown
  useEffect(() => {
    if (format === 'markdown' && data?.markdown && editor) {
      const loadMarkdown = async () => {
        try {
          console.log('📝 Parsing markdown to BlockNote blocks...');
          // Guard against the replaceBlocks below being counted as a user edit.
          isContentLoaded.current = false;
          // Read-only projection parses the action-items-stripped markdown; editing (or no
          // hiding) parses the full document so the save source keeps action items.
          const source = showFiltered ? stripActionItemsFromMarkdown(data.markdown) : data.markdown;
          const blocks = await editor.tryParseMarkdownToBlocks(source);
          editor.replaceBlocks(editor.document, blocks);
          console.log('✅ Markdown parsed successfully');

          // Delay to ensure editor has finished rendering before allowing onChange
          setTimeout(() => {
            isContentLoaded.current = true;
          }, 100);
        } catch (err) {
          console.error('❌ Failed to parse markdown:', err);
        }
      };
      loadMarkdown();
    }
  }, [format, data?.markdown, editor, showFiltered]);

  // Set content loaded flag for blocknote format
  useEffect(() => {
    if (format === 'blocknote' && data?.summary_json) {
      // Delay to ensure editor has finished rendering
      setTimeout(() => {
        isContentLoaded.current = true;
      }, 100);
    }
  }, [format, data?.summary_json]);

  const handleEditorChange = useCallback((blocks: Block[]) => {
    // Only set dirty flag if content has finished loading
    if (isContentLoaded.current) {
      setCurrentBlocks(blocks);
      setIsDirty(true);
    }
  }, []);

  // Notify parent of dirty state changes
  useEffect(() => {
    if (onDirtyChange) {
      onDirtyChange(isDirty);
    }
  }, [isDirty, onDirtyChange]);

  const handleSave = useCallback(async () => {
    if (!onSave || !isDirty) return;

    setIsSaving(true);
    try {
      console.log('💾 Saving BlockNote content...');

      // Generate markdown from current blocks
      const markdown = await editor.blocksToMarkdownLossy(currentBlocks);

      onSave({
        markdown: markdown,
        summary_json: currentBlocks as unknown as BlockNoteBlock[]
      });

      setIsDirty(false);
      console.log('✅ Save successful');
    } catch (err) {
      console.error('❌ Save failed:', err);
      alert('Failed to save changes. Please try again.');
    } finally {
      setIsSaving(false);
    }
  }, [onSave, isDirty, currentBlocks, editor]);

  // Expose methods to parent via ref
  useImperativeHandle(ref, () => ({
    saveSummary: handleSave,
    getMarkdown: async () => {
      try {
        console.log('🔍 getMarkdown called, format:', format);
        console.log('🔍 currentBlocks length:', currentBlocks.length);
        console.log('🔍 data:', data);

        // Read-only projection: the visible editor holds an action-items-stripped document, so
        // copy/export must come from the ORIGINAL unfiltered data, not the filtered editor.
        if (showFiltered) {
          if (format === 'markdown' && data?.markdown) return data.markdown;
          if (format === 'blocknote') {
            if (data?.markdown) return data.markdown;
            if (Array.isArray(data?.summary_json) && editor) {
              return await editor.blocksToMarkdownLossy(data.summary_json as unknown as Block[]);
            }
          }
        }

        // For markdown format - use the main editor
        if (format === 'markdown' && editor) {
          console.log('📝 Using markdown editor, blocks:', editor.document.length);
          const markdown = await editor.blocksToMarkdownLossy(editor.document);
          console.log('📝 Generated markdown length:', markdown.length);
          return markdown;
        }

        // For blocknote format - use currentBlocks state
        if (format === 'blocknote') {
          console.log('📝 BlockNote format, currentBlocks:', currentBlocks.length);
          if (currentBlocks.length > 0 && editor) {
            const markdown = await editor.blocksToMarkdownLossy(currentBlocks);
            console.log('📝 Generated markdown from blocks, length:', markdown.length);
            return markdown;
          }
          // Fallback: if we have the original data with markdown
          if (data?.markdown) {
            console.log('📝 Using fallback markdown from data');
            return data.markdown;
          }
        }

        // For legacy format - return empty (handled by parent)
        console.warn('⚠️ Cannot generate markdown for legacy format, returning empty');
        return '';
      } catch (err) {
        console.error('❌ Failed to generate markdown:', err);
        return '';
      }
    },
    isDirty
  }), [handleSave, isDirty, editor, format, currentBlocks, data, showFiltered]);

  // "Edit summary" affordance: only shown while the body is a read-only, action-items-hidden
  // projection. Clicking it reveals the full editable document (action items included).
  const editAffordance = showFiltered ? (
    <div className="flex justify-end mb-2">
      <button
        type="button"
        onClick={() => setIsEditing(true)}
        data-testid="edit-summary"
        className="text-sm text-muted-foreground hover:text-foreground underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
      >
        Edit summary
      </button>
    </div>
  ) : null;

  // Render legacy format
  if (format === 'legacy') {
    console.log('🎨 Rendering LEGACY format');
    const legacySummary = showFiltered
      ? (stripActionItemsFromLegacy(summaryData as Record<string, any>) as Summary)
      : (summaryData as Summary);
    return (
      <div className="flex flex-col w-full">
        {editAffordance}
        <div className={showFiltered ? 'pointer-events-none' : undefined}>
          <AISummary
            summary={legacySummary}
            status={status}
            error={error}
            onSummaryChange={onSummaryChange || (() => { })}
            onRegenerateSummary={onRegenerateSummary || (() => { })}
            meeting={meeting}
          />
        </div>
      </div>
    );
  }

  // Render BlockNote format (has summary_json)
  if (format === 'blocknote') {
    console.log('🎨 Rendering BLOCKNOTE format (direct)');
    const blocks = showFiltered ? stripActionItemsFromBlockNote(data.summary_json) : data.summary_json;
    return (
      <div className="flex flex-col w-full">
        {editAffordance}
        <div className="w-full">
          <Editor
            // Remount when toggling read-only<->edit so the new initialContent takes effect.
            key={showFiltered ? 'summary-ro' : 'summary-edit'}
            initialContent={blocks}
            onChange={showFiltered ? undefined : (b) => {
              console.log('📝 Editor blocks changed:', b.length);
              handleEditorChange(b);
            }}
            editable={!showFiltered}
          />
        </div>
      </div>
    );
  }

  // Render Markdown format (parse and display in BlockNote)
  if (format === 'markdown') {
    console.log('🎨 Rendering MARKDOWN format (parsed to BlockNote)');
    return (
      <div className="flex flex-col w-full">
        {editAffordance}
        <div className="w-full">
          <BlockNoteView
            editor={editor}
            editable={!showFiltered}
            onChange={() => {
              if (isContentLoaded.current) {
                handleEditorChange(editor.document);
              }
            }}
            theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
          />
        </div>
      </div>
    );
  }

  return null;
});

BlockNoteSummaryView.displayName = 'BlockNoteSummaryView';
