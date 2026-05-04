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

Respond with this exact JSON structure:
{
  "project_switch": { "detected": false, "project_name": null, "confidence": 0 },
  "intents": [],
  "notes": [],
  "stop_detected": false,
  "revoke_last": false
}

Classification rules:
- intents[] — actionable requests, decisions, plans, or bug reports the developer is making. These are things a coding assistant could take and act on. Phrase as imperative ("Fix X", "Change Y to Z", "Investigate W").
- notes[] — substantive observations, context, or rationale worth remembering but NOT something to act on. (e.g. "This is built on Tauri 2.x", "The original idea was X but we pivoted".)
- DO NOT include: narration about what the app is doing, demo commentary, throat-clearing, meta-speech about the product itself, or small talk. Omit these entirely — empty arrays are valid and expected.
- If a sentence is just the user explaining what they built or what's happening on screen, it's NOT an intent and NOT a note. Skip it.
- intents[].confidence and notes[].confidence reflect certainty (0-1). Use >= 0.7 only when truly confident.

Project switch rules:
- project_switch.detected = true ONLY when the user explicitly says they're switching/starting/moving to a different project ("I'm working on X now", "let's switch to Y", "moving over to Z").
- Match project_name to the closest registered project name or alias. Use the name as listed above, not the user's phrasing.
- Speech-to-text garbles short names. Expect variants: extra letters ("Jos" → "Joss"), merged words ("Jos project" → "Josproject"), possessives ("Joss's project"), phonetic slips. If a spoken name is phonetically close to or contains a registered name as a substring, treat it as that project. Return the REGISTERED name (not what was said).
- Do NOT detect a project switch when the user merely mentions a project in passing.

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

  return null;
}
