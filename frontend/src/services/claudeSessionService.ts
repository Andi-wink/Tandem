/**
 * F055: Claude session discovery + git branch helpers.
 *
 * Thin, typed wrappers around two Rust commands (built in parallel; this file
 * codes against their contract):
 *   - `list_claude_session_candidates` → live Claude Code sessions, sorted
 *     most-recently-user-active first.
 *   - `get_git_branch` → the branch of a checkout at a given path.
 *
 * Both are best-effort: this whole feature must fail silent-to-manual, so the
 * wrappers swallow invoke errors and return empty/null rather than throwing.
 */

import { invoke } from '@tauri-apps/api/core';

/** A live Claude Code session the HUD can offer as a one-click route target. */
export interface ClaudeSessionCandidate {
  session_id: string;
  pid: number;
  /** Session display name. */
  name: string;
  /** Absolute project path the session is running in. */
  cwd: string;
  /** Branch as seen by that Claude session (may be stale). */
  git_branch: string | null;
  /** Branch of the checkout right now. */
  head_branch: string | null;
  /** True when git_branch !== head_branch (session may be on a stale worktree). */
  branch_mismatch: boolean;
  kind: string;
  entrypoint: string;
  last_activity_ms: number | null;
  last_user_activity_ms: number | null;
  /** Set when this cwd is already a registered Solo Mode project. */
  registered_project_id: string | null;
}

/**
 * List live Claude session candidates. Never throws: returns [] on any failure
 * so the picker silently falls back to the manual registered-project list.
 */
export async function listClaudeSessionCandidates(): Promise<ClaudeSessionCandidate[]> {
  try {
    const list = await invoke<ClaudeSessionCandidate[]>('list_claude_session_candidates');
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.warn('[claudeSessionService] list_claude_session_candidates failed:', err);
    return [];
  }
}

/**
 * Resolve the git branch of a checkout. Returns the branch name, a
 * "detached@<sha7>" marker, or null on failure / non-repo / stale worktree.
 * Never throws — a branch lookup must never block a switch or handoff.
 */
export async function getGitBranch(path: string): Promise<string | null> {
  try {
    return await invoke<string | null>('get_git_branch', { path });
  } catch (err) {
    console.warn('[claudeSessionService] get_git_branch failed:', err);
    return null;
  }
}

/** Last path segment of an absolute cwd (handles both `/` and `\` separators). */
export function folderName(cwd: string): string {
  if (!cwd) return '';
  const trimmed = cwd.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
