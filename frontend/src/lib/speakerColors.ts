/**
 * F022: Deterministic speaker color assignments.
 *
 * Each speaker gets a consistent Tailwind color pair (light + dark mode)
 * based on their index or a hash of their name.
 */

const SPEAKER_COLORS = [
  'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300',
  'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300',
  'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
  'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
] as const;

/**
 * Get deterministic Tailwind color classes for a speaker label.
 *
 * - "SPEAKER_00" → index 0 → blue
 * - "SPEAKER_01" → index 1 → green
 * - "Client" (the channel remote label) → reserved teal
 * - Custom names → hash-based assignment (never the reserved Client color, so
 *   the two channel speakers always render in distinct colors)
 */
// Reserved for the "Client" channel label so a custom local name can never
// hash to the same color as the remote party (keep in sync with
// CLIENT_SPEAKER_NAME in speakerNames.ts).
const CLIENT_COLOR_INDEX = 5; // teal
const CLIENT_LABEL = 'Client';

export function getSpeakerColor(speakerLabel: string): string {
  const match = speakerLabel.match(/SPEAKER_(\d+)/);
  if (match) {
    return SPEAKER_COLORS[parseInt(match[1], 10) % SPEAKER_COLORS.length];
  }
  if (speakerLabel === CLIENT_LABEL) {
    return SPEAKER_COLORS[CLIENT_COLOR_INDEX];
  }
  // Hash-based for custom names, skipping the reserved Client color.
  let hash = 0;
  for (let i = 0; i < speakerLabel.length; i++) {
    hash = ((hash << 5) - hash + speakerLabel.charCodeAt(i)) | 0;
  }
  let idx = Math.abs(hash) % SPEAKER_COLORS.length;
  if (idx === CLIENT_COLOR_INDEX) idx = (idx + 1) % SPEAKER_COLORS.length;
  return SPEAKER_COLORS[idx];
}

/**
 * Format a speaker label for display. If a display name was assigned,
 * use it; otherwise show the raw pyannote label in a friendlier form.
 */
export function formatSpeakerLabel(
  rawLabel: string,
  displayName?: string,
): string {
  if (displayName) return displayName;
  // "SPEAKER_00" → "Speaker 1"
  const match = rawLabel.match(/SPEAKER_(\d+)/);
  if (match) {
    return `Speaker ${parseInt(match[1], 10) + 1}`;
  }
  return rawLabel;
}
