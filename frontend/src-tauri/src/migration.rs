//! Data migration from Meetily to Tandem.
//!
//! Runs once on first launch after the rebrand. Moves app data, models,
//! recordings, and config from old Meetily paths to new Tandem paths.
//! Writes a `.tandem-migrated` flag file to prevent re-running.

use std::fs;
use std::path::{Path, PathBuf};

/// Run all data migrations. Safe to call on every launch — it checks
/// a flag file and exits early if migration was already completed.
pub fn run_migration() {
    let flag_path = match migration_flag_path() {
        Some(p) => p,
        None => {
            log::warn!("Migration: Could not determine flag path, skipping");
            return;
        }
    };

    if flag_path.exists() {
        log::debug!("Migration: Already completed (flag exists at {})", flag_path.display());
        return;
    }

    log::info!("Migration: Starting Meetily → Tandem data migration...");

    let mut any_migrated = false;

    // 1. App data dir: com.meetily.ai → com.tandem.ai
    if let Some(data_dir) = dirs::data_dir() {
        any_migrated |= migrate_dir(
            &data_dir.join("com.meetily.ai"),
            &data_dir.join("com.tandem.ai"),
            "app data",
        );
    }

    // 2. Model dirs: Meetily/models → Tandem/models
    if let Some(data_dir) = dirs::data_dir() {
        any_migrated |= migrate_dir(
            &data_dir.join("Meetily"),
            &data_dir.join("Tandem"),
            "models",
        );
    }

    // 3. Recording dirs (platform-specific)
    #[cfg(target_os = "windows")]
    {
        if let Some(music_dir) = dirs::audio_dir() {
            any_migrated |= migrate_dir(
                &music_dir.join("meetily-recordings"),
                &music_dir.join("tandem-recordings"),
                "recordings",
            );
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(video_dir) = dirs::video_dir() {
            any_migrated |= migrate_dir(
                &video_dir.join("meetily-recordings"),
                &video_dir.join("tandem-recordings"),
                "recordings",
            );
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Some(doc_dir) = dirs::document_dir() {
            any_migrated |= migrate_dir(
                &doc_dir.join("meetily-recordings"),
                &doc_dir.join("tandem-recordings"),
                "recordings",
            );
        }
    }

    // 4. Notification settings: ~/.config/meetily → ~/.config/tandem
    if let Some(config_dir) = dirs::config_dir() {
        any_migrated |= migrate_dir(
            &config_dir.join("meetily"),
            &config_dir.join("tandem"),
            "notification settings",
        );
    }

    // Write migration flag regardless of whether anything was migrated,
    // so we don't keep checking on every launch.
    if let Some(parent) = flag_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    match fs::write(&flag_path, format!("migrated={}", chrono::Utc::now())) {
        Ok(_) => log::info!("Migration: Flag written to {}", flag_path.display()),
        Err(e) => log::warn!("Migration: Failed to write flag: {}", e),
    }

    if any_migrated {
        log::info!("Migration: Meetily → Tandem data migration complete");
    } else {
        log::info!("Migration: No Meetily data directories found to migrate");
    }
}

/// Attempt to move `src` to `dst`. Uses rename first (atomic), falls back
/// to recursive copy + delete. Returns true if migration actually occurred.
fn migrate_dir(src: &Path, dst: &Path, label: &str) -> bool {
    if !src.exists() {
        log::debug!("Migration [{}]: Source not found: {}", label, src.display());
        return false;
    }

    if dst.exists() {
        log::info!(
            "Migration [{}]: Destination already exists ({}), skipping",
            label,
            dst.display()
        );
        return false;
    }

    // Ensure parent directory exists
    if let Some(parent) = dst.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            log::error!(
                "Migration [{}]: Failed to create parent dir {}: {}",
                label,
                parent.display(),
                e
            );
            return false;
        }
    }

    // Try atomic rename first
    match fs::rename(src, dst) {
        Ok(_) => {
            log::info!(
                "Migration [{}]: Renamed {} → {}",
                label,
                src.display(),
                dst.display()
            );
            return true;
        }
        Err(e) => {
            log::debug!(
                "Migration [{}]: Rename failed ({}), trying copy fallback",
                label,
                e
            );
        }
    }

    // Fallback: recursive copy then delete source
    match copy_dir_recursive(src, dst) {
        Ok(_) => {
            log::info!(
                "Migration [{}]: Copied {} → {}",
                label,
                src.display(),
                dst.display()
            );
            if let Err(e) = fs::remove_dir_all(src) {
                log::warn!(
                    "Migration [{}]: Copied successfully but failed to remove old dir: {}",
                    label,
                    e
                );
            }
            true
        }
        Err(e) => {
            log::error!(
                "Migration [{}]: Failed to copy {} → {}: {}",
                label,
                src.display(),
                dst.display(),
                e
            );
            // Clean up partial copy
            let _ = fs::remove_dir_all(dst);
            false
        }
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

fn migration_flag_path() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("com.tandem.ai").join(".tandem-migrated"))
}
