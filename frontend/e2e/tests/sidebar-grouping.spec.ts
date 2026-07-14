import { test as base, expect } from '../fixtures/tauri-mock';

// Two meetings filed under Acme (project_list returns Acme at this path) plus one unfiled, so the
// "By project" view yields an "Acme" group (count 2) and an "Unfiled" group (count 1).
const GROUPED_MEETINGS = [
  { id: 'meeting-1', title: 'Acme Kickoff', folder_path: 'D:/Dev-projects/Client_projects/Acme/.tandem/Acme Kickoff' },
  { id: 'meeting-2', title: 'Acme Review', folder_path: 'D:/Dev-projects/Client_projects/Acme/.tandem/Acme Review' },
  { id: 'meeting-3', title: 'Loose Note', folder_path: null },
];

const test = base.extend({
  tauriPage: async ({ tauriPage }, use) => {
    await tauriPage.addInitScript(`
      const _originalInvoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async function(cmd, args, options) {
        if (cmd === 'api_get_meetings') {
          return ${JSON.stringify(GROUPED_MEETINGS)};
        }
        return _originalInvoke(cmd, args, options);
      };
    `);
    await use(tauriPage);
  },
});

async function expandSidebar(page: import('@playwright/test').Page) {
  const expandBtn = page.locator('button[style*="translateX(50%)"]').first();
  await expandBtn.click();
  await expect(page.getByText('Home', { exact: true })).toBeVisible({ timeout: 5_000 });
}

test.describe('Sidebar project grouping', () => {
  test('toggling to By project renders project group headers with counts', async ({ tauriPage }) => {
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');
    await expandSidebar(tauriPage);

    await tauriPage.getByTestId('sidebar-view-by-project').click();

    const acme = tauriPage.getByTestId('sidebar-group-header').filter({ hasText: 'Acme' });
    const unfiled = tauriPage.getByTestId('sidebar-group-header').filter({ hasText: 'Unfiled' });
    await expect(acme).toBeVisible({ timeout: 5_000 });
    await expect(unfiled).toBeVisible();
    // Acme group shows a count of 2.
    await expect(acme).toContainText('2');

    // Meetings render under their group (scoped to the sidebar to avoid the agenda's own copy).
    const groups = tauriPage.getByTestId('sidebar-group');
    await expect(groups.getByText('Acme Kickoff')).toBeVisible();
    await expect(groups.getByText('Loose Note')).toBeVisible();
  });

  test('collapsing a group persists across reload, along with the view mode', async ({ tauriPage }) => {
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');
    await expandSidebar(tauriPage);

    await tauriPage.getByTestId('sidebar-view-by-project').click();

    const acme = tauriPage.getByTestId('sidebar-group-header').filter({ hasText: 'Acme' });
    await expect(acme).toBeVisible({ timeout: 5_000 });
    const groups = tauriPage.getByTestId('sidebar-group');
    await expect(groups.getByText('Acme Kickoff')).toBeVisible();

    // Collapse the Acme group: its meetings disappear from the sidebar.
    await acme.click();
    await expect(groups.getByText('Acme Kickoff')).toHaveCount(0);

    // Reload: the mode is still "By project" and Acme stays collapsed.
    await tauriPage.reload();
    await tauriPage.waitForLoadState('networkidle');
    await expandSidebar(tauriPage);

    const acmeAfter = tauriPage.getByTestId('sidebar-group-header').filter({ hasText: 'Acme' });
    await expect(acmeAfter).toBeVisible({ timeout: 5_000 });
    // Still collapsed after reload (view mode persisted, so the group is rendered but collapsed).
    await expect(tauriPage.getByTestId('sidebar-group').getByText('Acme Kickoff')).toHaveCount(0);
  });
});
