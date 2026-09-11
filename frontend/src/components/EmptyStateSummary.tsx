'use client';

import { motion } from 'framer-motion';
import { FileQuestion, Sparkles, ScrollText, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface EmptyStateSummaryProps {
  onGenerate: () => void;
  hasModel: boolean;
  isGenerating?: boolean;
  /** Build the no-AI handover document instead of a summary. */
  onGenerateHandover?: () => void;
  isGeneratingHandover?: boolean;
}

export function EmptyStateSummary({
  onGenerate,
  hasModel,
  isGenerating = false,
  onGenerateHandover,
  isGeneratingHandover = false,
}: EmptyStateSummaryProps) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="flex flex-col items-center justify-center h-full p-8 text-center"
    >
      <FileQuestion className="w-16 h-16 text-muted-foreground/50 mb-4" />
      <h3 className="text-lg font-semibold text-foreground mb-2">
        No Summary Generated Yet
      </h3>
      <p className="text-sm text-muted-foreground mb-6 max-w-md">
        Generate an AI-powered summary of your meeting transcript to get key points, action items, and decisions.
      </p>

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <Button
                onClick={onGenerate}
                disabled={!hasModel || isGenerating}
                className="gap-2"
              >
                <Sparkles className="w-4 h-4" />
                {isGenerating ? 'Generating...' : 'Generate Summary'}
              </Button>
            </div>
          </TooltipTrigger>
          {!hasModel && (
            <TooltipContent>
              <p>Please select a model in Settings first</p>
            </TooltipContent>
          )}
        </Tooltip>
      </TooltipProvider>

      {!hasModel && (
        <p className="text-xs text-amber-600 dark:text-amber-400 mt-3">
          Please select a model in Settings first
        </p>
      )}

      {/* Second way out of this screen. A summary needs a model and takes time; the handover document
          needs neither, so it stays available when the summary path is blocked. */}
      {onGenerateHandover && (
        <div className="mt-8 pt-6 border-t border-border w-full max-w-md">
          <p className="text-sm text-muted-foreground mb-3">
            Or take the raw record instead: the full transcript in order, with your notes,
            screenshots and links laid out as they happened. No AI, no waiting.
          </p>
          <Button
            variant="outline"
            onClick={onGenerateHandover}
            disabled={isGeneratingHandover}
            className="gap-2"
          >
            {isGeneratingHandover ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Building handover document...
              </>
            ) : (
              <>
                <ScrollText className="w-4 h-4" />
                Create handover document
              </>
            )}
          </Button>
        </div>
      )}
    </motion.div>
  );
}
