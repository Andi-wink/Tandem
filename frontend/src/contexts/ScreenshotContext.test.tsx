import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { listen } from '@tauri-apps/api/event';
import { ScreenshotProvider, useScreenshots } from './ScreenshotContext';

const mockListen = vi.mocked(listen);

// Mock screenshotService — all IPC calls go through this layer
vi.mock('@/services/screenshotService', () => ({
  takeScreenshot: vi.fn().mockResolvedValue({
    id: 'test-id',
    file_path: '/tmp/screenshot.png',
    thumbnail_base64: '',
    timestamp: '12:00:00',
    width: 1920,
    height: 1080,
    capture_mode: 'fullscreen',
  }),
  cropPreCapturedRegion: vi.fn().mockResolvedValue({
    id: 'region-id',
    file_path: '/tmp/region.png',
    thumbnail_base64: '',
    timestamp: '12:00:01',
    width: 400,
    height: 300,
    capture_mode: 'region',
  }),
  startRegionCapture: vi.fn().mockResolvedValue({
    blobUrl: 'blob:http://localhost/fake-blob',
    monitorWidth: 1920,
    monitorHeight: 1080,
  }),
  cancelRegionCapture: vi.fn().mockResolvedValue(undefined),
  saveScreenshotsJson: vi.fn().mockResolvedValue(undefined),
  saveAnnotatedScreenshot: vi.fn().mockResolvedValue({
    id: 'annotated-id',
    file_path: '/tmp/annotated.png',
    thumbnail_base64: '',
    timestamp: '12:00:02',
    width: 400,
    height: 300,
    capture_mode: 'region',
  }),
  getPreCapturePreview: vi.fn().mockResolvedValue('blob:http://localhost/fake-preview'),
  loadScreenshotsJson: vi.fn().mockResolvedValue([]),
}));

// Stub Image to auto-fire onload (image preloading in the context)
const OriginalImage = globalThis.Image;
beforeEach(() => {
  globalThis.Image = class StubImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_val: string) {
      // Fire onload synchronously on next microtask
      queueMicrotask(() => this.onload?.());
    }
  } as unknown as typeof globalThis.Image;
});

// Capture event handlers registered via listen()
const eventHandlers: Record<string, Function> = {};

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(eventHandlers).forEach((key) => delete eventHandlers[key]);

  mockListen.mockImplementation(async (event, handler) => {
    eventHandlers[event as string] = handler as Function;
    return (() => {}) as unknown as ReturnType<typeof listen> extends Promise<infer U> ? U : never; // unlisten
  });
});

function wrapper({ children }: { children: React.ReactNode }) {
  return <ScreenshotProvider>{children}</ScreenshotProvider>;
}

describe('ScreenshotContext', () => {
  it('provides initial state with annotateAfterSelect false', async () => {
    const { result } = renderHook(() => useScreenshots(), { wrapper });

    expect(result.current.annotateAfterSelect).toBe(false);
    expect(result.current.isRegionSelecting).toBe(false);
    expect(result.current.screenshots).toEqual([]);
  });

  it('throws when used outside provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => {
      renderHook(() => useScreenshots());
    }).toThrow('useScreenshots must be used within a ScreenshotProvider');
    spy.mockRestore();
  });

  it('sets annotateAfterSelect=false when screenshot-region-select fires with annotate:false', async () => {
    const { result } = renderHook(() => useScreenshots(), { wrapper });

    // Wait for event listeners to register
    await waitFor(() => {
      expect(eventHandlers['screenshot-region-select']).toBeDefined();
    });

    // Simulate the Alt+Shift+S hotkey event (no annotation)
    await act(async () => {
      await eventHandlers['screenshot-region-select']!({
        payload: { monitor_width: 1920, monitor_height: 1080, annotate: false },
      });
    });

    await waitFor(() => {
      expect(result.current.isRegionSelecting).toBe(true);
    });
    expect(result.current.annotateAfterSelect).toBe(false);
  });

  it('sets annotateAfterSelect=true when screenshot-region-select fires with annotate:true', async () => {
    const { result } = renderHook(() => useScreenshots(), { wrapper });

    await waitFor(() => {
      expect(eventHandlers['screenshot-region-select']).toBeDefined();
    });

    // Simulate the Alt+Shift+R hotkey event (with annotation)
    await act(async () => {
      await eventHandlers['screenshot-region-select']!({
        payload: { monitor_width: 1920, monitor_height: 1080, annotate: true },
      });
    });

    await waitFor(() => {
      expect(result.current.isRegionSelecting).toBe(true);
    });
    expect(result.current.annotateAfterSelect).toBe(true);
  });

  it('defaults annotateAfterSelect to false when annotate field is missing (backwards compat)', async () => {
    const { result } = renderHook(() => useScreenshots(), { wrapper });

    await waitFor(() => {
      expect(eventHandlers['screenshot-region-select']).toBeDefined();
    });

    // Simulate an event without the annotate field (old Rust code path)
    await act(async () => {
      await eventHandlers['screenshot-region-select']!({
        payload: { monitor_width: 1920, monitor_height: 1080 },
      });
    });

    await waitFor(() => {
      expect(result.current.isRegionSelecting).toBe(true);
    });
    expect(result.current.annotateAfterSelect).toBe(false);
  });

  it('sets annotateAfterSelect=true when startRegionSelect(true) is called (button path)', async () => {
    const { result } = renderHook(() => useScreenshots(), { wrapper });

    await act(async () => {
      await result.current.startRegionSelect(true);
    });

    await waitFor(() => {
      expect(result.current.isRegionSelecting).toBe(true);
    });
    expect(result.current.annotateAfterSelect).toBe(true);
  });

  it('sets annotateAfterSelect=false when startRegionSelect() is called without arg (button path)', async () => {
    const { result } = renderHook(() => useScreenshots(), { wrapper });

    await act(async () => {
      await result.current.startRegionSelect();
    });

    await waitFor(() => {
      expect(result.current.isRegionSelecting).toBe(true);
    });
    expect(result.current.annotateAfterSelect).toBe(false);
  });

  it('resets annotateAfterSelect on cancel', async () => {
    const { result } = renderHook(() => useScreenshots(), { wrapper });

    // Start with annotation mode
    await act(async () => {
      await result.current.startRegionSelect(true);
    });

    await waitFor(() => {
      expect(result.current.annotateAfterSelect).toBe(true);
    });

    // Cancel
    await act(async () => {
      await result.current.cancelRegionSelect();
    });

    await waitFor(() => {
      expect(result.current.isRegionSelecting).toBe(false);
    });
    expect(result.current.annotateAfterSelect).toBe(false);
  });

  it('adds screenshot to state when screenshot-taken event fires', async () => {
    const { result } = renderHook(() => useScreenshots(), { wrapper });

    await waitFor(() => {
      expect(eventHandlers['screenshot-taken']).toBeDefined();
    });

    const mockScreenshot = {
      id: 'evt-screenshot',
      file_path: '/tmp/test.png',
      thumbnail_base64: 'data:image/jpeg;base64,/9j/',
      timestamp: '14:30:05',
      width: 1920,
      height: 1080,
      capture_mode: 'region' as const,
    };

    act(() => {
      eventHandlers['screenshot-taken']!({ payload: mockScreenshot });
    });

    await waitFor(() => {
      expect(result.current.screenshots).toHaveLength(1);
    });
    expect(result.current.screenshots[0].id).toBe('evt-screenshot');
  });
});
