import { invoke } from '@tauri-apps/api/core';
import { ScreenshotData } from '@/types';

export interface ScreenPreview {
  image_data: string;
  width: number;  // Original monitor width (for coordinate mapping)
  height: number; // Original monitor height (for coordinate mapping)
}

export async function takeScreenshot(): Promise<ScreenshotData> {
  return invoke<ScreenshotData>('take_screenshot');
}

export async function takeRegionScreenshot(
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<ScreenshotData> {
  return invoke<ScreenshotData>('take_region_screenshot', { x, y, width, height });
}

export async function captureScreenPreview(
  viewportWidth: number,
  viewportHeight: number,
): Promise<ScreenPreview> {
  return invoke<ScreenPreview>('capture_screen_preview', {
    viewportWidth,
    viewportHeight,
  });
}

export async function saveScreenshotsJson(
  folderPath: string,
  screenshots: ScreenshotData[],
): Promise<void> {
  return invoke<void>('save_screenshots_json', { folderPath, screenshots });
}

export async function loadScreenshotsJson(
  folderPath: string,
): Promise<ScreenshotData[]> {
  return invoke<ScreenshotData[]>('load_screenshots_json', { folderPath });
}

export async function cropPreCapturedRegion(
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<ScreenshotData> {
  return invoke<ScreenshotData>('crop_pre_captured_region', { x, y, width, height });
}

export async function cancelRegionCapture(): Promise<void> {
  return invoke<void>('cancel_region_capture');
}
