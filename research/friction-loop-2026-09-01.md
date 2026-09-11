# Friction loop: three independent passes over Solo Mode

Run 2026-09-01. Three agents worked separately with no sight of each other's output:

1. **Audit**: adversarial read of the current code, findings required to carry `file:line` evidence
2. **Research**: what shipping products do, and what to steal
3. **Invent**: capabilities that do not exist in any shipping product but are buildable today

The value is not in any one list. It is in what all three landed on independently.

---

## Convergence 1: the 30-second timer is the root problem

All three passes hit this from different directions.

- **Audit** found the router only fires on speech: `if (newSegments.length === 0) return`, plus a 30s interval and a 5-segment minimum ([useSoloModeRouter.ts:46-47](../frontend/src/hooks/useSoloModeRouter.ts#L46-L47)).
- **Invent** independently identified the same line as the structural blind spot: 40 minutes of silent refactoring produces zero feed entries, so "continue where I left off" has nothing to work from.
- **Research** found Screenpipe already solved this: it triggers capture on **OS signals** (app switch, click, typing pause, scroll) rather than a clock.

**The fix all three imply:** replace the blind timer with event-triggered classification. Real signals available on this machine: a git commit, a file save, a terminal command, a window switch, a long typing pause. Each is cheap to detect and each marks a moment that actually matters.

This also fixes a latency complaint the audit raised separately: on a timer, a task spoken at second 1 waits up to 30 seconds to be filed.

---

## Convergence 2: the classifier discards too much, silently

Four separate findings, one theme.

| Source | Finding |
|---|---|
| Audit #1 | Speech before you name a project is **never filed at all**. Only a toast, up to 30s late ([useSoloModeRouter.ts:559-565](../frontend/src/hooks/useSoloModeRouter.ts#L559-L565)) |
| Audit #3 | Anything under 0.7 confidence is dropped with no trace anywhere ([soloRoutingService.ts:122-124](../frontend/src/services/soloRoutingService.ts#L122-L124)) |
| Audit #10 | A **typed** jot gets the same probabilistic treatment as mumbling. You typed it to be certain, and it still has to clear the filter |
| Audit #4 | On an Ollama stall, up to 10 minutes of speech is dropped with only a `console.warn` |

Research supplies two ready-made answers:

- **Devin** emits a self-reported confidence score per decision, so trust does not require reading every transcript.
- **Fathom** has a "mark this moment" hotkey: a human-confirmed high-priority signal, which beats any passive detector.

**Cheapest high-value fixes, in order:**

1. Typed jots bypass the classifier entirely and become intents directly. You already did the classification work by typing it. Small.
2. Buffer intents detected with no active project, then file them retroactively when a project is named. The pre/post-switch split machinery already exists in `performProjectSwitch`. Medium.
3. Write dropped low-confidence entries to `discarded.md` instead of deleting them. Costs nothing, gives you somewhere to look when a task "never happened". Small.
4. A "mark this moment" hotkey alongside Alt+Shift+S/V. Small.

---

## Convergence 3: the agent half of the loop is unmanaged

- **Audit #2**: nothing auto-starts the Claude Code `/loop`. No `Command::new("claude")` exists anywhere in the Rust. The session folder is a fresh timestamp each run, so a loop left over from earlier silently points at a dead folder. The only signal is a 6-second toast.
- **Invent #3**: you and an unattended agent both write to one working tree with no coordination. The backend runs with `permission_mode="acceptEdits"` and no confirmation step. Proposes a HUD indicator showing which file Claude is editing right now. No ML, pure file-watching.
- **Research**: Cursor gates each tool call with an inline risk classifier, so only ~4% of actions need intervention. Tandem's handoff is today binary: fully unattended or fully manual.

**The fix:** a stable `.tandem/CURRENT_SESSION` pointer plus a copyable `/loop` command, then a coarse risk gate (auto-run reads and writes inside the project dir, pause on `git push`, deploy, `rm`).

---

## The single best idea nobody has shipped

**Ambient Debugger.** Detect the same error window being alt-tabbed to 3+ times inside a minute, correlate with rising vocal stress, OCR the stack trace, and queue a diagnosis before you ask for one.

Why it is cheap here specifically:

- `ort` (ONNX Runtime) is **already a Cargo dependency** for KWS and Parakeet, so no new runtime
- Windows ships **free CPU OCR** (`Windows.Media.Ocr`), no VRAM, no download
- Prosody features come from audio buffers the pipeline already has
- Foreground-window polling is ~50 lines and near-zero cost
- Total added footprint under 20MB RAM, **no GPU contention with transcription**

Why nobody has built it: it needs continuous mic capture, continuous screen access, **and** an agent that can act without being prompted. Cluely and oto have the first two and no write-capable agent. Copilot and Cursor have the agent and no ambient audio or window awareness. That combination is what makes this setup unusual, and it is where the genuinely novel ideas live.

**Kill-or-prove in a day:** log window-repeat events and a naive pitch-variance score during one real session. Automate nothing. If the two signals do not co-occur at the moments you would have wanted help, the idea dies for free.

---

## Two warnings worth heeding

**A local-first promise is only as durable as the company staying independent.** Rewind launched on "your data stays on your device", pivoted to a cloud pendant, was acquired by Meta, and had screen and audio capture switched off entirely on 2025-12-19, with EU users banned. Tandem markets on the identical promise. The difference is that Tandem is yours and does not need to survive an acquisition, which is worth saying out loud in the positioning.

**"Screenshot everything" without encryption at rest is a security liability, not just a privacy one.** Microsoft Recall's first build stored plaintext readable by any process, described as "a goldmine" for infostealers, and had to be redesigned. Any ambient-vision feature here needs encryption at rest and opt-in as the baseline, not as a later hardening pass.

Related, and specific to this app: **Cone of Silence**. Tandem has both a Meeting mode and a Solo mode with screen capture on one machine. Auto-detect an active screen share and gate capture off, so you never have to remember the privacy step.

---

## Recommended order

Ranked by value over cost, drawing across all three passes.

| # | Change | Size | Source |
|---|---|---|---|
| 1 | Typed jots become intents directly, no classifier | S | Audit #10 |
| 2 | Log discarded low-confidence entries instead of dropping them | S | Audit #3 |
| 3 | Stable `.tandem/CURRENT_SESSION` pointer + copyable `/loop` command | S | Audit #2 |
| 4 | Toast on the *first* routing failure, not the third | S | Audit #4 |
| 5 | "Mark this moment" hotkey | S | Fathom |
| 6 | Buffer pre-project speech, file retroactively | M | Audit #1 |
| 7 | Event-triggered classification replacing the 30s timer | M | Screenpipe, all three |
| 8 | Agent Presence Heartbeat in the HUD | S | Invent #3 |
| 9 | Collapse spoken self-corrections before filing | M | Wispr Flow |
| 10 | Ambient Debugger | M | Invent #1 |

Items 1 to 5 are all small and would land in a day between them. They address the losses you would never otherwise notice, which is the category that erodes trust in the whole pipeline.

---

## What was deliberately cut

- Generic "screenshot goes to a vision model" — that is Cluely with extra steps unless it feeds the agent's task queue
- Session Recall / continuous screen history — Windows Recall and Rewind already ship it, and C: is under 5% free on this machine
- Basic voice commands — the F047 wake-word infrastructure already covers this and it is a shipped pattern, not a new capability
