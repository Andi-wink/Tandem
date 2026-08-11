/**
 * Pre-record consent gate — frontend client.
 *
 * Recording a call without every participant's consent is a criminal offence in Germany
 * (§ 201 Abs. 1 Nr. 1 StGB, up to three years), Greece, Portugal, Switzerland and France, and the
 * consent must exist *before* capture starts. GDPR Art 7(1) separately requires it be provable.
 *
 * The gate itself is enforced in Rust inside `start_recording`, so every start path is covered.
 * This module is the client for the commands that arm it.
 */

import { invoke } from '@tauri-apps/api/core';

/** Error string Rust returns when a start is blocked for want of consent. */
export const CONSENT_REQUIRED = 'CONSENT_REQUIRED';

export type ConsentMethod = 'verbal' | 'written' | 'prior_written';

export interface ConsentInput {
  meetingTitle?: string | null;
  /** Everyone on the call, including the user. One consent per person, not per room. */
  participants: string[];
  method: ConsentMethod;
  /** ISO 3166-1 alpha-2 of the counterparty, e.g. 'DE'. */
  jurisdiction?: string | null;
  notes?: string | null;
}

export interface ConsentRecord {
  id: string;
  meeting_title: string | null;
  meeting_id: string | null;
  granted_at: string;
  recording_started_at: string | null;
  /** JSON-encoded array of names. */
  participants: string;
  method: string;
  jurisdiction: string | null;
  language: string | null;
  engine: string | null;
  processing: string | null;
  notes: string | null;
  created_at: string;
}

/**
 * True when the given error is the consent gate refusing a start (rather than a device or model
 * failure). Callers use this to open the consent dialog instead of surfacing an error.
 */
export function isConsentRequired(error: unknown): boolean {
  const message =
    typeof error === 'string' ? error : error instanceof Error ? error.message : String(error ?? '');
  return message.includes(CONSENT_REQUIRED);
}

/**
 * Writes the consent record and arms the gate. The next `start_recording` is permitted; the one
 * after that is not, because a grant authorises exactly one recording.
 */
export async function recordConsent(input: ConsentInput): Promise<string> {
  return invoke<string>('record_consent', {
    input: {
      meetingTitle: input.meetingTitle ?? null,
      participants: input.participants,
      method: input.method,
      jurisdiction: input.jurisdiction ?? null,
      notes: input.notes ?? null,
    },
  });
}

/** Most recent consent records, newest first. */
export async function listConsentLog(limit = 100): Promise<ConsentRecord[]> {
  return invoke<ConsentRecord[]>('list_consent_log', { limit });
}

export async function getConsentGateEnabled(): Promise<boolean> {
  return invoke<boolean>('get_consent_gate_enabled');
}

export async function setConsentGateEnabled(enabled: boolean): Promise<void> {
  return invoke('set_consent_gate_enabled', { enabled });
}

/**
 * All-party-consent warning for a jurisdiction, or null when notice alone is lawful there.
 * Resolved in Rust so the jurisdiction list has one home.
 */
export async function jurisdictionWarning(jurisdiction: string): Promise<string | null> {
  if (!jurisdiction.trim()) return null;
  try {
    return await invoke<string | null>('consent_jurisdiction_warning', { jurisdiction });
  } catch {
    return null;
  }
}

/**
 * Jurisdictions offered in the dialog. Deliberately short: the ones where getting this wrong is a
 * criminal matter, plus the common non-all-party cases so the field is not annoying to use.
 */
export const JURISDICTION_OPTIONS: { code: string; label: string }[] = [
  { code: '', label: 'Not specified' },
  { code: 'GB', label: 'United Kingdom' },
  { code: 'DE', label: 'Germany' },
  { code: 'AT', label: 'Austria' },
  { code: 'CH', label: 'Switzerland' },
  { code: 'FR', label: 'France' },
  { code: 'GR', label: 'Greece' },
  { code: 'PT', label: 'Portugal' },
  { code: 'ES', label: 'Spain' },
  { code: 'IT', label: 'Italy' },
  { code: 'NL', label: 'Netherlands' },
  { code: 'BE', label: 'Belgium' },
  { code: 'IE', label: 'Ireland' },
  { code: 'US', label: 'United States' },
];
