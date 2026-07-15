import { test, expect } from '../fixtures/tauri-mock';
import type { Page } from '@playwright/test';

// Deterministic clipboard buffer for the bar: the latest item names a registered project (Acme)
// so the heuristic router resolves without any network / LLM call.
const CLIPS = [
  { id: 'clip-1', text: 'Client is worried about the Acme onboarding cost' },
  { id: 'clip-2', text: 'Second copied snippet, unrelated' },
];

async function openCaptureBar(page: Page) {
  await page.addInitScript((clips) => {
    (window as unknown as { __QC_CLIPS__: unknown }).__QC_CLIPS__ = clips;
  }, CLIPS);
  await page.goto('/capture');
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('quick-capture-bar')).toBeVisible({ timeout: 10_000 });
}

/** All invoke() calls recorded by the Tauri mock. */
async function mockCalls(page: Page): Promise<Array<{ cmd: string; args: Record<string, unknown> }>> {
  return page.evaluate(
    () => (window as unknown as { __TAURI_MOCK_CALLS__?: Array<{ cmd: string; args: Record<string, unknown> }> }).__TAURI_MOCK_CALLS__ ?? [],
  );
}

test.describe('Quick capture bar (/capture)', () => {
  test('the latest clip is attached, the previous one is not', async ({ tauriPage }) => {
    await openCaptureBar(tauriPage);
    await expect(tauriPage.getByTestId('clip-chip-0')).toHaveAttribute('aria-pressed', 'true');
    await expect(tauriPage.getByTestId('clip-chip-1')).toHaveAttribute('aria-pressed', 'false');
  });

  test('pressing 2 includes the second clip', async ({ tauriPage }) => {
    await openCaptureBar(tauriPage);
    await tauriPage.getByTestId('capture-note').focus();
    await tauriPage.keyboard.press('2');
    await expect(tauriPage.getByTestId('clip-chip-1')).toHaveAttribute('aria-pressed', 'true');
  });

  test('routes to the project named in the clipboard', async ({ tauriPage }) => {
    await openCaptureBar(tauriPage);
    await expect(tauriPage.getByTestId('route-name')).toHaveText('Acme', { timeout: 10_000 });
  });

  test('Enter saves the note to the routed project via the command', async ({ tauriPage }) => {
    await openCaptureBar(tauriPage);
    await expect(tauriPage.getByTestId('route-name')).toHaveText('Acme', { timeout: 10_000 });

    const noteText = 'objection about onboarding cost';
    await tauriPage.getByTestId('capture-note').fill(noteText);
    await tauriPage.getByTestId('capture-note').press('Enter');

    await expect
      .poll(async () => (await mockCalls(tauriPage)).some(c => c.cmd === 'save_quick_capture'))
      .toBe(true);

    const calls = await mockCalls(tauriPage);
    const save = calls.find(c => c.cmd === 'save_quick_capture')!;
    expect(save.args.projectPath).toBe('D:/Dev-projects/Client_projects/Acme');
    expect(String(save.args.filename)).toMatch(/quick-capture\.md$/);
    expect(String(save.args.content)).toContain(noteText);
    // The attached clip is embedded in the note body.
    expect(String(save.args.content)).toContain('Acme onboarding cost');
    // The bar asks to close after saving.
    expect(calls.some(c => c.cmd === 'quick_capture_close')).toBe(true);
  });

  test('Ctrl+Enter saves and hands the content to the AI panel', async ({ tauriPage }) => {
    await openCaptureBar(tauriPage);
    await expect(tauriPage.getByTestId('route-name')).toHaveText('Acme', { timeout: 10_000 });

    await tauriPage.getByTestId('capture-note').fill('draft a reply');
    await tauriPage.getByTestId('capture-note').press('Control+Enter');

    await expect
      .poll(async () => (await mockCalls(tauriPage)).some(c => c.cmd === 'quick_capture_send_to_ai'))
      .toBe(true);
    const calls = await mockCalls(tauriPage);
    expect(calls.some(c => c.cmd === 'save_quick_capture')).toBe(true);
  });

  test('Esc dismisses and saves nothing', async ({ tauriPage }) => {
    await openCaptureBar(tauriPage);
    await tauriPage.getByTestId('capture-note').fill('should not be saved');
    await tauriPage.getByTestId('capture-note').press('Escape');

    await expect
      .poll(async () => (await mockCalls(tauriPage)).some(c => c.cmd === 'quick_capture_close'))
      .toBe(true);
    const calls = await mockCalls(tauriPage);
    expect(calls.some(c => c.cmd === 'save_quick_capture')).toBe(false);
  });
});
