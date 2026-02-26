/**
 * Centralized constants for the frontend application.
 * Avoids magic numbers scattered across components.
 */

// ─── AI / Token Estimation ──────────────────────────────────────────────────

/** Average characters per token (GPT/Claude rough heuristic) */
export const CHARS_PER_TOKEN = 4;

// ─── UI Dimensions ──────────────────────────────────────────────────────────

/** Max height (px) for the auto-resizing chat textarea */
export const TEXTAREA_MAX_HEIGHT_PX = 120;

// ─── Recording ──────────────────────────────────────────────────────────────

/** Minimum recording duration (ms) before stop is allowed */
export const MIN_RECORDING_DURATION_MS = 2000;
