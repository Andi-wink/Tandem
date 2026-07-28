import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  appendFeedEntry,
  buildScreenshotFeedEntry,
  buildClipboardFeedEntry,
  buildSessionFolderName,
  ensureLoopState,
  tandemDirFor,
  sessionScopeFolder,
  sanitizeSessionName,
  slugify,
  generateLiveScreenshotsMarkdown,
  allTasksDone,
  maybeArchiveSessionFolder,
  FeedEntry,
} from './handoffService';
import { ScreenshotData, ClipboardData } from '@/types';

const mockInvoke = vi.mocked(invoke);

const mkScreenshot = (overrides: Partial<ScreenshotData> = {}): ScreenshotData => ({
  id: 'ss-1',
  file_path: 'D:\\Dev-projects\\Tandem\\screenshot.png',
  thumbnail_base64: '',
  timestamp: '10:00',
  recording_elapsed_secs: 42,
  width: 1920,
  height: 1080,
  capture_mode: 'fullscreen',
  ...overrides,
});

describe('buildScreenshotFeedEntry', () => {
  it('normalizes Windows backslash paths to forward slashes for markdown embed', () => {
    const entry = buildScreenshotFeedEntry(mkScreenshot());
    expect(entry.body).toContain('D:/Dev-projects/Tandem/screenshot.png');
    expect(entry.body).not.toContain('\\');
  });

  it('embeds a markdown image reference so Claude Code can view it', () => {
    const entry = buildScreenshotFeedEntry(mkScreenshot());
    expect(entry.body).toMatch(/!\[screenshot\]\(.+\)/);
  });

  it('labels region vs fullscreen and includes dimensions', () => {
    const region = buildScreenshotFeedEntry(mkScreenshot({ capture_mode: 'region' }));
    expect(region.body).toContain('Region screenshot — 1920×1080');
    const full = buildScreenshotFeedEntry(mkScreenshot({ capture_mode: 'fullscreen' }));
    expect(full.body).toContain('Fullscreen screenshot — 1920×1080');
  });

  it('keeps the original backslash path in meta.file (absolute path for Read tool)', () => {
    const entry = buildScreenshotFeedEntry(mkScreenshot());
    expect(entry.meta?.file).toBe('D:\\Dev-projects\\Tandem\\screenshot.png');
  });

  it('handles missing recording_elapsed_secs', () => {
    const entry = buildScreenshotFeedEntry(mkScreenshot({ recording_elapsed_secs: undefined }));
    expect(entry.meta?.recording_elapsed_secs).toBe('n/a');
  });
});

describe('buildClipboardFeedEntry', () => {
  it('uses the text content as body for text clips', () => {
    const clip: ClipboardData = {
      id: 'c1',
      content_type: 'text',
      text: 'const x = 42;',
      timestamp: '10:00',
    };
    const entry = buildClipboardFeedEntry(clip);
    expect(entry.body).toBe('const x = 42;');
    expect(entry.meta?.content_type).toBe('text');
  });

  it('truncates long text previews to 400 chars', () => {
    const clip: ClipboardData = {
      id: 'c1',
      content_type: 'text',
      text: 'x'.repeat(1000),
      timestamp: '10:00',
    };
    const entry = buildClipboardFeedEntry(clip);
    expect(entry.body.length).toBe(400);
  });

  it('uses a placeholder with dimensions for image clips', () => {
    const clip: ClipboardData = {
      id: 'c1',
      content_type: 'image',
      file_path: '/path/clip.png',
      width: 640,
      height: 480,
      timestamp: '10:00',
    };
    const entry = buildClipboardFeedEntry(clip);
    expect(entry.body).toBe('[image 640×480]');
    expect(entry.meta?.content_type).toBe('image');
    expect(entry.meta?.file).toBe('/path/clip.png');
  });
});

describe('appendFeedEntry', () => {
  const projectDir = 'D:\\Dev-projects\\Tandem';
  const entry: FeedEntry = {
    type: 'intent',
    timestamp: new Date('2026-04-15T10:00:00Z'),
    body: 'Fix login redirect',
    meta: { confidence: '0.82' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates the feed with "# Tandem Feed" header when file does not exist', async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'read_file_if_exists') return null;
      if (cmd === 'save_transcript') return undefined;
      throw new Error('unexpected');
    });

    await appendFeedEntry(projectDir, entry);

    const saveCall = mockInvoke.mock.calls.find(c => c[0] === 'save_transcript');
    expect(saveCall).toBeDefined();
    const payload = saveCall![1] as { filePath: string; content: string };
    expect(payload.filePath).toContain('.tandem');
    expect(payload.filePath).toContain('feed.md');
    expect(payload.content).toMatch(/^# Tandem Feed/);
    expect(payload.content).toContain('2026-04-15T10:00:00.000Z — intent');
    expect(payload.content).toContain('Fix login redirect');
    expect(payload.content).toContain('- confidence: 0.82');
  });

  it('appends to existing feed without duplicating the header', async () => {
    const existing = '# Tandem Feed\n\n## 2026-04-15T09:00:00.000Z — session_start\nSession active on Tandem\n';
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'read_file_if_exists') return existing;
      if (cmd === 'save_transcript') return undefined;
      throw new Error('unexpected');
    });

    await appendFeedEntry(projectDir, entry);

    const saveCall = mockInvoke.mock.calls.find(c => c[0] === 'save_transcript');
    const payload = saveCall![1] as { content: string };
    // one header, both entries present
    expect(payload.content.match(/# Tandem Feed/g)?.length).toBe(1);
    expect(payload.content).toContain('session_start');
    expect(payload.content).toContain('intent');
    expect(payload.content).toContain('Fix login redirect');
  });

  it('picks the Windows path separator for Windows-style project dirs', async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'read_file_if_exists') return null;
      return undefined;
    });

    await appendFeedEntry('D:\\Dev\\X', entry);

    const saveCall = mockInvoke.mock.calls.find(c => c[0] === 'save_transcript');
    expect((saveCall![1] as { filePath: string }).filePath).toBe('D:\\Dev\\X\\.tandem\\feed.md');
  });

  it('picks the forward-slash separator for POSIX-style project dirs', async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'read_file_if_exists') return null;
      return undefined;
    });

    await appendFeedEntry('/home/u/X', entry);

    const saveCall = mockInvoke.mock.calls.find(c => c[0] === 'save_transcript');
    expect((saveCall![1] as { filePath: string }).filePath).toBe('/home/u/X/.tandem/feed.md');
  });
});

describe('tandemDirFor (session folder)', () => {
  it('returns .tandem root when no session folder is given', () => {
    expect(tandemDirFor('D:\\Proj')).toBe('D:\\Proj\\.tandem');
    expect(tandemDirFor('/home/u/p')).toBe('/home/u/p/.tandem');
  });

  it('nests under the session folder when one is given', () => {
    expect(tandemDirFor('D:\\Proj', 'Meeting_2026-05-08_14-30-15')).toBe(
      'D:\\Proj\\.tandem\\Meeting_2026-05-08_14-30-15',
    );
    expect(tandemDirFor('/home/u/p', 'Meeting_2026-05-08_14-30-15')).toBe(
      '/home/u/p/.tandem/Meeting_2026-05-08_14-30-15',
    );
  });

  it('treats null/undefined sessionFolder as no session folder', () => {
    expect(tandemDirFor('D:\\Proj', null)).toBe('D:\\Proj\\.tandem');
    expect(tandemDirFor('D:\\Proj', undefined)).toBe('D:\\Proj\\.tandem');
  });

  // F061: virtual sub-projects file under sessions/<session_id>, passed as a
  // multi-segment sessionFolder. Separators must be normalized to the project's
  // own, never mixed.
  it('re-splits a multi-segment (sessions/<id>) folder onto the project separator', () => {
    expect(tandemDirFor('D:\\Proj', 'sessions/abc-123')).toBe(
      'D:\\Proj\\.tandem\\sessions\\abc-123',
    );
    expect(tandemDirFor('/home/u/p', 'sessions/abc-123')).toBe(
      '/home/u/p/.tandem/sessions/abc-123',
    );
  });

  it('sessionScopeFolder falls back to the shortid alone when no display name and no timestamp', () => {
    expect(sessionScopeFolder('abc-123')).toBe('sessions/abc-123');
    expect(tandemDirFor('D:\\Proj', sessionScopeFolder('sid'))).toBe(
      'D:\\Proj\\.tandem\\sessions\\sid',
    );
  });
});

// ─── F061: human-readable `HH.MM, DD.MM - <name>` session folder ────────────
describe('sessionScopeFolder (human-readable timestamped folder)', () => {
  // Build the LOCAL-time expected `HH.MM, DD.MM` from an instant so these
  // assertions stay independent of the machine's timezone. `createdAt` is a
  // SQLite UTC wall-clock string ("YYYY-MM-DD HH:MM:SS").
  const pad = (n: number) => String(n).padStart(2, '0');
  const stampOf = (utc: string) => {
    const d = new Date(`${utc.replace(' ', 'T')}Z`);
    return `${pad(d.getHours())}.${pad(d.getMinutes())}, ${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
  };

  it('builds `sessions/HH.MM, DD.MM - <Session name>` from created_at (the documented example)', () => {
    const createdAt = '2026-07-23 11:41:00'; // UTC; 12:41 UK local (BST)
    expect(
      sessionScopeFolder('8effa465-9ffe-44c0-91d6-fc53f91b5687', 'Mock up solo mode project hub', createdAt),
    ).toBe(`sessions/${stampOf(createdAt)} - Mock up solo mode project hub`);
  });

  it('keeps spaces and letter case in the session name (human readable, not slugified)', () => {
    const createdAt = '2026-01-05 09:03:00';
    expect(sessionScopeFolder('deadbeef-1111', 'Fix Login Redirect', createdAt)).toBe(
      `sessions/${stampOf(createdAt)} - Fix Login Redirect`,
    );
  });

  it('accepts a Date for created_at as well as a string', () => {
    const when = new Date('2026-07-23T11:41:00Z');
    expect(sessionScopeFolder('abc12345', 'Notes', when)).toBe(
      `sessions/${pad(when.getHours())}.${pad(when.getMinutes())}, ${pad(when.getDate())}.${pad(when.getMonth() + 1)} - Notes`,
    );
  });

  it('replaces Windows-illegal characters in the name with a hyphen', () => {
    const createdAt = '2026-07-23 11:41:00';
    expect(sessionScopeFolder('abc12345', 'a/b\\c:d*e?f"g<h>i|j', createdAt)).toBe(
      `sessions/${stampOf(createdAt)} - a-b-c-d-e-f-g-h-i-j`,
    );
  });

  it('collapses whitespace and caps the name at ~60 chars (no trailing dot/space)', () => {
    const createdAt = '2026-07-23 11:41:00';
    const long = 'A'.repeat(80);
    const folder = sessionScopeFolder('abc12345', long, createdAt);
    const namePart = folder.split(' - ')[1];
    expect(namePart.length).toBe(60);
    expect(namePart.endsWith('.')).toBe(false);
    expect(namePart.endsWith(' ')).toBe(false);
  });

  it('falls back to the 8-char short session id when the name is empty / all-illegal', () => {
    const createdAt = '2026-07-23 11:41:00';
    expect(sessionScopeFolder('8effa465-xxxx', '   ', createdAt)).toBe(
      `sessions/${stampOf(createdAt)} - 8effa465`,
    );
    // Illegal-only names sanitize to hyphens, not empty, so they survive as-is;
    // a truly empty name (whitespace) is what triggers the shortid fallback.
    expect(sessionScopeFolder('8effa465-xxxx', '', createdAt)).toBe(
      `sessions/${stampOf(createdAt)} - 8effa465`,
    );
  });

  it('omits the timestamp prefix (deterministic) when created_at is missing/unparseable', () => {
    expect(sessionScopeFolder('abc12345', 'My Session')).toBe('sessions/My Session');
    expect(sessionScopeFolder('abc12345', 'My Session', 'not-a-date')).toBe('sessions/My Session');
    expect(sessionScopeFolder('abc12345', 'My Session', '')).toBe('sessions/My Session');
  });

  it('produces a folder tandemDirFor nests correctly (name has no path separators)', () => {
    const createdAt = '2026-07-23 11:41:00';
    const folder = sessionScopeFolder('abc12345', 'Mock up solo mode project hub', createdAt);
    expect(tandemDirFor('D:\\Proj', folder)).toBe(
      `D:\\Proj\\.tandem\\sessions\\${stampOf(createdAt)} - Mock up solo mode project hub`,
    );
  });
});

describe('sanitizeSessionName', () => {
  it('keeps spaces and case, replaces illegal chars, trims and collapses whitespace', () => {
    expect(sanitizeSessionName('  Fix   Login  ')).toBe('Fix Login');
    expect(sanitizeSessionName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });

  it('returns empty string for empty / whitespace-only input', () => {
    expect(sanitizeSessionName('')).toBe('');
    expect(sanitizeSessionName('   ')).toBe('');
  });

  it('caps at 60 chars and strips a trailing dot/space', () => {
    expect(sanitizeSessionName('A'.repeat(80)).length).toBe(60);
    expect(sanitizeSessionName('My session name...').endsWith('.')).toBe(false);
  });
});

describe('slugify', () => {
  it('lowercases, collapses non-alphanumeric runs to single hyphens, trims edges', () => {
    expect(slugify('Mock up solo mode project hub layout')).toBe(
      'mock-up-solo-mode-project-hub-layout',
    );
    expect(slugify('  Hello,   World!!  ')).toBe('hello-world');
    expect(slugify('a/b\\c:d')).toBe('a-b-c-d');
  });

  it('returns empty string for empty / all-punctuation input', () => {
    expect(slugify('')).toBe('');
    expect(slugify('!!! ???')).toBe('');
  });

  it('caps at ~40 chars and re-trims a trailing hyphen left at the cut', () => {
    // Groups of 4 put a hyphen at index 39, so the raw 40-char slice ends in a
    // hyphen that must be re-trimmed: 'aaaa-bbbb-cccc-dddd-eeee-ffff-gggg-hhhh-'.
    const out = slugify('aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii');
    expect(out).toBe('aaaa-bbbb-cccc-dddd-eeee-ffff-gggg-hhhh');
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith('-')).toBe(false);
  });
});

describe('generateLiveScreenshotsMarkdown (F061 session-scoped refs)', () => {
  const ss: ScreenshotData = {
    id: 'ss-1',
    file_path: 'D:\\P\\.tandem\\sessions\\slug-8effa465\\screenshots\\shot.png',
    thumbnail_base64: '',
    timestamp: '10:00',
    recording_elapsed_secs: 5,
    width: 800,
    height: 600,
    capture_mode: 'fullscreen',
  };

  it('references co-located screenshots/ for a virtual sub-project session folder', () => {
    const md = generateLiveScreenshotsMarkdown([ss], 'sessions/slug-8effa465');
    expect(md).toContain('File: screenshots/shot.png');
    expect(md).not.toContain('.tandem/screenshots/shot.png');
  });

  it('keeps the shared .tandem/screenshots/ ref for plain projects', () => {
    const md = generateLiveScreenshotsMarkdown([ss], null);
    expect(md).toContain('File: .tandem/screenshots/shot.png');
    const md2 = generateLiveScreenshotsMarkdown([ss], 'MyMeeting_2026-05-08_14-30-15');
    expect(md2).toContain('File: .tandem/screenshots/shot.png');
  });
});

describe('buildSessionFolderName', () => {
  const fixedDate = new Date('2026-05-08T14:30:15');

  it('combines sanitized title with date_time stamp', () => {
    expect(buildSessionFolderName('Discovery Call', fixedDate)).toMatch(
      /^Discovery Call_2026-05-08_14-30-15$/,
    );
  });

  it('replaces filesystem-unsafe characters', () => {
    const name = buildSessionFolderName('a/b\\c:d*e?f"g<h>i|j', fixedDate);
    expect(name).toBe('a-b-c-d-e-f-g-h-i-j_2026-05-08_14-30-15');
  });

  it('falls back to "Solo" prefix when title is empty or whitespace', () => {
    expect(buildSessionFolderName('', fixedDate)).toBe('Solo_2026-05-08_14-30-15');
    expect(buildSessionFolderName('   ', fixedDate)).toBe('Solo_2026-05-08_14-30-15');
  });

  it('truncates very long titles to 80 chars', () => {
    const long = 'A'.repeat(200);
    const name = buildSessionFolderName(long, fixedDate);
    const prefix = name.split('_')[0];
    expect(prefix.length).toBe(80);
  });
});

describe('appendFeedEntry with session folder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes feed.md inside the session subfolder when given', async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'read_file_if_exists') return null;
      return undefined;
    });

    const entry: FeedEntry = {
      type: 'intent',
      timestamp: new Date('2026-05-08T14:30:15Z'),
      body: 'Refactor login',
    };
    await appendFeedEntry('D:\\Proj', entry, 'MyMeeting_2026-05-08_14-30-15');

    const saveCall = mockInvoke.mock.calls.find(c => c[0] === 'save_transcript');
    expect((saveCall![1] as { filePath: string }).filePath).toBe(
      'D:\\Proj\\.tandem\\MyMeeting_2026-05-08_14-30-15\\feed.md',
    );
  });
});

describe('ensureLoopState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes {"last_processed_line": 0} when the file does not exist', async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'read_file_if_exists') return null;
      if (cmd === 'save_transcript') return undefined;
      return undefined;
    });

    await ensureLoopState('D:\\Proj');

    const saveCall = mockInvoke.mock.calls.find(c => c[0] === 'save_transcript');
    expect(saveCall).toBeDefined();
    const payload = saveCall![1] as { filePath: string; content: string };
    expect(payload.filePath).toBe('D:\\Proj\\.tandem\\loop-state.json');
    const parsed = JSON.parse(payload.content);
    expect(parsed).toEqual({ last_processed_line: 0 });
  });

  it('is idempotent when a loop-state.json already exists with content', async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'read_file_if_exists') return '{"last_processed_line": 247}';
      return undefined;
    });

    await ensureLoopState('D:\\Proj');

    const saveCalls = mockInvoke.mock.calls.filter(c => c[0] === 'save_transcript');
    expect(saveCalls.length).toBe(0);
  });

  it('re-seeds when an existing loop-state.json is empty (self-healing)', async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'read_file_if_exists') return '   ';
      if (cmd === 'save_transcript') return undefined;
      return undefined;
    });

    await ensureLoopState('D:\\Proj');

    const saveCalls = mockInvoke.mock.calls.filter(c => c[0] === 'save_transcript');
    expect(saveCalls.length).toBe(1);
  });
});

// ─── F061: session archival ─────────────────────────────────────────────────

describe('allTasksDone', () => {
  it('is false when the tasks dir never existed (null listing)', () => {
    expect(allTasksDone(null)).toBe(false);
  });

  it('is true when the tasks dir exists but holds no .md task files', () => {
    expect(allTasksDone([])).toBe(true);
    // A stray non-task file does not count as pending work.
    expect(allTasksDone(['.gitkeep', 'notes.txt'])).toBe(true);
  });

  it('is false while any task-*.md file remains', () => {
    expect(allTasksDone(['task-1712345678.md'])).toBe(false);
    expect(allTasksDone(['task-a.md', 'task-b.md'])).toBe(false);
    expect(allTasksDone(['done.txt', 'task-2.md'])).toBe(false);
  });
});

describe('maybeArchiveSessionFolder', () => {
  const projectPath = 'D:\\Dev-projects\\Tandem';
  const sessionFolder = 'sessions/mock-up-8effa465';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('archives (appends session_archived, then moves) when all tasks are done', async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'list_dir_file_names') return []; // tasks dir exists, empty
      if (cmd === 'read_file_if_exists') return null; // feed doesn't exist yet
      if (cmd === 'save_transcript') return undefined;
      if (cmd === 'archive_session_folder') return 'D:\\Dev-projects\\Tandem\\.tandem\\archive\\mock-up-8effa465';
      return undefined;
    });

    const result = await maybeArchiveSessionFolder(projectPath, sessionFolder);
    expect(result).toBe(true);

    // Listed the session's tasks/ dir.
    const listCall = mockInvoke.mock.calls.find(c => c[0] === 'list_dir_file_names');
    expect((listCall![1] as { path: string }).path).toBe(
      'D:\\Dev-projects\\Tandem\\.tandem\\sessions\\mock-up-8effa465\\tasks',
    );
    // Appended the session_archived marker into the session folder BEFORE moving.
    const feedSave = mockInvoke.mock.calls.find(
      c => c[0] === 'save_transcript' && String((c[1] as { content: string }).content).includes('session_archived'),
    );
    expect(feedSave).toBeDefined();
    expect((feedSave![1] as { filePath: string }).filePath).toBe(
      'D:\\Dev-projects\\Tandem\\.tandem\\sessions\\mock-up-8effa465\\feed.md',
    );
    // Requested the move with the session folder.
    const moveCall = mockInvoke.mock.calls.find(c => c[0] === 'archive_session_folder');
    expect(moveCall![1]).toEqual({ projectDir: projectPath, sessionFolder });
  });

  it('does nothing when tasks are still pending', async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'list_dir_file_names') return ['task-1.md'];
      return undefined;
    });

    const result = await maybeArchiveSessionFolder(projectPath, sessionFolder);
    expect(result).toBe(false);
    expect(mockInvoke.mock.calls.some(c => c[0] === 'archive_session_folder')).toBe(false);
    // No feed marker either.
    expect(mockInvoke.mock.calls.some(c => c[0] === 'save_transcript')).toBe(false);
  });

  it('does nothing when no task was ever handed off (tasks dir missing)', async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'list_dir_file_names') return null;
      return undefined;
    });

    const result = await maybeArchiveSessionFolder(projectPath, sessionFolder);
    expect(result).toBe(false);
    expect(mockInvoke.mock.calls.some(c => c[0] === 'archive_session_folder')).toBe(false);
  });

  it('returns false (no throw) when the move reports it was skipped (locked folder)', async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'list_dir_file_names') return [];
      if (cmd === 'read_file_if_exists') return null;
      if (cmd === 'save_transcript') return undefined;
      if (cmd === 'archive_session_folder') return null; // busy/locked → skipped
      return undefined;
    });

    const result = await maybeArchiveSessionFolder(projectPath, sessionFolder);
    expect(result).toBe(false);
  });
});
