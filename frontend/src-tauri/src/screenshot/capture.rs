use anyhow::{Context, Result};
use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::{DynamicImage, ImageEncoder, RgbaImage};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use uuid::Uuid;
use xcap::Monitor;

use super::types::{CaptureMode, ScreenshotData};
use crate::audio::recording_commands;

const THUMBNAIL_MAX_WIDTH: u32 = 200;

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
