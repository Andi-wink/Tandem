//! F055: session-aware HUD + branch stamping.
//!
//! Two responsibilities:
//!   1. Resolve the current git branch of an arbitrary repo/worktree directory
//!      WITHOUT spawning `git` (reads `.git/HEAD`, follows worktree `gitdir:` files).
//!   2. Enumerate live, interactive Claude Code sessions from the local session
//!      registry, cross-referencing each session's transcript tail and the branch
//!      currently checked out in its working directory.
//!
//! PRIVACY: transcript tails are read only for the `gitBranch`, `cwd`, `type`,
//! `timestamp` keys and the session's own display-title records (`customTitle`
//! from `custom-title` lines, `aiTitle` from `ai-title` lines). As a fallback the
//! very FIRST qualifying user prompt is read to derive a display title (`title`)
//! shown to the user in their own HUD picker (the same text Claude Code's resume
//! picker shows). That title is never logged, persisted to disk, or sent anywhere
//! off the machine; no other message content is ever read out.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use crate::database::repositories::project::ProjectRepository;
use crate::state::AppState;

/// A live, interactive Claude Code session paired with the branch it thinks it is
/// on (from its transcript) and the branch actually checked out in its cwd.
///
/// Field names are plain snake_case, matching the serialization convention used by
/// `ProjectModel` and the other project commands.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeSessionCandidate {
    pub session_id: String,
    pub pid: u32,
    pub name: String,
    /// Human-readable display title: the session's first real user prompt (what
    /// Claude Code's resume picker shows). `None` when no qualifying prompt has
    /// been written yet. Preferred over `name` (an internal slug) for display.
    pub title: Option<String>,
    pub cwd: String,
    pub git_branch: Option<String>,
    pub head_branch: Option<String>,
    pub branch_mismatch: bool,
    pub kind: String,
    pub entrypoint: String,
    pub last_activity_ms: Option<i64>,
    pub last_user_activity_ms: Option<i64>,
    pub registered_project_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Git branch resolution (no `git` subprocess)
// ---------------------------------------------------------------------------

/// Parse the contents of a `HEAD` file.
///
/// - `ref: refs/heads/<branch>` -> `Some(branch)` (branch may contain slashes).
/// - a raw 40-char sha (detached HEAD) -> `Some("detached@<7 hex>")`.
/// - anything else -> `None`.
fn parse_head(content: &str) -> Option<String> {
    let content = content.trim();
    if let Some(rest) = content.strip_prefix("ref:") {
        let reference = rest.trim();
        let branch = reference.strip_prefix("refs/heads/")?;
        if branch.is_empty() {
            return None;
        }
        return Some(branch.to_string());
    }

    // Detached HEAD: the file holds a raw commit sha.
    if content.len() >= 7 && content.chars().all(|c| c.is_ascii_hexdigit()) {
        return Some(format!("detached@{}", &content[..7]));
    }

    None
}

/// Given a repo/worktree directory, locate its `HEAD` file, following the
/// worktree `gitdir:` indirection when `.git` is a file rather than a directory.
///
/// Returns `None` for any missing / dangling / malformed setup.
fn resolve_head_path(repo: &Path) -> Option<PathBuf> {
    let dot_git = repo.join(".git");
    let meta = std::fs::symlink_metadata(&dot_git).ok()?;

    if meta.is_dir() {
        let head = dot_git.join("HEAD");
        return head.exists().then_some(head);
    }

    // `.git` is a file (linked worktree): `gitdir: <path-to-worktree-gitdir>`.
    let content = std::fs::read_to_string(&dot_git).ok()?;
    let target = content.trim().strip_prefix("gitdir:")?.trim();
    if target.is_empty() {
        return None;
    }

    let target_path = PathBuf::from(target);
    let resolved = if target_path.is_absolute() {
        target_path
    } else {
        repo.join(target_path)
    };

    // Stale worktree: the referenced gitdir no longer exists.
    if !resolved.exists() {
        return None;
    }

    let head = resolved.join("HEAD");
    head.exists().then_some(head)
}

/// Resolve the current branch of `path`. Never errors: any IO/parse failure is `None`.
pub fn git_branch_for(path: &str) -> Option<String> {
    if path.is_empty() {
        return None;
    }
    let head_path = resolve_head_path(Path::new(path))?;
    let content = std::fs::read_to_string(head_path).ok()?;
    parse_head(&content)
}

// ---------------------------------------------------------------------------
// Registry parsing
// ---------------------------------------------------------------------------

/// A defensively-parsed session registry file. Unknown fields are ignored;
/// `pid` and `sessionId` are required (a file missing either is skipped).
#[derive(Debug, Clone, Deserialize)]
struct RegistryEntry {
    pid: Option<u32>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    cwd: Option<String>,
    name: Option<String>,
    kind: Option<String>,
    entrypoint: Option<String>,
}

/// Parse a single registry JSON object. Returns `None` if it does not parse or
/// is missing the identity fields (`pid`, `sessionId`).
fn parse_registry(content: &str) -> Option<RegistryEntry> {
    let entry: RegistryEntry = serde_json::from_str(content).ok()?;
    if entry.pid.is_none() {
        return None;
    }
    match &entry.session_id {
        Some(s) if !s.is_empty() => {}
        _ => return None,
    }
    Some(entry)
}

// ---------------------------------------------------------------------------
// Transcript tail parsing (privacy-critical)
// ---------------------------------------------------------------------------

const TAIL_BYTES: u64 = 64 * 1024;

#[derive(Debug, Default, Clone, PartialEq)]
struct TailInfo {
    git_branch: Option<String>,
    /// `cwd` from the same line that carried `gitBranch` (registry fallback only).
    cwd: Option<String>,
    last_user_activity_ms: Option<i64>,
    /// Last `custom-title` record's `customTitle` in the tail (user-renamed chat).
    /// Highest-priority display title. Not cached — it can change over the session.
    custom_title: Option<String>,
    /// Last `ai-title` record's `aiTitle` in the tail (auto-generated title).
    /// Second-priority display title. Not cached — regeneration can change it.
    ai_title: Option<String>,
}

/// Read at most the last `TAIL_BYTES` of a file.
fn read_tail(path: &Path, max: u64) -> Option<Vec<u8>> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(max);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// Convert an ISO-8601 / RFC-3339 timestamp string to unix milliseconds.
fn iso_to_unix_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// Parse the tail of a `.jsonl` transcript.
///
/// The very last lines may be meta records (e.g. `type: "last-prompt"` /
/// `"ai-title"`) that lack `cwd`/`gitBranch`, so we scan backwards for the last
/// line that both parses and carries a non-empty `gitBranch`. Separately we scan
/// backwards for the last `type == "user"` line to recover its `timestamp`, and
/// for the last `custom-title` / `ai-title` records to recover the current
/// display title (these records repeat and can change; the LAST wins).
///
/// Only these keys are extracted; message content is never read out.
fn parse_tail(bytes: &[u8]) -> TailInfo {
    let text = String::from_utf8_lossy(bytes);
    let lines: Vec<&str> = text.lines().collect();

    let mut info = TailInfo::default();

    // Last line (from the back) carrying a gitBranch. A leading truncated line
    // simply fails to parse and is skipped.
    for line in lines.iter().rev() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(l) {
            if let Some(gb) = v.get("gitBranch").and_then(|x| x.as_str()) {
                // Claude Code records the literal "HEAD" for detached checkouts;
                // that is not a branch, so treat it like an absent value.
                if !gb.is_empty() && gb != "HEAD" {
                    info.git_branch = Some(gb.to_string());
                    if let Some(c) = v.get("cwd").and_then(|x| x.as_str()) {
                        if !c.is_empty() {
                            info.cwd = Some(c.to_string());
                        }
                    }
                    break;
                }
            }
        }
    }

    // Last `type: "user"` line -> its timestamp.
    for line in lines.iter().rev() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(l) {
            if v.get("type").and_then(|x| x.as_str()) == Some("user") {
                if let Some(ts) = v.get("timestamp").and_then(|x| x.as_str()) {
                    info.last_user_activity_ms = iso_to_unix_ms(ts);
                }
                break;
            }
        }
    }

    // Last `custom-title` record -> its `customTitle` (user-renamed chat).
    for line in lines.iter().rev() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(l) {
            if v.get("type").and_then(|x| x.as_str()) == Some("custom-title") {
                if let Some(t) = v.get("customTitle").and_then(|x| x.as_str()) {
                    let t = t.trim();
                    if !t.is_empty() {
                        info.custom_title = Some(format_title(t));
                    }
                }
                break;
            }
        }
    }

    // Last `ai-title` record -> its `aiTitle` (auto-generated title).
    for line in lines.iter().rev() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(l) {
            if v.get("type").and_then(|x| x.as_str()) == Some("ai-title") {
                if let Some(t) = v.get("aiTitle").and_then(|x| x.as_str()) {
                    let t = t.trim();
                    if !t.is_empty() {
                        info.ai_title = Some(format_title(t));
                    }
                }
                break;
            }
        }
    }

    info
}

// ---------------------------------------------------------------------------
// Display title extraction (privacy-critical)
// ---------------------------------------------------------------------------
//
// The display title is the session's FIRST real user prompt — the same text
// Claude Code's own resume picker surfaces. It is read from the head of the
// transcript, formatted for a single row, and cached forever (a found title is
// immutable). It is never logged, persisted, or sent off the machine.

/// Read at most the first `max` bytes of a file (the transcript HEAD).
fn read_head(path: &Path, max: u64) -> Option<Vec<u8>> {
    let f = std::fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    f.take(max).read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// How much of the transcript head to scan for the first user prompt.
const TITLE_HEAD_BYTES: u64 = 128 * 1024;

/// Prefixes that mark a synthetic / injected user entry (not a real prompt).
const TITLE_SKIP_PREFIXES: [&str; 4] = [
    "Caveat:",
    "<command-name>",
    "<local-command",
    "<system-reminder",
];

/// Pull the plain text out of a `message.content` value.
///
/// - a bare string -> that string.
/// - an array of blocks -> the concatenation of every `{"type":"text","text":…}`
///   block's text. Arrays with no text blocks (e.g. tool_result-only) -> `None`.
fn extract_user_text(content: &serde_json::Value) -> Option<String> {
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    if let Some(arr) = content.as_array() {
        let mut combined = String::new();
        for block in arr {
            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(t) = block.get("text").and_then(|x| x.as_str()) {
                    combined.push_str(t);
                }
            }
        }
        if combined.is_empty() {
            return None;
        }
        return Some(combined);
    }
    None
}

/// Truncate a string to at most `max` characters (never splitting a UTF-8 char),
/// appending '…' when truncation actually happened.
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max).collect();
    format!("{truncated}…")
}

/// Format a raw prompt into a single row: first line only, whitespace collapsed,
/// truncated to 80 chars.
fn format_title(text: &str) -> String {
    let first_line = text.lines().next().unwrap_or("");
    let collapsed = first_line.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_chars(&collapsed, 80)
}

/// Strip any leading IDE-context / system wrapper blocks (e.g. `<ide_selection>…
/// </ide_selection>`, `<ide_opened_file>…`, `<system-reminder>…`) that Claude
/// Code injects BEFORE the user's real prompt in the same message. The actual
/// prompt follows those blocks.
///
/// Repeatedly, while the (left-trimmed) text opens with a `<ide_…` or
/// `<system-reminder…` tag: find that tag's matching close (`</ide_selection>`,
/// etc.) and drop everything through it, then re-trim. Returns the remaining text
/// once it no longer opens with a wrapper, or `None` if a wrapper is unterminated
/// (no closing tag) — in which case the caller skips the line.
fn strip_leading_wrapper_blocks(text: &str) -> Option<String> {
    let mut rest = text.trim_start();
    loop {
        let is_wrapper = rest.starts_with("<ide_") || rest.starts_with("<system-reminder");
        if !is_wrapper {
            return Some(rest.to_string());
        }
        // Tag name = chars after '<' up to the first '>', '/', or whitespace.
        let after = &rest[1..];
        let name_end = after
            .find(|c: char| c == '>' || c == '/' || c.is_whitespace())
            .unwrap_or(after.len());
        let name = &after[..name_end];
        if name.is_empty() {
            return Some(rest.to_string());
        }
        let close = format!("</{name}>");
        match rest.find(&close) {
            Some(idx) => {
                rest = rest[idx + close.len()..].trim_start();
            }
            None => return None, // unterminated wrapper -> skip the line
        }
    }
}

/// Given one transcript line, return a display title if the line is a real,
/// qualifying user prompt; otherwise `None`.
///
/// Skips: non-`user` lines, `isMeta:true` entries, tool_result-only content,
/// empty/whitespace text, and synthetic prefixes (Caveat / command / reminder).
/// Leading IDE/system wrapper blocks are stripped first so the prompt text that
/// follows them becomes the title.
fn title_from_line(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("user") {
        return None;
    }
    if v.get("isMeta").and_then(|m| m.as_bool()) == Some(true) {
        return None;
    }
    let content = v.get("message").and_then(|m| m.get("content"))?;
    let text = extract_user_text(content)?;
    // Peel off any leading IDE-selection / system-reminder wrapper blocks; an
    // unterminated wrapper means we cannot find the real prompt -> skip.
    let stripped = strip_leading_wrapper_blocks(&text)?;
    let trimmed = stripped.trim_start();
    if trimmed.is_empty() {
        return None;
    }
    for p in TITLE_SKIP_PREFIXES {
        if trimmed.starts_with(p) {
            return None;
        }
    }
    let title = format_title(trimmed);
    if title.is_empty() {
        return None;
    }
    Some(title)
}

/// Scan the transcript head for the first qualifying user prompt. A trailing
/// truncated line (the byte window may cut mid-line) simply fails to parse and is
/// skipped.
fn extract_title(path: &Path) -> Option<String> {
    let bytes = read_head(path, TITLE_HEAD_BYTES)?;
    let text = String::from_utf8_lossy(&bytes);
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        if let Some(title) = title_from_line(l) {
            return Some(title);
        }
    }
    None
}

/// Process-wide title cache keyed by session id. A found title is immutable, so
/// it is cached forever; sessions with no title yet are simply not inserted and
/// re-scanned (bounded 128KB head read) on the next poll.
fn title_cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Cached title lookup: returns the cached title if present, otherwise scans the
/// transcript head, caches any hit, and returns it.
fn cached_title(session_id: &str, path: &Path) -> Option<String> {
    if let Ok(cache) = title_cache().lock() {
        if let Some(t) = cache.get(session_id) {
            return Some(t.clone());
        }
    }
    let title = extract_title(path)?;
    if let Ok(mut cache) = title_cache().lock() {
        cache.insert(session_id.to_string(), title.clone());
    }
    Some(title)
}

// ---------------------------------------------------------------------------
// Transcript / registry file location
// ---------------------------------------------------------------------------

/// Glob `~/.claude/projects/*/<session_id>.jsonl` and return any one match.
/// Case-variant duplicate directories are hardlinks of the same file, so which
/// one we pick does not matter.
fn find_transcript(home: &Path, session_id: &str) -> Option<PathBuf> {
    let projects_dir = home.join(".claude").join("projects");
    let entries = std::fs::read_dir(&projects_dir).ok()?;
    let file_name = format!("{session_id}.jsonl");
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let candidate = path.join(&file_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Unix-millis mtime of a file.
fn file_mtime_ms(path: &Path) -> Option<i64> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    modified
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)
}

// ---------------------------------------------------------------------------
// Path normalization / project matching
// ---------------------------------------------------------------------------

/// Case-, separator-, and trailing-separator-insensitive normalization.
fn normalize_path(p: &str) -> String {
    let mut s = p.replace('\\', "/").to_lowercase();
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    s
}

/// Match a session against the registered projects (`(id, path, session_id)`
/// triples). F061: prefer the virtual sub-project whose session_id equals this
/// session's id, then fall back to the plain folder project (NULL session_id) at
/// the same path, then any path match. This makes the HUD pair a live session
/// with its own virtual sub-project rather than the coexisting plain project.
fn match_project(
    cwd: &str,
    session_id: &str,
    projects: &[(String, String, Option<String>)],
) -> Option<String> {
    if cwd.is_empty() {
        return None;
    }
    let target = normalize_path(cwd);
    let path_matches: Vec<&(String, String, Option<String>)> = projects
        .iter()
        .filter(|(_, path, _)| normalize_path(path) == target)
        .collect();

    // 1. Exact session match wins.
    if let Some((id, _, _)) = path_matches
        .iter()
        .find(|(_, _, sid)| sid.as_deref() == Some(session_id))
    {
        return Some(id.clone());
    }
    // 2. Plain folder project (no session_id).
    if let Some((id, _, _)) = path_matches.iter().find(|(_, _, sid)| sid.is_none()) {
        return Some(id.clone());
    }
    // 3. Any project at that path.
    path_matches.first().map(|(id, _, _)| id.clone())
}

// ---------------------------------------------------------------------------
// PID liveness
// ---------------------------------------------------------------------------

/// Default PID-alive predicate.
///
/// On Windows we consult the process table (sysinfo, already a dependency). On
/// other platforms we assume alive (cheap cross-platform fallback).
#[cfg(windows)]
fn default_pid_is_alive() -> impl Fn(u32) -> bool {
    use sysinfo::{Pid, System};
    let sys = System::new_all();
    move |pid| sys.process(Pid::from_u32(pid)).is_some()
}

#[cfg(not(windows))]
fn default_pid_is_alive() -> impl Fn(u32) -> bool {
    |_pid| true
}

// ---------------------------------------------------------------------------
// Candidate enumeration
// ---------------------------------------------------------------------------

fn cmp_opt_desc(a: Option<i64>, b: Option<i64>) -> Ordering {
    match (a, b) {
        (Some(x), Some(y)) => y.cmp(&x), // descending
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

/// Enumerate live interactive session candidates. Pure over its inputs so it can
/// be unit-tested: `home` roots the `.claude` tree, `projects` are `(id, path)`
/// pairs, and `is_alive` decides PID liveness.
pub fn list_candidates<F>(
    home: &Path,
    projects: &[(String, String, Option<String>)],
    is_alive: &F,
) -> Vec<ClaudeSessionCandidate>
where
    F: Fn(u32) -> bool,
{
    let sessions_dir = home.join(".claude").join("sessions");
    let entries = match std::fs::read_dir(&sessions_dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut candidates: Vec<ClaudeSessionCandidate> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let reg = match parse_registry(&content) {
            Some(r) => r,
            None => continue,
        };

        // Only interactive sessions.
        if reg.kind.as_deref() != Some("interactive") {
            continue;
        }

        let pid = reg.pid.unwrap(); // parse_registry guarantees Some
        // Reserved/system PIDs (0 = idle, 4 = System on Windows) can never be a
        // Claude session; a stale registry entry with one would always pass the
        // liveness check.
        if pid <= 4 || !is_alive(pid) {
            continue;
        }

        let session_id = reg.session_id.clone().unwrap(); // guaranteed Some
        if !seen.insert(session_id.clone()) {
            continue; // dedupe
        }

        // Locate + tail-parse the transcript (best effort), and derive the
        // display title. Priority: the tail's last custom-title (user rename) >
        // the tail's last ai-title (auto-generated) > the first-prompt title from
        // the head (cached). The tail-derived titles come free with the tail read
        // and can change, so they are never cached; only the first-prompt title is.
        let (tail, last_activity_ms, title) = match find_transcript(home, &session_id) {
            Some(jsonl) => {
                let tail = read_tail(&jsonl, TAIL_BYTES)
                    .map(|b| parse_tail(&b))
                    .unwrap_or_default();
                let title = tail
                    .custom_title
                    .clone()
                    .or_else(|| tail.ai_title.clone())
                    .or_else(|| cached_title(&session_id, &jsonl));
                (tail, file_mtime_ms(&jsonl), title)
            }
            None => (TailInfo::default(), None, None),
        };

        // cwd: registry first, else the cwd seen on the transcript's gitBranch line.
        let cwd = reg
            .cwd
            .filter(|c| !c.is_empty())
            .or_else(|| tail.cwd.clone())
            .unwrap_or_default();

        let git_branch = tail.git_branch.clone();
        let head_branch = git_branch_for(&cwd);
        let branch_mismatch = match (&git_branch, &head_branch) {
            (Some(g), Some(h)) => g != h,
            _ => false,
        };

        let registered_project_id = match_project(&cwd, &session_id, projects);

        candidates.push(ClaudeSessionCandidate {
            session_id,
            pid,
            name: reg.name.unwrap_or_default(),
            title,
            cwd,
            git_branch,
            head_branch,
            branch_mismatch,
            kind: reg.kind.unwrap_or_default(),
            entrypoint: reg.entrypoint.unwrap_or_default(),
            last_activity_ms,
            last_user_activity_ms: tail.last_user_activity_ms,
            registered_project_id,
        });
    }

    candidates.sort_by(|a, b| {
        cmp_opt_desc(a.last_user_activity_ms, b.last_user_activity_ms)
            .then_with(|| cmp_opt_desc(a.last_activity_ms, b.last_activity_ms))
    });

    candidates
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Resolve the current git branch of a repo/worktree directory without spawning git.
#[tauri::command]
pub fn get_git_branch(path: String) -> Option<String> {
    git_branch_for(&path)
}

/// Enumerate live, interactive Claude Code sessions with branch/activity metadata.
#[tauri::command]
pub async fn list_claude_session_candidates(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ClaudeSessionCandidate>, String> {
    let pool = state.db_manager.pool();
    let projects = ProjectRepository::list_projects(pool)
        .await
        .map_err(|e| e.to_string())?;
    let project_triples: Vec<(String, String, Option<String>)> = projects
        .into_iter()
        .map(|p| (p.id, p.path, p.session_id))
        .collect();

    let candidates = tokio::task::spawn_blocking(move || {
        let home = dirs::home_dir()?;
        let is_alive = default_pid_is_alive();
        Some(list_candidates(&home, &project_triples, &is_alive))
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(candidates.unwrap_or_default())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // ---- HEAD parsing ----

    #[test]
    fn parse_head_ref_line() {
        assert_eq!(
            parse_head("ref: refs/heads/main\n"),
            Some("main".to_string())
        );
        // Branch names may contain slashes.
        assert_eq!(
            parse_head("ref: refs/heads/feature/session-aware-hud"),
            Some("feature/session-aware-hud".to_string())
        );
    }

    #[test]
    fn parse_head_detached() {
        let sha = "abc1234def5678901234567890123456789012ab";
        assert_eq!(parse_head(sha), Some("detached@abc1234".to_string()));
        // Non-heads ref and garbage -> None.
        assert_eq!(parse_head("ref: refs/tags/v1.0"), None);
        assert_eq!(parse_head("not-a-sha-or-ref"), None);
    }

    #[test]
    fn git_branch_worktree_gitdir_file() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        // Real (linked) gitdir with a HEAD.
        let real_gitdir = root.join("realgit");
        fs::create_dir_all(&real_gitdir).unwrap();
        fs::write(real_gitdir.join("HEAD"), "ref: refs/heads/worktree-branch\n").unwrap();

        // Worktree checkout whose `.git` is a FILE pointing (relatively) at it.
        let worktree = root.join("wt");
        fs::create_dir_all(&worktree).unwrap();
        fs::write(worktree.join(".git"), "gitdir: ../realgit\n").unwrap();

        assert_eq!(
            git_branch_for(worktree.to_str().unwrap()),
            Some("worktree-branch".to_string())
        );
    }

    #[test]
    fn git_branch_plain_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::write(repo.join(".git").join("HEAD"), "ref: refs/heads/dev").unwrap();
        assert_eq!(git_branch_for(repo.to_str().unwrap()), Some("dev".to_string()));
    }

    #[test]
    fn git_branch_dangling_gitdir_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        let worktree = tmp.path().join("wt");
        fs::create_dir_all(&worktree).unwrap();
        // Points at a gitdir that does not exist.
        fs::write(worktree.join(".git"), "gitdir: ../nope/does-not-exist").unwrap();
        assert_eq!(git_branch_for(worktree.to_str().unwrap()), None);
    }

    #[test]
    fn git_branch_missing_repo_returns_none() {
        assert_eq!(git_branch_for("/definitely/not/a/repo/xyzzy"), None);
        assert_eq!(git_branch_for(""), None);
    }

    // ---- transcript glob lookup ----

    #[test]
    fn find_transcript_globs_munged_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let munged = home
            .join(".claude")
            .join("projects")
            .join("D--Dev-projects-Tandem");
        fs::create_dir_all(&munged).unwrap();
        let sid = "11111111-2222-3333-4444-555555555555";
        let jsonl = munged.join(format!("{sid}.jsonl"));
        fs::write(&jsonl, "{}\n").unwrap();

        let found = find_transcript(home, sid).unwrap();
        assert_eq!(found, jsonl);

        // Unknown session id -> None.
        assert_eq!(find_transcript(home, "no-such-session"), None);
    }

    // ---- tail parsing with trailing meta lines ----

    #[test]
    fn parse_tail_skips_trailing_meta_without_gitbranch() {
        // Order: an early user line, a real gitBranch-bearing line, then meta
        // lines that lack gitBranch/cwd (as real transcripts end).
        let jsonl = concat!(
            "{\"type\":\"user\",\"timestamp\":\"2026-07-22T10:00:00.000Z\",\"message\":\"hi\"}\n",
            "{\"type\":\"assistant\",\"cwd\":\"D:/Dev-projects/Tandem\",\"gitBranch\":\"feature/x\",\"message\":\"ok\"}\n",
            "{\"type\":\"last-prompt\",\"content\":\"summarize\"}\n",
            "{\"type\":\"ai-title\",\"title\":\"Some Title\"}\n",
        );
        let info = parse_tail(jsonl.as_bytes());
        assert_eq!(info.git_branch, Some("feature/x".to_string()));
        assert_eq!(info.cwd, Some("D:/Dev-projects/Tandem".to_string()));
        assert_eq!(
            info.last_user_activity_ms,
            iso_to_unix_ms("2026-07-22T10:00:00.000Z")
        );
        assert!(info.last_user_activity_ms.is_some());
    }

    #[test]
    fn parse_tail_no_gitbranch_anywhere() {
        let jsonl = concat!(
            "{\"type\":\"last-prompt\",\"content\":\"x\"}\n",
            "{\"type\":\"ai-title\",\"title\":\"y\"}\n",
        );
        let info = parse_tail(jsonl.as_bytes());
        assert_eq!(info.git_branch, None);
        assert_eq!(info.cwd, None);
        assert_eq!(info.last_user_activity_ms, None);
    }

    // ---- tail-derived display titles (ai-title / custom-title) ----

    #[test]
    fn parse_tail_picks_up_ai_title() {
        let jsonl = concat!(
            "{\"type\":\"user\",\"timestamp\":\"2026-07-22T10:00:00.000Z\"}\n",
            "{\"type\":\"ai-title\",\"aiTitle\":\"Mock up solo mode project hub layout\",\"sessionId\":\"s\"}\n",
        );
        let info = parse_tail(jsonl.as_bytes());
        assert_eq!(
            info.ai_title,
            Some("Mock up solo mode project hub layout".to_string())
        );
        assert_eq!(info.custom_title, None);
    }

    #[test]
    fn parse_tail_custom_title_and_ai_title_coexist() {
        // Both present: parse_tail captures each independently; the composition
        // step (list_candidates) is what prefers custom over ai.
        let jsonl = concat!(
            "{\"type\":\"ai-title\",\"aiTitle\":\"Auto Generated\",\"sessionId\":\"s\"}\n",
            "{\"type\":\"custom-title\",\"customTitle\":\"CMS\",\"sessionId\":\"s\"}\n",
        );
        let info = parse_tail(jsonl.as_bytes());
        assert_eq!(info.custom_title, Some("CMS".to_string()));
        assert_eq!(info.ai_title, Some("Auto Generated".to_string()));
    }

    #[test]
    fn parse_tail_later_title_record_wins() {
        // Titles change over a session; the LAST occurrence is current.
        let jsonl = concat!(
            "{\"type\":\"ai-title\",\"aiTitle\":\"First Guess\",\"sessionId\":\"s\"}\n",
            "{\"type\":\"ai-title\",\"aiTitle\":\"Better Title\",\"sessionId\":\"s\"}\n",
            "{\"type\":\"custom-title\",\"customTitle\":\"Old Name\",\"sessionId\":\"s\"}\n",
            "{\"type\":\"custom-title\",\"customTitle\":\"New Name\",\"sessionId\":\"s\"}\n",
        );
        let info = parse_tail(jsonl.as_bytes());
        assert_eq!(info.ai_title, Some("Better Title".to_string()));
        assert_eq!(info.custom_title, Some("New Name".to_string()));
    }

    #[test]
    fn parse_tail_ignores_empty_ai_title() {
        let jsonl = concat!(
            "{\"type\":\"ai-title\",\"aiTitle\":\"   \",\"sessionId\":\"s\"}\n",
            "{\"type\":\"custom-title\",\"customTitle\":\"\",\"sessionId\":\"s\"}\n",
        );
        let info = parse_tail(jsonl.as_bytes());
        assert_eq!(info.ai_title, None);
        assert_eq!(info.custom_title, None);
    }

    #[test]
    fn parse_tail_truncates_long_title() {
        let long = "z".repeat(90);
        let jsonl = format!(
            "{{\"type\":\"ai-title\",\"aiTitle\":\"{long}\",\"sessionId\":\"s\"}}\n"
        );
        let info = parse_tail(jsonl.as_bytes());
        let t = info.ai_title.unwrap();
        assert_eq!(t.chars().count(), 81); // 80 + '…'
        assert!(t.ends_with('…'));
    }

    #[test]
    fn list_candidates_prefers_custom_over_ai_over_first_prompt() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let sessions = home.join(".claude").join("sessions");
        let projects_dir = home.join(".claude").join("projects").join("munged");
        fs::create_dir_all(&sessions).unwrap();
        fs::create_dir_all(&projects_dir).unwrap();

        // Session A: has a custom-title -> that wins over ai-title & first prompt.
        fs::write(
            sessions.join("a.json"),
            r#"{"pid":100,"sessionId":"sid-a","cwd":"D:/proj/a","name":"slug-a","kind":"interactive","entrypoint":"claude-cli"}"#,
        )
        .unwrap();
        fs::write(
            projects_dir.join("sid-a.jsonl"),
            concat!(
                "{\"type\":\"user\",\"timestamp\":\"2026-07-22T12:00:00.000Z\",\"message\":{\"role\":\"user\",\"content\":\"First prompt A\"}}\n",
                "{\"type\":\"ai-title\",\"aiTitle\":\"AI Title A\",\"sessionId\":\"sid-a\"}\n",
                "{\"type\":\"custom-title\",\"customTitle\":\"Custom A\",\"sessionId\":\"sid-a\"}\n",
            ),
        )
        .unwrap();

        // Session B: only ai-title -> ai-title wins over first prompt.
        fs::write(
            sessions.join("b.json"),
            r#"{"pid":200,"sessionId":"sid-b","cwd":"D:/proj/b","name":"slug-b","kind":"interactive","entrypoint":"claude-cli"}"#,
        )
        .unwrap();
        fs::write(
            projects_dir.join("sid-b.jsonl"),
            concat!(
                "{\"type\":\"user\",\"timestamp\":\"2026-07-22T11:00:00.000Z\",\"message\":{\"role\":\"user\",\"content\":\"First prompt B\"}}\n",
                "{\"type\":\"ai-title\",\"aiTitle\":\"AI Title B\",\"sessionId\":\"sid-b\"}\n",
            ),
        )
        .unwrap();

        // Session C: no title records -> falls back to first-prompt extraction.
        fs::write(
            sessions.join("c.json"),
            r#"{"pid":300,"sessionId":"sid-c","cwd":"D:/proj/c","name":"slug-c","kind":"interactive","entrypoint":"claude-cli"}"#,
        )
        .unwrap();
        fs::write(
            projects_dir.join("sid-c.jsonl"),
            "{\"type\":\"user\",\"timestamp\":\"2026-07-22T10:00:00.000Z\",\"message\":{\"role\":\"user\",\"content\":\"First prompt C\"}}\n",
        )
        .unwrap();

        let alive = |_pid: u32| true;
        let out = list_candidates(home, &[], &alive);

        let by_id = |id: &str| out.iter().find(|c| c.session_id == id).unwrap();
        assert_eq!(by_id("sid-a").title.as_deref(), Some("Custom A"));
        assert_eq!(by_id("sid-b").title.as_deref(), Some("AI Title B"));
        assert_eq!(by_id("sid-c").title.as_deref(), Some("First prompt C"));
    }

    // ---- display title extraction ----

    #[test]
    fn title_from_string_content() {
        let line = r#"{"type":"user","message":{"role":"user","content":"Fix the login bug"}}"#;
        assert_eq!(title_from_line(line), Some("Fix the login bug".to_string()));
    }

    #[test]
    fn title_from_array_content_uses_text_blocks() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Refactor the parser"}]}}"#;
        assert_eq!(
            title_from_line(line),
            Some("Refactor the parser".to_string())
        );
    }

    #[test]
    fn title_skips_is_meta() {
        let line = r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"meta stuff"}}"#;
        assert_eq!(title_from_line(line), None);
    }

    #[test]
    fn title_skips_caveat_command_and_reminder() {
        let caveat = r#"{"type":"user","message":{"role":"user","content":"Caveat: The following..."}}"#;
        assert_eq!(title_from_line(caveat), None);
        let command = r#"{"type":"user","message":{"role":"user","content":"<command-name>/loop</command-name>"}}"#;
        assert_eq!(title_from_line(command), None);
        let local = r#"{"type":"user","message":{"role":"user","content":"<local-command-stdout>x</local-command-stdout>"}}"#;
        assert_eq!(title_from_line(local), None);
        let reminder = r#"{"type":"user","message":{"role":"user","content":"<system-reminder>hi</system-reminder>"}}"#;
        assert_eq!(title_from_line(reminder), None);
    }

    #[test]
    fn title_skips_tool_result_only_array() {
        // No text blocks (tool_result-only) -> no title.
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"output"}]}}"#;
        assert_eq!(title_from_line(line), None);
    }

    #[test]
    fn title_skips_empty_and_whitespace() {
        let empty = r#"{"type":"user","message":{"role":"user","content":""}}"#;
        assert_eq!(title_from_line(empty), None);
        let ws = r#"{"type":"user","message":{"role":"user","content":"   \n\t  "}}"#;
        assert_eq!(title_from_line(ws), None);
    }

    #[test]
    fn title_skips_non_user_line() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":"hello"}}"#;
        assert_eq!(title_from_line(line), None);
        // Unparseable line -> None.
        assert_eq!(title_from_line("{ truncated json"), None);
    }

    #[test]
    fn title_first_line_only_and_collapses_whitespace() {
        let line =
            r#"{"type":"user","message":{"role":"user","content":"First   line here\nsecond line"}}"#;
        assert_eq!(title_from_line(line), Some("First line here".to_string()));
    }

    #[test]
    fn title_truncates_at_80_chars_multibyte_safe() {
        // 90 ASCII chars -> truncated to 80 + ellipsis.
        let long = "a".repeat(90);
        let out = format_title(&long);
        assert_eq!(out.chars().count(), 81); // 80 + '…'
        assert!(out.ends_with('…'));
        assert_eq!(out.chars().take(80).collect::<String>(), "a".repeat(80));

        // Multibyte: 85 'é' chars must truncate on a char boundary (no panic).
        let multibyte = "é".repeat(85);
        let out = format_title(&multibyte);
        assert_eq!(out.chars().count(), 81);
        assert!(out.ends_with('…'));

        // Exactly 80 chars -> unchanged, no ellipsis.
        let exact = "b".repeat(80);
        assert_eq!(format_title(&exact), exact);
    }

    #[test]
    fn title_strips_leading_ide_selection_block() {
        // <ide_selection>…</ide_selection> then the real prompt in the SAME msg
        // (the fiona-97 leak). serde_json::json! keeps the escaping honest.
        let content =
            "<ide_selection>The user selected lines 1 to 51 from d:\\proj\\x.py</ide_selection>\nActually fix the parser";
        let v = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": content }
        });
        assert_eq!(
            title_from_line(&v.to_string()),
            Some("Actually fix the parser".to_string())
        );
    }

    #[test]
    fn title_unterminated_wrapper_is_skipped() {
        let content = "<ide_selection>selection with no closing tag and a prompt after";
        let v = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": content }
        });
        assert_eq!(title_from_line(&v.to_string()), None);
    }

    #[test]
    fn title_strips_two_stacked_wrapper_blocks() {
        let content = "<ide_opened_file>d:\\proj\\a.py</ide_opened_file><system-reminder>be careful</system-reminder>  Real request here";
        let v = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": content }
        });
        assert_eq!(
            title_from_line(&v.to_string()),
            Some("Real request here".to_string())
        );
    }

    #[test]
    fn extract_title_returns_first_qualifying_prompt() {
        let tmp = tempfile::tempdir().unwrap();
        let jsonl = tmp.path().join("t.jsonl");
        // Leading skippable lines, then the first real prompt, then more.
        let body = concat!(
            "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"boot\"}}\n",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<command-name>/init</command-name>\"}}\n",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"Build the feature\"}}\n",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"a later prompt\"}}\n",
        );
        fs::write(&jsonl, body).unwrap();
        assert_eq!(extract_title(&jsonl), Some("Build the feature".to_string()));
    }

    // ---- defensive registry parsing ----

    #[test]
    fn parse_registry_ignores_unknown_and_requires_identity() {
        // Unknown field `extra` ignored; all known fields present.
        let ok = r#"{
            "pid": 4242,
            "sessionId": "sid-1",
            "cwd": "D:/Dev-projects/Tandem",
            "name": "Tandem work",
            "startedAt": "2026-07-22T09:00:00Z",
            "kind": "interactive",
            "entrypoint": "claude-vscode",
            "extra": {"nested": true}
        }"#;
        let reg = parse_registry(ok).expect("valid registry parses");
        assert_eq!(reg.pid, Some(4242));
        assert_eq!(reg.session_id.as_deref(), Some("sid-1"));
        assert_eq!(reg.kind.as_deref(), Some("interactive"));
        assert_eq!(reg.entrypoint.as_deref(), Some("claude-vscode"));

        // Missing pid -> skipped.
        assert!(parse_registry(r#"{"sessionId":"s"}"#).is_none());
        // Missing sessionId -> skipped.
        assert!(parse_registry(r#"{"pid":1}"#).is_none());
        // Empty sessionId -> skipped.
        assert!(parse_registry(r#"{"pid":1,"sessionId":""}"#).is_none());
        // Not JSON -> skipped.
        assert!(parse_registry("not json at all").is_none());
        // Missing optional fields still parses (cwd/name/entrypoint absent).
        let minimal = parse_registry(r#"{"pid":7,"sessionId":"s2","kind":"interactive"}"#)
            .expect("minimal registry parses");
        assert_eq!(minimal.cwd, None);
        assert_eq!(minimal.name, None);
    }

    // ---- end-to-end enumeration ----

    #[test]
    fn list_candidates_filters_and_sorts() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let sessions = home.join(".claude").join("sessions");
        let projects_dir = home.join(".claude").join("projects").join("munged");
        fs::create_dir_all(&sessions).unwrap();
        fs::create_dir_all(&projects_dir).unwrap();

        // Interactive + alive, with a transcript.
        fs::write(
            sessions.join("a.json"),
            r#"{"pid":100,"sessionId":"sid-a","cwd":"D:/proj/a","name":"A","kind":"interactive","entrypoint":"claude-cli"}"#,
        )
        .unwrap();
        fs::write(
            projects_dir.join("sid-a.jsonl"),
            "{\"type\":\"user\",\"timestamp\":\"2026-07-22T12:00:00.000Z\"}\n{\"gitBranch\":\"main\",\"cwd\":\"D:/proj/a\"}\n",
        )
        .unwrap();

        // Interactive + alive, older user activity.
        fs::write(
            sessions.join("b.json"),
            r#"{"pid":200,"sessionId":"sid-b","cwd":"D:/proj/b","name":"B","kind":"interactive","entrypoint":"claude-cli"}"#,
        )
        .unwrap();
        fs::write(
            projects_dir.join("sid-b.jsonl"),
            "{\"type\":\"user\",\"timestamp\":\"2026-07-22T08:00:00.000Z\"}\n{\"gitBranch\":\"dev\"}\n",
        )
        .unwrap();

        // Non-interactive -> excluded.
        fs::write(
            sessions.join("c.json"),
            r#"{"pid":300,"sessionId":"sid-c","cwd":"D:/proj/c","name":"C","kind":"batch","entrypoint":"claude-cli"}"#,
        )
        .unwrap();

        // Interactive but dead PID -> excluded.
        fs::write(
            sessions.join("d.json"),
            r#"{"pid":999,"sessionId":"sid-d","cwd":"D:/proj/d","name":"D","kind":"interactive","entrypoint":"claude-cli"}"#,
        )
        .unwrap();

        let alive = |pid: u32| pid == 100 || pid == 200;
        let projects = vec![("proj-a-id".to_string(), "D:\\proj\\a\\".to_string(), None)];

        let out = list_candidates(home, &projects, &alive);
        assert_eq!(out.len(), 2, "only alive interactive sessions kept");

        // Sorted by last_user_activity_ms desc -> sid-a (12:00) before sid-b (08:00).
        assert_eq!(out[0].session_id, "sid-a");
        assert_eq!(out[1].session_id, "sid-b");

        // Registered project matched with case/sep/trailing-slash normalization.
        assert_eq!(out[0].registered_project_id.as_deref(), Some("proj-a-id"));
        assert_eq!(out[1].registered_project_id, None);

        assert_eq!(out[0].git_branch.as_deref(), Some("main"));
        assert!(out[0].last_activity_ms.is_some());
    }

    // ---- F061: (path, session_id) project matching ----

    #[test]
    fn match_project_prefers_session_over_plain() {
        // Same path registered twice: a plain folder project (NULL session_id)
        // and a virtual sub-project for "sid-x". A session whose id is "sid-x"
        // must resolve to the virtual sub-project, not the plain one.
        let projects = vec![
            ("plain-id".to_string(), "D:/proj/a".to_string(), None),
            (
                "virtual-id".to_string(),
                "D:\\proj\\a\\".to_string(),
                Some("sid-x".to_string()),
            ),
        ];
        assert_eq!(
            match_project("d:/proj/a", "sid-x", &projects).as_deref(),
            Some("virtual-id")
        );
        // A different session id at the same path falls back to the plain project.
        assert_eq!(
            match_project("D:/proj/a", "sid-other", &projects).as_deref(),
            Some("plain-id")
        );
        // No path match at all -> None.
        assert_eq!(match_project("D:/proj/z", "sid-x", &projects), None);
        // Empty cwd -> None.
        assert_eq!(match_project("", "sid-x", &projects), None);
    }

    #[test]
    fn match_project_falls_back_to_any_when_no_plain() {
        // Only a virtual sub-project exists at the path; an unrelated session id
        // still resolves to it (path match of last resort).
        let projects = vec![(
            "virtual-id".to_string(),
            "D:/proj/a".to_string(),
            Some("sid-x".to_string()),
        )];
        assert_eq!(
            match_project("D:/proj/a", "sid-other", &projects).as_deref(),
            Some("virtual-id")
        );
    }
}
