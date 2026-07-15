use anyhow::{anyhow, Context, Result};
use arboard::Clipboard;
use image::{ImageBuffer, RgbaImage};
use log::{info, warn};
use std::path::{Path, PathBuf};
use uuid::Uuid;

use super::types::{ClipboardContentType, ClipboardData};
use crate::screenshot::capture::generate_thumbnail_from_path;

/// Returns the clipboard sub-directory inside a meeting folder (or app data dir).
pub fn get_clipboard_dir(base_dir: &Path) -> PathBuf {
    base_dir.join("clipboard")
}

/// Open the clipboard, retrying briefly on a transient failure. The Windows clipboard is a
/// single exclusive OS resource (OpenClipboard/CloseClipboard): a background reader (such as the
/// quick-capture watcher, which polls every ~1.5s) or another app can hold it for a few
/// milliseconds. Without a retry, a one-shot capture (Alt+Shift+V) that races that read would
/// fail outright. A short bounded backoff lets the contending holder release first.
fn open_clipboard_with_retry() -> Result<Clipboard> {
    const ATTEMPTS: u32 = 8;
    let mut last_err: Option<arboard::Error> = None;
    for _ in 0..ATTEMPTS {
        match Clipboard::new() {
            Ok(cb) => return Ok(cb),
            Err(e) => {
                last_err = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
        }
    }
    match last_err {
        Some(e) => Err(anyhow::Error::new(e).context("Failed to open clipboard after retries")),
        None => Err(anyhow!("Failed to open clipboard")),
    }
}

/// Read the current clipboard content (text or image).
/// If the clipboard contains an image it is saved to `clipboard_dir` as a PNG file
/// and a JPEG thumbnail is generated (reusing the screenshot thumbnail helper).
pub fn read_clipboard(
    clipboard_dir: &Path,
    recording_elapsed_secs: Option<f64>,
) -> Result<ClipboardData> {
    let mut clipboard = open_clipboard_with_retry()?;

    let timestamp = chrono::Local::now().format("%H:%M:%S").to_string();
    let id = Uuid::new_v4().to_string();

    // Try text first
    if let Ok(text) = clipboard.get_text() {
        let trimmed = text.trim().to_string();
        if !trimmed.is_empty() {
            info!("Clipboard captured text ({} chars)", trimmed.len());
            return Ok(ClipboardData {
                id,
                content_type: ClipboardContentType::Text,
                text: Some(trimmed),
                file_path: None,
                thumbnail_base64: None,
                timestamp,
                recording_elapsed_secs,
                width: None,
                height: None,
            });
        }
    }

    // Try image
    if let Ok(img_data) = clipboard.get_image() {
        let width = img_data.width as u32;
        let height = img_data.height as u32;

        // Convert arboard ImageData (RGBA bytes) to an image::RgbaImage
        let rgba_bytes: Vec<u8> = img_data.bytes.into_owned();
        let img: RgbaImage = ImageBuffer::from_raw(width, height, rgba_bytes)
            .ok_or_else(|| anyhow!("Failed to create image buffer from clipboard image data"))?;

        // Ensure the clipboard directory exists
        std::fs::create_dir_all(clipboard_dir)
            .context("Failed to create clipboard directory")?;

        // Save as PNG
        let ts_file = chrono::Local::now().format("%Y%m%d_%H%M%S%.3f").to_string();
        let filename = format!("clip_{}.png", ts_file);
        let file_path = clipboard_dir.join(&filename);

        img.save(&file_path)
            .context("Failed to save clipboard image to disk")?;

        info!("Clipboard image saved: {}", file_path.display());

        // Generate thumbnail (reuses screenshot capture logic)
        let thumbnail_base64 = match generate_thumbnail_from_path(&file_path) {
            Ok(thumb) => Some(thumb),
            Err(e) => {
                warn!("Failed to generate thumbnail for clipboard image: {}", e);
                None
            }
        };

        return Ok(ClipboardData {
            id,
            content_type: ClipboardContentType::Image,
            text: None,
            file_path: Some(file_path.to_string_lossy().to_string()),
            thumbnail_base64,
            timestamp,
            recording_elapsed_secs,
            width: Some(width),
            height: Some(height),
        });
    }

    Err(anyhow!("Clipboard is empty or contains unsupported content"))
}
