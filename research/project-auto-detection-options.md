# Solo Mode: Low-friction Project + Branch Detection, Options Report

Date: 2026-07-22. Based on three research iterations: codebase mapping, live Windows signal verification on this machine, and an adversarial stress-test of the candidate designs.

## Where friction comes from today

- A "project" in Tandem is only name + path + aliases (`ProjectModel`, [models.rs:110](../frontend/src-tauri/src/database/models.rs#L110)). **There is no branch field anywhere**, and no git, window, process, or port awareness in the codebase.
- The active project is set only by voice ("switch to X"), the HUD picker, meeting-title heuristics, or the folder modal. All switches funnel through `performProjectSwitch` ([useSoloModeRouter.ts:134](../frontend/src/hooks/useSoloModeRouter.ts#L134)), which is a clean single injection point for new signals.
- Captures (clipboard, screenshot) carry zero source metadata: no window title, no app, no URL. A localhost URL is just clipboard text.
- Task handoffs go to a project *path* only; branch is never part of it, and nothing verifies the folder is on the branch you meant.

## Verified signal sources (live-tested on this machine)

**S1. Claude Code session registry (strongest, zero setup).** `C:\Users\andre\.claude\sessions\<pid>.json`, one file per live Claude Code process, with pid, sessionId, cwd, name, startedAt. 24 live sessions found during testing. The matching transcript at `.claude\projects\<munged>\<sessionId>.jsonl` carries `cwd` AND `gitBranch` on every content line, so each session knows its own branch. Caveats found: trailing meta lines lack those keys (must scan backwards), the same session appears under case-variant dirs (`D--` and `d--`, dedupe by sessionId), and the format is undocumented and version-stamped, so parse defensively and fail silent-to-manual.

**S2. Localhost port to owning worktree.** Port → PID (`GetExtendedTcpTable`) → process command line. Verified: 3118 resolved to the exact Tandem worktree path via the next.js command line; 5173 resolved to the Agnes vite path; uvicorn needed one parent-chain hop to the venv path. Dead ends: Docker-proxied ports (com.docker.backend.exe reveals nothing) and port 3000 had two listeners (v4 vs v6, different PIDs), so match address family too. The PowerShell/WMI route took ~700ms; the native Win32 route from Rust is sub-ms, so resolve asynchronously and back-fill the capture tag.

**S3. Repo index + `.git/HEAD` reads.** 53 repos under D:\Dev-projects. Discovery scan is slow (~23s, do it rarely and cache), but per-repo branch reads including worktree gitdir indirection are microseconds. This is the resolver layer (path → branch), not an activity signal. Found during testing: ~10 dead Tandem worktrees whose gitdir still points at the old `D:/Dev projects` path (with a space); the index must validate gitdir targets and could surface a cleanup nudge.

**S4. Foreground window title.** Antigravity IDE titles carry workspace folder + file, a decent hint. Browsers give tab title only, no URL. This is activity surveillance, so: opt-in, sampled only at capture moments, processed in memory, never persisted raw.

## What the adversarial pass killed

- **"Auto-select the most recently active Claude session" is wrong most of the day.** With 24 parallel sessions, jsonl mtime tracks whichever background loop last flushed, not your attention. Worse, the F054 task loop in the Tandem repo touches its jsonl every minute, so recency would permanently elect Tandem itself, and misrouted captures would land in a feed that Claude Code *executes from*.
- **A wrong auto-switch is a privacy incident, not just a routing bug.** One bad switch silently files one client's confidential captures into another client's `.tandem/` feed. So auto-switch must be a suggestion (or require N consistent signals), and every feed entry needs an audit tag.
- **`.git/HEAD` at handoff time can lie.** Verified live: the main repo's branch flipped between two branches within minutes because parallel sessions share the checkout. Prefer the branch as seen by the *matching session's* jsonl; use `.git/HEAD` as tie-breaker and record both on disagreement.
- **Port 3118 means "some Tandem worktree".** All 22 worktree copies hard-code it; only the live process command line disambiguates, and a forgotten dev server from yesterday resolves to yesterday's branch. Treat port resolution as evidence ranked against the session candidate set, not a verdict.

## Options

### Option A: Session-aware HUD (candidate list, never auto-switch)
Tandem reads the sessions registry + jsonl tails and populates the solo HUD picker with live {project, branch, last user activity} pairs, ordered by *interactive* user activity (filter `kind: "interactive"`, require recent user-message lines, exclude the Tandem repo and loop-pattern sessions). Switching becomes one glance + one click instead of registration + declaration. Privacy handling: read only the last few KB, extract only cwd/gitBranch/timestamp/type, never persist anything else, and say so in settings.
- Yields: path + branch + recency for every parallel session. Effort: ~1-2 days (Rust file reads + HUD list). Risk: format drift (mitigate with defensive parsing, silent fallback).

### Option B: Capture-time resolution (the "I capture a URL and Tandem gets it" ask)
When a capture happens (clipboard containing a localhost URL, screenshot, quick capture): tag it immediately as provisional, resolve asynchronously (URL → port → process → worktree path; else window title; else session candidate set), stamp the capture with {project, branch, signal, confidence}, and pop a HUD suggestion: "Looks like Agnes portal-mock on feature/x. Switch?". In solo mode, auto-commit after N consistent signals. Requires adding source-metadata fields to `ClipboardData`/`ScreenshotData` and a native Rust port resolver.
- Yields: exact owning worktree for localhost URLs (verified). Effort: ~3-4 days. Risk: stale dev servers, Docker ports (fall back to `docker ps` labels or admit ignorance).

### Option C: Branch-aware everything (stamping + resolver index)
Add branch to the model where it is cheap: cached repo index (S3) resolves any path to a branch in microseconds; stamp branch into `project_switch`/`session_start` feed entries and task handoff files (rides in existing `meta`, no schema migration needed); flag when the resolved worktree's branch differs from the session's jsonl branch instead of guessing. Also fixes the silent "handed off to the right folder, wrong branch" failure.
- Effort: ~1-2 days. Risk: low; main work is dead-worktree filtering.

### Option D: Foreground window tie-breaker (opt-in)
Sample the foreground window title only at capture moments to break ties when no port or session signal resolves (e.g. working in Antigravity with no Claude session open). Never continuous, never persisted.
- Effort: ~1 day. Risk: privacy optics; keep strictly opt-in.

### Not recommended
- Recency-based auto-switching from session mtimes (killed above).
- A cooperative port-registry file each project writes (manual registration by another name; only worth it as a Docker escape hatch).

## Recommended phasing

1. **Phase 1: A + C** (~3 days). Session-aware HUD picker plus branch stamping. Kills most of the registration friction (projects appear because a Claude session is open in them) and makes every feed entry auditable. No auto-switching, so zero misrouting risk.
2. **Phase 2: B** (~3-4 days). Capture-time resolution with confidence-tagged suggestions; auto-commit in solo mode after consistent signals.
3. **Phase 3: D** if gaps remain when no Claude session is open.

The combination that survived the adversarial pass: capture-time resolution as the trigger, branch stamping as metadata, and the sessions registry demoted to a candidate-list provider that never auto-switches on its own.
