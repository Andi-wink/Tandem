use anyhow::{Context, Result};
use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, RgbaImage};
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
/// Quality budget for the small list thumbnails, where size matters more than fidelity.
const THUMBNAIL_QUALITY: u8 = 40;
/// Width cap for an image embedded in an exported document. Wide enough to read a screenshot of
/// code or a dashboard on a printed page, small enough that a call with a dozen 4K captures does
/// not produce a document too heavy to open.
pub const EMBED_MAX_WIDTH: u32 = 1600;
/// Quality budget for embedded images. Higher than a thumbnail because this one is actually read.
const EMBED_QUALITY: u8 = 72;

// ── Pre-capture storage for region screenshots ──────────────────────────────
// The full-resolution RgbaImage is stored here after the hotkey fires.
// The frontend shows its selection overlay while this image waits in memory.
// When the user finishes drawing, we crop from this image instead of
// capturing the screen a second time.

static PRE_CAPTURED_IMAGE: LazyLock<Arc<StdMutex<Option<RgbaImage>>>> =
    LazyLock::new(|| Arc::new(StdMutex::new(None)));

/// Raw JPEG bytes of the pre-captured screen preview.
/// Stored separately so the frontend can fetch them via ipc::Response (raw binary)
/// instead of base64-encoding them into a JSON event (~200ms savings).
static PRE_CAPTURED_JPEG: LazyLock<Arc<StdMutex<Option<Vec<u8>>>>> =
    LazyLock::new(|| Arc::new(StdMutex::new(None)));

static REGION_CAPTURE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
pub struct PreCaptureResult {
    pub monitor_width: u32,
    pub monitor_height: u32,
}

/// Pre-capture the screen: store the raw RGBA image and a JPEG preview in memory.
/// The frontend fetches the JPEG bytes separately via `get_pre_capture_preview`
/// which returns raw bytes (no base64 overhead).
pub fn pre_capture_screen() -> Result<PreCaptureResult> {
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

    // Encode a half-resolution JPEG preview for the overlay backdrop.
    // Full-res RGBA stays in PRE_CAPTURED_IMAGE for the actual crop.
    // Downscaling = ~4x fewer pixels to encode + ~4x smaller transfer.
    // resize() borrows &raw_image — no clone of 33MB needed.
    let preview_width = monitor_width / 2;
    let preview_height = monitor_height / 2;
    let preview_rgba = image::imageops::resize(
        &raw_image,
        preview_width,
        preview_height,
        image::imageops::FilterType::Nearest,
    );
    let preview_rgb = DynamicImage::ImageRgba8(preview_rgba).to_rgb8();

    // Store raw image for later cropping (move, no clone)
    {
        let mut guard = PRE_CAPTURED_IMAGE
            .lock()
            .map_err(|e| anyhow::anyhow!("Lock poisoned: {}", e))?;
        *guard = Some(raw_image);
    }

    let mut buf = Cursor::new(Vec::with_capacity(200_000));
    let mut encoder = JpegEncoder::new_with_quality(&mut buf, 50);
    encoder
        .encode(
            preview_rgb.as_raw(),
            preview_rgb.width(),
            preview_rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .context("Failed to encode preview JPEG")?;

    let jpeg_bytes = buf.into_inner();

    info!(
        "Pre-captured screen: {}x{}, preview: {}x{}, JPEG: {} bytes",
        monitor_width, monitor_height,
        preview_width, preview_height,
        jpeg_bytes.len()
    );

    // Store JPEG preview bytes for frontend to fetch (hotkey path)
    if let Ok(mut guard) = PRE_CAPTURED_JPEG.lock() {
        *guard = Some(jpeg_bytes);
    }

    Ok(PreCaptureResult {
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

/// Crop a region from the pre-captured image and return a JPEG data URI for annotation preview.
/// Does NOT consume the stored image — it remains available for the final save.
pub fn crop_preview_from_pre_captured(
    x: i32,
    y: i32,
    region_width: u32,
    region_height: u32,
) -> Result<(String, u32, u32)> {
    let guard = PRE_CAPTURED_IMAGE
        .lock()
        .map_err(|e| anyhow::anyhow!("Lock poisoned: {}", e))?;

    let raw_image = guard
        .as_ref()
        .context("No pre-captured image available")?;

    let cropped = crop_image(raw_image, x, y, region_width, region_height)?;
    let w = cropped.width();
    let h = cropped.height();

    // Encode as JPEG (much faster than PNG, fine for annotation preview)
    let dynamic = DynamicImage::ImageRgba8(cropped);
    let rgb = dynamic.to_rgb8();
    let mut buf = Cursor::new(Vec::new());
    let mut encoder = JpegEncoder::new_with_quality(&mut buf, 50);
    encoder
        .encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .context("Failed to encode crop preview JPEG")?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(buf.into_inner());
    let data_uri = format!("data:image/jpeg;base64,{}", b64);

    info!(
        "Cropped preview from pre-captured: {}x{}, data URI length: {}",
        w, h, data_uri.len()
    );

    Ok((data_uri, w, h))
}

/// Take the stored JPEG preview bytes out of memory (consuming them).
/// Returns None if no preview is available.
pub fn take_pre_captured_jpeg() -> Option<Vec<u8>> {
    PRE_CAPTURED_JPEG.lock().ok()?.take()
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
    if let Ok(mut guard) = PRE_CAPTURED_JPEG.lock() {
        *guard = None;
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

    let sub = image::imageops::crop_imm(img, x0, y0, crop_w, crop_h);
    Ok(sub.to_image())
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

/// Generate a base64-encoded JPEG thumbnail with max width constraint.
fn generate_thumbnail(image: &DynamicImage, max_width: u32) -> Result<String> {
    encode_scaled_jpeg(image, max_width, THUMBNAIL_QUALITY)
}

/// Scale an image down to `max_width` (never up) and return it as a JPEG data URI.
///
/// Shared by the 200px list thumbnails and the far larger images embedded into an exported
/// handover document, which differ only in size and quality budget.
fn encode_scaled_jpeg(image: &DynamicImage, max_width: u32, quality: u8) -> Result<String> {
    let thumb = if image.width() > max_width {
        let scale = max_width as f64 / image.width() as f64;
        let new_height = (image.height() as f64 * scale) as u32;
        image.resize(max_width, new_height, image::imageops::FilterType::Triangle)
    } else {
        image.clone()
    };

    let rgb = thumb.to_rgb8();
    let mut buf = Cursor::new(Vec::new());
    let mut encoder = JpegEncoder::new_with_quality(&mut buf, quality);
    encoder
        .encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .context("Failed to encode thumbnail JPEG")?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(buf.into_inner());
    Ok(format!("data:image/jpeg;base64,{}", b64))
}

/// Generate a thumbnail from a screenshot file on disk.
/// Used when loading screenshots.json for the meeting details page.
pub fn generate_thumbnail_from_path(file_path: &Path) -> Result<String> {
    let image = image::open(file_path)
        .with_context(|| format!("Failed to open image: {}", file_path.display()))?;
    generate_thumbnail(&image, THUMBNAIL_MAX_WIDTH)
}

/// Read an image from disk and return it as a JPEG data URI sized for embedding in a document.
///
/// Returns a self-contained string so an exported handover document carries its own images and
/// stays readable after it is moved, copied or emailed, with no folder of assets alongside it.
pub fn generate_embed_data_uri(file_path: &Path, max_width: u32) -> Result<String> {
    let image = image::open(file_path)
        .with_context(|| format!("Failed to open image: {}", file_path.display()))?;
    encode_scaled_jpeg(&image, max_width, EMBED_QUALITY)
}

/// Save an annotated screenshot from a base64-encoded PNG data URI.
/// Decodes the image, saves to disk, generates thumbnail, and returns metadata.
pub fn save_from_base64(image_base64: &str, screenshots_dir: &Path) -> Result<ScreenshotData> {
    // Strip data URI prefix if present
    let raw_b64 = if let Some(pos) = image_base64.find(",") {
        &image_base64[pos + 1..]
    } else {
        image_base64
    };

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw_b64)
        .context("Failed to decode base64 image data")?;

    let dynamic = image::load_from_memory(&bytes)
        .context("Failed to decode image from base64 bytes")?;

    let width = dynamic.width();
    let height = dynamic.height();

    save_screenshot(dynamic, width, height, CaptureMode::Region, screenshots_dir)
}

/// Get or create a screenshots directory under the given base path.
pub fn get_screenshots_dir(base_dir: &Path) -> PathBuf {
    base_dir.join("screenshots")
}
