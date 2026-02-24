import { test, expect } from '../fixtures/tauri-mock';

test.describe('Home Page', () => {
  test('renders without crashing and shows main layout', async ({ tauriPage }) => {
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');

    // The app should show the main content (not the OnboardingFlow)
    // "Welcome to Tandem!" is the empty transcript state, confirming main app rendered
    await expect(tauriPage.getByText('Welcome to Tandem!')).toBeVisible({ timeout: 15_000 });
    await expect(tauriPage.getByText('Start recording to see live transcription')).toBeVisible();
  });

  test('shows recording controls', async ({ tauriPage }) => {
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');

    // The recording controls are a pill-shaped container at the bottom.
    // Use the inner container with specific spacing class to disambiguate.
    const recordingControls = tauriPage.locator('div.space-x-2.bg-card.rounded-full.shadow-lg');
    await expect(recordingControls).toBeVisible({ timeout: 15_000 });
  });

  test('shows AI Assistant toggle button', async ({ tauriPage }) => {
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');

    await expect(
      tauriPage.locator('[title="Open AI Assistant"]'),
    ).toBeVisible({ timeout: 15_000 });
  });
});
