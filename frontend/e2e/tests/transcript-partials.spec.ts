import { test, expect } from '../fixtures/tauri-mock';
import type { Page } from '@playwright/test';

/**
 * E2E for the Scribe Realtime volatile-tail layer (Phase 1, design decision D4).
 *
 * Drives the dev/test emitter (`window.__tandemDevTranscript`, installed in dev by
 * TranscriptContext) which fires synthetic `transcript-partial` / `transcript-update`
 * events over the SAME Tauri event bus (the mock's `plugin:event|emit`) the Rust
 * engine will use in Phase 2. Asserts:
 *   1. a partial renders a muted "live" tail
 *   2. successive partials update that tail IN PLACE (still one tail element)
 *   3. a committed `transcript-update` replaces the tail with a normal segment
 */

async function emitPartial(page: Page, source: string, text: string, session_seq: number) {
  await page.evaluate(
    ({ source, text, session_seq }) =>
      (window as unknown as { __tandemDevTranscript: { emitPartial: (p: unknown) => Promise<void> } })
        .__tandemDevTranscript.emitPartial({ source, text, session_seq }),
    { source, text, session_seq }
  );
}

async function emitCommitted(page: Page, source: string, text: string, sequence_id: number) {
  await page.evaluate(
    ({ source, text, sequence_id }) =>
      (window as unknown as { __tandemDevTranscript: { emitCommitted: (p: unknown) => Promise<void> } })
        .__tandemDevTranscript.emitCommitted({ source, text, sequence_id }),
    { source, text, sequence_id }
  );
}

test.describe('Transcript volatile partial tail', () => {
  test('renders a live tail, updates it in place, then a commit replaces it', async ({ tauriPage }) => {
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');

    // App is up (empty transcript state visible).
    await expect(tauriPage.getByText('Welcome to Tandem!')).toBeVisible({ timeout: 15_000 });

    // The dev emitter is installed by TranscriptContext (dev/e2e only).
    await expect
      .poll(async () =>
        tauriPage.evaluate(
          () => typeof (window as unknown as { __tandemDevTranscript?: unknown }).__tandemDevTranscript
        ),
        { timeout: 15_000 }
      )
      .toBe('object');

    const tail = tauriPage.getByTestId('live-tail-Local');

    // 1) First partial → muted live tail appears with the partial text.
    await emitPartial(tauriPage, 'Local', 'quarterly revenue looked', 1);
    await expect(tail).toBeVisible({ timeout: 10_000 });
    await expect(tail).toContainText('quarterly revenue looked');

    // 2) Growing partials replace the tail IN PLACE — still exactly one tail element.
    await emitPartial(tauriPage, 'Local', 'quarterly revenue looked strong this', 2);
    await expect(tail).toContainText('quarterly revenue looked strong this');
    await emitPartial(tauriPage, 'Local', 'quarterly revenue looked strong this period', 3);
    await expect(tail).toContainText('quarterly revenue looked strong this period');
    await expect(tauriPage.getByTestId('live-tail-Local')).toHaveCount(1);

    // 3) Committed segment supersedes the tail: tail is removed, committed text renders.
    await emitCommitted(tauriPage, 'Local', 'Quarterly revenue looked strong this period.', 10);
    await expect(tauriPage.getByTestId('live-tail-Local')).toHaveCount(0, { timeout: 10_000 });
    await expect(
      tauriPage.getByText('Quarterly revenue looked strong this period.')
    ).toBeVisible();
  });
});
