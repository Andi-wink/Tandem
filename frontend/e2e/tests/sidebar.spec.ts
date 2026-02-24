import { test, expect } from '../fixtures/tauri-mock';

test.describe('Sidebar Navigation', () => {
  test.beforeEach(async ({ tauriPage }) => {
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');
    // Wait for app to render
    await expect(tauriPage.getByText('Welcome to Tandem!')).toBeVisible({ timeout: 15_000 });
  });

  test('sidebar can be expanded via toggle button', async ({ tauriPage }) => {
    // The collapse toggle is an absolute-positioned button with ChevronRightCircle icon
    const expandBtn = tauriPage.locator('button.absolute.-right-6, button[style*="translateX(50%)"]').first();
    await expandBtn.click();

    // After expanding, "Home" text should be visible in sidebar
    await expect(tauriPage.getByText('Home')).toBeVisible({ timeout: 5_000 });
  });

  test('expanded sidebar shows meeting list', async ({ tauriPage }) => {
    // Expand sidebar
    const expandBtn = tauriPage.locator('button[style*="translateX(50%)"]').first();
    await expandBtn.click();
    await expect(tauriPage.getByText('Home')).toBeVisible({ timeout: 5_000 });

    // Mock meetings should appear
    await expect(tauriPage.getByText('Team Standup 2026-02-23')).toBeVisible({ timeout: 5_000 });
    await expect(tauriPage.getByText('Product Review')).toBeVisible();
    await expect(tauriPage.getByText('Sprint Planning')).toBeVisible();
  });

  test('can navigate to Settings', async ({ tauriPage }) => {
    // Expand sidebar
    const expandBtn = tauriPage.locator('button[style*="translateX(50%)"]').first();
    await expandBtn.click();
    await expect(tauriPage.getByText('Home')).toBeVisible({ timeout: 5_000 });

    // Click Settings in sidebar footer
    await tauriPage.getByText('Settings').click();

    // Should navigate to settings page
    await expect(tauriPage).toHaveURL(/.*settings/);
    await expect(tauriPage.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 10_000 });
  });

  test('can navigate Home from Settings', async ({ tauriPage }) => {
    // Go to settings first
    await tauriPage.goto('/settings');
    await tauriPage.waitForLoadState('networkidle');
    await expect(tauriPage.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 10_000 });

    // Expand sidebar and click Home
    const expandBtn = tauriPage.locator('button[style*="translateX(50%)"]').first();
    await expandBtn.click();
    await tauriPage.getByText('Home').click();

    // Should be back on home page
    await expect(tauriPage).toHaveURL(/localhost:3118\/?$/);
  });

  test('search input is visible when expanded', async ({ tauriPage }) => {
    // Expand sidebar
    const expandBtn = tauriPage.locator('button[style*="translateX(50%)"]').first();
    await expandBtn.click();

    await expect(tauriPage.getByPlaceholder('Search meeting content...')).toBeVisible({ timeout: 5_000 });
  });

  test('can collapse sidebar back', async ({ tauriPage }) => {
    // Expand
    const toggleBtn = tauriPage.locator('button[style*="translateX(50%)"]').first();
    await toggleBtn.click();
    await expect(tauriPage.getByText('Home')).toBeVisible({ timeout: 5_000 });

    // Collapse
    await toggleBtn.click();

    // "Home" text should disappear (icons only in collapsed mode)
    await expect(tauriPage.getByText('Home')).not.toBeVisible({ timeout: 5_000 });
  });
});
