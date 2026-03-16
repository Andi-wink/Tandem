'use client';

import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { ClipboardData } from '@/types';
import { readClipboardContent, saveClipboardJson } from '@/services/clipboardService';
import { toast } from 'sonner';

interface ClipboardContextType {
  clipboardItems: ClipboardData[];
  captureClipboard: () => Promise<void>;
  clearClipboard: () => void;
  saveToMeetingFolder: (folderPath: string) => Promise<void>;
}

const ClipboardContext = createContext<ClipboardContextType | null>(null);

export const useClipboard = () => {
  const context = useContext(ClipboardContext);
  if (!context) {
    throw new Error('useClipboard must be used within a ClipboardProvider');
  }
  return context;
};

export function ClipboardProvider({ children }: { children: React.ReactNode }) {
  const [clipboardItems, setClipboardItems] = useState<ClipboardData[]>([]);
  const unlistenCapturedRef = useRef<UnlistenFn | null>(null);
  const unlistenStoppedRef = useRef<UnlistenFn | null>(null);
  const itemsRef = useRef<ClipboardData[]>([]);

  // Keep ref in sync for use inside event listeners (avoids stale closure)
  useEffect(() => {
    itemsRef.current = clipboardItems;
  }, [clipboardItems]);

  // Listen for clipboard-captured and recording-stopped events
  // Both listeners are registered in parallel and each checks a mounted flag
  // after the async listen() call completes to prevent leaks on early unmount.
  useEffect(() => {
    let mounted = true;

    // Register both listeners concurrently to minimise the window where
    // a clipboard-captured event could fire before the listener exists.
    const capturedPromise = listen<ClipboardData>('clipboard-captured', (event) => {
      if (!mounted) return;
      setClipboardItems((prev) => [...prev, event.payload]);
      const label = event.payload.content_type === 'image' ? 'Image' : 'Text';
      toast.success(`${label} clip captured`);
    });

    const stoppedPromise = listen<{
      message: string;
      folder_path?: string;
    }>('recording-stopped', async (event) => {
      if (!mounted) return;
      const { folder_path } = event.payload;
      const currentItems = itemsRef.current;
      if (folder_path && currentItems.length > 0) {
        try {
          await saveClipboardJson(folder_path, currentItems);
          console.log(`[ClipboardContext] Auto-saved ${currentItems.length} clipboard items to ${folder_path}`);
        } catch (err) {
          console.error('[ClipboardContext] Failed to auto-save clipboard items:', err);
        }
      }
    });

    // Assign unlisten functions once the promises resolve; if we unmounted
    // in the meantime, immediately call the unlisten to clean up.
    capturedPromise.then((unlisten) => {
      if (mounted) {
        unlistenCapturedRef.current = unlisten;
      } else {
        unlisten();
      }
    });

    stoppedPromise.then((unlisten) => {
      if (mounted) {
        unlistenStoppedRef.current = unlisten;
      } else {
        unlisten();
      }
    });

    return () => {
      mounted = false;
      unlistenCapturedRef.current?.();
      unlistenStoppedRef.current?.();
    };
  }, []);

  const captureClipboard = useCallback(async () => {
    try {
      await readClipboardContent();
      // clipboard-captured event listener handles adding to state and showing success toast
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[ClipboardContext] Failed to capture clipboard:', err);
      if (msg.includes('empty') || msg.includes('unsupported')) {
        toast.info('Nothing to clip — copy some text or an image first');
      } else {
        toast.error(`Clip failed: ${msg}`);
      }
    }
  }, []);

  const clearClipboard = useCallback(() => {
    setClipboardItems([]);
  }, []);

  const saveToMeetingFolder = useCallback(async (folderPath: string) => {
    if (clipboardItems.length === 0) return;
    try {
      await saveClipboardJson(folderPath, clipboardItems);
      console.log(`[ClipboardContext] Saved ${clipboardItems.length} clipboard items to ${folderPath}`);
    } catch (err) {
      console.error('[ClipboardContext] Failed to save clipboard.json:', err);
    }
  }, [clipboardItems]);

  return (
    <ClipboardContext.Provider
      value={{
        clipboardItems,
        captureClipboard,
        clearClipboard,
        saveToMeetingFolder,
      }}
    >
      {children}
    </ClipboardContext.Provider>
  );
}
