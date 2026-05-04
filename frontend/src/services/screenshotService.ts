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

export interface CropPreviewResult {
  data_uri: string;
  width: number;
  height: number;
}

export async function cropPreCapturedPreview(
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<CropPreviewResult> {
  return invoke<CropPreviewResult>('crop_pre_captured_preview', { x, y, width, height });
}

export interface RegionCaptureResult {
  blobUrl: string;
  monitorWidth: number;
  monitorHeight: number;
}

/** Pre-capture screen and return JPEG preview + dimensions in a single IPC call.
 *  Response format: [width: u32 LE][height: u32 LE][JPEG bytes...] */
export async function startRegionCapture(): Promise<RegionCaptureResult> {
  const buffer = await invoke<ArrayBuffer>('start_region_capture');
  const view = new DataView(buffer);
  const monitorWidth = view.getUint32(0, true);
  const monitorHeight = view.getUint32(4, true);
  const jpegData = buffer.slice(8);
  const blob = new Blob([jpegData], { type: 'image/jpeg' });
  const blobUrl = URL.createObjectURL(blob);
  return { blobUrl, monitorWidth, monitorHeight };
}

/** Fetch the pre-captured JPEG preview as raw bytes (no base64 overhead).
 *  Used by the hotkey path where data arrives via event + separate fetch. */
export async function getPreCapturePreview(): Promise<string> {
  const buffer = await invoke<ArrayBuffer>('get_pre_capture_preview');
  const blob = new Blob([buffer], { type: 'image/jpeg' });
  return URL.createObjectURL(blob);
}

export async function cancelRegionCapture(): Promise<void> {
  return invoke<void>('cancel_region_capture');
}

export async function saveAnnotatedScreenshot(
  imageBase64: string,
): Promise<ScreenshotData> {
  return invoke<ScreenshotData>('save_annotated_screenshot', { imageBase64 });
}

/** Tell Rust which Solo Mode project is active so screenshot files land in
 *  `{path}/.tandem/screenshots/`. Pass null to clear (returns to meeting-folder routing). */
export async function setActiveSoloProject(path: string | null): Promise<void> {
  return invoke<void>('set_active_solo_project', { path });
}
