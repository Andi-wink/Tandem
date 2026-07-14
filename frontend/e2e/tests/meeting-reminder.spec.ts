import { test, expect } from '../fixtures/tauri-mock';
import type { Page } from '@playwright/test';

/** All invoke calls recorded by the Tauri mock this session. */
async function calls(page: Page): Promise<Array<{ cmd: string; args: unknown }>> {
  return page.evaluate(() => (window as unknown as { __TAURI_MOCK_CALLS__?: Array<{ cmd: string; args: unknown }> }).__TAURI_MOCK_CALLS__ || []);
}
async function resetCalls(page: Page): Promise<void> {
  await page.evaluate(() => { (window as unknown as { __TAURI_MOCK_CALLS__: unknown[] }).__TAURI_MOCK_CALLS__ = []; });
}

/**
 * Override fetch_calendar_ics with a single call starting inside the reminder lead window (45s
 * ahead, default lead 60s) so the pre-meeting prompt fires deterministically. Wraps the base
 * fixture's invoke (added earlier), so every other command still flows through the shared mock.
 */
async function seedImminentEvent(page: Page): Promise<void> {
  // Opt back in: the shared fixture defaults reminders OFF to avoid contaminating other specs.
  await page.addInitScript(() => {
    try { window.localStorage.setItem('tandem.reminder.enabled', '1'); } catch { /* ignore */ }
  });
  await page.addInitScript(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const orig = internals.invoke;
    internals.invoke = async function (cmd: string, args: unknown) {
      if (cmd === 'fetch_calendar_ics') {
        const pad = (n: number) => String(n).padStart(2, '0');
        const start = new Date(Date.now() + 45_000);
        const end = new Date(start.getTime() + 30 * 60_000);
        const fmt = (d: Date) =>
          d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
          'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
        return [
          'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tandem Test//EN',
          'BEGIN:VEVENT', 'UID:reminder-1', 'SUMMARY:Acme discovery call',
          'DTSTART:' + fmt(start), 'DTEND:' + fmt(end),
          'LOCATION:https://us02web.zoom.us/j/8412345678?pwd=abcd',
          'ATTENDEE;CN=Jane Client:mailto:jane@acme.com',
          'END:VEVENT', 'END:VCALENDAR',
        ].join('\n');
      }
      return orig.call(internals, cmd, args);
    };
  });
}

test.describe('Pre-meeting recording prompt (I5)', () => {
  test('an imminent call surfaces the prompt with its suggested folder', async ({ tauriPage }) => {
    await seedImminentEvent(tauriPage);
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');

    const dialog = tauriPage.getByTestId('meeting-reminder-dialog');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(dialog).toContainText('Acme discovery call');
    // Strong match on the attendee domain -> files under the registered Acme project.
    await expect(dialog.getByTestId('reminder-folder-name')).toContainText('Acme');
  });

  test('Start recording begins recording with the seeded call title', async ({ tauriPage }) => {
    await seedImminentEvent(tauriPage);
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');

    const dialog = tauriPage.getByTestId('meeting-reminder-dialog');
    await expect(dialog).toBeVisible({ timeout: 20_000 });

    await resetCalls(tauriPage);
    await dialog.getByTestId('reminder-start').click();

    await expect.poll(async () => {
      const c = await calls(tauriPage);
      const start = c.find((x) => x.cmd === 'start_recording_with_devices_and_meeting');
      if (!start) return null;
      return (start.args as { meeting_name?: string }).meeting_name ?? null;
    }, { timeout: 15_000 }).toBe('Acme discovery call');

    // The prompt closes once recording is requested.
    await expect(dialog).toHaveCount(0);
  });

  test('Dismiss closes the prompt and it does not reappear', async ({ tauriPage }) => {
    await seedImminentEvent(tauriPage);
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');

    const dialog = tauriPage.getByTestId('meeting-reminder-dialog');
    await expect(dialog).toBeVisible({ timeout: 20_000 });

    await dialog.getByTestId('reminder-dismiss').click();
    await expect(dialog).toHaveCount(0);

    // Give the 15s ticker a chance plus the immediate re-evaluation: it must stay dismissed.
    await tauriPage.waitForTimeout(2_000);
    await expect(dialog).toHaveCount(0);
  });
});
