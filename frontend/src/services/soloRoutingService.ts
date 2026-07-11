/**
 * Solo Routing Service — calls Gemma via Ollama to detect project switches and tasks
 */

import { invoke } from '@tauri-apps/api/core';
import { Project } from '@/services/projectService';
import { RoutingDecision } from '@/types/solo';
import { Transcript } from '@/types';

const CONFIDENCE_THRESHOLD = 0.7;
const SWITCH_CONFIDENCE_THRESHOLD = 0.55; // lower bar for switches — STT garbles short names

function buildSystemPrompt(projects: Project[], activeProject: Project | null): string {
  const projectList = projects
    .map(p => {
      const aliases = p.aliases.length > 0 ? ` (aliases: ${p.aliases.map(a => `"${a}"`).join(', ')})` : '';
      return `- ${p.name}${aliases} — ${p.path}`;
    })
    .join('\n');

  return `You are a transcript classifier for a developer working solo. You watch a running transcript and tag meaningful content into one of two buckets — nothing else.

Registered projects:
${projectList}

Current active project: ${activeProject ? activeProject.name : 'none'}

Respond with this exact JSON structure (use these EXACT field names — do not rename or add fields):
{
  "project_switch": { "detected": false, "project_name": null, "confidence": 0 },
  "intents": [ { "description": "string", "confidence": 0.0 } ],
  "notes": [ { "description": "string", "confidence": 0.0 } ],
  "stop_detected": false,
  "revoke_last": false
}
The intents and notes arrays may be empty. Each entry MUST have keys "description" and "confidence" — never "text", "content", or "note".

Classification rules:
- intents[] — actionable requests, decisions, plans, or bug reports the developer is making. These are things a coding assistant could take and act on. Phrase as imperative ("Fix X", "Change Y to Z", "Investigate W").
- notes[] — substantive observations, context, or rationale worth remembering but NOT something to act on. (e.g. "This is built on Tauri 2.x", "The original idea was X but we pivoted".)
- DO NOT include: narration about what the app is doing, demo commentary, throat-clearing, meta-speech about the product itself, or small talk. Omit these entirely — empty arrays are valid and expected.
- If a sentence is just the user explaining what they built or what's happening on screen, it's NOT an intent and NOT a note. Skip it.
- intents[].confidence and notes[].confidence reflect certainty (0-1). Use >= 0.7 only when truly confident.

Project switch rules:
- project_switch.detected = true when the user declares what they are working on: "Working on X", "I'm on X today", "I'm working on X (now)", "let's switch to Y", "moving over to Z", "back to X", "today I'm doing X". Repetition strengthens the signal — if they say the project name 2+ times, treat it as a clear declaration.
- ALWAYS return project_name as the REGISTERED name from the list above (or its alias). Never echo back the user's literal phrasing if it differs.
- Speech-to-text garbles names heavily. Match phonetically and loosely:
  • "Jos" → "Joss", "Josproject", "Joss's project" → registered "Jos"
  • "higher path" / "high pat" → registered "Hirepath" (phonetic: hire ≈ higher)
  • "I-on" / "Ion" → registered "Iron" (phonetic similarity)
  • Extra/missing letters, merged words, possessives — all expected. If the spoken name is phonetically close to or contains/is contained in a registered name, treat it as that project.
- Confidence: 0.8+ when the user clearly states they are working on a registered project (even with garbles). 0.5–0.7 when ambiguous. <0.5 when it's just a passing mention.
- Do NOT detect a switch when the user merely mentions a project in passing without claiming to work on it.
- If the spoken name does NOT plausibly match any registered project, set detected=false. Do not invent matches.

Stop rules:
- stop_detected = true when the user says they're done working or ending the session.

Revoke rules:
- revoke_last = true when the user retracts the most recent task/intent — phrases like "ignore that", "not a task", "never mind that last one", "scratch that", "disregard that", "actually don't do that". It doesn't matter what the prior intent was — if the user is clearly undoing their most recent request, set revoke_last to true.
- Default to false. Only set true on explicit retraction, not mere hesitation.

If nothing meaningful was said, return all arrays empty and all booleans false. Empty responses are correct and preferred over spurious ones.`;
}

function formatTranscriptChunk(transcripts: Transcript[]): string {
  return transcripts
    .map(t => {
      const time = t.audio_start_time != null
        ? formatTime(t.audio_start_time)
        : t.timestamp || '??:??';
      return `[${time}] ${t.text}`;
    })
    .join('\n');
}

function formatTime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export async function analyzeTranscript(
  transcripts: Transcript[],
  projects: Project[],
  activeProject: Project | null,
  model: string,
  ollamaEndpoint?: string,
): Promise<RoutingDecision | null> {
  if (transcripts.length === 0) return null;

  const systemPrompt = buildSystemPrompt(projects, activeProject);
  const userPrompt = `Recent transcript (last 30 seconds):\n${formatTranscriptChunk(transcripts)}`;

  try {
    const rawJson = await invoke<string>('ollama_chat_json', {
      model,
      systemPrompt,
      userPrompt,
      endpoint: ollamaEndpoint ?? null,
    });

    const decision: RoutingDecision = JSON.parse(rawJson);

    console.log('[SoloRouting] Gemma raw response:', {
      project_switch: decision.project_switch,
      intent_count: decision.intents?.length ?? 0,
      note_count: decision.notes?.length ?? 0,
      stop: decision.stop_detected,
      revoke: decision.revoke_last,
    });

    // Apply confidence threshold to project switch (looser than intents/notes)
    if (decision.project_switch.detected && decision.project_switch.confidence < SWITCH_CONFIDENCE_THRESHOLD) {
      console.log('[SoloRouting] Switch below threshold — dropped:', decision.project_switch);
      decision.project_switch.detected = false;
    }

    // Filter low-confidence intents/notes; tolerate missing arrays from older prompts
    decision.intents = (decision.intents ?? []).filter(i => i.confidence >= CONFIDENCE_THRESHOLD);
    decision.notes = (decision.notes ?? []).filter(n => n.confidence >= CONFIDENCE_THRESHOLD);
    decision.revoke_last = decision.revoke_last ?? false;

    return decision;
  } catch (error) {
    console.error('[SoloRouting] Ollama call failed:', error, {
      model,
      systemPromptLen: systemPrompt.length,
      userPromptLen: userPrompt.length,
    });
    return null;
  }
}

/**
 * Fire a trivial JSON prompt so Ollama loads the model into VRAM.
 * Called when a Solo session starts so the first real routing cycle doesn't
 * pay the 15-60s cold-start cost for large models like gemma4:26b.
 * Fire-and-forget — errors are logged but not propagated.
 */
export async function warmupModel(model: string, ollamaEndpoint?: string): Promise<void> {
  try {
    const t0 = Date.now();
    await invoke<string>('ollama_chat_json', {
      model,
      systemPrompt: 'Respond with JSON only.',
      userPrompt: 'Return {"ready": true}',
      endpoint: ollamaEndpoint ?? null,
    });
    console.log(`[SoloRouting] Warmed ${model} in ${Date.now() - t0}ms`);
  } catch (err) {
    console.warn(`[SoloRouting] Warmup failed for ${model}:`, err);
  }
}

/** Levenshtein distance — used as fuzzy fallback for STT garbles. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m: number[][] = Array.from({ length: b.length + 1 }, () => new Array(a.length + 1).fill(0));
  for (let i = 0; i <= b.length; i++) m[i][0] = i;
  for (let j = 0; j <= a.length; j++) m[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b.charAt(i - 1) === a.charAt(j - 1) ? 0 : 1;
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + cost);
    }
  }
  return m[b.length][a.length];
}

/** Strip filler words and non-alphanumerics, then concatenate (handles "higher path" → "higherpath"). */
function normalizeForFuzzy(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(the|a|an|project|projects|app|website|to|for)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

// Explicit switch CUES — the user declaring what they're working on. Captures
// the spoken name (group 1), optionally trailing "project"/"app"/"repo"/etc.
const SWITCH_CUE_RE =
  /\b(?:fil(?:e|ing)\s+(?:this|that|it|everything|the\s+(?:meeting|call|notes?))?\s*under|put\s+(?:this|that|it|everything)\s+(?:under|in|into)|working on|work on|i'?m on|i am on|switch(?:ing)?(?:\s+(?:to|over to))?|mov(?:e|ing)(?:\s+over)?\s+to|back\s+(?:to|on)|jump(?:ing)?\s+(?:to|on)|let'?s\s+(?:do|work on|switch to)|today\s+(?:i'?m|i am)\s+(?:on|doing|working on))\s+(?:the\s+)?([a-z0-9][\w'’\- ]{0,40}?)(?:\s+(?:project|projects|app|repo|repository|codebase|code\s*base))?\s*[.,!?]?(?:\s|$)/i;

// Negation / past-tense markers that flip a cue from "I'm on X" to "I'm NOT on X".
const SWITCH_NEGATION_RE = /\b(?:not|never|don'?t|stop|stopped|done|finished|no longer|quit|quitting|leaving)\b/i;

/**
 * Deterministic project-switch detection — NO LLM.
 *
 * Catches the common, explicit case ("I'm working on the X project", "switch to
 * X", "back to Y") so switching is instant and survives a slow/cold/offline
 * Ollama. Deliberately conservative:
 *  - fires only on an explicit switch CUE (above),
 *  - skips negated/past clauses ("not working on X", "done with X"),
 *  - only returns a REGISTERED project (via matchProjectByName) — it can't
 *    invent a switch to something that isn't set up.
 * Anything it doesn't catch falls through to the LLM router, so coverage never
 * drops. Returns the matched project, or null.
 */
export function detectProjectSwitchFastPath(text: string, projects: Project[]): Project | null {
  if (!text || projects.length === 0) return null;
  // Split into clauses so a negation in one sentence can't suppress a real cue
  // in another ("I'm done with Foo. Now working on Bar.").
  for (const clause of text.split(/[.!?\n]+/)) {
    const m = clause.match(SWITCH_CUE_RE);
    if (!m) continue;
    const before = clause.slice(0, m.index ?? 0);
    if (SWITCH_NEGATION_RE.test(before)) continue; // "I'm not working on X"
    const candidate = m[1]?.trim();
    if (!candidate) continue;
    const matched = matchProjectByName(candidate, projects);
    if (matched) return matched;
  }
  return null;
}

export function matchProjectByName(name: string | null, projects: Project[]): Project | null {
  if (!name) return null;
  const lower = name.toLowerCase();

  // Exact name match
  const exact = projects.find(p => p.name.toLowerCase() === lower);
  if (exact) return exact;

  // Alias match
  const alias = projects.find(p =>
    p.aliases.some(a => a.toLowerCase() === lower),
  );
  if (alias) return alias;

  // Substring match
  const substring = projects.find(p =>
    p.name.toLowerCase().includes(lower) || lower.includes(p.name.toLowerCase()),
  );
  if (substring) return substring;

  // Fuzzy fallback — Levenshtein on stripped/concatenated forms.
  // Catches STT garbles like "higher path" → "Hirepath" where surface strings share no substring
  // but the concatenated forms are within ~30% edit distance.
  const fuzzyKey = normalizeForFuzzy(name);
  if (fuzzyKey.length >= 3) {
    let best: { project: Project; distance: number; ratio: number } | null = null;
    for (const p of projects) {
      const candidates = [p.name, ...p.aliases]
        .map(normalizeForFuzzy)
        .filter(c => c.length >= 3);
      for (const candidate of candidates) {
        const d = levenshtein(fuzzyKey, candidate);
        const maxLen = Math.max(fuzzyKey.length, candidate.length);
        const ratio = d / maxLen;
        // Accept if edit ratio ≤ 0.35 AND absolute distance ≤ 4
        if (ratio <= 0.35 && d <= 4 && (!best || d < best.distance)) {
          best = { project: p, distance: d, ratio };
        }
      }
    }
    if (best) {
      console.log(`[SoloRouting] Fuzzy match: "${name}" → ${best.project.name} (distance=${best.distance}, ratio=${best.ratio.toFixed(2)})`);
      return best.project;
    }
  }

  return null;
}
