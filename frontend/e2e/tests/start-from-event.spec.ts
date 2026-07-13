import { test, expect } from '../fixtures/tauri-mock';
import type { Page } from '@playwright/test';

/** All invoke calls recorded by the Tauri mock this session. */
async function calls(page: Page): Promise<Array<{ cmd: string; args: unknown }>> {
  return page.evaluate(() => (window as unknown as { __TAURI_MOCK_CALLS__?: Array<{ cmd: string; args: unknown }> }).__TAURI_MOCK_CALLS__ || []);
}
async function resetCalls(page: Page): Promise<void> {
  await page.evaluate(() => { (window as unknown as { __TAURI_MOCK_CALLS__: unknown[] }).__TAURI_MOCK_CALLS__ = []; });
}

test.describe('Start recording from a calendar event (I3 + R1/R2/R3)', () => {
  test('strong match: agenda Record seeds title + <project>/.tandem base, no chooser', async ({ tauriPage }) => {
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');
    const agenda = tauriPage.getByTestId('today-agenda');
    await expect(agenda).toBeVisible({ timeout: 15_000 });
    // The strong-match chip is shown on the Acme row.
    await expect(agenda.getByTestId('agenda-match').first()).toContainText(/Acme/i, { timeout: 15_000 });

    await resetCalls(tauriPage);
    await agenda.getByRole('button', { name: 'Start recording for Acme discovery call' }).click();

    // Recording starts with the seeded event title and a .tandem base directory.
    await expect.poll(async () => {
      const c = await calls(tauriPage);
      const start = c.find((x) => x.cmd === 'start_recording_with_devices_and_meeting');
      if (!start) return null;
      const a = start.args as { meeting_name?: string; meeting_base_dir?: string };
      return `${a.meeting_name}|${a.meeting_base_dir}`;
    }, { timeout: 15_000 }).toMatch(/^Acme discovery call\|.*[\\/]\.tandem$/);

    // No ambiguity chooser for a strong single match.
    await expect(tauriPage.getByText('Which folder is this call for?')).toHaveCount(0);
  });

  test('ambiguous match: recording starts AND the chooser appears with both candidates; Escape leaves it unfiled', async ({ tauriPage }) => {
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');
    const agenda = tauriPage.getByTestId('today-agenda');
    await expect(agenda).toBeVisible({ timeout: 15_000 });
    // The ambiguous chip is shown on the Globex row.
    await expect(agenda.getByTestId('agenda-ambiguous').first()).toBeVisible({ timeout: 15_000 });

    await resetCalls(tauriPage);
    await agenda.getByRole('button', { name: 'Start recording for Globex roadmap review' }).click();

    // Recording still starts (the chooser never gates the start).
    await expect.poll(async () => {
      const c = await calls(tauriPage);
      return c.some((x) => x.cmd === 'start_recording_with_devices_and_meeting');
    }, { timeout: 15_000 }).toBe(true);

    // The chooser appears, seeded with both ranked candidates + their match signals.
    await expect(tauriPage.getByText('Which folder is this call for?')).toBeVisible({ timeout: 15_000 });
    const dialog = tauriPage.locator('div', { hasText: 'Which folder is this call for?' }).last();
    await expect(tauriPage.getByText(/Matched attendee @acme\.com/i)).toBeVisible();
    await expect(tauriPage.getByText(/globex/i).first()).toBeVisible();

    // Escape dismisses; the call stays unfiled (no project adopted, no relocation).
    await tauriPage.keyboard.press('Escape');
    await expect(tauriPage.getByText('Which folder is this call for?')).toHaveCount(0);
    const after = await calls(tauriPage);
    expect(after.some((x) => x.cmd === 'project_create')).toBe(false);
    expect(after.some((x) => x.cmd === 'relocate_meeting_folder')).toBe(false);
  });

  test('picking a discovered client folder in the chooser adopts it via createProject', async ({ tauriPage }) => {
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');
    const agenda = tauriPage.getByTestId('today-agenda');
    await expect(agenda).toBeVisible({ timeout: 15_000 });

    await resetCalls(tauriPage);
    await agenda.getByRole('button', { name: 'Start recording for Globex roadmap review' }).click();
    await expect(tauriPage.getByText('Which folder is this call for?')).toBeVisible({ timeout: 15_000 });

    // Globex is an unregistered discovered folder — picking it adopts it via project_create.
    await tauriPage.getByRole('button', { name: /Globex/ }).first().click();

    await expect.poll(async () => {
      const c = await calls(tauriPage);
      return c.some((x) => x.cmd === 'project_create');
    }, { timeout: 15_000 }).toBe(true);
  });
});
