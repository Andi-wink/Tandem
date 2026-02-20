use anyhow::{Context, Result};
use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::{DynamicImage, ImageEncoder, RgbaImage};
use log::{error, info};
use serde::Serialize;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use uuid::Uuid;
use xcap::Monitor;

use super::types::{CaptureMode, ScreenshotData};
use crate::audio::recording_commands;

const THUMBNAIL_MAX_WIDTH: u32 = 200;

// ── Pre-capture storage for region screenshots ──────────────────────────────
// The full-resolution RgbaImage is stored here after the hotkey fires.
// The frontend shows its selection overlay while this image waits in memory.
// When the user finishes drawing, we crop from this image instead of
// capturing the screen a second time.

static PRE_CAPTURED_IMAGE: LazyLock<Arc<StdMutex<Option<RgbaImage>>>> =
    LazyLock::new(|| Arc::new(StdMutex::new(None)));

static REGION_CAPTURE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
pub struct PreCaptureResult {
    pub preview_path: String,
    pub monitor_width: u32,
    pub monitor_height: u32,
}

/// Pre-capture the screen: store the raw image in memory and write a
/// full-resolution JPEG preview to disk for the frontend to load via
/// the asset protocol.  Returns the file path and monitor dimensions.
pub fn pre_capture_screen(app_data_dir: &Path) -> Result<PreCaptureResult> {
    // Guard against double-press
    if REGION_CAPTURE_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        anyhow::bail!("Region capture already in progress");
    }

    let monitors = Monitor::all().context("Failed to enumerate monitors")?;
    let monitor = monitors
        .into_iter()
        .next()
        .context("No monitors found")?;

    let raw_image = monitor
        .capture_image()
        .context("Failed to capture monitor image")?;

    let monitor_width = raw_image.width();
    let monitor_height = raw_image.height();

    // Write full-resolution JPEG preview to a temp file
    let preview_dir = app_data_dir.join("temp");
    std::fs::create_dir_all(&preview_dir).context("Failed to create temp directory")?;
    let preview_path = preview_dir.join("region_preview.jpg");

    let dynamic = DynamicImage::ImageRgba8(raw_image.clone());
    let rgb = dynamic.to_rgb8();
    let mut file =
        std::fs::File::create(&preview_path).context("Failed to create preview file")?;
    let mut encoder = JpegEncoder::new_with_quality(&mut file, 85);
    encoder
        .encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .context("Failed to encode preview JPEG")?;

    info!(
        "Pre-captured screen: {}x{}, preview at {}",
        monitor_width,
        monitor_height,
        preview_path.display()
    );

    // Store raw image for later cropping
    let mut guard = PRE_CAPTURED_IMAGE
        .lock()
        .map_err(|e| anyhow::anyhow!("Lock poisoned: {}", e))?;
    *guard = Some(raw_image);

    Ok(PreCaptureResult {
        preview_path: preview_path.to_string_lossy().to_string(),
        monitor_width,
        monitor_height,
    })
}

/// Crop a region from the pre-captured image, save as PNG, and return metadata.
/// Consumes the stored image (sets it to None) and resets the in-progress flag.
pub fn crop_from_pre_captured(
    x: i32,
    y: i32,
    region_width: u32,
    region_height: u32,
    screenshots_dir: &Path,
) -> Result<ScreenshotData> {
    let mut guard = PRE_CAPTURED_IMAGE
        .lock()
        .map_err(|e| anyhow::anyhow!("Lock poisoned: {}", e))?;

    let raw_image = guard
        .take()
        .context("No pre-captured image available")?;

    // Reset the in-progress flag
    REGION_CAPTURE_IN_PROGRESS.store(false, Ordering::SeqCst);

    let cropped = crop_image(&raw_image, x, y, region_width, region_height)?;
    let w = cropped.width();
    let h = cropped.height();

    let dynamic = DynamicImage::ImageRgba8(cropped);
    save_screenshot(dynamic, w, h, CaptureMode::Region, screenshots_dir)
}

/// Free the stored pre-captured image and reset the in-progress flag.
/// Called when the user cancels region selection.
pub fn clear_pre_captured() {
    if let Ok(mut guard) = PRE_CAPTURED_IMAGE.lock() {
        if guard.is_some() {
            info!("Clearing pre-captured image from memory");
        }
        *guard = None;
    } else {
        error!("Failed to lock PRE_CAPTURED_IMAGE for cleanup");
    }
    REGION_CAPTURE_IN_PROGRESS.store(false, Ordering::SeqCst);
}

/// Check if a region capture is currently in progress.
pub fn is_region_capture_in_progress() -> bool {
    REGION_CAPTURE_IN_PROGRESS.load(Ordering::SeqCst)
}

/// Capture the primary monitor and return a JPEG preview downscaled to viewport size.
/// Returns (data_uri, original_monitor_width, original_monitor_height) so the frontend
/// can map viewport coordinates back to screen coordinates.
pub fn capture_screen_preview(viewport_width: u32, viewport_height: u32) -> Result<(String, u32, u32)> {
    let monitors = Monitor::all().context("Failed to enumerate monitors")?;
    let monitor = monitors
        .into_iter()
        .next()
        .context("No monitors found")?;

    let raw_image = monitor
        .capture_image()
        .context("Failed to capture monitor image")?;

    let original_width = raw_image.width();
    let original_height = raw_image.height();

    let dynamic = DynamicImage::ImageRgba8(raw_image);

    // Downscale to viewport dimensions for faster transfer and rendering
    let preview = dynamic.resize_exact(
        viewport_width,
        viewport_height,
        image::imageops::FilterType::Triangle,
    );

    // Encode as JPEG (much faster and smaller than PNG for preview purposes)
    let rgb_image = preview.to_rgb8();
    let mut buf = Cursor::new(Vec::new());
    let mut encoder = JpegEncoder::new_with_quality(&mut buf, 80);
    encoder
        .encode(
            rgb_image.as_raw(),
            rgb_image.width(),
            rgb_image.height(),
            image::ExtendedColorType::Rgb8,
        )
        .context("Failed to encode screen preview JPEG")?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(buf.into_inner());
    let data_uri = format!("data:image/jpeg;base64,{}", b64);

    // Return original monitor dimensions for coordinate mapping
    Ok((data_uri, original_width, original_height))
}

/// Capture the primary monitor's full screen.
pub fn capture_fullscreen(screenshots_dir: &Path) -> Result<ScreenshotData> {
    let monitors = Monitor::all().context("Failed to enumerate monitors")?;
    let monitor = monitors
        .into_iter()
        .next()
        .context("No monitors found")?;

    let raw_image = monitor
        .capture_image()
        .context("Failed to capture monitor image")?;

    let width = raw_image.width();
    let height = raw_image.height();

    let dynamic = DynamicImage::ImageRgba8(raw_image);
    save_screenshot(dynamic, width, height, CaptureMode::Fullscreen, screenshots_dir)
}

/// Capture a region of the primary monitor.
pub fn capture_region(
    x: i32,
    y: i32,
    region_width: u32,
    region_height: u32,
    screenshots_dir: &Path,
) -> Result<ScreenshotData> {
    let monitors = Monitor::all().context("Failed to enumerate monitors")?;
    let monitor = monitors
        .into_iter()
        .next()
        .context("No monitors found")?;

    let raw_image = monitor
        .capture_image()
        .context("Failed to capture monitor image")?;

    let cropped = crop_image(&raw_image, x, y, region_width, region_height)?;
    let width = cropped.width();
    let height = cropped.height();

    let dynamic = DynamicImage::ImageRgba8(cropped);
    save_screenshot(dynamic, width, height, CaptureMode::Region, screenshots_dir)
}

/// Crop an RGBA image to the given region, clamping to image bounds.
fn crop_image(
    img: &RgbaImage,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> Result<RgbaImage> {
    let img_w = img.width();
    let img_h = img.height();

    // Clamp coordinates to image bounds
    let x0 = x.max(0) as u32;
    let y0 = y.max(0) as u32;
    let x1 = ((x as u32).saturating_add(w)).min(img_w);
    let y1 = ((y as u32).saturating_add(h)).min(img_h);

    let crop_w = x1.saturating_sub(x0);
    let crop_h = y1.saturating_sub(y0);

    if crop_w == 0 || crop_h == 0 {
        anyhow::bail!("Region selection resulted in zero-size image");
    }

    let dynamic = DynamicImage::ImageRgba8(img.clone());
    let cropped = dynamic.crop_imm(x0, y0, crop_w, crop_h);
    Ok(cropped.to_rgba8())
}

/// Save screenshot to disk, generate thumbnail, and return metadata.
fn save_screenshot(
    image: DynamicImage,
    width: u32,
    height: u32,
    capture_mode: CaptureMode,
    screenshots_dir: &Path,
) -> Result<ScreenshotData> {
    std::fs::create_dir_all(screenshots_dir)
        .context("Failed to create screenshots directory")?;

    let id = Uuid::new_v4().to_string();
    let timestamp = chrono::Local::now().format("%H:%M:%S").to_string();
    let filename = format!("screenshot_{}_{}.png",
        chrono::Local::now().format("%Y%m%d_%H%M%S"),
        &id[..8]
    );
    let file_path = screenshots_dir.join(&filename);

    // Save full-size PNG
    image
        .save(&file_path)
        .context("Failed to save screenshot PNG")?;

    // Generate thumbnail
    let thumbnail_base64 = generate_thumbnail(&image, THUMBNAIL_MAX_WIDTH)?;

    // Get recording elapsed time if actively recording
    let recording_elapsed_secs = recording_commands::get_recording_elapsed_secs();

    Ok(ScreenshotData {
        id,
        file_path: file_path.to_string_lossy().to_string(),
        thumbnail_base64,
        timestamp,
        recording_elapsed_secs,
        width,
        height,
        capture_mode,
    })
}

/// Generate a base64-encoded PNG thumbnail with max width constraint.
fn generate_thumbnail(image: &DynamicImage, max_width: u32) -> Result<String> {
    let thumb = if image.width() > max_width {
        let scale = max_width as f64 / image.width() as f64;
        let new_height = (image.height() as f64 * scale) as u32;
        image.resize(max_width, new_height, image::imageops::FilterType::Triangle)
    } else {
        image.clone()
    };

    let mut buf = Cursor::new(Vec::new());
    let encoder = PngEncoder::new(&mut buf);
    encoder.write_image(
        thumb.as_bytes(),
        thumb.width(),
        thumb.height(),
        thumb.color().into(),
    ).context("Failed to encode thumbnail PNG")?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(buf.into_inner());
    Ok(format!("data:image/png;base64,{}", b64))
}

/// Generate a thumbnail from a screenshot file on disk.
/// Used when loading screenshots.json for the meeting details page.
pub fn generate_thumbnail_from_path(file_path: &Path) -> Result<String> {
    let image = image::open(file_path)
        .with_context(|| format!("Failed to open image: {}", file_path.display()))?;
    generate_thumbnail(&image, THUMBNAIL_MAX_WIDTH)
}

/// Get or create a screenshots directory under the given base path.
pub fn get_screenshots_dir(base_dir: &Path) -> PathBuf {
    base_dir.join("screenshots")
}
