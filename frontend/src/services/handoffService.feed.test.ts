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
  slugify,
  generateLiveScreenshotsMarkdown,
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

  it('sessionScopeFolder falls back to the shortid alone when no display name', () => {
    expect(sessionScopeFolder('abc-123')).toBe('sessions/abc-123');
    expect(tandemDirFor('D:\\Proj', sessionScopeFolder('sid'))).toBe(
      'D:\\Proj\\.tandem\\sessions\\sid',
    );
  });

  it('sessionScopeFolder builds sessions/<slug>-<shortid> from the display name', () => {
    // The documented example.
    expect(
      sessionScopeFolder('8effa465-9ffe-44c0-91d6-fc53f91b5687', 'Mock up solo mode project hub layout'),
    ).toBe('sessions/mock-up-solo-mode-project-hub-layout-8effa465');
    // shortid is exactly the first 8 chars of the session id.
    expect(sessionScopeFolder('deadbeef-1111', 'Fix Login')).toBe('sessions/fix-login-deadbeef');
  });

  it('sessionScopeFolder guards an all-punctuation name (empty slug) to shortid only', () => {
    expect(sessionScopeFolder('8effa465-xxxx', '!!! ??? ...')).toBe('sessions/8effa465');
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
