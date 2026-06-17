// Canvas intent router — decides whether a chat message should DRAW on the canvas or go to the AI
// assistant. Two stages so we don't pay LLM latency on every message:
//   1. a deterministic heuristic for obvious cases (instant), then
//   2. a tiny Claude (Haiku) classification for ambiguous ones — NOT Ollama, per the design.
// Any failure (no key, network, etc.) falls back to 'chat' so the assistant always works.

import { logger } from '@/lib/logger';

export type CanvasRoute = 'canvas' | 'chat';

// Strong "make something on the canvas" signals — high precision, route straight to canvas.
const CREATE_RE =
  /\b(draw|sketch|diagram|flow ?chart|wireframe|mock ?up|whiteboard|visuali[sz]e|graph|process flow|map (it|this|that|the)\b.*\bout|lay (it|this|out))\b/i;
// Edit signals that only make sense when there's already something on the canvas.
const EDIT_RE =
  /\b(make (it|that|the|this)\b|recolou?r|rename (it|that|the)\b|add (a|an|another) (step|box|node|arrow|shape|label)|move (it|that|the)\b|connect (it|the|them)\b|bigger|smaller|delete (it|that|the)\b)\b/i;
// Obvious assistant/question signals — keep these in chat even if a draw word appears.
const CHAT_RE =
  /\b(summari[sz]e|what (is|are|was|were)|who (is|are)|when (is|did)|why|how (do|does|can|should)|explain|search|look up|find me|write (me|a|an)|draft|email|translate|code|fix|debug|action items?)\b/i;

/** Fast, dependency-free guess. Returns a route, or null when it's genuinely ambiguous. */
export function heuristicRoute(message: string, canvasOpen: boolean): CanvasRoute | null {
  const m = message.trim();
  if (!m) return 'chat';
  if (CREATE_RE.test(m)) return 'canvas';
  if (CHAT_RE.test(m)) return 'chat';
  // Edit-style imperatives are canvas ONLY if a board is already open (else they're probably chat).
  if (canvasOpen && EDIT_RE.test(m)) return 'canvas';
  return null;
}

/** One-shot Claude (Haiku) classification. Returns null on any error / missing key. */
async function llmRoute(message: string, apiKey: string, canvasOpen: boolean): Promise<CanvasRoute | null> {
  if (!apiKey) return null;
  const system =
    'You route one user message to a tool. Reply with EXACTLY one word: "canvas" or "chat". ' +
    'Choose "canvas" if the user wants to draw, diagram, sketch, mock up, wireframe, lay out, or edit ' +
    'something on a visual whiteboard canvas' +
    (canvasOpen ? ' (a canvas is currently open, so edits like "make it blue" mean the canvas)' : '') +
    '. Choose "chat" for questions, explanations, summaries, search, writing, code, or anything else.';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 5,
        system,
        messages: [{ role: 'user', content: message }],
      }),
    });
    if (!res.ok) {
      logger.warn('[CanvasRouter] Claude classify HTTP', res.status);
      return null;
    }
    const data = await res.json();
    const text = String(data?.content?.[0]?.text ?? '').toLowerCase();
    if (text.includes('canvas')) return 'canvas';
    if (text.includes('chat')) return 'chat';
    return null;
  } catch (e) {
    logger.warn('[CanvasRouter] Claude classify failed', e);
    return null;
  }
}

/**
 * Decide the route for a message. Heuristic first; if ambiguous and a Claude key is available, ask
 * Haiku; otherwise default to the assistant ('chat') so nothing is ever lost.
 */
export async function routeMessage(
  message: string,
  opts: { anthropicKey?: string | null; canvasOpen?: boolean } = {},
): Promise<CanvasRoute> {
  const canvasOpen = !!opts.canvasOpen;
  const fast = heuristicRoute(message, canvasOpen);
  if (fast) return fast;
  const llm = await llmRoute(message, opts.anthropicKey ?? '', canvasOpen);
  return llm ?? 'chat';
}
