# Whispering + Tandem: fold in, or keep separate?

Iteration B analyst pass, 2026-07-17. Question (Andrew, verbatim): "Currently I'm using
Whispering, which is a project where I do transcription. I just talk to the computer, hit a hotkey,
and when I'm done it gets posted into my clipboard. Review whether it makes sense to fold this into
the Tandem app or I keep on using it separately. I don't really see a main benefit of folding it
together right now, but I'm curious what you think."

**Verdict: keep them separate. Do not fold Whispering into Tandem. Confidence: high.**

Andrew's instinct is correct, and the evidence makes it stronger than a gut call. The two apps do
orthogonal jobs, the hard part of Whispering is months of dictation-specific reliability work that a
merge would either duplicate or throw away, and Whispering feeds a separate voice-training pipeline
that has nothing to do with meetings. The only things worth doing are light and optional: share a
keyterm vocabulary once ElevenLabs Scribe keyterms ship (helps both), and, only if a concrete need
appears, add a thin one-way "send this dictation to a Tandem project note" destination inside
Whispering's existing delivery pipeline. Neither of those is "folding in."

This also strengthens (does not overturn) the two prior kills on the narrower version of this idea:
[I1-landscape.md #7](I1-landscape.md#L267-L280) and [I3-own-projects.md #4](I3-own-projects.md#L296-L313)
both killed "borrow Whispering's dictation into Tandem." This pass reaches the same conclusion for the
bigger "swallow the whole app" question, with additional evidence they did not surface.

---

## What Whispering actually is (grounded in its own repo)

- A **fork of Epicenter/Whispering** (upstream `EpicenterHQ/epicenter`, formerly `braden-w/whispering`),
  a Svelte 5 + Tauri + Rust desktop app, cloned into `d:/Dev-projects/Whispering/epicenter/` and
  actively customised by Andrew on a `local-build` branch, installed as a signed-off MSI at
  `C:\Program Files\Whispering` (currently ~7.11.x), autostarting at login via a Startup-folder
  shortcut ([Whispering/To-do.md](../../../Whispering/To-do.md#L128-L139)).
- Its whole reason for existing, in the author's own README: "Press a keyboard shortcut, speak, and
  your words will transcribe, transform, then copy and paste at the cursor... I use it for several
  hours a day, from coding to thinking out loud while carrying pizza boxes"
  ([README.md](../../../Whispering/epicenter/apps/whispering/README.md#L37-L43)). Critically, the same
  README draws the boundary line for us: **"Whispering is designed for quick transcriptions, not long
  recordings. For extended recording sessions, use a dedicated recording app."**
  ([README.md](../../../Whispering/epicenter/apps/whispering/README.md#L45-L46)). Tandem *is* the
  dedicated recording app. The two are complementary by the tool's own design, not competitors.
- It runs on **ElevenLabs Scribe v2** ([To-do.md](../../../Whispering/To-do.md#L217), same engine as
  Tandem's live path per project MEMORY), with an optional **local Ollama transformation** pass to
  polish the raw transcript.
- What it stores and does that Tandem does not: **paste-at-cursor** via a Rust clipboard sandwich
  behind a tokio Mutex, an **ordered delivery queue**, **tap-vs-hold** hotkey handling (tap = toggle,
  hold = push-to-talk), **VAD mode** with tuned pause tolerance / thresholds / pre-speech pad,
  connection prewarming, request timeout + retry classification, **snippets** (spoken trigger phrase
  expands to stored boilerplate), and **transformation-aware shortcuts** (one hotkey polishes, another
  transcribes raw). Its own `transformationRuns` table (raw input + polished output pairs) is the data
  source for a **separate voice-corpus / tone-of-voice project** in `D:\Dev-projects\Andrews_Voice_Training`
  (3,014 dictations, feeding the `client-communication` skill; [To-do.md](../../../Whispering/To-do.md#L102-L120)).
- Its bindings are **Alt+Shift+D** (dictate/polish) and **Alt+Shift+F** (dictate raw), as global OS
  shortcuts.

The reliability surface is the headline. Whispering's To-do is a months-long log of hard-won dictation
bug fixes: double-capture, minutes-late paste, interleaved delivery, an empty transcript firing a stray
Enter into the focused app, VAD cutting off quiet speech too soon, a hotkey press permanently disabling
voice activation ([To-do.md](../../../Whispering/To-do.md#L14-L42), [L74-L86](../../../Whispering/To-do.md#L74-L86),
[L152](../../../Whispering/To-do.md#L152)). That is exactly the kind of edge-case hardening that only
comes from daily use, and it is the part that is genuinely hard to get right.

## What Tandem already has (so a merge would rebuild, not gain)

Tandem is not missing STT primitives; it is only missing *system-wide paste-at-cursor*, which is the
one thing it should not want:

- **Scribe v2 provider** already in-repo:
  [elevenlabs_provider.rs](../../frontend/src-tauri/src/audio/transcription/elevenlabs_provider.rs)
  and [engine.rs](../../frontend/src-tauri/src/audio/transcription/engine.rs).
- **Record-a-clip-and-transcribe** primitive: `canvas_transcribe_clip` in
  [canvas/commands.rs](../../frontend/src-tauri/src/canvas/commands.rs), wired to the canvas voice
  feature (Alt+Shift+A) via [useCanvasVoice.ts](../../frontend/src/hooks/useCanvasVoice.ts).
- **Push-to-talk plumbing** already built: Alt+Shift+Q hold-to-talk in
  [useVoiceCommand.ts](../../frontend/src/hooks/useVoiceCommand.ts), using the OS-level global-shortcut
  plugin registered in [lib.rs](../../frontend/src-tauri/src/lib.rs).
- **Quick-capture** window (Alt+Shift+N), which already writes a dated note into
  `<project>/.tandem/notes` and routes by project ([capture/page.tsx](../../frontend/src/app/capture/page.tsx#L9-L11)).
- A crowded but currently-clean **Alt+Shift namespace**: Tandem owns Q, A, N, E, S, R, V; Whispering
  owns D, F. They collided once (Tandem renamed its record toggle from Alt+Shift+D to Alt+Shift+E on
  2026-07-15 to get out of Whispering's way) and have not since.

So if Tandem ever wants an in-app voice jot (e.g. dictate into the just-shipped enhance-my-notes jot
strip), it can build it on `canvas_transcribe_clip` + the Alt+Shift+Q plumbing it already owns, with
zero Whispering involvement. The prior verdicts made exactly this point.

---

## The honest ledger

### Cost of running both today (real, but small)

| Duplication | Actual cost | Severity |
|---|---|---|
| Two apps resident | Whispering is a tiny always-on tray/dictation app; Tandem is the meeting app. Negligible RAM/attention overlap. | Low |
| Two global hotkeys | Alt+Shift+D/F vs Tandem's Q/A/N/E/S/R/V. One past collision, resolved; namespace is crowded but managed. | Low-Med |
| Two Scribe consumers | Same ElevenLabs account, same key, usage-based billing. Two key entries to maintain, one bill. Not a real duplication cost. | Low |
| Two configs | Whispering's dictation config (transformations, snippets, VAD thresholds) is genuinely dictation-specific and has no meaningful Tandem analogue to unify with. | Low |
| Two forks to maintain | Whispering tracks upstream Epicenter (a 716-commit unreleased rework); Tandem tracks Meetily. Independent maintenance either way. | Neutral |

The running-both cost is low and mostly already paid. There is no bleeding wound here that a merge
would cauterise.

### What folding IN would buy (thin)

- **"Dictation that routes to projects"** — marginally net-new: Alt+Shift+N quick-capture already turns
  captured text into a routed project note; the only gap is speaking it instead of typing/pasting. That
  is a small delta, and achievable without a merge (see middle path 3).
- **Dictation into the in-call jot strip** (enhance-my-notes phase 1 shipped a typed jot box) — the one
  genuinely interesting angle, but Tandem's own `canvas_transcribe_clip` + Alt+Shift+Q already cover it
  natively. Whispering adds nothing Tandem lacks for this.
- **Shared keyterm vocabulary once Scribe keyterms ship** — real, and it improves *both* apps. But this
  is an argument for *sharing a config file*, not for *merging the apps*.

### What folding IN would COST (heavy)

- **Scope creep that breaks Tandem's own thesis.** To absorb Whispering, Tandem would have to become an
  always-on, system-wide dictation daemon that types into any app on the machine. That is the opposite
  of Tandem's "invisible when active, meeting co-pilot" identity, and it is 90% used *outside* Tandem's
  window (coding, email, Slack, browser).
- **Reimplementing paste-at-cursor well is the genuinely hard part**, and Whispering has already paid for
  it in blood: the clipboard sandwich, ordered delivery queue, tap/hold disambiguation, empty-transcript
  guarding, VAD tuning, timeout/retry classification. Rebuilding that in Tandem discards months of
  edge-case fixes ([To-do.md](../../../Whispering/To-do.md#L14-L42)) for zero user-visible gain.
- **Breaking a tool used several hours a day** during a rebuild, for a workflow (talk anywhere, paste
  anywhere) that Tandem does not otherwise need.
- **Orphaning the voice-corpus pipeline.** Whispering's transformation-run pairs feed
  `Andrews_Voice_Training` and the `client-communication` skill
  ([To-do.md](../../../Whispering/To-do.md#L102-L120)). That is dictation infrastructure, not meeting
  infrastructure; folding it into a meeting app is a category error.
- **Losing upstream.** Whispering still pulls selective fixes from Epicenter
  ([To-do.md](../../../Whispering/To-do.md#L88-L100)); absorbing it into Tandem's tree severs that.

The ledger is lopsided: low, already-paid duplication cost on one side; heavy rebuild-and-break cost
for a thin, largely-already-achievable gain on the other.

---

## Middle paths (in preference order)

1. **Status quo, keep separate (recommended default).** Two focused tools, each best-in-class at its
   job. This is Andrew's current lean and it is right.

2. **Share a keyterm vocabulary once Scribe keyterms land (light, do when the feature ships).** The
   ranked roadmap already has "Scribe keyterms" in its top 5
   ([ROADMAP.md](../ai-os-integrations/ROADMAP.md)). When built, put the keyterm list in one shared
   location (a plain file both apps read) so a name/acronym learned for meetings also sharpens
   dictation, and vice versa. This is the only "integration" with a clean two-way payoff, and it is
   config-sharing, not merging. Effort: S, and only meaningful after keyterms exist.

3. **Optional thin one-way bridge: a "send to Tandem project note" delivery target in Whispering (only
   if a concrete need appears).** Whispering already has a pluggable delivery/output pipeline
   ([delivery.ts](../../../Whispering/epicenter/apps/whispering/src/lib/operations/delivery.ts) per its
   To-do). Adding an output destination that POSTs the final (optionally Ollama-polished) transcript to
   Tandem's quick-capture/router would deliver the north star ("I talk to it and it routes my notes to
   the right project") *by cooperation, not merger*: Whispering stays the capture surface it is good at,
   Tandem stays the router it is good at. Build this only if Andrew finds himself actually wanting spoken
   notes filed to projects; do not build it speculatively. Effort: S-M, and it lives in Whispering, not
   Tandem.

4. **If Tandem wants in-call voice jots, build them natively.** Use `canvas_transcribe_clip` + the
   Alt+Shift+Q plumbing already in Tandem. No Whispering code, no cross-app coupling. This is the same
   correction I3 already made ([I3-own-projects.md #4](I3-own-projects.md#L296-L313)).

**Explicitly not recommended:** a full fold-in, a shared Rust STT library across the two Tauri apps
(couples two independently-versioned codebases for no user gain), or Tandem taking over system-wide
paste-at-cursor.

---

## Bottom line

Keep using Whispering separately. It is a mature, daily-driver dictation tool whose value is precisely
the system-wide "talk anywhere, paste anywhere" behaviour that Tandem should not want to own, and whose
hard-won reliability a merge would either duplicate or destroy. Tandem already has every STT primitive
it needs for its *own* in-app voice moments. Do the two light, optional things if and when they earn
their keep: a shared keyterm list once Scribe keyterms ship, and (only on a real need) a one-way
"file this dictation to a Tandem project" output inside Whispering. Everything heavier is negative-value.

Confidence: **high**. The recommendation aligns with Andrew's own read, matches the tool author's own
stated design boundary, is consistent with two prior independent adversarial verdicts, and survives the
full cost/benefit ledger without a single load-bearing assumption that failed to verify against the
files on disk.

---

## Skeptic review

Adversarial pass, 2026-07-17. Read `d:/Dev-projects/Whispering/To-do.md` in full and grepped the live
`epicenter/apps/whispering` source tree directly (not the analyst's quotes of it); read Tandem's
`lib.rs`, `elevenlabs_provider.rs`, `canvas/commands.rs`, `capture/page.tsx`, and the git log for the
hotkey-rename commit; re-read both prior verdicts (I1 #7, I3 #4) in full rather than trusting the
excerpt. Mandate: find defects, default to failing.

### What held up (verified against files on disk, not just the doc's quotes)

- **README quote is exact.** Both sentences ("I use it for several hours a day... carrying pizza boxes"
  and "Whispering is designed for quick transcriptions, not long recordings... use a dedicated recording
  app") are verbatim in `epicenter/apps/whispering/README.md`. Not paraphrased, not cherry-picked out of
  context — the "not long recordings" line is its own blockquote immediately after the daily-use claim.
- **Scribe v2 + delivery pipeline claims check out.** `src/lib/operations/delivery.ts` exists;
  `transformationRuns` is a real table in `definition.ts` (line 162); the tokio Mutex clipboard sandwich,
  ordered delivery queue, tap/hold disambiguation, empty-transcript guard, and VAD threshold tuning are
  all real, dated, commit-hashed entries in `To-do.md` (not invented war stories) — e.g. the
  2026-07-14 "Alt+Shift+D permanently turned off voice activation" postmortem is a genuine two-iteration
  bug fix with root cause and a named race condition, exactly as characterized.
- **Tandem-side primitives are real and match the doc's line numbers.** `canvas_transcribe_clip` exists
  at `canvas/commands.rs:119`; `elevenlabs_provider.rs` really does implement a Scribe v2 HTTP client
  (`ELEVENLABS_STT_URL`, `model_id` e.g. `scribe_v2`); `useVoiceCommand.ts` and `useCanvasVoice.ts` both
  exist. `lib.rs` confirms the CURRENT live hotkey set is exactly Q/A/N/E/S/R/V as claimed
  (`Alt+Shift+S/R/V/A/Q/E/N`, line 713), and `git log` confirms commit `67f52e0`,
  "fix(hotkey): record toggle moved Alt+Shift+D to Alt+Shift+E (user already uses Alt+Shift+D
  elsewhere)" — the collision-and-resolution story is not invented.
- **Both cited prior verdicts say what the doc claims they say.** I1-landscape.md #7 and I3-own-projects.md
  #4, read in full, independently reach "kill the borrowed-dictation proposal" for the same
  already-covered-primitive reasoning, including the identical Alt+Shift+D/E collision citation.
- **The core architecture argument is sound, not a strawman.** "Folding in" plausibly means Tandem
  absorbing Whispering's always-on, system-wide daemon behavior into what is currently a
  triggered-per-meeting co-pilot. That is a real identity conflict with Tandem's stated "invisible when
  active" design principle (project CLAUDE.md, Design Context section), not a rhetorical inflation of the
  ask.

### What did not hold up / should be corrected

1. **The Alt+Shift+F binding is asserted as settled fact but is only ever a TODO in the source.**
   `To-do.md` line 58 says "bind Alt+Shift+F to 'Toggle recording (skip transformation)' in Settings ->
   Shortcuts -> Global" as an action item after the 2026-07-08 feature landed — there is no later `[x]`
   or confirmation anywhere in the file that Andrew actually did this. Grepping the whole repo for
   "Alt+Shift+F" turns up only that one planning sentence, twice. The doc's line "Its bindings are
   Alt+Shift+D (dictate/polish) and Alt+Shift+F (dictate raw), as global OS shortcuts" states this as
   current fact when it is at best an unconfirmed to-do. Low stakes (doesn't change the recommendation)
   but should be softened to "planned to bind" or verified with Andrew before being stated flatly.
2. **The "90% used outside Tandem's window" figure is invented.** No usage telemetry, log, or even a
   rough manual estimate is cited anywhere in this doc or in Whispering's To-do.md to back that specific
   number. It reads as a real qualitative claim (dictation happens mostly outside meetings) dressed up
   in a fabricated precise statistic, which is the kind of thing that erodes trust in an otherwise
   well-sourced document. Recommend restating as a qualitative claim without an invented number.
3. **Middle paths were fairly considered, and checking them turned up a point in the doc's OWN favor that
   it missed.** Reading `frontend/src/app/capture/page.tsx` directly: Alt+Shift+N quick-capture already
   loads `get_quick_capture_clips`, a rolling buffer of the last 3 copied clipboard items, as selectable
   chips that get routed and filed to a project note. That means the stated north star ("I talk to it
   and it routes my notes to the correct project") may already work TODAY with zero new code: dictate
   with Whispering's Alt+Shift+D (which ends by placing the polished transcript on the clipboard), then
   press Tandem's Alt+Shift+N and file the resulting clip. The doc's middle path 3 proposes *building* a
   one-way bridge "only if a concrete need appears" — but the chain that satisfies that need may already
   exist via two hotkeys Andrew already owns. This doesn't change the recommendation (it reinforces
   "don't build anything yet"), but the doc should have surfaced it as a thing to just try before
   scoping any new code, and undersold its own case by not checking.

### Steelmanning the opposite case (fold in), and why it still loses

The strongest version of "fold in" is a maintenance-burden argument the doc doesn't fully engage: Andrew
is a solo operator running TWO independently-forked Tauri desktop apps, each with its own upstream-tracking
burden, build-toolchain quirks (Bun-runtime workaround, Vulkan SDK gap, MSI signing/autostart), and settings
surface. A shared Rust STT crate (connection prewarming, VAD tuning, timeout/retry classification) could in
principle mean a fix landed once benefits both apps, which is a real recurring engineering tax the "low,
already-paid duplication cost" table undercounts.

This is real but not compelling enough to flip the verdict: it is a speculative future-maintenance argument
against a concrete, present cost (breaking a tool used several hours a day, for a rebuild of infrastructure
Tandem does not currently need and whose only proven demand is a north star that may already be satisfiable
by chaining two existing hotkeys, per point 3 above). It also runs against Andrew's own stated instinct in
the original question. A shared-crate refactor is worth revisiting only if Tandem ever ships its own
in-app dictation feature AND that feature starts accumulating the same category of edge-case bugs Whispering
already solved — at that point, "extract the shared logic into a crate both apps depend on" becomes a
concrete, evidence-backed proposal rather than a preemptive one. Not now.

### Final verdict

**Concur** with "keep separate." The factual grounding is unusually solid — every load-bearing claim about
Whispering's architecture, Tandem's primitives, hotkey history, and the two prior verdicts verified against
the files on disk, not just the doc's paraphrase of them. Two small precision issues (the unconfirmed
Alt+Shift+F binding, the invented 90% figure) should be corrected but do not change the recommendation. One
genuine improvement is available: try the already-existing Whispering-dictate -> Tandem-quick-capture hotkey
chain before building middle path 3's bridge, since it may already deliver the north star with zero new code.
