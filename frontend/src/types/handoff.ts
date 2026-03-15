/**
 * F048: Types for structured task extraction from meeting transcripts.
 */

export interface ExtractedTask {
  id: string;
  description: string;
  autonomy: 'auto' | 'review';
  category: 'research' | 'email' | 'code' | 'document' | 'followup';
  context: string;
  priority: 'high' | 'medium' | 'low';
}

export interface ExtractTasksResponse {
  tasks: ExtractedTask[];
}
