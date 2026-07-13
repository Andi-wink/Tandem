import { test as base, expect } from '../fixtures/tauri-mock';
import { MOCK_TRANSCRIPTS } from '../fixtures/mock-data';

// meeting-1 is FILED under Acme (folder lives in Acme/.tandem); meeting-2 is UNFILED (folder sits
// in the default recordings location). Both reuse MOCK_TRANSCRIPTS so the page renders content.
const FILED_FOLDER = 'D:/Dev-projects/Client_projects/Acme/.tandem/Team Standup 2026-02-23';
const UNFILED_FOLDER = 'C:/Users/test/.meetily/recordings/Product Review';

const test = base.extend({
  tauriPage: async ({ tauriPage }, use) => {
    await tauriPage.addInitScript(`
      const _meta = {
        'meeting-1': { id: 'meeting-1', title: 'Team Standup 2026-02-23',
          created_at: '2026-02-23T10:00:00Z', updated_at: '2026-02-23T10:30:00Z',
          folder_path: ${JSON.stringify(FILED_FOLDER)} },
        'meeting-2': { id: 'meeting-2', title: 'Product Review',
          created_at: '2026-02-23T10:00:00Z', updated_at: '2026-02-23T10:30:00Z',
          folder_path: ${JSON.stringify(UNFILED_FOLDER)} },
      };
      const _originalInvoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async function(cmd, args, options) {
        if (cmd === 'api_get_meeting_metadata' && args && _meta[args.meetingId]) {
          return _meta[args.meetingId];
        }
        if (cmd === 'api_get_meeting_transcripts' && args && _meta[args.meetingId]) {
          return ${JSON.stringify(MOCK_TRANSCRIPTS)};
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

/** Read the recorded Tauri invokes for a given command name. */
async function invokesFor(page: import('@playwright/test').Page, cmd: string) {
  return page.evaluate(
    (c) => (window as any).__TAURI_MOCK_CALLS__?.filter((x: any) => x.cmd === c) ?? [],
    cmd,
  );
}

test.describe('Filed-under row + Move dialog', () => {
  test('filed meeting shows its project, reveals in Explorer, and unfiles to default', async ({ tauriPage }) => {
    await tauriPage.goto('/meeting-details?id=meeting-1');
    await tauriPage.waitForLoadState('networkidle');

    const row = tauriPage.getByTestId('filed-under-row');
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Filed under Acme, with the full folder path shown.
    await expect(tauriPage.getByTestId('filed-under-project')).toHaveText('Acme');
    await expect(tauriPage.getByTestId('filed-under-path')).toHaveText(FILED_FOLDER);

    // Reveal in Explorer -> show_in_folder with the folder path.
    await tauriPage.getByTestId('filed-under-reveal').click();
    await expect
      .poll(async () => (await invokesFor(tauriPage, 'show_in_folder')).length)
      .toBeGreaterThan(0);
    const reveal = await invokesFor(tauriPage, 'show_in_folder');
    expect(reveal[0].args.path).toBe(FILED_FOLDER);

    // Expand actions and Unfile -> relocate back to the default recordings base.
    await tauriPage.getByTestId('filed-under-toggle').click();
    const unfile = tauriPage.getByTestId('filed-under-unfile');
    await expect(unfile).toBeEnabled();
    await unfile.click();

    await expect
      .poll(async () => (await invokesFor(tauriPage, 'relocate_meeting_folder')).length)
      .toBeGreaterThan(0);
    const rel = await invokesFor(tauriPage, 'relocate_meeting_folder');
    expect(rel[0].args.meetingId).toBe('meeting-1');
    expect(String(rel[0].args.destParentDir)).toContain('recordings');
    await expect(tauriPage.getByText('Unfiled to the default recordings folder')).toBeVisible();
    // Undo affordance present (undo-over-confirm).
    await expect(tauriPage.getByRole('button', { name: 'Undo' })).toBeVisible();
  });

  test('unfiled meeting can be moved into a project', async ({ tauriPage }) => {
    await tauriPage.goto('/meeting-details?id=meeting-2');
    await tauriPage.waitForLoadState('networkidle');

    await expect(tauriPage.getByTestId('filed-under-row')).toBeVisible({ timeout: 15_000 });
    await expect(tauriPage.getByTestId('filed-under-unfiled')).toHaveText('Unfiled (default location)');

    // Expand: Move is offered, Unfile is not (nothing to unfile).
    await tauriPage.getByTestId('filed-under-toggle').click();
    await expect(tauriPage.getByTestId('filed-under-move')).toBeEnabled();
    await expect(tauriPage.getByTestId('filed-under-unfile')).toHaveCount(0);

    // Open the picker and choose the registered "Acme" project.
    await tauriPage.getByTestId('filed-under-move').click();
    const search = tauriPage.getByPlaceholder('Search projects or type to filter...');
    await expect(search).toBeVisible();
    await search.fill('Acme');
    await search.press('Enter');

    await expect
      .poll(async () => (await invokesFor(tauriPage, 'relocate_meeting_folder')).length)
      .toBeGreaterThan(0);
    const rel = await invokesFor(tauriPage, 'relocate_meeting_folder');
    expect(rel[0].args.meetingId).toBe('meeting-2');
    expect(rel[0].args.destParentDir).toBe('D:/Dev-projects/Client_projects/Acme/.tandem');
    await expect(tauriPage.getByText('Moved to Acme')).toBeVisible();
  });

  test('actively-recording meeting disables Move/Unfile with a live tooltip', async ({ tauriPage }) => {
    // Simulate the live case: the backend reports an active recording whose folder IS meeting-1's
    // folder. The row must detect this on folder-path identity (not an id that can never overlap)
    // and disable the actions, mirroring the Rust command's refusal. This overrides the base mock's
    // get_recording_state (idle) and get_meeting_folder_path so isLive resolves true.
    await tauriPage.addInitScript(`
      const _liveInvoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async function(cmd, args, options) {
        if (cmd === 'get_recording_state') {
          return { is_recording: true, is_paused: false, is_active: true,
                   recording_duration: 42, active_duration: 42 };
        }
        if (cmd === 'get_meeting_folder_path') {
          return ${JSON.stringify(FILED_FOLDER)};
        }
        return _liveInvoke(cmd, args, options);
      };
    `);

    await tauriPage.goto('/meeting-details?id=meeting-1');
    await tauriPage.waitForLoadState('networkidle');

    await expect(tauriPage.getByTestId('filed-under-row')).toBeVisible({ timeout: 15_000 });
    await tauriPage.getByTestId('filed-under-toggle').click();

    const move = tauriPage.getByTestId('filed-under-move');
    await expect(move).toBeDisabled();
    await expect(move).toHaveAttribute('title', /still recording/i);
    await expect(tauriPage.getByTestId('filed-under-unfile')).toBeDisabled();

    // Guard holds: clicking the disabled control never reaches the Rust relocate command.
    await move.click({ force: true }).catch(() => {});
    expect((await invokesFor(tauriPage, 'relocate_meeting_folder')).length).toBe(0);
  });
});
