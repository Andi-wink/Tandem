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

/**
 * Like seedImminentEvent, but also puts the app into an ACTIVE recording state so the reminder must
 * surface as a HANDOVER (toast), not a dialog. stop_recording is patched to emit 'recording-stopped'
 * so RecordingStateContext flips isRecording -> false, letting the follow-up start proceed exactly as
 * it would after a real pipeline stop.
 */
async function seedImminentEventWhileRecording(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try { window.localStorage.setItem('tandem.reminder.enabled', '1'); } catch { /* ignore */ }
  });
  await page.addInitScript(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const orig = internals.invoke;
    // A live recording that stops when stop_recording is invoked. Every recording-state read honours
    // this flag, so the 500ms context poll and the 5s page poll converge on idle after the stop and
    // the follow-up start is allowed (RecordingControls only starts when it sees is_recording false).
    let recording = true;
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
          'BEGIN:VEVENT', 'UID:handover-1', 'SUMMARY:Acme discovery call',
          'DTSTART:' + fmt(start), 'DTEND:' + fmt(end),
          'LOCATION:https://us02web.zoom.us/j/8412345678?pwd=abcd',
          'ATTENDEE;CN=Jane Client:mailto:jane@acme.com',
          'END:VEVENT', 'END:VCALENDAR',
        ].join('\n');
      }
      // Report the current recording state so the reminder chooses handover vs dialog correctly.
      if (cmd === 'get_recording_state') {
        return { is_recording: recording, is_paused: false, is_active: recording, recording_duration: recording ? 120 : null, active_duration: recording ? 120 : null };
      }
      if (cmd === 'is_recording') return recording;
      // A real stop emits 'recording-stopped'; the mock's default no-op does not, so flip the flag and
      // emit here, then delegate so the call is still recorded in __TAURI_MOCK_CALLS__.
      if (cmd === 'stop_recording') {
        recording = false;
        await orig.call(internals, 'plugin:event|emit', { event: 'recording-stopped', payload: { message: 'stopped' } });
        return orig.call(internals, cmd, args);
      }
      return orig.call(internals, cmd, args);
    };
  });
}

test.describe('Mid-recording handover (I5b)', () => {
  test('an imminent call while recording surfaces a handover toast, not a dialog', async ({ tauriPage }) => {
    await seedImminentEventWhileRecording(tauriPage);
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');

    // The handover toast appears with the call title and the wrap-up action.
    await expect(tauriPage.getByText('Next: Acme discovery call')).toBeVisible({ timeout: 20_000 });
    await expect(tauriPage.getByRole('button', { name: 'Wrap up and start next' })).toBeVisible();

    // The focus-grabbing dialog must NOT render while recording.
    await expect(tauriPage.getByTestId('meeting-reminder-dialog')).toHaveCount(0);
  });

  test('Wrap up and start next stops the current recording BEFORE starting the next, seeded with the call title', async ({ tauriPage }) => {
    // The handover awaits a full stop (transcript wait + late-segment settle, ~5s in the mock)
    // before dispatching the next start, so this test needs more than the default 30s budget.
    test.setTimeout(90_000);
    await seedImminentEventWhileRecording(tauriPage);
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');

    const action = tauriPage.getByRole('button', { name: 'Wrap up and start next' });
    await expect(action).toBeVisible({ timeout: 20_000 });

    await resetCalls(tauriPage);
    await action.click();

    // The new recording eventually starts with the calendar invite title.
    await expect.poll(async () => {
      const c = await calls(tauriPage);
      const start = c.find((x) => x.cmd === 'start_recording_with_devices_and_meeting');
      if (!start) return null;
      return (start.args as { meeting_name?: string }).meeting_name ?? null;
    }, { timeout: 30_000 }).toBe('Acme discovery call');

    // Ordering: the stop must be invoked strictly before the next start.
    const c = await calls(tauriPage);
    const stopIdx = c.findIndex((x) => x.cmd === 'stop_recording');
    const startIdx = c.findIndex((x) => x.cmd === 'start_recording_with_devices_and_meeting');
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(stopIdx);
  });

  test('mashing the stop hotkey during an in-flight handover does not fire a second stop_recording, and the handover still completes', async ({ tauriPage }) => {
    // The handover awaits a full stop (~5s in the mock) before the next start, so give it room.
    test.setTimeout(90_000);
    await seedImminentEventWhileRecording(tauriPage);
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');

    const action = tauriPage.getByRole('button', { name: 'Wrap up and start next' });
    await expect(action).toBeVisible({ timeout: 20_000 });

    await resetCalls(tauriPage);
    await action.click();

    // While the handover is stopping the current call (isRecording flips false partway through),
    // hammer the OS record hotkey. The handover transition guard in RecordingPostProcessingProvider
    // must swallow every one — otherwise the toggle would drive a SECOND, independent stop pipeline
    // against the same recording (double-save + double stop_recording). Bounded to the stop phase so
    // no late toggle can stop the freshly-started NEXT recording.
    await tauriPage.evaluate(async () => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
      for (let i = 0; i < 12; i++) {
        try { await internals.invoke('plugin:event|emit', { event: 'global-record-toggle', payload: null }); } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 150));
      }
    });

    // The handover still completes: the next recording starts with the calendar invite title.
    await expect.poll(async () => {
      const c = await calls(tauriPage);
      const start = c.find((x) => x.cmd === 'start_recording_with_devices_and_meeting');
      if (!start) return null;
      return (start.args as { meeting_name?: string }).meeting_name ?? null;
    }, { timeout: 30_000 }).toBe('Acme discovery call');

    // Exactly ONE stop_recording was invoked across the whole handover, despite the hotkey mashing.
    const c = await calls(tauriPage);
    const stops = c.filter((x) => x.cmd === 'stop_recording');
    expect(stops.length).toBe(1);
    // And exactly one next-recording start (no duplicate/racing start either).
    const starts = c.filter((x) => x.cmd === 'start_recording_with_devices_and_meeting');
    expect(starts.length).toBe(1);
  });
});

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
