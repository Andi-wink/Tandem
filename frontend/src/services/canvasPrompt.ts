// Composes what actually gets sent to the canvas agent when the user asks it to draw/edit.
//
// The canvas agent is a separate agent embedded in the whiteboard — it only knows what we hand it in
// the prompt. Left to the bare instruction ("map out the process") it invents a generic, textbook
// diagram, because it never saw the call. So we prepend a slice of the meeting transcript as context.
//
// Scope: default to the last few minutes (keeps prompts small and on-topic), but let the INSTRUCTION
// widen it — "grab the full transcript…", "everything we discussed recently", "pull up the last
// workflow we covered" all switch to the whole call and let the agent locate the relevant part. When
// a wide slice is sent we explicitly tell the agent to ignore the parts that aren't relevant, so extra
// context can't derail it.

import { Transcript } from '@/types';
import { getRecentTranscripts } from '@/services/handoffService';

/** Default rolling window (seconds) attached when the instruction doesn't ask for more. */
export const CANVAS_CONTEXT_WINDOW_SECS = 300;

// Signals in the instruction that mean "look wider than the last few minutes" → send the whole call.
// Covers explicit "full/whole transcript", "everything/all the workflows", time words ("recently",
// "so far", "earlier", "from the start"), and the retrieval verbs the user reaches for ("grab",
// "pull up", "go back to") — in every case the agent gets the full transcript and finds the bit asked for.
const BROAD_SCOPE_RE =
  /\b(full|whole|entire|complete)\s+(transcript|call|meeting|conversation)\b|\beverything\b|\ball\s+(of\s+)?(the\s+)?(workflows?|processes?|steps?|flows?)\b|\brecently\b|\bso\s+far\b|\bearlier\b|\bthroughout\b|\bthe\s+(whole|entire)\s+(call|meeting)\b|\bfrom\s+the\s+(start|beginning)\b|\bgrab\b|\bpull\s+up\b|\bgo\s+back\b/i;

/** True when the instruction implies the agent needs the whole call, not just the recent window. */
export function canvasPromptWantsFullTranscript(instruction: string): boolean {
  return BROAD_SCOPE_RE.test(instruction);
}

/**
 * Build the canvas message: optional transcript context + the instruction. Returns the bare
 * instruction unchanged when context is disabled or there's no transcript yet.
 */
export function composeCanvasPrompt(
  instruction: string,
  transcripts: Transcript[],
  opts: { enabled: boolean; defaultWindowSecs?: number },
): string {
  const trimmed = instruction.trim();
  if (!opts.enabled || transcripts.length === 0) return trimmed;

  const wantsFull = canvasPromptWantsFullTranscript(trimmed);
  const slice = wantsFull
    ? transcripts
    : getRecentTranscripts(transcripts, opts.defaultWindowSecs ?? CANVAS_CONTEXT_WINDOW_SECS);
  const ctxText = slice
    .map((t) => t.text)
    .join(' ')
    .trim();
  if (!ctxText) return trimmed;

  const scope = wantsFull ? 'the full call transcript' : 'the last few minutes of the call';
  return (
    `Context from ${scope} (may include unrelated discussion):\n${ctxText}\n\n` +
    `Using that context, do this on the canvas: ${trimmed}\n` +
    `Focus only on what the instruction asks for; ignore any part of the transcript that isn't relevant to it.`
  );
}
