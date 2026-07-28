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
 * Get Tailwind color classes for a speaker label.
 *
 * Channel-based labels are compact chips differentiated by fill:
 * - the local speaker (any other name) → dark chip, white text (readable in
 *   both light and dark themes; avoids the black-on-dark unreadability of a
 *   plain white square)
 * - "Client" (the remote party) → white chip, blue text
 * Pyannote "SPEAKER_NN" labels keep their distinct palette colors.
 */
const CLIENT_LABEL = 'Client';

export function getSpeakerColor(speakerLabel: string): string {
  const match = speakerLabel.match(/SPEAKER_(\d+)/);
  if (match) {
    return SPEAKER_COLORS[parseInt(match[1], 10) % SPEAKER_COLORS.length];
  }
  if (speakerLabel === CLIENT_LABEL) {
    // Client: white chip, blue text
    return 'bg-white text-blue-600 border border-border';
  }
  // Local speaker: dark chip, white text
  return 'bg-neutral-800 text-white border border-neutral-700';
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
