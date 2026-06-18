'use client';

/**
 * CanvasHudGuard — keeps the floating Solo project HUD (a separate always-on-top window) from
 * overlapping the whiteboard. While the canvas is open we hide the HUD; when it closes we restore it
 * only if a Solo session is active and the HUD is enabled (so we never pop it up out of context).
 */

import { useEffect, useRef } from 'react';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useCanvas } from '@/contexts/CanvasContext';
import { useSoloMode } from '@/contexts/SoloModeContext';
import { SOLO_HUD_ENABLED_KEY } from '@/contexts/SoloModeContext';

async function setHudWindowVisible(visible: boolean): Promise<void> {
  try {
    const hud = await WebviewWindow.getByLabel('solo-hud');
    if (!hud) return;
    if (visible) await hud.show();
    else await hud.hide();
  } catch {
    /* no HUD window (browser / not created) — ignore */
  }
}

export function CanvasHudGuard() {
  const { canvasVisible } = useCanvas();
  const { isActive } = useSoloMode();
  const prevVisibleRef = useRef(false);

  useEffect(() => {
    const wasVisible = prevVisibleRef.current;
    prevVisibleRef.current = canvasVisible;
    if (canvasVisible && !wasVisible) {
      void setHudWindowVisible(false);
    } else if (!canvasVisible && wasVisible) {
      const hudEnabled =
        typeof localStorage !== 'undefined' && localStorage.getItem(SOLO_HUD_ENABLED_KEY) !== 'false';
      if (isActive && hudEnabled) void setHudWindowVisible(true);
    }
  }, [canvasVisible, isActive]);

  return null;
}

export default CanvasHudGuard;
