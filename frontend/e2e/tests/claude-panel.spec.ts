import { test, expect } from '../fixtures/tauri-mock';

test.describe('Claude AI Panel', () => {
  test.beforeEach(async ({ tauriPage }) => {
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');
    // Wait for app to render
    await expect(tauriPage.getByText('Welcome to Tandem!')).toBeVisible({ timeout: 15_000 });
  });

  test('AI panel toggle button is visible', async ({ tauriPage }) => {
    await expect(tauriPage.locator('[title="Open AI Assistant"]')).toBeVisible();
  });

  test('clicking toggle opens the Claude panel', async ({ tauriPage }) => {
    await tauriPage.locator('[title="Open AI Assistant"]').click();

    // The panel should show with the message input
    await expect(
      tauriPage.getByPlaceholder('Ask about this meeting...'),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('panel shows model selector', async ({ tauriPage }) => {
    await tauriPage.locator('[title="Open AI Assistant"]').click();
    await tauriPage.waitForTimeout(500);

    // Model selector button should show one of the model names
    await expect(tauriPage.getByRole('button', { name: /Opus|Sonnet|Haiku/ })).toBeVisible({ timeout: 5_000 });
  });

  test('can close the Claude panel', async ({ tauriPage }) => {
    // The panel container
    const panel = tauriPage.locator('div.fixed.right-0.top-0.bottom-0');

    // Open panel
    await tauriPage.locator('[title="Open AI Assistant"]').click();
    await expect(tauriPage.getByPlaceholder('Ask about this meeting...')).toBeVisible({ timeout: 5_000 });
    // Panel should have translate-x-0 (open)
    await expect(panel).toHaveClass(/translate-x-0/, { timeout: 3_000 });

    // Close via the X button — it's the last button in the panel header button group
    const closeBtn = panel.locator('div.flex.items-center.gap-1').locator('button').last();
    await closeBtn.click();

    // Panel should slide off-screen with translate-x-full
    await expect(panel).toHaveClass(/translate-x-full/, { timeout: 5_000 });
  });

  test('can type in the message input', async ({ tauriPage }) => {
    await tauriPage.locator('[title="Open AI Assistant"]').click();

    const input = tauriPage.getByPlaceholder('Ask about this meeting...');
    await expect(input).toBeVisible({ timeout: 5_000 });

    await input.fill('Summarize the key discussion points');
    await expect(input).toHaveValue('Summarize the key discussion points');
  });
});
