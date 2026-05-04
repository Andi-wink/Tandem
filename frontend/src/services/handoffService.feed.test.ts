import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  appendFeedEntry,
  buildScreenshotFeedEntry,
  buildClipboardFeedEntry,
  ensureLoopState,
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
