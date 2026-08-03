//! Tauri commands + window/watcher glue for the global quick-capture bar. See `mod.rs`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use log::{error, info, warn};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, Runtime, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use super::{Clip, QuickCaptureState, QUICK_CAPTURE_WINDOW_LABEL};
use crate::api::api::DEFAULT_CLIENTS_ROOT;
use crate::audio::recording_preferences::get_default_recordings_folder;
use crate::database::repositories::{project::ProjectRepository, setting::SettingsRepository};
use crate::state::AppState;

const WIN_W: f64 = 640.0;
const WIN_H: f64 = 220.0;

/// Create the quick-capture window (hidden) if it does not already exist. Frameless,
/// always-on-top, off the taskbar, non-resizable, and pointed at the local `/capture`
/// route so its UI is plain React (and Playwright-testable at :3118). Closes on blur.
fn ensure_window<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, String> {
    if let Some(win) = app.get_webview_window(QUICK_CAPTURE_WINDOW_LABEL) {
        return Ok(win);
    }
    info!("Creating quick-capture window at /capture");
    let win = WebviewWindowBuilder::new(
        app,
        QUICK_CAPTURE_WINDOW_LABEL,
        WebviewUrl::App("capture".into()),
    )
    .title("Tandem Quick Capture")
    .inner_size(WIN_W, WIN_H)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .build()
    .map_err(|e| format!("failed to create quick-capture window: {e}"))?;

    // Dismiss on blur so the always-on-top bar can never become a zombie: if the user
    // clicks away (or Alt-Tabs), it closes and saves nothing. We only act on a blur AFTER
    // the window has actually gained focus once, so a slow first paint (cold Next.js
    // compile, delayed OS focus grant) cannot let a pre-focus blur close the bar before the
    // user ever interacts with it. This is robust regardless of how long build->visible takes.
    let has_focused = Arc::new(AtomicBool::new(false));
    let has_focused_ev = has_focused.clone();
    let win_for_events = win.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::Focused(focused) = event {
            if *focused {
                has_focused_ev.store(true, Ordering::Relaxed);
            } else if has_focused_ev.load(Ordering::Relaxed) {
                let _ = win_for_events.close();
            }
        }
    });

    Ok(win)
}

/// Position the bar centered horizontally in the upper third of the current monitor.
fn position_upper_third<R: Runtime>(win: &WebviewWindow<R>) {
    let monitor = match win.current_monitor().ok().flatten().or_else(|| win.primary_monitor().ok().flatten()) {
        Some(m) => m,
        None => return, // no monitor info: leave the OS default placement
    };
    let size = monitor.size();
    let origin = monitor.position();
    let scale = monitor.scale_factor();
    let win_w = WIN_W * scale;
    let win_h = WIN_H * scale;
    let x = origin.x as f64 + ((size.width as f64) - win_w).max(0.0) / 2.0;
    // Upper third: one sixth of the remaining vertical space from the top.
    let y = origin.y as f64 + ((size.height as f64) - win_h).max(0.0) / 6.0;
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// Toggle the bar: open it (create + position + focus) if closed, dismiss it if open. Called
/// from both the global-shortcut handler and the `quick_capture_open` command. No-op while the
/// feature is disabled.
pub fn open_or_toggle<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<Arc<QuickCaptureState>>();
    if !state.enabled() {
        info!("Quick capture hotkey ignored (feature disabled)");
        return;
    }
    if let Some(win) = app.get_webview_window(QUICK_CAPTURE_WINDOW_LABEL) {
        // Already open: a second hotkey press dismisses it (no duplicate windows).
        let _ = win.close();
        return;
    }
    match ensure_window(app) {
        Ok(win) => {
            position_upper_third(&win);
            let _ = win.show();
            let _ = win.set_focus();
        }
        Err(e) => error!("Failed to open quick-capture bar: {e}"),
    }
}

/// Open (or toggle) the quick-capture bar. Idempotent.
#[tauri::command]
pub async fn quick_capture_open<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    open_or_toggle(&app);
    Ok(())
}

/// Close the quick-capture bar (used by Esc and after a save). Saves nothing.
#[tauri::command]
pub async fn quick_capture_close<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(QUICK_CAPTURE_WINDOW_LABEL) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Return the current rolling clipboard buffer (most recent first) for the bar to preview.
#[tauri::command]
pub async fn get_quick_capture_clips(
    state: State<'_, Arc<QuickCaptureState>>,
) -> Result<Vec<Clip>, String> {
    Ok(state.clips())
}

/// Enable/disable the feature. Disabling stops the watcher from recording and clears the buffer.
#[tauri::command]
pub async fn set_quick_capture_enabled(
    state: State<'_, Arc<QuickCaptureState>>,
    enabled: bool,
) -> Result<(), String> {
    state.set_enabled(enabled);
    info!("Quick capture {}", if enabled { "enabled" } else { "disabled" });
    Ok(())
}

/// Normalize a path for prefix comparison: forward slashes, no trailing slash, lowercased.
fn normalize(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// True if `fname` (a bare filename) is a reserved Windows device name, which the OS treats
/// specially regardless of extension (CON, PRN, AUX, NUL, COM1-9, LPT1-9). The check is on the
/// stem before the first dot and is case-insensitive.
fn is_reserved_windows_name(fname: &str) -> bool {
    let stem = fname.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

/// Validate that `project_path` is under a known root before we ever write to it. Allowed roots:
/// the configured clients folder, every registered project's path, and the default recordings
/// folder. Rejects traversal outright. Returns the vetted destination directory.
async fn validate_project_path(
    state: &State<'_, AppState>,
    project_path: &str,
) -> Result<PathBuf, String> {
    let target = normalize(project_path);
    if target.is_empty() {
        return Err("Empty destination path".to_string());
    }
    // Reject real traversal (a `..` path SEGMENT), but not a folder that merely contains
    // two consecutive dots in its name (e.g. "R&D..Phase2").
    if target.split('/').any(|seg| seg == "..") {
        return Err("Path traversal is not allowed".to_string());
    }

    let pool = state.db_manager.pool();
    // Each root carries whether an EXACT match is allowed. A registered project or the
    // recordings folder may be written to directly; the clients root is a container only,
    // so notes must land in one of its subfolders (a specific client), never generically
    // in the bare clients root itself.
    let mut roots: Vec<(String, bool)> = Vec::new();

    // Clients root (falls back to the compiled default): subfolders only.
    let clients_root = SettingsRepository::get_clients_root(pool)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| DEFAULT_CLIENTS_ROOT.to_string());
    roots.push((normalize(&clients_root), false));

    // Default recordings folder (the safe "Unfiled" fallback destination): exact ok.
    roots.push((normalize(&get_default_recordings_folder().to_string_lossy()), true));

    // Every registered project path: exact ok.
    if let Ok(projects) = ProjectRepository::list_projects(pool).await {
        for p in projects {
            roots.push((normalize(&p.path), true));
        }
    }

    let allowed = roots.iter().any(|(root, allow_exact)| {
        !root.is_empty()
            && ((*allow_exact && target == *root) || target.starts_with(&format!("{root}/")))
    });
    if !allowed {
        warn!("Rejected quick-capture save outside known roots: {project_path}");
        return Err("Destination is not under a known project or the recordings folder".to_string());
    }

    Ok(PathBuf::from(project_path.replace('\\', "/")))
}

/// True when `child`, after fully resolving symlinks/junctions, still lives inside `root`
/// (also resolved). Used as the last line of defense before writing: a `.tandem` (or `notes`)
/// directory that is secretly a junction/symlink pointing outside the vetted project would
/// otherwise let `fs::write` escape the root even though the string path passed prefix checks.
fn resolved_within(child: &Path, root: &Path) -> Result<bool, String> {
    let canon_child = std::fs::canonicalize(child)
        .map_err(|e| format!("Failed to resolve note directory: {e}"))?;
    let canon_root = std::fs::canonicalize(root)
        .map_err(|e| format!("Failed to resolve project directory: {e}"))?;
    Ok(canon_child.starts_with(&canon_root))
}

/// Save a quick-capture note into `<project_path>/.tandem/notes/<filename>`.
///
/// Narrowly scoped on purpose (NOT a general file-write primitive): the destination must be
/// under a known project/recordings root, the filename may not contain separators or `..`, and
/// an existing file is never overwritten (a numeric suffix is appended). `content` is the
/// already-rendered markdown (built + unit-tested in the frontend's quickCapture.ts). Returns
/// the absolute path written.
#[tauri::command]
pub async fn save_quick_capture<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    project_path: String,
    project_name: Option<String>,
    filename: String,
    content: String,
) -> Result<String, String> {
    // 1. Filename must be a bare, safe name. Beyond separators and `..`, reject Windows-only
    //    tricks: `:` (NTFS alternate-data-stream syntax, e.g. "note:hidden.md") and reserved
    //    device names (CON, PRN, NUL, AUX, COM1-9, LPT1-9). The filename is machine-generated by
    //    quickCaptureFilename(), so this is defense-in-depth against a direct invoke() bypass.
    let fname = filename.trim();
    if fname.is_empty()
        || fname.contains('/')
        || fname.contains('\\')
        || fname.contains("..")
        || fname.contains(':')
        || fname.chars().any(|c| c.is_control())
        || !fname.ends_with(".md")
        || is_reserved_windows_name(fname)
    {
        return Err("Invalid note filename".to_string());
    }

    // 2. Destination must be inside a known root.
    let target_dir = validate_project_path(&state, &project_path).await?;

    // 3. Ensure the notes directory exists.
    let notes_dir = target_dir.join(".tandem").join("notes");
    std::fs::create_dir_all(&notes_dir)
        .map_err(|e| format!("Failed to create notes folder: {e}"))?;

    // 3b. Symlink/junction escape check: the string path passed the prefix vetting, but a
    //     `.tandem`/`notes` directory that is really a junction could resolve outside the root.
    //     Refuse to write if the RESOLVED notes directory is not inside the resolved project root.
    if !resolved_within(&notes_dir, &target_dir)? {
        warn!("Rejected quick-capture save: notes dir resolves outside the project root ({project_path})");
        return Err("Destination resolves outside the project folder".to_string());
    }

    // 4. Never overwrite: create the file atomically (create_new), bumping -2, -3, ... on
    //    collision. Using an exclusive create closes the TOCTOU window that a separate
    //    exists()-then-write check left open between two concurrent saves.
    let stem = Path::new(fname)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "quick-capture".to_string());
    let mut candidate = notes_dir.join(fname);
    let mut n = 2u32;
    let mut file = loop {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(f) => break f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                candidate = notes_dir.join(format!("{stem}-{n}.md"));
                n += 1;
            }
            Err(e) => return Err(format!("Failed to write note: {e}")),
        }
    };
    use std::io::Write as _;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("Failed to write note: {e}"))?;

    let path_str = candidate.to_string_lossy().to_string();
    info!("Quick-capture note saved: {path_str}");

    // Confirmation for the main window (a toast), naming the destination so a misroute is visible.
    let _ = app.emit(
        "quick-capture-saved",
        serde_json::json!({ "path": path_str, "project": project_name }),
    );

    Ok(path_str)
}

/// After (or instead of) saving, hand the captured content to the AI panel: focus the main
/// window and emit `quick-capture-to-ai` for the renderer to inject as context.
#[tauri::command]
pub async fn quick_capture_send_to_ai<R: Runtime>(
    app: AppHandle<R>,
    content: String,
    project_name: Option<String>,
) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
    app.emit(
        "quick-capture-to-ai",
        serde_json::json!({ "content": content, "project": project_name }),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ─── New inquiry: create a client folder straight from the bar ───────────────
//
// A capture that matches no project is usually a NEW client arriving (an Upwork invite,
// a cold email). These commands turn that capture into a folder under the clients root.
// All the markdown is built and unit-tested in the frontend's quickCapture.ts; Rust owns
// only the filesystem work, and re-validates the name and destination independently
// because a renderer value is never trusted here.

/// Outcome of `create_inquiry`, shaped so the UI can report honestly and undo precisely.
#[derive(serde::Serialize)]
pub struct InquiryResult {
    /// Absolute path of the inquiry folder.
    pub path: String,
    /// True when THIS call created the folder; false when it adopted an existing one.
    pub created: bool,
    /// Project-relative paths this call actually wrote. Undo removes exactly these and
    /// nothing else, so a folder that already held work is never destroyed.
    pub written: Vec<String>,
}

/// True when `name` is usable as a single folder segment. Mirrors the frontend's
/// `sanitizeFolderName`, but as a REJECTION check rather than a repair: by this point the
/// name has been shown to the user, so silently altering it here would create a folder
/// they did not agree to.
fn is_safe_segment(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && !name.contains('/')
        && !name.contains('\\')
        // Only the traversal segments themselves are dangerous. A name that merely
        // CONTAINS two dots ("R&D..Phase2") is a legitimate folder, and rejecting it
        // would contradict validate_project_path, which allows exactly that.
        && name != "."
        && name != ".."
        && !name.contains(':')
        && !name.chars().any(|c| c.is_control())
        && !name.chars().any(|c| matches!(c, '<' | '>' | '"' | '|' | '?' | '*'))
        // Windows silently drops these, so the folder on disk would not match the name
        // we hand back to the UI (and to createProject).
        && !name.ends_with('.')
        && !name.ends_with(' ')
        && !name.starts_with(' ')
        && !is_reserved_windows_name(name)
}

/// The configured clients root (or the compiled default), normalized.
async fn clients_root_normalized(state: &State<'_, AppState>) -> String {
    let root = SettingsRepository::get_clients_root(state.db_manager.pool())
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| DEFAULT_CLIENTS_ROOT.to_string());
    normalize(&root)
}

/// Validate that `base_path` is the clients root itself or a folder beneath it. Inquiry
/// folders may only ever be created inside the clients tree: this command creates
/// directories, so a loose destination check would turn it into an arbitrary-mkdir
/// primitive reachable from the renderer.
async fn validate_inquiry_base(
    state: &State<'_, AppState>,
    base_path: &str,
) -> Result<PathBuf, String> {
    let target = normalize(base_path);
    if target.is_empty() {
        return Err("Empty destination".to_string());
    }
    if target.split('/').any(|seg| seg == "..") {
        return Err("Path traversal is not allowed".to_string());
    }
    let root = clients_root_normalized(state).await;
    if root.is_empty() {
        return Err("No clients root is configured".to_string());
    }
    if target != root && !target.starts_with(&format!("{root}/")) {
        warn!("Rejected inquiry outside the clients root: {base_path}");
        return Err("New inquiries can only be created inside the clients folder".to_string());
    }
    let base = PathBuf::from(base_path.replace('\\', "/"));
    if !base.is_dir() {
        return Err(format!("Destination folder does not exist: {base_path}"));
    }
    Ok(base)
}

/// Write `content` to `path` only if nothing is there yet. Returns true when written.
/// `create_new` makes the check and the write one atomic step, so two captures racing
/// on the same folder cannot clobber each other's file.
fn write_if_absent(path: &Path, content: &str) -> Result<bool, String> {
    match std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut f) => {
            use std::io::Write as _;
            f.write_all(content.as_bytes())
                .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(format!("Failed to write {}: {e}", path.display())),
    }
}

/// Create (or adopt) an inquiry folder under the clients root and seed it.
///
/// Fresh folder: writes `brief.md` (the full document) and `CLAUDE.md`.
/// Existing folder: appends `brief_append` to `brief.md` and leaves `CLAUDE.md` alone,
/// because an existing folder may be a real project whose instructions must not be
/// touched. Never overwrites an existing file under any path.
#[tauri::command]
pub async fn create_inquiry(
    state: State<'_, AppState>,
    base_path: String,
    name: String,
    brief: String,
    brief_append: String,
    claude_md: String,
) -> Result<InquiryResult, String> {
    let name = name.trim().to_string();
    if !is_safe_segment(&name) {
        return Err("That name cannot be used as a folder name".to_string());
    }
    let base = validate_inquiry_base(&state, &base_path).await?;
    seed_inquiry_folder(&base, &name, &brief, &brief_append, &claude_md)
}

/// The filesystem half of `create_inquiry`, split out so it is testable without an
/// AppState/database: the command above owns validation, this owns the writes.
fn seed_inquiry_folder(
    base: &Path,
    name: &str,
    brief: &str,
    brief_append: &str,
    claude_md: &str,
) -> Result<InquiryResult, String> {
    let dir = base.join(name);

    // create_dir (not create_dir_all): the parent is already vetted, and the
    // AlreadyExists error is exactly how we learn this is an adoption, not a creation.
    let created = match std::fs::create_dir(&dir) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(e) => return Err(format!("Failed to create folder: {e}")),
    };

    // The string path passed the prefix check, but a junction/symlink in the chain could
    // still resolve outside the clients tree. Refuse before writing anything into it.
    if !resolved_within(&dir, base)? {
        warn!("Rejected inquiry: folder resolves outside the clients root ({})", base.display());
        if created {
            let _ = std::fs::remove_dir(&dir);
        }
        return Err("That folder resolves outside the clients folder".to_string());
    }

    let mut written: Vec<String> = Vec::new();
    let brief_path = dir.join("brief.md");
    if write_if_absent(&brief_path, brief)? {
        written.push("brief.md".to_string());
    } else if !brief_append.trim().is_empty() {
        // Adoption: append instead of overwrite. Not recorded in `written` because an
        // append cannot be undone by deleting the file.
        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&brief_path)
            .map_err(|e| format!("Failed to open brief.md: {e}"))?;
        f.write_all(brief_append.as_bytes())
            .map_err(|e| format!("Failed to append to brief.md: {e}"))?;
    }

    // Only ever seeded on a folder we just created: overwriting or appending to an
    // existing CLAUDE.md would corrupt a real project's instructions.
    if created && write_if_absent(&dir.join("CLAUDE.md"), claude_md)? {
        written.push("CLAUDE.md".to_string());
    }

    let path_str = dir.to_string_lossy().to_string();
    info!(
        "Inquiry folder {}: {path_str}",
        if created { "created" } else { "adopted" }
    );
    Ok(InquiryResult { path: path_str, created, written })
}

/// Undo a just-created inquiry, conservatively.
///
/// Removes exactly the files `create_inquiry` (and the follow-up note save) reported
/// writing, prunes the directories that this leaves empty, then removes the folder only
/// if it is empty. Anything else present means the user (or an editor, or a Claude
/// session) has already put work there, so the folder stays and we return false. An undo
/// that could delete unrelated work is worse than no undo at all.
#[tauri::command]
pub async fn undo_inquiry(
    state: State<'_, AppState>,
    path: String,
    written: Vec<String>,
) -> Result<bool, String> {
    let target = normalize(&path);
    let root = clients_root_normalized(&state).await;
    if root.is_empty() || target == root || !target.starts_with(&format!("{root}/")) {
        return Err("Refusing to remove a folder outside the clients folder".to_string());
    }
    undo_inquiry_at(&PathBuf::from(path.replace('\\', "/")), &written)
}

/// The filesystem half of `undo_inquiry`, split out so the destructive path can be tested
/// directly against a temp directory. The caller has already proven `dir` is inside the
/// clients root.
fn undo_inquiry_at(dir: &Path, written: &[String]) -> Result<bool, String> {
    if !dir.is_dir() {
        return Ok(true); // already gone
    }

    // Remove the recorded files. Each entry must be a plain relative path: a `..` or an
    // absolute path here would let a crafted call delete outside the folder.
    let mut dirs_touched: Vec<PathBuf> = Vec::new();
    for rel in written {
        let rel_norm = rel.replace('\\', "/");
        if rel_norm.starts_with('/')
            || rel_norm.contains(':')
            || rel_norm.split('/').any(|s| s == ".." || s.is_empty())
        {
            return Err(format!("Invalid path in undo list: {rel}"));
        }
        let file = dir.join(&rel_norm);
        if file.is_file() {
            std::fs::remove_file(&file).map_err(|e| format!("Failed to remove {rel}: {e}"))?;
        }
        if let Some(parent) = file.parent() {
            if parent != dir {
                dirs_touched.push(parent.to_path_buf());
            }
        }
    }

    // Prune the directories those files lived in, deepest first, stopping at the folder
    // root. remove_dir only succeeds on an empty directory, so this can never take
    // anything with it.
    dirs_touched.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
    for d in dirs_touched {
        let mut cur = d;
        while cur.starts_with(dir) && cur != dir {
            if std::fs::remove_dir(&cur).is_err() {
                break; // not empty: stop climbing
            }
            match cur.parent() {
                Some(p) => cur = p.to_path_buf(),
                None => break,
            }
        }
    }

    let empty = std::fs::read_dir(dir)
        .map_err(|e| format!("Failed to inspect folder: {e}"))?
        .next()
        .is_none();
    if !empty {
        info!("Inquiry undo kept a non-empty folder: {}", dir.display());
        return Ok(false);
    }
    std::fs::remove_dir(dir).map_err(|e| format!("Failed to remove folder: {e}"))?;
    info!("Inquiry undo removed: {}", dir.display());
    Ok(true)
}

/// Locate the Antigravity launcher. Ordered so a user can always override:
/// `TANDEM_IDE_COMMAND`, then the per-user install (LOCALAPPDATA is not always on C:),
/// then whatever `antigravity` resolves to on PATH.
fn resolve_ide_command() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("TANDEM_IDE_COMMAND") {
        let p = PathBuf::from(custom.trim());
        if p.is_file() {
            return Some(p);
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            // The GUI exe, not bin\antigravity.cmd: launching the .cmd needs cmd.exe and
            // flashes a console window on every open.
            let exe = PathBuf::from(local)
                .join("Programs")
                .join("Antigravity")
                .join("Antigravity.exe");
            if exe.is_file() {
                return Some(exe);
            }
        }
    }
    // PATH fallback (also the non-Windows path).
    let exe_name = if cfg!(target_os = "windows") { "antigravity.cmd" } else { "antigravity" };
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|d| d.join(exe_name))
            .find(|p| p.is_file())
    })
}

/// Open a folder in Antigravity in a NEW window, leaving other windows untouched.
/// Fire-and-forget: we do not wait for the IDE, we only report whether it started.
#[tauri::command]
pub async fn open_in_antigravity(state: State<'_, AppState>, path: String) -> Result<(), String> {
    // Only ever open folders inside the clients tree: this spawns a process with a
    // renderer-supplied argument, so the destination is constrained just like the writes.
    let target = normalize(&path);
    let root = clients_root_normalized(&state).await;
    if root.is_empty() || !target.starts_with(&format!("{root}/")) {
        return Err("Refusing to open a folder outside the clients folder".to_string());
    }
    if !PathBuf::from(path.replace('\\', "/")).is_dir() {
        return Err(format!("Folder not found: {path}"));
    }
    let cmd = resolve_ide_command()
        .ok_or_else(|| "Antigravity was not found. Set TANDEM_IDE_COMMAND to its executable.".to_string())?;

    let mut command = std::process::Command::new(&cmd);
    command.arg("-n").arg(&path);
    #[cfg(target_os = "windows")]
    {
        // CREATE_NO_WINDOW: without it the .cmd fallback flashes a console window.
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(0x0800_0000);
    }
    command
        .spawn()
        .map_err(|e| format!("Failed to launch Antigravity: {e}"))?;
    info!("Opened in Antigravity: {path}");
    Ok(())
}

/// Spawn the background clipboard watcher. While the feature is enabled it polls the current
/// clipboard text every ~1.5s and rolls it into the memory-only buffer (consecutive dupes
/// collapse). Text only this pass. Never logs clipboard contents.
pub fn spawn_clipboard_watcher(state: Arc<QuickCaptureState>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            if !state.enabled() {
                continue;
            }
            let state_for_blocking = state.clone();
            let _ = tokio::task::spawn_blocking(move || {
                match arboard::Clipboard::new() {
                    Ok(mut clipboard) => {
                        if let Ok(text) = clipboard.get_text() {
                            state_for_blocking.push_text(text);
                        }
                    }
                    Err(_) => { /* clipboard busy/unavailable: try again next tick */ }
                }
            })
            .await;
        }
    });
}

#[cfg(test)]
mod inquiry_tests {
    use super::*;

    fn seed(base: &Path, name: &str) -> InquiryResult {
        seed_inquiry_folder(base, name, "BRIEF BODY\n", "\n## Follow-up\n\nMORE\n", "CLAUDE BODY\n")
            .expect("seed failed")
    }

    #[test]
    fn creates_the_folder_with_both_seed_files() {
        let tmp = tempfile::tempdir().unwrap();
        let r = seed(tmp.path(), "Acme Corp");

        assert!(r.created);
        assert_eq!(r.written, vec!["brief.md".to_string(), "CLAUDE.md".to_string()]);
        let dir = tmp.path().join("Acme Corp");
        assert_eq!(std::fs::read_to_string(dir.join("brief.md")).unwrap(), "BRIEF BODY\n");
        assert_eq!(std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap(), "CLAUDE BODY\n");
    }

    #[test]
    fn adopting_appends_to_the_brief_and_never_touches_claude_md() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("Existing");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("brief.md"), "ORIGINAL\n").unwrap();
        std::fs::write(dir.join("CLAUDE.md"), "PROJECT RULES\n").unwrap();

        let r = seed(tmp.path(), "Existing");

        assert!(!r.created, "an existing folder must be reported as adopted");
        assert!(r.written.is_empty(), "an append is not undoable, so nothing may be listed");
        let brief = std::fs::read_to_string(dir.join("brief.md")).unwrap();
        assert!(brief.starts_with("ORIGINAL\n"), "the original brief must survive");
        assert!(brief.contains("MORE"), "the new capture must be appended");
        // The whole point: a real project's instructions are not ours to overwrite.
        assert_eq!(std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap(), "PROJECT RULES\n");
    }

    #[test]
    fn adopting_a_folder_without_a_brief_creates_one() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("Bare");
        std::fs::create_dir(&dir).unwrap();

        let r = seed(tmp.path(), "Bare");
        assert!(!r.created);
        // brief.md was absent so it was written, but CLAUDE.md is only ever seeded on a
        // folder we created ourselves.
        assert_eq!(r.written, vec!["brief.md".to_string()]);
        assert!(!dir.join("CLAUDE.md").exists());
    }

    #[test]
    fn undo_removes_exactly_what_was_written() {
        let tmp = tempfile::tempdir().unwrap();
        let r = seed(tmp.path(), "Acme");
        let dir = tmp.path().join("Acme");

        assert!(undo_inquiry_at(&dir, &r.written).unwrap());
        assert!(!dir.exists(), "a pristine inquiry folder should be gone");
    }

    #[test]
    fn undo_keeps_a_folder_that_has_other_work_in_it() {
        let tmp = tempfile::tempdir().unwrap();
        let r = seed(tmp.path(), "Acme");
        let dir = tmp.path().join("Acme");
        // The user (or an IDE, or a Claude session) already put something here.
        std::fs::write(dir.join("proposal.md"), "hours of work").unwrap();

        assert!(!undo_inquiry_at(&dir, &r.written).unwrap(), "must report it did not remove");
        assert!(dir.exists());
        assert!(dir.join("proposal.md").exists(), "unrelated work must never be deleted");
        // Our own seed files are still cleaned up.
        assert!(!dir.join("brief.md").exists());
    }

    #[test]
    fn undo_prunes_nested_dirs_it_emptied_but_not_ones_it_did_not() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("Acme");
        std::fs::create_dir_all(dir.join(".tandem").join("notes")).unwrap();
        std::fs::write(dir.join(".tandem").join("notes").join("n.md"), "x").unwrap();

        assert!(undo_inquiry_at(&dir, &[".tandem/notes/n.md".to_string()]).unwrap());
        assert!(!dir.exists(), "emptied parents should be pruned all the way up");

        // Now the same shape, but with a sibling file that must hold the tree open.
        let dir2 = tmp.path().join("Beta");
        std::fs::create_dir_all(dir2.join(".tandem").join("notes")).unwrap();
        std::fs::write(dir2.join(".tandem").join("notes").join("n.md"), "x").unwrap();
        std::fs::write(dir2.join(".tandem").join("keep.md"), "keep").unwrap();

        assert!(!undo_inquiry_at(&dir2, &[".tandem/notes/n.md".to_string()]).unwrap());
        assert!(dir2.join(".tandem").join("keep.md").exists());
        assert!(!dir2.join(".tandem").join("notes").exists(), "the emptied leaf still goes");
    }

    #[test]
    fn undo_refuses_a_traversal_in_the_written_list() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("Acme");
        std::fs::create_dir(&dir).unwrap();
        let outside = tmp.path().join("secret.txt");
        std::fs::write(&outside, "do not delete").unwrap();

        for evil in ["../secret.txt", "..\\secret.txt", "/etc/passwd", "C:/Windows/x"] {
            let res = undo_inquiry_at(&dir, &[evil.to_string()]);
            assert!(res.is_err(), "{evil} should be rejected");
        }
        assert!(outside.exists(), "nothing outside the folder may be touched");
    }

    #[test]
    fn undo_on_a_missing_folder_is_a_no_op_success() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(undo_inquiry_at(&tmp.path().join("never-existed"), &[]).unwrap());
    }

    #[test]
    fn rejects_names_that_would_escape_or_confuse_the_filesystem() {
        for bad in [
            "", "..", "a/b", "a\\b", "../etc", "C:evil", "con", "COM1", "PRN",
            "trailing.", "trailing ", " leading", "has\u{0}null", "q?", "s*", "p|pe",
        ] {
            assert!(!is_safe_segment(bad), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn accepts_the_names_the_frontend_actually_produces() {
        for ok in [
            "Acme Corp", "Brand-Upgrade & Co. Ltd", "n8n developer", "Project 2",
            "CONSOLE", "COM0", "Acme (rush)", "R&D..Phase2",
        ] {
            assert!(is_safe_segment(ok), "{ok:?} must be accepted");
        }
    }
}
