# Global quick-capture (plan, 2026-07-15)

User intent (their words, condensed): "sometimes I might be in my email and I might highlight and
copy-paste something to my clipboard, and then if I hit a hotkey, whatever's in my clipboard,
maybe the last item, or enhance it to make the last two or three items get grabbed, and then get
sent to the correct chat." Ranked top-3 by the skeptical backlog review (cheapest of the three,
most north-star-aligned: talk to Tandem like an OS, notes route to the right project).

## Design (agreed in chat)

- Global hotkey Alt+Shift+N from anywhere in Windows (taken: S, R, V, A, Q, E).
- A CAPTURE BAR, not the app: a small frameless always-on-top Tauri window that appears centered
  in the upper third of the screen. Tandem main window stays wherever it is. Model it on the
  existing canvas secondary-window scaffolding (src-tauri/src/canvas/commands.rs:
  ensure_window/pop_forward) but with .always_on_top(true), .decorations(false),
  .skip_taskbar(true), sized roughly 640x200, closes on Esc or blur. The window loads a dedicated
  Next.js route (e.g. /capture) so the UI is plain React and Playwright-testable at :3118.
- Contents:
  1. Clipboard chips: the LAST clipboard item pre-attached as a preview chip (type + first ~80
     chars, or "image" for image content). The previous 2 items shown as dimmed chips; pressing
     2 or 3 (or clicking) includes them too. Windows only exposes the CURRENT clipboard item to
     apps (Win+V history is off-limits), so Tandem keeps its own rolling history: a lightweight
     watcher (poll ~2s or reuse the existing Alt+Shift+V clipboard-capture machinery /
     ClipboardContext plumbing if it already reads the clipboard from Rust) storing the last 3
     text items in memory (Rust side, no disk persistence, privacy-first). Image support may be
     deferred to keep this pass text-only; if so, say "text copied items only" in Settings copy.
  2. A single text input, focused on open, for an optional note ("objection about onboarding
     cost"). Empty note + attached clip is valid.
  3. Routing chip on the right: the existing projectRouter (heuristic + Haiku fallback,
     frontend/src/services/projectRouter.ts) scores clipboard text + note against the project
     pool (getMatchPool from clientFolderDiscovery). Shows the top suggestion; Tab cycles the
     top 3 candidates; a "?" state when no match (falls back to Unfiled/default location).
- Actions:
  - Enter: silently save a dated note into the routed project's .tandem folder, e.g.
    .tandem/notes/<YYYY-MM-DD-HHmm>-quick-capture.md containing the note text and each attached
    clipboard item in a fenced block with a "captured from clipboard" marker. Bar closes
    immediately, tiny "Captured -> <project>" confirmation before closing (or a main-window
    toast). Frecency history records the pick like other filings.
  - Ctrl+Enter: same save, PLUS focus the main window and open the AI panel with the captured
    content injected as context (reuse the context-basket / ClaudeContext mechanisms) so the user
    can immediately ask something ("draft a reply to this").
  - Esc or blur: dismiss, save nothing.
- Settings: Keyboard shortcuts card gains Alt+Shift+N; a Quick capture toggle (default on) in
  Preferences. Rolling clipboard watcher only runs while the toggle is on.
- Writing files: the routed project folder is an arbitrary path (D:\Client_projects\...), so the
  save must go through a Rust command (plugin-fs ACL is $APPDATA-scoped). Check for an existing
  suitable command (save_transcript writes into meeting folders) and add a narrow
  save_quick_capture command if needed (validate the target is under a known project path or the
  default base; never a free-for-all write primitive).

## Tests

- vitest: pure logic: rolling 3-item clipboard buffer (dedupe consecutive identical copies),
  note-file naming/content builder, chip-selection state, router payload assembly.
- Playwright: drive the /capture route directly with the Tauri mock: open with mocked clipboard
  history -> latest chip attached; press 2 -> second chip included; type note -> Enter ->
  mock-calls show the save command with the routed path + content; Esc saves nothing.

## Risks for skeptics

- The write primitive: save_quick_capture must not become an arbitrary-file-write hole (path
  validation, no traversal, no overwrite of existing files, unique filenames).
- Clipboard privacy: the rolling buffer must be memory-only, capped, cleared when the toggle is
  disabled; never logged, never sent anywhere except the local note file / AI panel on explicit
  user action.
- Focus behavior: the bar must take keyboard focus on open (or the hotkey feels dead) but must
  not steal focus while the user is mid-keystroke elsewhere beyond the intentional hotkey press;
  Esc/blur must reliably close it (no zombie always-on-top window).
- Hotkey while the bar is already open (toggle/refresh semantics, no duplicate windows: reuse
  the ensure_window pattern).
- Router misroute: Enter on a wrong suggestion files to the wrong client; the chip must be
  clearly visible before Enter and the note file trivially movable (existing misfile-correction
  flow does not cover notes; at minimum log the destination in the confirmation).
- Multi-monitor placement, dark mode, DPI scaling on the frameless window.
- Recording state: capture must work during a live recording without touching it.
