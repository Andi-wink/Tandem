# Lessons

## Stale checkouts cannot open the shared app database (2026-07-27)

All checkouts (Tandem, Tandem-main, worktrees) share one SQLite DB at
`C:\Users\andre\AppData\Roaming\com.tandem.ai\meeting_minutes.sqlite`. Once a newer
checkout applies a migration, any older checkout panics at startup with
"migration ... was previously applied but is missing in the resolved migrations".
This is why autostart failed on 2026-07-27: the Startup shortcut ran
`start_tandem.bat`, which launched the frontend from `D:\Dev-projects\Tandem\frontend`
(old feature branch, 39 commits behind main) against the upgraded DB.

Rule: anything that launches the app (launchers, autostart, docs, scripts) must point
at the checkout tracking main, currently `D:\Dev-projects\Tandem-main\frontend`. Never
launch the app from a branch older than the last migration applied to the shared DB.

## Never normalize line endings on applied sqlx migration files (2026-07-23)

The ten pre-2026 migration files under `frontend/src-tauri/migrations/` show as
"modified" in every worktree because their working copies are CRLF while the
index is LF. That CRLF form is what sqlx recorded checksums for in the live
database (`meeting_minutes.sqlite`). Running `git checkout --` on them (or any
formatter/EOL cleanup) rewrites them to LF and the next app start panics with
"migration 20250916100000 was previously applied but has been modified".

Rule: treat those perpetual "modified" migration files as load-bearing state,
not noise. Leave them out of commits AND leave them untouched on disk. If the
panic ever happens anyway, restore CRLF on the affected files (replace `\n`
with `\r\n`); do not edit the `_sqlx_migrations` table.
