import { test, expect } from '../fixtures/tauri-mock';

test.describe('Settings Page', () => {
  test.beforeEach(async ({ tauriPage }) => {
    await tauriPage.goto('/settings');
    await tauriPage.waitForLoadState('networkidle');
  });

  test('renders settings page with heading and back button', async ({ tauriPage }) => {
    await expect(tauriPage.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 10_000 });
    await expect(tauriPage.getByRole('button', { name: 'Back' })).toBeVisible();
  });

  test('shows all four tabs', async ({ tauriPage }) => {
    await expect(tauriPage.getByRole('tab', { name: 'General' })).toBeVisible({ timeout: 10_000 });
    await expect(tauriPage.getByRole('tab', { name: 'Recordings' })).toBeVisible();
    await expect(tauriPage.getByRole('tab', { name: 'Transcription' })).toBeVisible();
    await expect(tauriPage.getByRole('tab', { name: 'Summary' })).toBeVisible();
  });

  test('General tab is active by default', async ({ tauriPage }) => {
    const generalTab = tauriPage.getByRole('tab', { name: 'General' });
    await expect(generalTab).toHaveAttribute('data-state', 'active', { timeout: 10_000 });
  });

  test('can switch to Recordings tab', async ({ tauriPage }) => {
    await tauriPage.getByRole('tab', { name: 'Recordings' }).click();
    await expect(tauriPage.getByRole('tab', { name: 'Recordings' })).toHaveAttribute('data-state', 'active');
    await expect(tauriPage.getByRole('tab', { name: 'General' })).toHaveAttribute('data-state', 'inactive');
  });

  test('can switch to Transcription tab', async ({ tauriPage }) => {
    await tauriPage.getByRole('tab', { name: 'Transcription' }).click();
    await expect(tauriPage.getByRole('tab', { name: 'Transcription' })).toHaveAttribute('data-state', 'active');
  });

  test('can switch to Summary tab', async ({ tauriPage }) => {
    await tauriPage.getByRole('tab', { name: 'Summary' }).click();
    await expect(tauriPage.getByRole('tab', { name: 'Summary' })).toHaveAttribute('data-state', 'active');
  });

  test('General tab shows the Calendar section with a masked URL and interval', async ({ tauriPage }) => {
    await expect(tauriPage.getByRole('heading', { name: 'Calendar' })).toBeVisible({ timeout: 10_000 });

    // URL field is masked (password type) and hydrated from the mock config.
    const urlField = tauriPage.locator('#calendar-ics-url');
    await expect(urlField).toHaveAttribute('type', 'password');

    // Interval select defaults to the mock's 15 minutes.
    await expect(tauriPage.locator('#calendar-interval')).toHaveValue('15');
  });

  test('Test connection surfaces an event count', async ({ tauriPage }) => {
    await expect(tauriPage.getByRole('heading', { name: 'Calendar' })).toBeVisible({ timeout: 10_000 });

    await tauriPage.getByRole('button', { name: /test connection/i }).click();

    // The mock ICS has 3 events, 2 today.
    await expect(tauriPage.getByText(/Connected — 3 events found \(2 today\)/)).toBeVisible({ timeout: 10_000 });
  });

  test('back button navigates to previous page', async ({ tauriPage }) => {
    // Navigate from home to settings
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');
    await tauriPage.goto('/settings');
    await tauriPage.waitForLoadState('networkidle');
    await expect(tauriPage.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 10_000 });

    // Click back
    await tauriPage.getByRole('button', { name: 'Back' }).click();

    // Should go back to home
    await expect(tauriPage).toHaveURL(/localhost:3118\/?$/);
  });
});
