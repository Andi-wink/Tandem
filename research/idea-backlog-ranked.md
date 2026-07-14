# Idea backlog, ranked by real productivity gain (2026-07-14)

Ranking criterion: real productivity gain for Andrew, a solo consultant doing 5-15 discovery/advisory
calls a week, whose north star is "talk to the tool, it routes my notes to the right project." Only two
things score: minutes saved per week, and dropped balls / errors prevented. Novelty, coolness, and
engineering elegance score nothing. Where an idea leans on unshipped infrastructure, feasibility was
checked against the repo state (I3-I6 shipped, I7-I9 parked, diarization F022 still an in-flight
worktree, STT is now ElevenLabs Scribe v2 cloud).

Numbers below are deliberately conservative estimates of steady-state value after the novelty fades,
not launch-week enthusiasm.

---

## Top tier: build these

### 1. Cross-meeting action-item inbox (idea 2)
- Est. value: 20-40 min/week saved plus the single biggest dropped-ball preventer. One missed commitment to a paying client can cost far more than any weekly minute count.
- Strongest FOR: this is literally "what do I owe everyone," the one surface a multi-client consultant checks daily. The per-meeting checklist shipped in I4 already parses action items, so the raw data exists and just needs aggregation, grouping by project, and open/done/overdue states. Net-new, not parked.
- Strongest AGAINST: only as trustworthy as the underlying action-item parsing; if the "Immediate Action Items" extraction is noisy, the inbox inherits that noise and a cluttered inbox gets ignored. Needs open/done state to persist reliably across summary regeneration.
- Verdict: highest gain-to-effort on the board, build first.

### 2. Meeting prep one-pager (idea 3)
- Est. value: 5-10 min saved per call (10x/week is 50-100 min) plus walking in genuinely prepared instead of cold.
- Strongest FOR: fires on every single call, reuses the I5 pre-meeting popup as the delivery surface and the I3 project match to pull last summary + open action items + open follow-ups. I8 only planned a "recorded" check and "What's next," not a content brief, so this is net-new and directly advances the OS vision.
- Strongest AGAINST: value collapses if the client has little history (first discovery call gets an empty brief), and a stale or wrong project match would surface the wrong client's brief, which is worse than none. Depends on prep content actually being right.
- Verdict: the "before the call" half of the daily spine, build second.

### 3. Global quick-capture (idea 11)
- Est. value: 10-20 min/week plus captures thoughts that would otherwise evaporate between calls.
- Strongest FOR: the purest expression of the north star, talk to it and it files itself, and it is cheap because the router already exists (I3). High frequency (potentially several times a day), low risk since the user sees where it landed and can redirect.
- Strongest AGAINST: routing a one-line note is harder than routing a whole transcript (less context for the router), so misfiles will be more common here; needs a visible "filed under X, change?" affordance or it silently scatters notes.
- Verdict: cheap, north-star-aligned, high frequency, build third.

---

## Strong tier: clear value, a notch below

### 4. Ask-my-meetings Q&A (idea 1)
- Est. value: 15-30 min/week when it works, on the handful of "what did we actually agree" moments.
- Strongest FOR: genuine capability leap over keyword search, synthesized answers to "when did we agree the deadline" across all history. This is the memory a consultant wishes they had.
- Strongest AGAINST: hallucinated citations are a trust-killer; one confidently wrong "Nate said $40k" and Andrew stops believing every answer, making the feature net-negative. Also I6 keyword search already covers "find where X was discussed," so the delta is only the synthesis, which is exactly the risky part. Local RAG over SQLite is real build + maintenance.
- Verdict: high ceiling, but citations must be exact-quote-linked or it corrodes trust; build carefully.

### 5. Smart meeting titles (idea 14)
- Est. value: 5-15 min/week of faster scanning across the sidebar and search results.
- Strongest FOR: compounds daily, a By-project sidebar full of "Acme: rollout scope + pricing objections" beats a wall of timestamps, and the summary already produced the content to title from. Undo makes it safe.
- Strongest AGAINST: a wrong or generic auto-title ("Weekly sync") is arguably worse than a timestamp for scanning, and I6 search already reduces the findability pain, so this is polish rather than a new capability.
- Verdict: real quality-of-life multiplier on shipped surfaces, keep undo front and center.

### 6. Post-call one-screen review (idea 5)
- Est. value: 5-10 min/call IF it lands the follow-up draft where memory is freshest, otherwise 1-2 min of saved clicks.
- Strongest FOR: consolidates the post-call chore (summary, action items, follow-up, filing confirm) into one accept-all keystroke, touching every call.
- Strongest AGAINST: most of its value is already shipped or parked. Auto-summary fires on stop (I4), filing is automatic (I3), and the follow-up email draft is explicitly planned in I8. Net-new value is mostly the one-screen consolidation, so building it before I8 partly duplicates I8.
- Verdict: good UX consolidation, but sequence it with I8 so the follow-up draft is not built twice.

---

## Marginal tier: real but modest, or gated by accuracy/feasibility

### 7. Client dossier page (idea 10)
- Est. value: 5-10 min/week of "who are the stakeholders again" lookups before advisory calls.
- Strongest FOR: aligned with recurring advisory relationships; a maintained fact sheet per client is exactly what a solo consultant lacks.
- Strongest AGAINST: the valuable part (auto-extracted, auto-maintained facts) is the drift-and-hallucination-prone part; the safe part (all meetings per client) is already the I6 By-project sidebar. Editable facts also create a maintenance chore.
- Verdict: worthwhile only if fact extraction is conservative and clearly editable; heavy overlap with idea 3.

### 8. n8n export hook (idea 9)
- Est. value: 0 to 30 min/week, entirely dependent on whether Andrew wires real downstream automations.
- Strongest FOR: feasible today (outbound webhook, no OAuth unlike the parked two-way calendar write path), and Andrew already runs n8n, so the plumbing is familiar.
- Strongest AGAINST: speculative demand. Pushing every summary to a CRM assumes automations that may not exist; per-project setup cost with unproven payoff. Classic "cool because it connects things" trap.
- Verdict: build only when a concrete downstream flow exists to consume it, not on spec.

### 9. Auto-stop suggestion (idea 6)
- Est. value: prevents roughly one runaway recording every week or two (wasted disk, garbage transcript, wasted summary tokens).
- Strongest FOR: very cheap, low risk (toast only, never auto-stops), reuses calendar-end + silence signals already available.
- Strongest AGAINST: the underlying problem is infrequent, so absolute time saved is small; a false "meeting seems over" during a quiet advisory pause would be mildly annoying.
- Verdict: cheap insurance against an occasional but real annoyance; good filler, not a headline.

### 10. Meeting-type templates (idea 8)
- Est. value: marginal summary-quality improvement, near-zero dropped-ball prevention.
- Strongest FOR: a discovery-tuned summary (pain points, budget, next steps) is more useful than a generic one, and calendar keywords can auto-pick it.
- Strongest AGAINST: better output quality is not saved time; a generic summary is already usable. Keyword-to-template mapping is fiddly and will mis-pick.
- Verdict: nice tuning, not a productivity lever.

### 11. Weekly review digest (idea 17)
- Est. value: 10-15 min on Monday, but largely rehashing ideas 2 and 3.
- Strongest FOR: a single orientation ritual to start the week.
- Strongest AGAINST: if the action-item inbox (2) and prep one-pager (3) exist, this is just a scheduled rollup of them; low net-new value and one more thing to maintain.
- Verdict: build after 2 and 3, and only as a thin scheduled view over them.

### 12. Commitment tracker (idea 4)
- Est. value: high in theory (prevents dropped promises), near-zero or negative in practice due to accuracy.
- Strongest FOR: parsing "I'll send X by Friday" into dated nudges targets exactly the consultant's trust-critical failure mode.
- Strongest AGAINST: extraction of commitments and their dates is error-prone; a wrong nudge ("you owe Acme a proposal" when you don't) or a wrong date trains Andrew to ignore all nudges, killing the feature. Heavily overlaps the action-item inbox (2), which already surfaces owed items more safely.
- Verdict: seductive but the false-positive cost is severe; let idea 2 cover this ground first.

### 13. Custom vocabulary for STT (idea 15)
- Est. value: potentially high and compounding (fewer mangled client/product names improves search, summaries, and dossier all at once), but feasibility-gated.
- Strongest FOR: transcription errors propagate into every downstream feature, so cutting recurring misrecognitions has leverage.
- Strongest AGAINST: STT is now ElevenLabs Scribe v2, a cloud engine; whether it exposes keyword biasing / custom vocabulary is unverified, and if it does not, this idea is dead as written. Also a maintenance chore to curate the vocabulary.
- Verdict: verify Scribe supports vocabulary biasing before spending an hour on it; high payoff only if the API cooperates.

---

## Skip tier: low productivity gain, blunt reasons

### 14. Transcript snippet clipping (idea 13)
- Est. value: a few minutes a week at most; occasional use.
- Blunt reason: saving a quotable clip is a nice-to-have that happens rarely and saves little; it is capture without a clear recurring payoff, and search (I6) already finds the passage when needed.

### 15. Search operators in Ctrl+K (idea 12)
- Est. value: seconds per search, low frequency.
- Blunt reason: a power-user filter on top of I6 search that most sessions will never invoke; marginal refinement of an already-shipped feature, not new capability.

### 16. Encrypted backup (idea 18)
- Est. value: about zero minutes/week and zero dropped balls in normal operation.
- Blunt reason: on the productivity axis this scores near nothing, it is insurance not a time-saver. Honest caveat: it is the one "skip" that is strategically important, because losing all client history would be catastrophic, but the acute data-loss risk (the dangerous 7-day retention default) is already being fixed in the parked I7 plan, and Windows users have File History / OneDrive. Rank it low here, but do not confuse "low productivity gain" with "unimportant."

### 17. Speaker diarization surfacing, F022 (idea 7)
- Est. value: marginal for a solo consultant, versus enormous build/maintenance cost.
- Blunt reason: worst gain-to-effort on the list. It is an unshipped infra piece (channel-split + pyannote, eval harness still being built in the Tandem-f022 worktree), and for the common 2-party call the mic-vs-system channel split already separates "me" from "them." Big lift, small marginal attribution win.

### 18. Live commitment/question flags (idea 19)
- Est. value: low, and at odds with the design principle.
- Blunt reason: an in-call list competing for attention violates "invisible when active," real-time NLP false positives during a live call are distracting, and the genuine value (post-call recall) is already covered more safely by ideas 2 and 4. Wrong place, wrong time.

### 19. Voice control everywhere (idea 20)
- Est. value: near zero incremental; mostly redundant.
- Blunt reason: everything it offers is already faster and more reliable via a hotkey or Ctrl+K. Alt+Shift+D already toggles recording; "What's next" is in I8. Voice adds a flashy, error-prone layer over commands that already work. Novelty, not gain.

### 20. Mini recording HUD (idea 16)
- Est. value: essentially zero productivity gain.
- Blunt reason: a comfort/awareness pill, and a Solo HUD already exists in the canvas work, so this is partly redundant. Knowing you are recording is nice but saves no time and prevents no meaningful dropped ball once the tray/indicator exist. Lowest priority.

---

## Top 3 to build next, and why

Build the cross-meeting action-item inbox (idea 2), the meeting prep one-pager (idea 3), and global
quick-capture (idea 11). These three form the spine of every working day for a multi-client consultant:
the inbox is the single best dropped-ball preventer and reuses action-item parsing already shipped in I4;
the prep one-pager makes Andrew walk into every call informed instead of cold and rides on the I5 popup
plus I3 routing that already exist; and quick-capture is the cheapest, most north-star-aligned win,
turning any stray thought into a correctly filed note through the router already built in I3. Together
they cover before-call, owed-work, and always-on capture with high frequency, low build cost, and low
failure blast radius. The higher-ceiling but riskier bets (ask-my-meetings Q&A, client dossier) should
wait until their trust problem, exact citations and conservative fact extraction, is designed, because a
confidently wrong answer there costs more trust than the feature returns.
