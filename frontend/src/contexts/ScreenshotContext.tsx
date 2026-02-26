'use client';

import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { ScreenshotData } from '@/types';
import { takeScreenshot, cropPreCapturedRegion, startRegionCapture, cancelRegionCapture, saveScreenshotsJson, saveAnnotatedScreenshot, getPreCapturePreview } from '@/services/screenshotService';

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
  const blobUrlRef = useRef<string | null>(null);

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

      // Region select event carries only dimensions — preview fetched as raw bytes (no base64)
      unlistenRegionRef.current = await listen<{
        monitor_width: number;
        monitor_height: number;
      }>('screenshot-region-select', async (event) => {
        if (abortController.signal.aborted) return;
        try {
          // Fetch raw JPEG bytes via IPC, get back a blob URL
          const blobUrl = await getPreCapturePreview();
          if (abortController.signal.aborted) {
            URL.revokeObjectURL(blobUrl);
            return;
          }
          // Preload image so the overlay doesn't flash without a background
          await new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => resolve();
            img.onerror = () => resolve();
            img.src = blobUrl;
          });
          if (abortController.signal.aborted) {
            URL.revokeObjectURL(blobUrl);
            return;
          }
          // Track blob URL for cleanup in callbacks
          blobUrlRef.current = blobUrl;
          setRegionSelectInfo({
            previewDataUri: blobUrl,
            monitorWidth: event.payload.monitor_width,
            monitorHeight: event.payload.monitor_height,
          });
          setIsRegionSelecting(true);
        } catch (err) {
          console.error('[ScreenshotContext] Failed to fetch pre-capture preview:', err);
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

  // Revoke the current blob URL if one exists
  const revokeBlobUrl = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);

  // Crop from the pre-captured image stored in Rust memory
  const captureRegion = useCallback(async (x: number, y: number, width: number, height: number) => {
    revokeBlobUrl();
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
  }, [revokeBlobUrl]);

  // Save an annotated region screenshot (base64 PNG from the annotation canvas)
  const captureAnnotatedRegion = useCallback(async (annotatedBase64: string) => {
    revokeBlobUrl();
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
  }, [revokeBlobUrl]);

  const startRegionSelect = useCallback(async (annotate: boolean = false) => {
    setAnnotateAfterSelect(annotate);
    try {
      // Single IPC call: captures screen and returns dimensions + JPEG bytes as raw binary
      const result = await startRegionCapture();

      // Preload image to avoid flash when overlay mounts
      await new Promise<void>((resolve) => {
        const img = new Image();
        img.onload = () => resolve();
        img.onerror = () => resolve();
        img.src = result.blobUrl;
      });

      blobUrlRef.current = result.blobUrl;
      setRegionSelectInfo({
        previewDataUri: result.blobUrl,
        monitorWidth: result.monitorWidth,
        monitorHeight: result.monitorHeight,
      });
      setIsRegionSelecting(true);
    } catch (err) {
      console.error('Failed to start region capture:', err);
    }
  }, []);

  // Cancel region selection and free the pre-captured image from Rust memory
  const cancelRegionSelect = useCallback(async () => {
    revokeBlobUrl();
    setIsRegionSelecting(false);
    setRegionSelectInfo(null);
    setAnnotateAfterSelect(false);
    try {
      await cancelRegionCapture();
    } catch (err) {
      console.error('Failed to cancel region capture:', err);
    }
  }, [revokeBlobUrl]);

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
