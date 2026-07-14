import { test as base, expect } from '../fixtures/tauri-mock';
import { MOCK_MEETING_DETAIL, MOCK_TRANSCRIPTS } from '../fixtures/mock-data';

// A completed legacy-format summary that includes an "Immediate Action Items" section,
// which the frontend parses into the action-items checklist (I4).
const MOCK_SUMMARY = {
  status: 'completed',
  data: {
    MeetingName: 'Team Standup 2026-02-23',
    _section_order: ['SessionSummary', 'ImmediateActionItems'],
    SessionSummary: {
      title: 'Session Summary',
      blocks: [{ id: 's1', type: 'bullet', content: 'Discussed the sprint', color: '' }],
    },
    ImmediateActionItems: {
      title: 'Immediate Action Items',
      blocks: [
        { id: 'a1', type: 'bullet', content: 'Send the proposal to Acme', color: '' },
        { id: 'a2', type: 'bullet', content: 'Schedule the follow-up call', color: '' },
      ],
    },
  },
};

const MOCK_METADATA_WITH_FOLDER = {
  ...MOCK_MEETING_DETAIL,
  has_summary: true,
  folder_path: 'C:\\\\Users\\\\test\\\\.meetily\\\\recordings\\\\meeting-1',
};

const test = base.extend({
  tauriPage: async ({ tauriPage }, use) => {
    await tauriPage.addInitScript(`
      const _originalInvoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async function(cmd, args, options) {
        if (cmd === 'api_get_meeting_metadata' && args && args.meetingId === 'meeting-1') {
          return ${JSON.stringify(MOCK_METADATA_WITH_FOLDER)};
        }
        if (cmd === 'api_get_meeting_transcripts' && args && args.meetingId === 'meeting-1') {
          return ${JSON.stringify(MOCK_TRANSCRIPTS)};
        }
        if (cmd === 'api_get_summary' && args && args.meetingId === 'meeting-1') {
          return ${JSON.stringify(MOCK_SUMMARY)};
        }
        if (cmd === 'load_screenshots_json' || cmd === 'load_clipboard_json') {
          return [];
        }
        return _originalInvoke(cmd, args, options);
      };
    `);
    await use(tauriPage);
  },
});

test.describe('Action Items Checklist', () => {
  test('renders parsed action items with a persisted checkbox', async ({ tauriPage }) => {
    await tauriPage.goto('/meeting-details?id=meeting-1');
    await tauriPage.waitForLoadState('networkidle');

    // The checklist container renders from the Immediate Action Items section.
    const checklist = tauriPage.getByTestId('action-items-checklist');
    await expect(checklist).toBeVisible({ timeout: 20_000 });

    // Both parsed items appear.
    await expect(checklist.getByText('Send the proposal to Acme')).toBeVisible();
    await expect(checklist.getByText('Schedule the follow-up call')).toBeVisible();

    const items = checklist.getByTestId('action-item');
    await expect(items).toHaveCount(2);

    // Copy + handoff affordances exist.
    await expect(tauriPage.getByTestId('copy-action-items')).toBeVisible();
    await expect(tauriPage.getByTestId('send-action-items-handoff')).toBeVisible();

    // Toggle the first checkbox.
    const firstCheckbox = checklist.getByTestId('action-item-checkbox').first();
    await expect(firstCheckbox).toHaveAttribute('aria-checked', 'false');
    await firstCheckbox.click();
    await expect(firstCheckbox).toHaveAttribute('aria-checked', 'true');

    // The checked state persists across a reload (localStorage keyed by meeting id).
    // A generous reload timeout absorbs first-compile cost in Next.js dev mode under parallel
    // workers, where the default 30s 'load' wait can race a cold route compile and flake.
    await tauriPage.reload({ timeout: 60_000 });
    await tauriPage.waitForLoadState('networkidle');
    const reloadedCheckbox = tauriPage
      .getByTestId('action-items-checklist')
      .getByTestId('action-item-checkbox')
      .first();
    await expect(reloadedCheckbox).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 });
  });
});
