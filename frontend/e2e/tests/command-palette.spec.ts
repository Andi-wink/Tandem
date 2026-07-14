import { test as base, expect } from '../fixtures/tauri-mock';

const test = base;

// The default mock returns three meetings (Team Standup, Product Review, Sprint Planning) with no
// folder_path, and api_search_transcripts returns []. So a title query like "Product" surfaces a
// meeting row purely from the local title match: no extra mocking needed.
test.describe('Command palette meeting search (Ctrl+K)', () => {
  test.beforeEach(async ({ tauriPage }) => {
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');
    await expect(tauriPage.getByText('Welcome to Tandem!')).toBeVisible({ timeout: 15_000 });
  });

  test('typing a query surfaces a matching meeting; Enter navigates to its details', async ({ tauriPage }) => {
    await tauriPage.keyboard.press('Control+k');

    const input = tauriPage.getByPlaceholder('Search meetings, projects and commands…');
    await expect(input).toBeVisible({ timeout: 5_000 });

    await input.fill('Product');

    // The Meetings group renders a row for the title match.
    const row = tauriPage.getByTestId('palette-meeting-row').filter({ hasText: 'Product Review' });
    await expect(row).toBeVisible({ timeout: 5_000 });

    // Enter on the (auto-selected, only) meeting match navigates to its details page.
    await input.press('Enter');
    await expect(tauriPage).toHaveURL(/meeting-details\?id=meeting-2/, { timeout: 10_000 });
  });

  test('does not search meetings for a 2-char query', async ({ tauriPage }) => {
    await tauriPage.keyboard.press('Control+k');
    const input = tauriPage.getByPlaceholder('Search meetings, projects and commands…');
    await expect(input).toBeVisible({ timeout: 5_000 });

    await input.fill('Pr');
    // Below the 3-char threshold: no meeting rows.
    await expect(tauriPage.getByTestId('palette-meeting-row')).toHaveCount(0);
  });
});

// Two meetings that share the exact same title (a very plausible collision for "Discovery Call").
// The cmdk row value must be keyed by the meeting id, not the title, or the two rows collide onto a
// single shared selection state and the second is unreachable by keyboard.
const DUP_MEETINGS = [
  { id: 'meeting-dup-1', title: 'Discovery Call' },
  { id: 'meeting-dup-2', title: 'Discovery Call' },
];

const dupTest = base.extend({
  tauriPage: async ({ tauriPage }, use) => {
    await tauriPage.addInitScript(`
      const _originalInvoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async function(cmd, args, options) {
        if (cmd === 'api_get_meetings') return ${JSON.stringify(DUP_MEETINGS)};
        return _originalInvoke(cmd, args, options);
      };
    `);
    await use(tauriPage);
  },
});

dupTest.describe('Command palette duplicate-title meetings', () => {
  dupTest.beforeEach(async ({ tauriPage }) => {
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');
    await expect(tauriPage.getByText('Welcome to Tandem!')).toBeVisible({ timeout: 15_000 });
  });

  dupTest('two same-title rows are individually selectable and reachable by keyboard', async ({ tauriPage }) => {
    await tauriPage.keyboard.press('Control+k');
    const input = tauriPage.getByPlaceholder('Search meetings, projects and commands…');
    await expect(input).toBeVisible({ timeout: 5_000 });

    await input.fill('Discovery');

    const rows = tauriPage.getByTestId('palette-meeting-row');
    await expect(rows).toHaveCount(2, { timeout: 5_000 });

    // Exactly one row is selected at a time (not both), proving the rows carry distinct cmdk values.
    await expect(tauriPage.locator('[data-testid="palette-meeting-row"][data-selected="true"]')).toHaveCount(1);

    // ArrowDown reaches the second duplicate, and Enter navigates to it (not the first in DOM order).
    await input.press('ArrowDown');
    await input.press('Enter');
    await expect(tauriPage).toHaveURL(/meeting-details\?id=meeting-dup-2/, { timeout: 10_000 });
  });
});
