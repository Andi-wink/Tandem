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
      tauriPage.getByPlaceholder('What can we help you with?'),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('panel shows model selector', async ({ tauriPage }) => {
    await tauriPage.locator('[title="Open AI Assistant"]').click();
    await expect(tauriPage.getByPlaceholder('What can we help you with?')).toBeVisible({ timeout: 5_000 });

    // The model picker now lives behind the Settings popover in the composer footer.
    await tauriPage.locator('button[title="Settings"]').click();
    await expect(tauriPage.getByRole('button', { name: /Opus|Sonnet|Haiku/ }).first()).toBeVisible({ timeout: 5_000 });
  });

  test('can close the Claude panel', async ({ tauriPage }) => {
    // The panel container
    const panel = tauriPage.locator('div.fixed.right-0.top-0.bottom-0');

    // Open panel
    await tauriPage.locator('[title="Open AI Assistant"]').click();
    await expect(tauriPage.getByPlaceholder('What can we help you with?')).toBeVisible({ timeout: 5_000 });
    // Panel should have translate-x-0 (open)
    await expect(panel).toHaveClass(/translate-x-0/, { timeout: 3_000 });

    // Close via the labelled X button in the panel header
    await panel.getByRole('button', { name: 'Close AI Assistant' }).click();

    // Panel should slide off-screen with translate-x-full
    await expect(panel).toHaveClass(/translate-x-full/, { timeout: 5_000 });
  });

  test('can type in the message input', async ({ tauriPage }) => {
    await tauriPage.locator('[title="Open AI Assistant"]').click();

    const input = tauriPage.getByPlaceholder('What can we help you with?');
    await expect(input).toBeVisible({ timeout: 5_000 });

    await input.fill('Summarize the key discussion points');
    await expect(input).toHaveValue('Summarize the key discussion points');
  });
});
