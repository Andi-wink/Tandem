/**
 * F005: PII Anonymization service — communicates with the FastAPI backend
 * Presidio endpoints for on-device PII detection and surrogate replacement.
 */

import { invoke } from '@tauri-apps/api/core';
import { BACKEND } from '@/services/claudeService';

// ---------------------------------------------------------------------------
// Transcription language (for language-correct NER)
// ---------------------------------------------------------------------------

/**
 * Cached transcription language preference. Resolved from the Rust side rather than React
 * context so any caller gets it without a provider dependency. Short TTL so a mid-session
 * language change is picked up without a restart.
 */
let _languageCache: { value: string | null; at: number } | null = null;
const LANGUAGE_TTL_MS = 30_000;

async function getTranscriptionLanguage(): Promise<string | null> {
  const now = Date.now();
  if (_languageCache && now - _languageCache.at < LANGUAGE_TTL_MS) {
    return _languageCache.value;
  }
  try {
    const value = await invoke<string>('get_language_preference');
    _languageCache = { value: value || null, at: now };
    return _languageCache.value;
  } catch {
    // Not running under Tauri (browser dev), or the command failed. The backend falls back to
    // sniffing the text, so this is not fatal.
    _languageCache = { value: null, at: now };
    return null;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntityFound {
  entity_type: string;
  original: string;
  score: number;
  start: number;
  end: number;
}

export interface AnonymizeResult {
  sanitized: string[];
  entityMap: Record<string, string>;
  entitiesFound: EntityFound[];
}

export interface AnonymizeHealthStatus {
  available: boolean;
  /** Loaded spaCy models keyed by language code, e.g. `{ en: 'en_core_web_sm', de: 'de_core_news_sm' }`. */
  models?: Record<string, string>;
  /** Languages the backend can actually analyse. Anything else falls back to `default_language`. */
  languages?: string[];
  default_language?: string;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Anonymize PII in one or more text strings.
 * Uses shared entity registry per meeting_id for consistent surrogates.
 */
export async function anonymizeTexts(
  texts: string[],
  meetingId: string,
  entityMap?: Record<string, string>,
  detectJson: boolean = true,
  language?: string | null,
): Promise<AnonymizeResult> {
  // Default to the app's transcription language so every caller gets language-correct NER
  // without having to thread it through. Pass an explicit value to override.
  const resolvedLanguage =
    language === undefined ? await getTranscriptionLanguage() : language;

  const res = await fetch(`${BACKEND}/api/anonymize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      texts,
      meeting_id: meetingId,
      entity_map: entityMap || null,
      detect_json: detectJson,
      // Transcription language, so a German call is analysed with the German NER model rather
      // than the English one (which invents PERSON entities out of German greetings and misses
      // German phone numbers entirely).
      language: resolvedLanguage || null,
    }),
  });

  if (!res.ok) {
    throw new Error(`Anonymization failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return {
    sanitized: data.sanitized,
    entityMap: data.entity_map,
    entitiesFound: data.entities_found,
  };
}

/**
 * Get the current entity map for a meeting.
 */
export async function getEntityMap(
  meetingId: string,
): Promise<Record<string, string>> {
  const res = await fetch(
    `${BACKEND}/api/anonymize/entity-map/${encodeURIComponent(meetingId)}`,
  );
  if (!res.ok) return {};
  const data = await res.json();
  return data.entity_map || {};
}

/**
 * Clear the entity map for a meeting.
 */
export async function clearEntityMap(meetingId: string): Promise<void> {
  await fetch(
    `${BACKEND}/api/anonymize/entity-map/${encodeURIComponent(meetingId)}`,
    { method: 'DELETE' },
  );
}

/**
 * Get the reverse entity map (surrogate → real) for de-anonymizing AI responses.
 */
export async function getReverseMap(
  meetingId: string,
): Promise<Record<string, string>> {
  const res = await fetch(
    `${BACKEND}/api/anonymize/reverse-map/${encodeURIComponent(meetingId)}`,
  );
  if (!res.ok) return {};
  const data = await res.json();
  return data.reverse_map || {};
}

/**
 * Check if the anonymization backend is available.
 */
export async function checkAnonymizationHealth(): Promise<AnonymizeHealthStatus> {
  try {
    const res = await fetch(`${BACKEND}/api/anonymize/health`);
    if (!res.ok) return { available: false, models: {}, languages: [] };
    return await res.json();
  } catch {
    return { available: false, models: {}, languages: [] };
  }
}
