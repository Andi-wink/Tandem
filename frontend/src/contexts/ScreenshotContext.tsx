'use client';

import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { ScreenshotData } from '@/types';
import { takeScreenshot, cropPreCapturedRegion, startRegionCapture, cancelRegionCapture, saveScreenshotsJson, saveAnnotatedScreenshot } from '@/services/screenshotService';

export interface RegionSelectInfo {
  previewDataUri: string;
  monitorWidth: number;
  monitorHeight: number;
}

interface ScreenshotContextType {
  screenshots: ScreenshotData[];
  selectedScreenshot: ScreenshotData | null;
  isRegionSelecting: boolean;
  regionSelectInfo: RegionSelectInfo | null;
  annotateAfterSelect: boolean;
  isCapturing: boolean;
  captureFullscreen: () => Promise<void>;
  captureRegion: (x: number, y: number, width: number, height: number) => Promise<void>;
  captureAnnotatedRegion: (annotatedBase64: string) => Promise<void>;
  startRegionSelect: (annotate?: boolean) => void;
  cancelRegionSelect: () => void;
  openLightbox: (screenshot: ScreenshotData) => void;
  closeLightbox: () => void;
  clearScreenshots: () => void;
  saveToMeetingFolder: (folderPath: string) => Promise<void>;
}

const ScreenshotContext = createContext<ScreenshotContextType | null>(null);

export const useScreenshots = () => {
  const context = useContext(ScreenshotContext);
  if (!context) {
    throw new Error('useScreenshots must be used within a ScreenshotProvider');
  }
  return context;
};

export function ScreenshotProvider({ children }: { children: React.ReactNode }) {
  const [screenshots, setScreenshots] = useState<ScreenshotData[]>([]);
  const [selectedScreenshot, setSelectedScreenshot] = useState<ScreenshotData | null>(null);
  const [isRegionSelecting, setIsRegionSelecting] = useState(false);
  const [regionSelectInfo, setRegionSelectInfo] = useState<RegionSelectInfo | null>(null);
  const [annotateAfterSelect, setAnnotateAfterSelect] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const unlistenRegionRef = useRef<UnlistenFn | null>(null);
  const unlistenStoppedRef = useRef<UnlistenFn | null>(null);
  const screenshotsRef = useRef<ScreenshotData[]>([]);

  // Keep ref in sync with state for use in event listeners
  useEffect(() => {
    screenshotsRef.current = screenshots;
  }, [screenshots]);

  // Listen for screenshot-taken, region-select, and recording-stopped events
  useEffect(() => {
    const abortController = new AbortController();

    const setup = async () => {
      if (abortController.signal.aborted) return;

      unlistenRef.current = await listen<ScreenshotData>('screenshot-taken', (event) => {
        if (!abortController.signal.aborted) {
          setScreenshots((prev) => [...prev, event.payload]);
        }
      });

      if (abortController.signal.aborted) { unlistenRef.current?.(); return; }

      // Region select event now carries pre-capture metadata from the hotkey handler
      unlistenRegionRef.current = await listen<{
        preview_data_uri: string;
        monitor_width: number;
        monitor_height: number;
      }>('screenshot-region-select', (event) => {
        if (!abortController.signal.aborted) {
          setRegionSelectInfo({
            previewDataUri: event.payload.preview_data_uri,
            monitorWidth: event.payload.monitor_width,
            monitorHeight: event.payload.monitor_height,
          });
          setIsRegionSelecting(true);
        }
      });

      if (abortController.signal.aborted) { unlistenRegionRef.current?.(); return; }

      // Auto-save screenshots when recording stops
      unlistenStoppedRef.current = await listen<{
        message: string;
        folder_path?: string;
      }>('recording-stopped', async (event) => {
        const { folder_path } = event.payload;
        const currentScreenshots = screenshotsRef.current;
        if (folder_path && currentScreenshots.length > 0) {
          try {
            await saveScreenshotsJson(folder_path, currentScreenshots);
            console.log(`[ScreenshotContext] Auto-saved ${currentScreenshots.length} screenshots to ${folder_path}`);
          } catch (err) {
            console.error('[ScreenshotContext] Failed to auto-save screenshots:', err);
          }
        }
      });
    };

    setup();

    return () => {
      abortController.abort();
      unlistenRef.current?.();
      unlistenRegionRef.current?.();
      unlistenStoppedRef.current?.();
    };
  }, []);

  const captureFullscreen = useCallback(async () => {
    setIsCapturing(true);
    try {
      await takeScreenshot();
      // Event listener handles adding to state via screenshot-taken event
    } catch (err) {
      console.error('Failed to capture screenshot:', err);
    } finally {
      setIsCapturing(false);
    }
  }, []);

  // Crop from the pre-captured image stored in Rust memory
  const captureRegion = useCallback(async (x: number, y: number, width: number, height: number) => {
    setIsRegionSelecting(false);
    setRegionSelectInfo(null);
    setIsCapturing(true);
    try {
      await cropPreCapturedRegion(x, y, width, height);
      // screenshot-taken event listener handles adding to state
    } catch (err) {
      console.error('Failed to crop pre-captured region:', err);
    } finally {
      setIsCapturing(false);
    }
  }, []);

  // Save an annotated region screenshot (base64 PNG from the annotation canvas)
  const captureAnnotatedRegion = useCallback(async (annotatedBase64: string) => {
    setIsRegionSelecting(false);
    setRegionSelectInfo(null);
    setIsCapturing(true);
    try {
      await saveAnnotatedScreenshot(annotatedBase64);
      // screenshot-taken event listener handles adding to state
    } catch (err) {
      console.error('Failed to save annotated screenshot:', err);
    } finally {
      setIsCapturing(false);
    }
  }, []);

  const startRegionSelect = useCallback(async (annotate: boolean = false) => {
    setAnnotateAfterSelect(annotate);
    try {
      await startRegionCapture();
      // The Rust command emits 'screenshot-region-select' event,
      // which our listener handles to set regionSelectInfo and isRegionSelecting
    } catch (err) {
      console.error('Failed to start region capture:', err);
    }
  }, []);

  // Cancel region selection and free the pre-captured image from Rust memory
  const cancelRegionSelect = useCallback(async () => {
    setIsRegionSelecting(false);
    setRegionSelectInfo(null);
    setAnnotateAfterSelect(false);
    try {
      await cancelRegionCapture();
    } catch (err) {
      console.error('Failed to cancel region capture:', err);
    }
  }, []);

  const openLightbox = useCallback((screenshot: ScreenshotData) => {
    setSelectedScreenshot(screenshot);
  }, []);

  const closeLightbox = useCallback(() => {
    setSelectedScreenshot(null);
  }, []);

  const clearScreenshots = useCallback(() => {
    setScreenshots([]);
  }, []);

  const saveToMeetingFolder = useCallback(async (folderPath: string) => {
    if (screenshots.length === 0) return;
    try {
      await saveScreenshotsJson(folderPath, screenshots);
      console.log(`Saved ${screenshots.length} screenshots to ${folderPath}`);
    } catch (err) {
      console.error('Failed to save screenshots.json:', err);
    }
  }, [screenshots]);

  return (
    <ScreenshotContext.Provider
      value={{
        screenshots,
        selectedScreenshot,
        isRegionSelecting,
        regionSelectInfo,
        annotateAfterSelect,
        isCapturing,
        captureFullscreen,
        captureRegion,
        captureAnnotatedRegion,
        startRegionSelect,
        cancelRegionSelect,
        openLightbox,
        closeLightbox,
        clearScreenshots,
        saveToMeetingFolder,
      }}
    >
      {children}
    </ScreenshotContext.Provider>
  );
}
