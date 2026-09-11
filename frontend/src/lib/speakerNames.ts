/**
 * Channel-based speaker naming (default, no ML).
 *
 * Every transcript segment carries an audio-channel source:
 *   "Local"  = the user's microphone  -> the user's name (default "Andrew")
 *   "Remote" = system audio (the other party) -> "Client"
 *
 * This is the DEFAULT speaker labeling. The optional F022 pyannote
 * `speaker_label` takes precedence whenever it is present.
 *
 * Note: the DB column that stores the channel is named `speaker` but holds
 * the "Local"/"Remote" values, so callers may pass either `source` or the
 * DB `speaker` value here.
 */

export const LOCAL_SPEAKER_NAME_KEY = 'tandem.localSpeakerName';
export const DEFAULT_LOCAL_SPEAKER_NAME = 'Andrew';
export const CLIENT_SPEAKER_NAME = 'Client';

/** Fired when the local speaker name setting changes, so open views can react. */
export const LOCAL_SPEAKER_NAME_EVENT = 'localSpeakerNameChanged';

/**
 * Read the configured local speaker name from localStorage.
 * Falls back to the default ("Andrew") when unset or unavailable.
 */
export function getLocalSpeakerName(): string {
  if (typeof window === 'undefined') return DEFAULT_LOCAL_SPEAKER_NAME;
  const saved = localStorage.getItem(LOCAL_SPEAKER_NAME_KEY);
  return saved && saved.trim() ? saved.trim() : DEFAULT_LOCAL_SPEAKER_NAME;
}

/**
 * Persist the local speaker name and notify open views (via a CustomEvent,
 * mirroring the confidenceIndicatorChanged pattern in ConfigContext). An empty
 * value clears the setting so it falls back to the default.
 */
export function setLocalSpeakerName(name: string): void {
  if (typeof window === 'undefined') return;
  const trimmed = name.trim();
  if (trimmed) {
    localStorage.setItem(LOCAL_SPEAKER_NAME_KEY, trimmed);
  } else {
    localStorage.removeItem(LOCAL_SPEAKER_NAME_KEY);
  }
  window.dispatchEvent(new CustomEvent(LOCAL_SPEAKER_NAME_EVENT));
}

/**
 * Map an audio-channel source to a display name. Accepts the current
 * "Local"/"Remote" labels and the legacy "mic"/"system" values (see migration
 * 20251110000001), case-insensitively. Returns undefined for anything else, so
 * legacy/null segments get no badge.
 */
export function speakerNameFromSource(
  source?: string,
  localName?: string,
): string | undefined {
  if (!source) return undefined;
  const s = source.toLowerCase();
  if (s === 'local' || s === 'mic') return localName || DEFAULT_LOCAL_SPEAKER_NAME;
  if (s === 'remote' || s === 'system') return CLIENT_SPEAKER_NAME;
  return undefined;
}

/** A segment that may carry a pyannote label and/or a channel source. */
interface SpeakerBearingSegment {
  speaker_label?: string;
  source?: string;
  speaker?: string;
}

/**
 * Resolve the speaker name for a segment.
 *
 * Precedence: pyannote `speaker_label` wins when present; otherwise the
 * audio-channel source ("Local"/"Remote", from `source` or the DB `speaker`
 * field) is mapped to a name. Returns undefined when nothing applies.
 */
export function resolveSpeaker(
  segment: SpeakerBearingSegment,
  localName?: string,
): string | undefined {
  if (segment.speaker_label) return segment.speaker_label;
  return speakerNameFromSource(segment.source ?? segment.speaker, localName);
}
