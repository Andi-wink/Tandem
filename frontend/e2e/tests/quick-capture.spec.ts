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

/**
 * Tab until the route chip is a "+ New in X" entry. Bounded so a regression that drops
 * the entries fails the test instead of hanging it.
 */
async function cycleToNewInquiry(page: Page, max = 10): Promise<void> {
  for (let i = 0; i < max; i++) {
    const name = await page.getByTestId('route-name').textContent();
    if (name?.startsWith('New in')) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('never reached a "+ New in" candidate');
}

test.describe('Quick capture bar: new inquiry', () => {
  test('the create-new entries come last, after every real destination', async ({ tauriPage }) => {
    await openCaptureBar(tauriPage);
    await expect(tauriPage.getByTestId('route-name')).toHaveText('Acme', { timeout: 10_000 });
    // One Tab must not land on a create-new entry: filing somewhere real is the common case.
    await tauriPage.keyboard.press('Tab');
    await expect(tauriPage.getByTestId('route-name')).not.toContainText('New in');
  });

  test('selecting one swaps the note field for a name field, prefilled from the capture', async ({ tauriPage }) => {
    await openCaptureBar(tauriPage);
    await expect(tauriPage.getByTestId('route-name')).toHaveText('Acme', { timeout: 10_000 });
    await cycleToNewInquiry(tauriPage);

    await expect(tauriPage.getByTestId('capture-note')).toHaveCount(0);
    const nameField = tauriPage.getByTestId('inquiry-name');
    await expect(nameField).toBeVisible();
    // Derived from the clip: "Client is worried about the Acme onboarding cost".
    await expect(nameField).toHaveValue(/Acme onboarding cost/);
    await expect(tauriPage.getByTestId('inquiry-path')).toContainText('Client_projects');
  });

  test('the name field keeps keyboard focus after the swap', async ({ tauriPage }) => {
    await openCaptureBar(tauriPage);
    await expect(tauriPage.getByTestId('route-name')).toHaveText('Acme', { timeout: 10_000 });
    await cycleToNewInquiry(tauriPage);
    // Regression: the swap unmounts the focused note input. If focus fell to <body>, the
    // container's key handler would go deaf and Enter would do nothing.
    await expect(tauriPage.getByTestId('inquiry-name')).toBeFocused();
  });

  test('Enter creates the folder with a sanitized name and registers it', async ({ tauriPage }) => {
    await openCaptureBar(tauriPage);
    await expect(tauriPage.getByTestId('route-name')).toHaveText('Acme', { timeout: 10_000 });
    await cycleToNewInquiry(tauriPage);

    const chip = await tauriPage.getByTestId('route-name').textContent();
    const baseName = chip!.replace('New in ', '');

    await tauriPage.getByTestId('inquiry-name').fill('Acme: Q3/Q4 <rush>');
    await expect(tauriPage.getByTestId('inquiry-path')).toContainText('Acme Q3 Q4 rush');
    await tauriPage.getByTestId('inquiry-name').press('Enter');

    await expect
      .poll(async () => (await mockCalls(tauriPage)).some(c => c.cmd === 'create_inquiry'))
      .toBe(true);

    const calls = await mockCalls(tauriPage);
    const create = calls.find(c => c.cmd === 'create_inquiry')!;
    // The illegal characters never reach the filesystem layer.
    expect(create.args.name).toBe('Acme Q3 Q4 rush');
    expect(String(create.args.basePath)).toContain(baseName);
    expect(String(create.args.brief)).toContain('# Acme Q3 Q4 rush');
    expect(String(create.args.brief)).toContain('Acme onboarding cost'); // the captured clip
    expect(String(create.args.claudeMd)).toContain('[brief.md](brief.md)');

    // Registered as a project, and the bar closes.
    const created = calls.find(c => c.cmd === 'project_create');
    expect(created?.args.name).toBe('Acme Q3 Q4 rush');
    expect(calls.some(c => c.cmd === 'quick_capture_close')).toBe(true);
    // Enter alone must not launch the IDE.
    expect(calls.some(c => c.cmd === 'open_in_antigravity')).toBe(false);
  });

  test('Ctrl+Enter also opens the folder in Antigravity', async ({ tauriPage }) => {
    await openCaptureBar(tauriPage);
    await expect(tauriPage.getByTestId('route-name')).toHaveText('Acme', { timeout: 10_000 });
    await cycleToNewInquiry(tauriPage);

    await tauriPage.getByTestId('inquiry-name').fill('Globex Rebuild');
    await tauriPage.getByTestId('inquiry-name').press('Control+Enter');

    await expect
      .poll(async () => (await mockCalls(tauriPage)).some(c => c.cmd === 'open_in_antigravity'))
      .toBe(true);
    const calls = await mockCalls(tauriPage);
    const open = calls.find(c => c.cmd === 'open_in_antigravity')!;
    expect(String(open.args.path)).toContain('Globex Rebuild');
  });

  test('an empty name refuses to create and says why', async ({ tauriPage }) => {
    await openCaptureBar(tauriPage);
    await expect(tauriPage.getByTestId('route-name')).toHaveText('Acme', { timeout: 10_000 });
    await cycleToNewInquiry(tauriPage);

    // Only characters that sanitize away to nothing.
    await tauriPage.getByTestId('inquiry-name').fill('///');
    await tauriPage.getByTestId('inquiry-name').press('Enter');

    await expect(tauriPage.getByTestId('inquiry-error')).toBeVisible();
    const calls = await mockCalls(tauriPage);
    expect(calls.some(c => c.cmd === 'create_inquiry')).toBe(false);
    expect(calls.some(c => c.cmd === 'quick_capture_close')).toBe(false);
  });

  test('typing a digit in the name does not detach a clip', async ({ tauriPage }) => {
    await openCaptureBar(tauriPage);
    await expect(tauriPage.getByTestId('route-name')).toHaveText('Acme', { timeout: 10_000 });
    await cycleToNewInquiry(tauriPage);

    // "Project 2" must be typeable: in note mode the bare 2 toggles the second clip.
    await tauriPage.getByTestId('inquiry-name').fill('Project 2');
    await expect(tauriPage.getByTestId('inquiry-name')).toHaveValue('Project 2');
    await expect(tauriPage.getByTestId('clip-chip-1')).toHaveAttribute('aria-pressed', 'false');
  });

  test('an edited name is not overwritten when the capture changes', async ({ tauriPage }) => {
    await openCaptureBar(tauriPage);
    await expect(tauriPage.getByTestId('route-name')).toHaveText('Acme', { timeout: 10_000 });
    await cycleToNewInquiry(tauriPage);

    await tauriPage.getByTestId('inquiry-name').fill('My Chosen Name');
    // Attaching another clip re-runs the derivation; the typed name must survive it.
    await tauriPage.getByTestId('clip-chip-1').click();
    await expect(tauriPage.getByTestId('clip-chip-1')).toHaveAttribute('aria-pressed', 'true');
    await expect(tauriPage.getByTestId('inquiry-name')).toHaveValue('My Chosen Name');
  });

  test('Esc while naming creates nothing', async ({ tauriPage }) => {
    await openCaptureBar(tauriPage);
    await expect(tauriPage.getByTestId('route-name')).toHaveText('Acme', { timeout: 10_000 });
    await cycleToNewInquiry(tauriPage);

    await tauriPage.getByTestId('inquiry-name').fill('Should Not Exist');
    await tauriPage.getByTestId('inquiry-name').press('Escape');

    await expect
      .poll(async () => (await mockCalls(tauriPage)).some(c => c.cmd === 'quick_capture_close'))
      .toBe(true);
    const calls = await mockCalls(tauriPage);
    expect(calls.some(c => c.cmd === 'create_inquiry')).toBe(false);
  });
});
