import { test as base, expect } from '../fixtures/tauri-mock';
import type { Page } from '@playwright/test';
import { MOCK_MEETING_DETAIL, MOCK_TRANSCRIPTS } from '../fixtures/mock-data';

/** All invoke() calls recorded by the Tauri mock. */
async function mockCalls(page: Page): Promise<Array<{ cmd: string; args: Record<string, unknown> }>> {
  return page.evaluate(
    () => (window as unknown as { __TAURI_MOCK_CALLS__?: Array<{ cmd: string; args: Record<string, unknown> }> }).__TAURI_MOCK_CALLS__ ?? [],
  );
}

// ── Strip lifecycle (recording active on the home view) ──────────────────────

const recordingActive = base.extend({
  tauriPage: async ({ tauriPage }, use) => {
    await tauriPage.addInitScript(`
      const _origInvoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async function(cmd, args, options) {
        if (cmd === 'get_recording_state') {
          return { is_recording: true, is_paused: false, is_active: true,
                   recording_duration: 30, active_duration: 30 };
        }
        if (cmd === 'is_recording') return true;
        return _origInvoke(cmd, args, options);
      };
    `);
    await use(tauriPage);
  },
});

recordingActive.describe('Jot strip (recording active)', () => {
  recordingActive('is visible, Enter adds a chip, digits stay in the input', async ({ tauriPage }) => {
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');

    const strip = tauriPage.getByTestId('jot-strip');
    await expect(strip).toBeVisible({ timeout: 15_000 });

    const input = tauriPage.getByTestId('jot-input');
    // Type character by character (pressSequentially fires real per-key keydown events, unlike fill()
    // which sets the value in one shot) so the embedded digit "2" actually travels through JotStrip's
    // handleKeyDown/stopPropagation path. This proves the digit-toggle lesson: typing "2" edits the
    // note and never toggles anything elsewhere.
    await input.focus();
    await input.pressSequentially('pricing 2 concerns');
    await input.press('Enter');

    const chips = tauriPage.getByTestId('jot-chip');
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toContainText('pricing 2 concerns');
    // Input cleared after commit.
    await expect(input).toHaveValue('');
  });

  recordingActive('edit and delete a chip', async ({ tauriPage }) => {
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');
    await expect(tauriPage.getByTestId('jot-strip')).toBeVisible({ timeout: 15_000 });

    const input = tauriPage.getByTestId('jot-input');
    await input.fill('first note');
    await input.press('Enter');
    await input.fill('second note');
    await input.press('Enter');
    await expect(tauriPage.getByTestId('jot-chip')).toHaveCount(2);

    // Click the first chip's text (the first button in the chip) to edit it.
    await tauriPage.getByTestId('jot-chip').first().getByRole('button').first().click();
    await expect(input).toHaveValue('first note');
    await input.fill('first note edited');
    await input.press('Enter');
    await expect(tauriPage.getByTestId('jot-chip').first()).toContainText('first note edited');
    await expect(tauriPage.getByTestId('jot-chip')).toHaveCount(2);

    // Delete the first chip.
    await tauriPage.getByTestId('jot-chip').first().getByTestId('jot-chip-delete').click();
    await expect(tauriPage.getByTestId('jot-chip')).toHaveCount(1);
    await expect(tauriPage.getByTestId('jot-chip').first()).toContainText('second note');
  });
});

base.describe('Jot strip (idle)', () => {
  base('is not visible when no recording is active', async ({ tauriPage }) => {
    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');
    // Give the app time to settle so a late mount can't create a false negative.
    await tauriPage.waitForTimeout(1_000);
    await expect(tauriPage.getByTestId('jot-strip')).toHaveCount(0);
  });
});

// ── Persist at stop: jots.json written and enhance call triggered ────────────

const stopFlow = base.extend({
  tauriPage: async ({ tauriPage }, use) => {
    await tauriPage.addInitScript(`
      // Seed a completed-recording context and one pending jot before the app boots.
      try {
        sessionStorage.setItem('last_recording_folder_path', 'C:/Users/test/meetings/StopTest');
        sessionStorage.setItem('last_recording_meeting_name', 'Stop Test Meeting');
        sessionStorage.setItem('indexeddb_current_meeting_id', 'meeting-idb-1');
        sessionStorage.setItem('tandem.meetingJots.active', JSON.stringify([
          { id: 'j1', createdAtMs: 1, audioMs: 5000, content: 'pricing concerns', kind: 'text' }
        ]));
      } catch (e) {}

      const _origInvoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async function(cmd, args, options) {
        if (cmd === 'get_transcription_status') {
          return { is_processing: false, chunks_in_queue: 0, last_activity_ms: 99999 };
        }
        if (cmd === 'api_save_transcript') {
          return { meeting_id: 'meeting-stopped' };
        }
        return _origInvoke(cmd, args, options);
      };
    `);
    await use(tauriPage);
  },
});

stopFlow.describe('Recording stop', () => {
  stopFlow('writes jots.json into the meeting folder and triggers the enhance call', async ({ tauriPage }) => {
    // Capture the enhance POST (fetch, not invoke) and answer it so the pipeline completes.
    const enhanceHits: string[] = [];
    await tauriPage.route('**/enhance-notes', async (route) => {
      enhanceHits.push(route.request().postData() || '');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ notes: '# Notes\n\n## pricing concerns\n\nThey flagged pricing.' }),
      });
    });

    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');

    // Wait for the stop handler to be registered on window, then drive it.
    await tauriPage.waitForFunction(() => typeof (window as unknown as { handleRecordingStop?: unknown }).handleRecordingStop === 'function');
    await tauriPage.evaluate(() => (window as unknown as { handleRecordingStop: (b: boolean) => void }).handleRecordingStop(true));

    // jots.json must be saved via save_transcript with the jot content.
    await expect
      .poll(async () => {
        const calls = await mockCalls(tauriPage);
        return calls.some(
          (c) => c.cmd === 'save_transcript' &&
            String((c.args as { filePath?: string }).filePath || '').endsWith('jots.json'),
        );
      }, { timeout: 20_000 })
      .toBe(true);

    const calls = await mockCalls(tauriPage);
    const jotsSave = calls.find(
      (c) => c.cmd === 'save_transcript' &&
        String((c.args as { filePath?: string }).filePath || '').endsWith('jots.json'),
    )!;
    expect(String((jotsSave.args as { filePath?: string }).filePath)).toBe('C:/Users/test/meetings/StopTest/jots.json');
    expect(String((jotsSave.args as { content?: string }).content)).toContain('pricing concerns');

    // The enhance model pass was triggered.
    await expect.poll(() => enhanceHits.length, { timeout: 20_000 }).toBeGreaterThan(0);
  });
});

// ── jots.json write fails: a rescue copy is written to the recordings base dir ──

// Proves the never-lose invariant: when the primary jots.json write throws, the stop path still drops a
// jots-rescue-*.md into the default recordings base dir (a location that always exists), so the jots are
// never silently destroyed by useMeetingJots' recording-started clear.
const rescueOnFailStop = base.extend({
  tauriPage: async ({ tauriPage }, use) => {
    await tauriPage.addInitScript(`
      try {
        sessionStorage.setItem('last_recording_folder_path', 'C:/Users/test/meetings/RescueTest');
        sessionStorage.setItem('last_recording_meeting_name', 'Rescue Test Meeting');
        sessionStorage.setItem('indexeddb_current_meeting_id', 'meeting-idb-3');
        sessionStorage.setItem('tandem.meetingJots.active', JSON.stringify([
          { id: 'jr1', createdAtMs: 1, audioMs: 5000, content: 'must not be lost', kind: 'text' }
        ]));
      } catch (e) {}

      const _origInvoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async function(cmd, args, options) {
        if (cmd === 'get_transcription_status') {
          return { is_processing: false, chunks_in_queue: 0, last_activity_ms: 99999 };
        }
        if (cmd === 'api_save_transcript') {
          return { meeting_id: 'meeting-rescue' };
        }
        // Force the primary jots.json write to fail; let the rescue write (jots-rescue-*.md) through to
        // the base mock so it is recorded in __TAURI_MOCK_CALLS__.
        if (cmd === 'save_transcript') {
          const fp = String((args && args.filePath) || '');
          if (fp.endsWith('jots.json')) throw new Error('disk full (simulated)');
          return _origInvoke(cmd, args, options);
        }
        if (cmd === 'get_recordings_base_dir') {
          return 'C:/Users/test/tandem-recordings';
        }
        return _origInvoke(cmd, args, options);
      };
    `);
    await use(tauriPage);
  },
});

rescueOnFailStop.describe('Recording stop (jots.json write fails)', () => {
  rescueOnFailStop('writes a jots-rescue-*.md to the recordings base dir when jots.json fails', async ({ tauriPage }) => {
    await tauriPage.route('**/enhance-notes', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ notes: '# Notes\n\n## must not be lost\n\nNoted.' }),
      });
    });

    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');

    await tauriPage.waitForFunction(() => typeof (window as unknown as { handleRecordingStop?: unknown }).handleRecordingStop === 'function');
    await tauriPage.evaluate(() => (window as unknown as { handleRecordingStop: (b: boolean) => void }).handleRecordingStop(true));

    // A rescue save_transcript into the recordings base dir must fire after the jots.json write throws.
    await expect
      .poll(async () => {
        const calls = await mockCalls(tauriPage);
        return calls.some(
          (c) => c.cmd === 'save_transcript' &&
            /jots-rescue-\d{8}-\d{6}\.md$/.test(String((c.args as { filePath?: string }).filePath || '')),
        );
      }, { timeout: 20_000 })
      .toBe(true);

    const calls = await mockCalls(tauriPage);
    const rescue = calls.find(
      (c) => c.cmd === 'save_transcript' &&
        /jots-rescue-\d{8}-\d{6}\.md$/.test(String((c.args as { filePath?: string }).filePath || '')),
    )!;
    expect(String((rescue.args as { filePath?: string }).filePath)).toContain('C:/Users/test/tandem-recordings');
    expect(String((rescue.args as { content?: string }).content)).toContain('must not be lost');
  });
});

// ── Solo -> Meeting mid-call switch: jots flagged after the switch must survive to jots.json ──

// Reproduces the round-1 regression: recording began in Solo, the user switched the dropdown to Meeting
// mid-call (which mounts the jot strip), flagged jots, then stopped. The old fix pinned the mode at START
// (='solo') and forced capturedJots=[] at stop, silently discarding those jots. With the pin removed the
// store is read unconditionally, so the jots are written. A stale 'currentRecordingMode'='solo' key is
// seeded here on purpose to prove it can no longer suppress the save.
const soloToMeetingStop = base.extend({
  tauriPage: async ({ tauriPage }, use) => {
    await tauriPage.addInitScript(`
      try {
        sessionStorage.setItem('last_recording_folder_path', 'C:/Users/test/meetings/SoloSwitch');
        sessionStorage.setItem('last_recording_meeting_name', 'Solo Switch Meeting');
        sessionStorage.setItem('indexeddb_current_meeting_id', 'meeting-idb-2');
        // A stale start-time pin that the removed code would have honored to drop the jots.
        sessionStorage.setItem('tandem.currentRecordingMode', 'solo');
        sessionStorage.setItem('tandem.meetingJots.active', JSON.stringify([
          { id: 'js1', createdAtMs: 1, audioMs: 12000, content: 'switched to meeting mid call', kind: 'text' }
        ]));
      } catch (e) {}

      const _origInvoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async function(cmd, args, options) {
        if (cmd === 'get_transcription_status') {
          return { is_processing: false, chunks_in_queue: 0, last_activity_ms: 99999 };
        }
        if (cmd === 'api_save_transcript') {
          return { meeting_id: 'meeting-solo-switch' };
        }
        return _origInvoke(cmd, args, options);
      };
    `);
    await use(tauriPage);
  },
});

soloToMeetingStop.describe('Recording stop (Solo -> Meeting switch)', () => {
  soloToMeetingStop('jots flagged after switching to Meeting survive to jots.json despite a stale solo pin', async ({ tauriPage }) => {
    const enhanceHits: string[] = [];
    await tauriPage.route('**/enhance-notes', async (route) => {
      enhanceHits.push(route.request().postData() || '');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ notes: '# Notes\n\n## switched to meeting mid call\n\nNoted.' }),
      });
    });

    await tauriPage.goto('/');
    await tauriPage.waitForLoadState('networkidle');

    await tauriPage.waitForFunction(() => typeof (window as unknown as { handleRecordingStop?: unknown }).handleRecordingStop === 'function');
    await tauriPage.evaluate(() => (window as unknown as { handleRecordingStop: (b: boolean) => void }).handleRecordingStop(true));

    await expect
      .poll(async () => {
        const calls = await mockCalls(tauriPage);
        return calls.some(
          (c) => c.cmd === 'save_transcript' &&
            String((c.args as { filePath?: string }).filePath || '').endsWith('jots.json'),
        );
      }, { timeout: 20_000 })
      .toBe(true);

    const calls = await mockCalls(tauriPage);
    const jotsSave = calls.find(
      (c) => c.cmd === 'save_transcript' &&
        String((c.args as { filePath?: string }).filePath || '').endsWith('jots.json'),
    )!;
    expect(String((jotsSave.args as { filePath?: string }).filePath)).toBe('C:/Users/test/meetings/SoloSwitch/jots.json');
    expect(String((jotsSave.args as { content?: string }).content)).toContain('switched to meeting mid call');
  });
});

// ── Notes render on meeting-details, with an [unverified] marker ─────────────

const ENHANCED_MD = [
  '# Notes',
  '',
  '## pricing concerns',
  '',
  'The client raised pricing. "we cannot verify this fabricated line" [unverified] came up in the call.',
].join('\n');

const withNotes = base.extend({
  tauriPage: async ({ tauriPage }, use) => {
    await tauriPage.addInitScript(`
      const _origInvoke = window.__TAURI_INTERNALS__.invoke;
      const _md = ${JSON.stringify(ENHANCED_MD)};
      const _jots = ${JSON.stringify(JSON.stringify({ version: 1, jots: [{ id: 'j1', createdAtMs: 1, audioMs: 5000, content: 'pricing concerns', kind: 'text' }] }))};
      window.__TAURI_INTERNALS__.invoke = async function(cmd, args, options) {
        if (cmd === 'api_get_meeting_metadata' && args && args.meetingId === 'meeting-1') {
          return ${JSON.stringify({ ...MOCK_MEETING_DETAIL, folder_path: 'C:/Users/test/meetings/NotesMeeting' })};
        }
        if (cmd === 'api_get_meeting_transcripts' && args && args.meetingId === 'meeting-1') {
          return ${JSON.stringify(MOCK_TRANSCRIPTS)};
        }
        if (cmd === 'read_file_if_exists') {
          const p = String((args && args.path) || '');
          if (p.endsWith('enhanced-notes.md')) return _md;
          if (p.endsWith('jots.json')) return _jots;
          return null;
        }
        if (cmd === 'load_screenshots_json' || cmd === 'load_clipboard_json') return [];
        return _origInvoke(cmd, args, options);
      };
    `);
    await use(tauriPage);
  },
});

withNotes.describe('Meeting details notes', () => {
  withNotes('renders enhanced notes with a distinct [unverified] marker', async ({ tauriPage }) => {
    await tauriPage.goto('/meeting-details?id=meeting-1');
    await tauriPage.waitForLoadState('networkidle');

    const section = tauriPage.getByTestId('meeting-notes-section');
    await expect(section).toBeVisible({ timeout: 15_000 });
    await expect(tauriPage.getByTestId('notes-markdown')).toContainText('pricing concerns');

    const marker = tauriPage.getByTestId('unverified-marker');
    await expect(marker).toBeVisible();
    await expect(marker).toHaveText('unverified');

    // The Regenerate control is available because jots.json exists.
    await expect(tauriPage.getByTestId('regenerate-notes')).toBeVisible();
  });

  withNotes('clicking Regenerate re-runs the enhance pass from jots.json and the full transcript', async ({ tauriPage }) => {
    const enhanceHits: string[] = [];
    await tauriPage.route('**/enhance-notes', async (route) => {
      enhanceHits.push(route.request().postData() || '');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ notes: '# Notes\n\n## pricing concerns\n\nRegenerated.' }),
      });
    });

    await tauriPage.goto('/meeting-details?id=meeting-1');
    await tauriPage.waitForLoadState('networkidle');

    const regen = tauriPage.getByTestId('regenerate-notes');
    await expect(regen).toBeVisible({ timeout: 15_000 });
    await regen.click();

    // The enhance model pass fired, and the prompt was built from the saved jot (proving jots.json was
    // read) plus the mocked transcript (proving loadAllTranscripts/collectAllTranscripts ran).
    await expect.poll(() => enhanceHits.length, { timeout: 20_000 }).toBeGreaterThan(0);
    expect(enhanceHits[0]).toContain('pricing concerns');
    expect(enhanceHits[0]).toContain('welcome to the standup');

    // A save_transcript for enhanced-notes.md was issued by the regenerate write.
    await expect
      .poll(async () => {
        const calls = await mockCalls(tauriPage);
        return calls.some(
          (c) => c.cmd === 'save_transcript' &&
            String((c.args as { filePath?: string }).filePath || '').endsWith('enhanced-notes.md'),
        );
      }, { timeout: 20_000 })
      .toBe(true);
  });
});
