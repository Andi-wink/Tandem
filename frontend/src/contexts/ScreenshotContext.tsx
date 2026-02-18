'use client';

import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { ScreenshotData } from '@/types';
import { takeScreenshot, takeRegionScreenshot, saveScreenshotsJson } from '@/services/screenshotService';

interface ScreenshotContextType {
  screenshots: ScreenshotData[];
  selectedScreenshot: ScreenshotData | null;
  isRegionSelecting: boolean;
  isCapturing: boolean;
  captureFullscreen: () => Promise<void>;
  captureRegion: (x: number, y: number, width: number, height: number) => Promise<void>;
  startRegionSelect: () => void;
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
    let mounted = true;

    const setup = async () => {
      unlistenRef.current = await listen<ScreenshotData>('screenshot-taken', (event) => {
        if (mounted) {
          setScreenshots((prev) => [...prev, event.payload]);
        }
      });

      unlistenRegionRef.current = await listen('screenshot-region-select', () => {
        if (mounted) {
          setIsRegionSelecting(true);
        }
      });

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
      mounted = false;
      unlistenRef.current?.();
      unlistenRegionRef.current?.();
      unlistenStoppedRef.current?.();
    };
  }, []);

  const captureFullscreen = useCallback(async () => {
    setIsCapturing(true);
    try {
      const data = await takeScreenshot();
      // Event listener handles adding to state via screenshot-taken event
      // But if invoked directly (not via hotkey), the event also fires,
      // so we don't need to add manually here.
    } catch (err) {
      console.error('Failed to capture screenshot:', err);
    } finally {
      setIsCapturing(false);
    }
  }, []);

  const captureRegion = useCallback(async (x: number, y: number, width: number, height: number) => {
    setIsRegionSelecting(false);
    setIsCapturing(true);
    try {
      await takeRegionScreenshot(x, y, width, height);
      // Event listener handles adding to state
    } catch (err) {
      console.error('Failed to capture region screenshot:', err);
    } finally {
      setIsCapturing(false);
    }
  }, []);

  const startRegionSelect = useCallback(() => {
    setIsRegionSelecting(true);
  }, []);

  const cancelRegionSelect = useCallback(() => {
    setIsRegionSelecting(false);
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
        isCapturing,
        captureFullscreen,
        captureRegion,
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
