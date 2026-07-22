//! F055: session-aware HUD + branch stamping.
//!
//! Two responsibilities:
//!   1. Resolve the current git branch of an arbitrary repo/worktree directory
//!      WITHOUT spawning `git` (reads `.git/HEAD`, follows worktree `gitdir:` files).
//!   2. Enumerate live, interactive Claude Code sessions from the local session
//!      registry, cross-referencing each session's transcript tail and the branch
//!      currently checked out in its working directory.
//!
//! PRIVACY: transcript tails are read only for the `gitBranch`, `cwd`, `type` and
//! `timestamp` keys. Message content is never logged, stored, or returned.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
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
/// backwards for the last `type == "user"` line to recover its `timestamp`.
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

    info
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

/// Match a session cwd against the registered projects (`(id, path)` pairs).
fn match_project(cwd: &str, projects: &[(String, String)]) -> Option<String> {
    if cwd.is_empty() {
        return None;
    }
    let target = normalize_path(cwd);
    projects
        .iter()
        .find(|(_, path)| normalize_path(path) == target)
        .map(|(id, _)| id.clone())
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
    projects: &[(String, String)],
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

        // Locate + tail-parse the transcript (best effort).
        let (tail, last_activity_ms) = match find_transcript(home, &session_id) {
            Some(jsonl) => {
                let tail = read_tail(&jsonl, TAIL_BYTES)
                    .map(|b| parse_tail(&b))
                    .unwrap_or_default();
                (tail, file_mtime_ms(&jsonl))
            }
            None => (TailInfo::default(), None),
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

        let registered_project_id = match_project(&cwd, projects);

        candidates.push(ClaudeSessionCandidate {
            session_id,
            pid,
            name: reg.name.unwrap_or_default(),
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
    let project_pairs: Vec<(String, String)> =
        projects.into_iter().map(|p| (p.id, p.path)).collect();

    let candidates = tokio::task::spawn_blocking(move || {
        let home = dirs::home_dir()?;
        let is_alive = default_pid_is_alive();
        Some(list_candidates(&home, &project_pairs, &is_alive))
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
        let projects = vec![("proj-a-id".to_string(), "D:\\proj\\a\\".to_string())];

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
}
