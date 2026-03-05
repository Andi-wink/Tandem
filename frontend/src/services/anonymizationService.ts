/**
 * F005: PII Anonymization service — communicates with the FastAPI backend
 * Presidio endpoints for on-device PII detection and surrogate replacement.
 */

import { BACKEND } from '@/services/claudeService';

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
  model: string | null;
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
): Promise<AnonymizeResult> {
  const res = await fetch(`${BACKEND}/api/anonymize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      texts,
      meeting_id: meetingId,
      entity_map: entityMap || null,
      detect_json: detectJson,
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
    if (!res.ok) return { available: false, model: null };
    return await res.json();
  } catch {
    return { available: false, model: null };
  }
}
