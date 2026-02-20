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
  useEffect(() => {
    let mounted = true;

    const setup = async () => {
      unlistenCapturedRef.current = await listen<ClipboardData>('clipboard-captured', (event) => {
        if (mounted) {
          setClipboardItems((prev) => [...prev, event.payload]);
          const label = event.payload.content_type === 'image' ? 'Image' : 'Text';
          toast.success(`${label} clip captured`);
        }
      });

      // Auto-save when recording stops
      unlistenStoppedRef.current = await listen<{
        message: string;
        folder_path?: string;
      }>('recording-stopped', async (event) => {
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
    };

    setup();

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
