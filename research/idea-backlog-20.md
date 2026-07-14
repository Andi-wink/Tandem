# 20 candidate ideas (unranked, 2026-07-14)

Context: Tandem is Andrew's privacy-first meeting co-pilot becoming his daily driver / OS-like
tool. Consultant/freelancer, discovery + advisory calls, client folders on D:\Client_projects,
calendar-driven recording with auto-filing (I3-I6), pre-meeting popup + handover (I5/I5b),
Ctrl+K palette, action-items checklist, auto-summary on stop. Ranking criterion: PRODUCTIVITY
GAIN for Andrew, above all else.

1. **Ask-my-meetings Q&A**: natural-language questions across all past transcripts ("what did
   Nate say about pricing?", "when did we agree the deadline?") with answers citing meeting +
   timestamp, from Ctrl+K or the AI panel. Local RAG over the existing SQLite transcripts.
2. **Cross-meeting action-item inbox**: one view aggregating action items from every meeting,
   grouped by project, with open/done/overdue states and jump-to-source. The per-meeting
   checklist exists; this is the missing "what do I owe everyone" surface.
3. **Meeting prep one-pager**: 10 min before a matched call, auto-generate a brief: last
   meeting's summary, open action items for that client, unanswered follow-ups. Surfaced in
   the reminder dialog / agenda row.
4. **Commitment tracker**: parse "I'll send you X by Friday" style commitments (mine and
   theirs) from transcripts into dated follow-ups; nudge when a commitment is 48h stale.
5. **Post-call one-screen review**: after stop, a single screen: summary, action items,
   follow-up draft, filing confirmation; one keystroke accepts all, esc defers. Replaces
   hunting through meeting details after each call.
6. **Auto-stop suggestion**: when the calendar event has ended AND sustained silence is
   detected, toast "Meeting seems over, stop and summarize?" (never auto-stop). Catches the
   classic forgot-to-stop 2-hour recording.
7. **Speaker diarization surfacing (F022)**: land the existing diarization worktree so
   transcripts and summaries say who said what; makes commitments/decisions attributable.
8. **Meeting-type templates**: summary template auto-picked by calendar keywords (discovery
   vs advisory vs standup), each with tuned sections (e.g. discovery: pain points, budget,
   next steps).
9. **n8n export hook**: push summary + action items to an n8n webhook per project (CRM
   update, task creation) with a per-project on/off. Andrew already runs n8n for clients.
10. **Client dossier page**: per project: all meetings, cumulative key facts (stakeholders,
    tools, constraints) extracted and maintained across calls, editable.
11. **Global quick-capture**: hotkey outside meetings opens a tiny input; the note routes to
    the right project via the existing router ("Acme wants a demo of the invoice flow").
12. **Search operators in Ctrl+K**: qualifiers like `@acme pricing`, `after:last-week`,
    filtering the meeting search that shipped in I6.
13. **Transcript snippet clipping**: select a transcript range, one keystroke saves it as a
    quotable clip (text + timestamp + meeting link) to the project; palette lists clips.
14. **Smart meeting titles**: after summary, rename timestamp-titled meetings to a content
    title ("Acme: rollout scope + pricing objections"), with undo.
15. **Custom vocabulary for STT**: feed client/product names and jargon (from project names +
    corrections) into the transcription path to cut recurring misrecognitions.
16. **Mini recording HUD**: tiny always-on-top pill (elapsed, recording state, mute-note,
    stop) visible during screen shares on any monitor; click expands.
17. **Weekly review digest**: Monday brief: last week's meetings per client, decisions,
    open action items, this week's calendar with suggested prep.
18. **Encrypted backup**: scheduled encrypted backup of both SQLite DBs + meeting folders to
    a chosen drive/NAS path with restore flow. Protects the asset everything else builds on.
19. **Live commitment/question flags**: during a call, quietly flag detected questions asked
    to Andrew and commitments made, shown as a small in-call list so nothing is missed while
    multitasking.
20. **Voice control everywhere**: extend push-to-talk grammar beyond filing: "start recording",
    "summarize the last call", "what's next today", executed via the palette's command
    registry without opening the app window.
