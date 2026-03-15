/**
 * F048: Task extraction service — calls the backend POST /api/extract-tasks
 * endpoint to extract structured tasks from meeting transcripts using Anthropic API.
 */

import { ExtractedTask, ExtractTasksResponse } from '@/types/handoff';

const BACKEND = 'http://localhost:5167';

/**
 * Extract structured tasks from a meeting transcript.
 *
 * @param transcript - The meeting transcript text.
 * @param apiKey - Anthropic API key (passed per-request, not stored server-side).
 * @param screenshots - Optional list of screenshot descriptions.
 * @param clipboard - Optional list of clipboard text items.
 * @returns Array of extracted tasks with autonomy and category classification.
 */
export async function extractTasks(
  transcript: string,
  apiKey: string,
  screenshots?: string[],
  clipboard?: string[],
): Promise<ExtractedTask[]> {
  const response = await fetch(`${BACKEND}/api/extract-tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      transcript,
      api_key: apiKey,
      screenshots: screenshots ?? null,
      clipboard: clipboard ?? null,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Task extraction failed (${response.status}): ${errorText}`);
  }

  const data: ExtractTasksResponse = await response.json();
  return data.tasks;
}
