/** Centralized mock data for Playwright E2E tests. */

export const MOCK_MEETINGS = [
  { id: 'meeting-1', title: 'Team Standup 2026-02-23' },
  { id: 'meeting-2', title: 'Product Review' },
  { id: 'meeting-3', title: 'Sprint Planning' },
];

export const MOCK_MEETING_DETAIL = {
  id: 'meeting-1',
  title: 'Team Standup 2026-02-23',
  created_at: '2026-02-23T10:00:00Z',
  updated_at: '2026-02-23T10:30:00Z',
  transcript_count: 2,
  has_summary: false,
  has_audio: false,
};

export const MOCK_TRANSCRIPTS = {
  transcripts: [
    {
      id: '1',
      text: 'Hello everyone, welcome to the standup.',
      timestamp: '10:00:05',
      sequence_id: 1,
      chunk_start_time: 5.0,
      is_partial: false,
      confidence: 0.95,
      audio_start_time: 5.0,
      audio_end_time: 8.0,
      duration: 3.0,
    },
    {
      id: '2',
      text: 'Let us start with the updates from last sprint.',
      timestamp: '10:00:10',
      sequence_id: 2,
      chunk_start_time: 10.0,
      is_partial: false,
      confidence: 0.92,
      audio_start_time: 10.0,
      audio_end_time: 14.0,
      duration: 4.0,
    },
  ],
  total: 2,
  has_more: false,
};
