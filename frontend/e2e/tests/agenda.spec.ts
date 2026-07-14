import { test, expect } from '../fixtures/tauri-mock';

test.describe('Today agenda (calendar overlay)', () => {
  test('shows today\'s event with time and a Join link; hides tomorrow\'s', async ({ tauriPage }) => {
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');

    const agenda = tauriPage.getByTestId('today-agenda');
    await expect(agenda).toBeVisible({ timeout: 15_000 });

    // Today's event from the mock ICS.
    await expect(agenda.getByText('Acme discovery call')).toBeVisible({ timeout: 15_000 });
    // Tomorrow's event must not appear in the today list.
    await expect(agenda.getByText('Beta strategy sync')).toHaveCount(0);

    // A time in HH:MM form is rendered.
    await expect(agenda.getByTestId('agenda-row').first()).toContainText(/\d{2}:\d{2}/);

    // Join link points at the Zoom URL from the mock.
    const join = agenda.getByRole('link', { name: /join/i });
    await expect(join).toBeVisible();
    await expect(join).toHaveAttribute('href', /zoom\.us/);
  });

  test('refresh button is clickable without error', async ({ tauriPage }) => {
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');

    const agenda = tauriPage.getByTestId('today-agenda');
    await expect(agenda).toBeVisible({ timeout: 15_000 });

    const refresh = agenda.getByRole('button', { name: /refresh calendar/i });
    await expect(refresh).toBeVisible();
    await refresh.click();
    // Still there, still shows the event.
    await expect(agenda.getByText('Acme discovery call')).toBeVisible();
  });

  test('command palette exposes calendar commands', async ({ tauriPage }) => {
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');
    await expect(tauriPage.getByTestId('today-agenda')).toBeVisible({ timeout: 15_000 });

    await tauriPage.keyboard.press('Control+k');
    await expect(tauriPage.getByPlaceholder('Search meetings, projects and commands…')).toBeVisible();

    await expect(tauriPage.getByText('Refresh calendar')).toBeVisible();
    const showAgenda = tauriPage.getByText("Show today's agenda");
    await expect(showAgenda).toBeVisible();

    // Selecting it keeps us on home with the agenda visible.
    await showAgenda.click();
    await expect(tauriPage).toHaveURL(/localhost:3118\/?$/);
    await expect(tauriPage.getByTestId('today-agenda')).toBeVisible();
  });

  test('unconfigured calendar shows the empty state with a Settings link', async ({ tauriPage }) => {
    // Patch the mock (added AFTER the fixture's init script, so it wraps invoke) to report
    // no calendar configured.
    await tauriPage.addInitScript(() => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
      const orig = internals.invoke;
      internals.invoke = async function (cmd: string, args: unknown) {
        if (cmd === 'api_get_calendar_config') return null;
        return orig(cmd, args);
      };
    });

    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');

    const agenda = tauriPage.getByTestId('today-agenda');
    await expect(agenda).toBeVisible({ timeout: 15_000 });
    await expect(agenda.getByText('Connect your calendar')).toBeVisible();
    await expect(agenda.getByRole('link', { name: 'Settings' })).toBeVisible();
    // No event rows when unconfigured.
    await expect(agenda.getByTestId('agenda-row')).toHaveCount(0);
  });
});
