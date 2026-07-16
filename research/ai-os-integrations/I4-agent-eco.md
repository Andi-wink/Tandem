# I4 - Agent / MCP Ecosystem for Tandem (researcher output, 2026-07-16)

Iteration I4-agent-eco of the "AI OS features and integrations" loop. Goal: map the agent /
MCP ecosystem onto Tandem's AI panel and the `@code` handoff, being precise about what the
Claude Agent SDK actually supports as of mid-2026, and proposing 6-10 concrete features that
advance the north star ("I talk to it and it routes my notes to the correct project") without
breaking the privacy-first, local-infrastructure ethos.

## Grounding: what Tandem already runs (verified in-repo)

This matters because several "capabilities" people ask for are already present, and the good
proposals build on them rather than re-introducing them.

- **The AI panel is built on the Claude Agent SDK, not the raw Messages API.** The backend
  imports `claude_agent_sdk` (`query`, `ClaudeAgentOptions`, `AssistantMessage`, `ToolUseBlock`,
  ...) in [backend/app/claude_agent.py](../../backend/app/claude_agent.py#L22-L31). That means
  subagents, hooks, and MCP client support are *already available to us as SDK options* - we
  just are not using most of them yet.
- **MCP client support is already wired.** `_load_mcp_servers()` reads
  `backend/mcp_servers.json` (same schema as `.mcp.json`), expands `${ENV_VAR}` secrets from the
  environment, and the options builder wildcard-allows every tool from each configured server
  (`allowed_tools.append(f"mcp__{name}__*")`) - see
  [claude_agent.py](../../backend/app/claude_agent.py#L53-L79) and
  [L233-L252](../../backend/app/claude_agent.py#L233-L252). No `mcp_servers.json` ships today, so
  the panel currently runs with built-in tools only.
- **Built-in tools already allowed:** `Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch,
  TodoWrite, AskUserQuestion`, `permission_mode="acceptEdits"`, `cwd=project_dir`
  ([L233-L242](../../backend/app/claude_agent.py#L233-L242)). So a "filesystem MCP" or a
  "web-search MCP" would be largely redundant with what the SDK ships.
- **What we are NOT using yet:** `agents=` (subagents), `hooks=` (PreToolUse/PostToolUse/etc.),
  `can_use_tool` permission callbacks, `setting_sources`. Model is pinned to `claude-opus-4-6`
  ([L231](../../backend/app/claude_agent.py#L231)).
- **`@code` handoff today** is file-drop polling: Tandem writes `.tandem/tasks/<ts>.md`, an
  external `claude --dangerously-skip-permissions` running `/loop 1m ...` polls, executes, and
  deletes the file; `.tandem/live-transcript.md` is rolling context. Documented in
  [CLAUDE.md](../../CLAUDE.md) ("Claude Code Autonomous Loop (F054 Handoff)"). Fragile: needs a
  terminal open, no status flows back into Tandem, no structured result.
- **Deferred write path.** The Microsoft Graph / n8n calendar+email *write* path is explicitly
  parked as "the later OAuth-crossing track" because an agent cannot complete an interactive
  OAuth consent - see
  [To-do.md](../../To-do.md) I2-deferred and
  [research/proton-mail-calendar-integration/01-ADDENDUM-n8n-docker-outlook.md](../proton-mail-calendar-integration/01-ADDENDUM-n8n-docker-outlook.md).
- **n8n MCP is unauthenticated for this agent session** (flagged at session start) - not yet
  connected.

## What the Claude Agent SDK actually supports as of 2026 (with citations)

The Claude Agent SDK (`claude-agent-sdk` Python / `@anthropic-ai/claude-agent-sdk` TS) is Claude
Code packaged as a library: it ships the full agent loop, built-in tools (Read/Write/Edit/Bash/
Glob/Grep/WebSearch/WebFetch), context management, sessions, and first-class support for the
three things this iteration is about. It was renamed from the "Claude Code SDK" in Sept 2025.
([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview),
[anthropics/claude-agent-sdk-python](https://github.com/anthropics/claude-agent-sdk-python),
[PyPI claude-agent-sdk](https://pypi.org/project/claude-agent-sdk/))

- **Subagents** - focused child agents with their own context window, tools, and optionally their
  own model; the main agent delegates and they report back. Defined via the `agents` option or
  `.claude/agents/` files.
  ([Subagents in the SDK](https://code.claude.com/docs/en/agent-sdk/subagents),
  [2026 subagents playbook](https://www.developersdigest.tech/blog/claude-code-agent-teams-subagents-2026))
- **Hooks** - Python/TS callbacks the *harness* (not the model) fires at defined points
  (PreToolUse, PostToolUse, etc.) to validate, block, modify, or log actions deterministically.
  ([Hooks](https://code.claude.com/docs/en/agent-sdk/hooks))
- **MCP client support** - connect to MCP servers as local processes, over HTTP (SSE / streamable
  HTTP), or **in-process** ("custom tools" = an in-process MCP server inside your app, no separate
  process). ([MCP in the SDK](https://code.claude.com/docs/en/agent-sdk/mcp),
  [Model Context Protocol](https://modelcontextprotocol.io))
- **Distinct from Managed Agents (CMA).** CMA is a *separate* Anthropic product: a REST API where
  Anthropic runs the agent loop and hosts a per-session sandbox container, with scheduled
  "deployments" (cron). Its tools execute in Anthropic's cloud, not on your machine - a privacy
  fork in the road for Tandem.
  ([Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview),
  [scheduled deployments](https://platform.claude.com/docs/en/managed-agents/overview))
- **Model note.** The panel is on `claude-opus-4-6`; the current Opus tier is `claude-opus-4-8`
  (1M context, `effort` control, same request surface as 4.7). A model-ID bump plus an `effort`
  setting is a drop-in quality lift. ([Models overview](https://platform.claude.com/docs/en/about-claude/models/overview))
- **No native voice-to-voice API.** Anthropic does not ship a realtime voice model as of mid-2026;
  a voice panel must be a pipeline (STT -> Claude -> TTS). Tandem already uses ElevenLabs Scribe
  for STT, and ElevenLabs ships both a realtime STT WebSocket and low-latency TTS.
  ([ElevenLabs docs](https://elevenlabs.io/docs))

---

## Proposals

Ranked loosely by gain-to-effort for Andrew (solo consultant, confidential client calls). Every
proposal is checked against the privacy-first / local ethos and against what is already shipped.

### P1. n8n MCP write-path bridge (the deferred Graph/email/calendar write path, solved)

**What.** Stand up an **n8n "MCP Server Trigger"** in the local n8n instance that exposes a small
set of workflows as MCP tools - `send_followup_email`, `create_calendar_event`,
`move_calendar_event`, `push_summary_to_crm` - and register that server's URL in
`backend/mcp_servers.json`. The AI panel (already an MCP client) can then take real outbound
actions from a call: "send Acme the follow-up," "book the next review Thursday 3pm."

**Why it is the strongest one.** It dissolves the parked OAuth-crossing problem. Tandem never
holds a Microsoft Graph / Google token; the OAuth consent lives once in n8n's credential store,
and Tandem just calls the tool. The MCP Server Trigger natively speaks SSE / streamable HTTP and
exposes attached workflow tools for a client to list and call
([MCP Server Trigger docs](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.mcptrigger),
[connect to n8n MCP](https://docs.n8n.io/connect/connect-to-n8n-mcp-server)). Andrew already runs
n8n locally, and idea 8 ("n8n export hook") in
[research/idea-backlog-ranked.md](../idea-backlog-ranked.md) rated this feasible-today; the MCP
framing turns it from a fire-and-forget webhook into interactive, agent-callable tools.

**Privacy fit:** excellent - localhost/LAN only, secrets stay in n8n, nothing leaves the machine
unless a workflow the user built chooses to send it (and the send is the point).

**Feasibility:** high. `mcp_servers.json` loader already exists and wildcard-allows the server's
tools; the only new work is building the n8n MCP trigger workflows and a per-tool confirmation UX
(pairs naturally with P3). Directly advances the I8 "Draft follow-up email" item and the deferred
two-way calendar write.

### P2. Headless Agent SDK code-handoff session (evolve `@code` off file-polling)

**What.** Replace the `.tandem/tasks/*.md` drop + external `/loop` with a backend-spawned Claude
Agent SDK `query()` session: `cwd` = the target repo, the task + transcript context as the prompt,
progress streamed back into the meeting UI over the SSE channel the panel already uses. Same
`query()` / `ClaudeAgentOptions` machinery as
[claude_agent.py](../../backend/app/claude_agent.py) - a second, repo-scoped agent config.

**Why.** The current handoff needs a terminal open, gives no status back, and returns nothing
structured; the transcript is only "background context" that a human must not act on blindly. A
headless SDK session removes the terminal, streams real-time tool calls and a final result into
the call, and lets us gate/observe it (P3). It reuses infrastructure Tandem already ships.
([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview),
[claude-agent-sdk-python](https://github.com/anthropics/claude-agent-sdk-python)). Fold in the
`claude-opus-4-6` -> `claude-opus-4-8` model bump + an `effort` setting here while touching the
options builder.

**Privacy fit:** good - runs locally with the user's own key, same trust boundary as the panel.
Note: code + transcript context is sent to the Anthropic API exactly as the panel already does.

**Feasibility:** medium. The SDK, options builder, SSE plumbing, and per-meeting session
management already exist; the work is a repo-scoped options profile, a handoff trigger, and a UI
surface for streamed progress. Supersedes the fragile F054 file-poll loop.

### P3. Privacy-gating + audit hooks (PreToolUse / PostToolUse) for the panel and handoff

**What.** Register Agent SDK `hooks`: a **PreToolUse** hook that intercepts `Write`/`Edit`/`Bash`
and destructive MCP calls (e.g. `send_followup_email`, `delete_file`) touching confidential
client folders and requires an in-panel confirmation; a **PostToolUse** hook that appends every
tool call to a per-meeting `audit.md`. Turns "privacy is visible" (design principle #3) into a
mechanism, and is the safety net that makes the autonomous handoff (P2) and outbound actions (P1)
trustworthy.

**Why.** Hooks fire deterministically in the harness, not the model, so they cannot be
prompt-injected around - exactly the property you want gating a "send email to the client" or a
`Bash rm` in a client repo. ([Hooks](https://code.claude.com/docs/en/agent-sdk/hooks),
[SDK hooks/subagents guide](https://aiworkflowlab.dev/article/how-to-build-production-ai-agents-claude-agent-sdk-custom-tools-hooks-subagents)).
The panel currently runs `permission_mode="acceptEdits"` with no gating
([claude_agent.py L241](../../backend/app/claude_agent.py#L241)) - fine for note-taking, risky
once P1/P2 give it outbound + repo write power.

**Privacy fit:** excellent - it *is* a privacy feature; also produces a visible audit trail for
confidential-call reassurance.

**Feasibility:** high. A `hooks=` dict on `ClaudeAgentOptions` plus a small confirm-event over the
existing SSE bridge. Low blast radius, high trust payoff.

### P4. Local browser MCP for in-call / post-call web actions

**What.** Add a **Playwright MCP** (or **Chrome DevTools MCP**) server to `mcp_servers.json`, so
the panel can drive a *local* browser: look up a prospect's site mid-call, verify a fact, fill a
form, or complete a post-call web action an API/MCP does not cover.
([microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp),
[ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp))

**Why.** It is the local, cheaper, safer alternative to computer-use (P8) for anything that lives
in a browser, and it composes with P1 (n8n handles known integrations; the browser handles the
long tail). WebSearch/WebFetch are already built in, so this is specifically for *interacting*
with pages, not reading them.

**Privacy fit:** good - browser runs on the user's machine; only the sites the agent visits see
traffic. Add it behind the same PreToolUse gate (P3) since it can act on live sites.

**Feasibility:** medium. Drop-in via `mcp_servers.json`; needs the P3 gate and a headed/headless
policy decision. Value is real but demand is bursty (idea-backlog "n8n export" caution applies:
build when a concrete flow needs it).

### P5. Subagents in the AI panel (parallel, context-isolated helpers)

**What.** Configure Agent SDK `agents`: a **researcher** subagent (browses/reads while the main
agent stays responsive to the live call), a **note-router** subagent (owns the project-routing
decision with its own tight context), and a **code-handoff** subagent (P2's session as a
delegated child). The panel's main agent delegates and they report back.

**Why.** Subagents each get their own context window and can run a cheaper model, so the panel can
fan out ("research this company") without polluting or blocking the main conversation - directly
useful during a live call where latency and focus matter (design principle #1, "invisible when
active"). ([Subagents](https://code.claude.com/docs/en/agent-sdk/subagents),
[agent teams playbook](https://www.developersdigest.tech/blog/claude-code-agent-teams-subagents-2026))

**Privacy fit:** neutral - same trust boundary as the panel; a subagent on a cheaper model can
reduce cost.

**Feasibility:** medium. `agents=` config plus prompt design and a UI to show subagent activity.
Higher design cost than payoff for a solo user in the near term - sequence after P1-P3.

### P6. Tandem-as-an-MCP-server (expose meetings to any MCP client)

**What.** Ship a small **in-process / local MCP server** that exposes Tandem's own data as tools:
`search_meetings`, `get_summary`, `list_action_items`, `get_transcript(meeting_id)`,
`find_project`. Bound to localhost. Two payoffs: (a) the AI panel gets clean, structured access
to cross-meeting memory instead of grepping files; (b) *any* MCP client on the machine (Claude
Desktop, Claude Code, an n8n MCP Client node) can ask "what did we agree with Acme?"

**Why.** This is the safe, structured route to the high-ceiling "ask-my-meetings Q&A" (idea 1 in
[research/idea-backlog-ranked.md](../idea-backlog-ranked.md)) - the ranked backlog flagged
hallucinated citations as the trust-killer; an MCP tool that returns exact transcript spans with
meeting IDs makes answers verifiable. It also makes Tandem a *provider* in the ecosystem, not just
a consumer. The Agent SDK supports in-process MCP servers ("custom tools") with no extra process.
([MCP in the SDK](https://code.claude.com/docs/en/agent-sdk/mcp), [MCP spec](https://modelcontextprotocol.io))

**Privacy fit:** excellent - localhost-only server over the user's own confidential data; nothing
is exposed beyond the machine.

**Feasibility:** medium. Read paths over the existing Rust SQLite / meeting files; the risk is
schema/versioning and making sure the server is loopback-only and unauthenticated-safe (same
hardening lessons as the canvas server in [To-do.md](../../To-do.md)).

### P7. Realtime voice-to-voice AI panel (pipeline, not a native API)

**What.** A full-duplex voice mode for the panel: **ElevenLabs Scribe Realtime WS** (STT) ->
Claude Agent SDK (streaming) -> **ElevenLabs TTS** (low-latency), so Andrew can talk to Tandem and
hear it answer, hands-free, between/after calls. Reuses the Scribe realtime work already planned
in [research/scribe-realtime-ws-plan.md](../scribe-realtime-ws-plan.md).

**Why.** It is the most literal expression of the north star ("I talk to it"). But be precise:
**Anthropic has no native voice-to-voice model in 2026** ([Anthropic docs](https://platform.claude.com/docs)),
so this is an orchestration of three streaming components, each with its own latency and failure
mode. ([ElevenLabs docs](https://elevenlabs.io/docs))

**Privacy fit:** mixed - STT and TTS are cloud (ElevenLabs), same as today's STT path; no *new*
local-vs-cloud regression, but voice adds always-listening surface to think about. The ranked
backlog rated "voice control everywhere" (idea 20) near-zero incremental gain because hotkeys/
Ctrl+K already work - so scope this to genuinely hands-free moments, not as a command layer.

**Feasibility:** low-to-medium and high complexity. Barge-in, turn-taking, and latency budgeting
are the hard parts. Recommend gating behind the Scribe realtime WS landing first; treat as a
later, opt-in mode.

### P8. Computer-use for post-call desktop actions (narrow, gated)

**What.** Use Anthropic's **computer-use** tool for post-call actions in apps that have *no* API
or MCP - e.g. logging a call in a legacy desktop CRM - by driving the GUI (screenshots +
mouse/keyboard). ([Computer use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use))

**Why / caveat.** Prefer P1 (n8n) and P4 (browser MCP) wherever an API or web UI exists - they are
cheaper, more reliable, and easier to gate. Computer-use is the fallback for GUI-only targets.
It is beta, higher-risk, and must sit behind the P3 PreToolUse confirmation gate. For a solo
consultant this is a "when a specific GUI-only tool blocks a workflow" item, not a headline.

**Privacy fit:** mixed - screenshots of the desktop are sent to the API; scope tightly to the
target app, never the whole screen during a confidential session.

**Feasibility:** low near-term priority; medium effort. Build only against a concrete GUI-only
target.

### P9. Managed Agents for scheduled / overnight handoff (evaluate, privacy-gated - likely defer)

**What.** Anthropic's Managed Agents (CMA) "deployments" run an agent on a cron in an
Anthropic-hosted sandbox, no terminal open - attractive for "run this `@code` task overnight and
have the result waiting."
([Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview))

**Why it is a proposal at all, and why it probably loses.** It would remove the always-on-terminal
constraint that P2 still implicitly wants for long jobs. **But CMA executes tools in Anthropic's
cloud container**, so the code *and* the transcript context leave the machine - a direct conflict
with Tandem's "entirely on local infrastructure" promise and confidential-client mandate. Honest
recommendation: **do not** route confidential client repos/transcripts through CMA. Consider it
only for explicitly non-confidential, public-repo tasks, or skip. Documenting it here so it is a
decided "no for confidential work," not an open question.

**Privacy fit:** poor for Tandem's core use case (cloud sandbox, data egress). Feasibility:
technically high, ethos-fit low.

---

## Recommended sequencing

1. **P1 (n8n MCP write-path)** + **P3 (privacy/audit hooks)** together - unlocks the parked write
   path with the gating that makes it safe. Highest gain-to-effort, both build on shipped infra.
2. **P2 (headless handoff)** with the Opus-4.8 model bump - kills the fragile F054 file-poll loop.
3. **P6 (Tandem-as-MCP-server)** - the safe route to cross-meeting memory / ask-my-meetings.
4. **P4 (browser MCP)** when a concrete web action needs it; **P5 (subagents)** as the panel grows.
5. **P7 (voice)** after Scribe realtime WS lands; **P8/P9** only against specific, decided cases.

## Sources

- Claude Agent SDK overview - https://code.claude.com/docs/en/agent-sdk/overview
- Claude Agent SDK subagents - https://code.claude.com/docs/en/agent-sdk/subagents
- Claude Agent SDK hooks - https://code.claude.com/docs/en/agent-sdk/hooks
- Claude Agent SDK MCP - https://code.claude.com/docs/en/agent-sdk/mcp
- anthropics/claude-agent-sdk-python - https://github.com/anthropics/claude-agent-sdk-python
- PyPI claude-agent-sdk - https://pypi.org/project/claude-agent-sdk/
- Agent teams/subagents 2026 playbook - https://www.developersdigest.tech/blog/claude-code-agent-teams-subagents-2026
- SDK custom tools/hooks/subagents guide - https://aiworkflowlab.dev/article/how-to-build-production-ai-agents-claude-agent-sdk-custom-tools-hooks-subagents
- Model Context Protocol - https://modelcontextprotocol.io
- n8n MCP Server Trigger - https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.mcptrigger
- Connect to n8n MCP server - https://docs.n8n.io/connect/connect-to-n8n-mcp-server
- Playwright MCP - https://github.com/microsoft/playwright-mcp
- Chrome DevTools MCP - https://github.com/ChromeDevTools/chrome-devtools-mcp
- Anthropic Managed Agents - https://platform.claude.com/docs/en/managed-agents/overview
- Anthropic computer use - https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use
- Anthropic models overview - https://platform.claude.com/docs/en/about-claude/models/overview
- ElevenLabs docs (Scribe realtime STT + TTS) - https://elevenlabs.io/docs
- In-repo: [backend/app/claude_agent.py](../../backend/app/claude_agent.py),
  [CLAUDE.md](../../CLAUDE.md), [To-do.md](../../To-do.md),
  [research/idea-backlog-ranked.md](../idea-backlog-ranked.md),
  [research/proton-mail-calendar-integration/01-ADDENDUM-n8n-docker-outlook.md](../proton-mail-calendar-integration/01-ADDENDUM-n8n-docker-outlook.md)

---

## Skeptic verdicts (adversarial pass, 2026-07-16)

Method: re-read [backend/app/claude_agent.py](../../backend/app/claude_agent.py) directly (confirmed:
no `backend/mcp_servers.json` ships today, matching the researcher's claim; `_VALID_MODELS` in the
file only lists `claude-opus-4-6`/`claude-sonnet-4-6`/`claude-sonnet-4-20250514`/
`claude-haiku-4-5-20251001`), re-checked [To-do.md](../../To-do.md) and
[idea-backlog-ranked.md](../idea-backlog-ranked.md) for redundancy, and ran fresh web searches /
fetches against the primary docs for every non-trivial external claim rather than trusting the
citations as given. Two claims failed verification outright (flagged below); two proposals are
killed on productivity/redundancy grounds even though their technical claims check out, because the
ranking criterion is real time saved for a solo consultant, not novelty.

### Model-claim correction (affects P2, and the "model note" in Grounding)

**FAILED as stated.** The report's claim that "the current Opus tier is `claude-opus-4-8`" is
already stale relative to the report's own dateline (2026-07-16). Anthropic shipped Claude Opus 4.8
in late May 2026 ([Anthropic: Introducing Claude Opus 4.8](https://www.anthropic.com/news/claude-opus-4-8)),
but then GA'd **Claude Fable 5** (Mythos-class flagship, 1M context) on June 9, 2026 and **Claude
Sonnet 5** (built for agentic coding/tool use/lower-cost agent workflows) on June 30, 2026
([Anthropic: Introducing Claude Sonnet 5](https://www.anthropic.com/news/claude-sonnet-5),
model-family summary via [hidekazu-konishi.com timeline](https://hidekazu-konishi.com/entry/anthropic_claude_model_release_timeline.html)).
So "bump `claude-opus-4-6` -> `claude-opus-4-8`" undersells the actual available upgrade by two
generations. **Fix, don't kill**: when P2 touches the options builder, evaluate Sonnet 5 (cheaper,
agent-workflow-tuned) as the AI-panel default and re-derive `_VALID_MODELS` from whatever the
`claude-agent-sdk` package version in `requirements.txt` actually accepts, rather than hand-picking a
name from a research doc that will be stale again in weeks.

### P1. n8n MCP write-path bridge — KEEP, but scope down and re-sequence

The core mechanics verify: n8n's MCP Server Trigger is real, supports SSE/streamable HTTP, and does
run on self-hosted instances (not cloud-only) — confirmed by fetching
[the n8n docs directly](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.mcptrigger).
One detail the report didn't surface: **auth on the MCP Server Trigger is opt-in, not default** — the
docs describe bearer/header auth as "a configuration choice," so an unauthenticated local trigger is
the out-of-the-box state, and Andrew must explicitly turn auth on or the tool is reachable by anything
that can reach the port. Flag this as a required setup step, not a footnote.

More importantly, two fit problems:
1. **Contradicts an already-made decision.** [To-do.md's parked I8 plan](../../To-do.md) explicitly
   scopes the follow-up-email feature as "Andrew's voice, copy-only, **never sends**." P1 proposes an
   agent-callable `send_followup_email` tool, i.e. exactly the auto-send capability that decision
   rejected. P3's gating helps, but a PreToolUse pattern-match is not the same guarantee as "this
   tool literally cannot exist yet." Keep `create_calendar_event`/`move_calendar_event` (these fill a
   real, previously-parked gap with no prior "never do X" decision attached); cut or radically rescope
   `send_followup_email` and `push_summary_to_crm` to require an explicit confirm-click every single
   send, never a remembered/`acceptEdits`-style approval.
2. **Contradicts the project's own ranking discipline.** [idea-backlog-ranked.md](../idea-backlog-ranked.md)
   already rated the n8n export hook (idea 9) marginal tier specifically because "Andrew already runs
   n8n" is not evidence of demand: "build only when a concrete downstream flow exists to consume it,
   not on spec." No concrete workflow is named anywhere in the repo. Calling this proposal "the
   strongest one" overrides that discipline without new evidence. Keep it, but re-rank it behind P3
   and demote it out of "build now" until a specific automation is named.

### P2. Headless Agent SDK code-handoff session — KEEP

Verified: subagents/`agents=`, hooks, and MCP client wiring are all real, documented SDK features
([Subagents](https://code.claude.com/docs/en/agent-sdk/subagents),
[Hooks](https://code.claude.com/docs/en/agent-sdk/hooks)), and the file-poll `@code` handoff it
replaces is real and already flagged as fragile in [CLAUDE.md](../../CLAUDE.md) ("F054 Handoff").
This is a genuine reliability fix reusing infrastructure that already exists in
[claude_agent.py](../../backend/app/claude_agent.py) (same `query()`/options-builder pattern). Apply
the model correction above when building it.

### P3. Privacy-gating + audit hooks (PreToolUse / PostToolUse) — KEEP, strongest proposal

Verified directly against the code: `_build_options()` in
[claude_agent.py](../../backend/app/claude_agent.py#L226-L257) really does set
`permission_mode="acceptEdits"` with no `hooks=` configured — so the gap this closes is real, not
hypothetical. Hooks are a genuine SDK mechanism, confirmed via
[the official hooks doc](https://code.claude.com/docs/en/agent-sdk/hooks) (PreToolUse can set
`permissionDecision`, PostToolUse can log/append context). This is the one proposal that is purely
additive risk-reduction with no redundancy against anything already shipped or parked. Sequence it
ahead of P1/P4/anything with outbound reach, exactly as the report already recommends.

### P4. Local browser MCP — KEEP as scoped (low priority, build-on-demand)

Both `microsoft/playwright-mcp` and `ChromeDevTools/chrome-devtools-mcp` verified as real, maintained
projects. No over-claim found; the report already self-flags this as "build when a concrete flow
needs it," which matches the same "don't build on spec" discipline P1 should also be held to. Keep,
unchanged priority (low, reactive).

### P5. Subagents in the AI panel — KILL

Technically real ([Subagents docs](https://code.claude.com/docs/en/agent-sdk/subagents) confirm
`agents=`, per-subagent model/tools/context), but fails the productivity test on three counts:
1. **No demonstrated need.** Nothing in [idea-backlog-ranked.md](../idea-backlog-ranked.md) or
   [To-do.md](../../To-do.md) asks for parallel/background agent helpers; this is speculative
   infrastructure looking for a use case, the exact "cool because it connects things" trap the
   backlog calls out for a different idea (n8n export, idea 9).
2. **Redundant with shipped work.** The proposed "note-router subagent" would re-implement
   project-routing decisions that [projectRouter.ts](../../frontend/src/services/projectRouter.ts)
   already does (heuristic + Haiku fallback, shipped in I3, refined in I3b). No stated benefit over
   the existing single-pass router.
3. **Fights a stated design principle.** A "researcher" subagent browsing/fetching in the background
   during a live call adds latency, cost, and background network activity precisely when the design
   doc says the panel should be "invisible when active" (principle #1 in
   [CLAUDE.md](../../CLAUDE.md)). The report's own text hedges hard ("higher design cost than payoff
   for a solo user in the near term") — that hedge is correct; the proposal should not survive it.

### P6. Tandem-as-an-MCP-server — KEEP the idea, but the citation and feasibility rating are wrong

**Citation does not verify as used.** Fetched
[the SDK's MCP doc](https://code.claude.com/docs/en/agent-sdk/mcp) directly: the "SDK MCP server" /
in-process "custom tools" mechanism the report cites is explicitly for defining tools *that Tandem's
own agent session can call* ("Build your own MCP server that runs in-process with your SDK
application") — it is a client-side convenience, not a mechanism for an external MCP client (Claude
Desktop, Claude Code, an n8n MCP Client node) to reach into Tandem. Exposing Tandem's meetings *to
other tools*, which is the entire pitch of this proposal ("Tandem-as-a-provider"), needs a genuinely
separate, standalone MCP server process (stdio for Claude Desktop's config, or local HTTP/SSE for
everything else) — a heavier build than "no extra process" implies.
**Feasibility also undercounts the two-database split.** [CLAUDE.md](../../CLAUDE.md) is explicit
that meetings/transcripts live in the **Rust frontend's** sqlx SQLite, while the Claude Agent SDK
backend (where this server would live) only has its own separate aiosqlite database — the proposal's
"read paths over the existing Rust SQLite" glosses over the fact that the Python process has no
native access to that database and would need a new Tauri-command-backed HTTP bridge, or file-level
reads of each meeting's `transcript.json`/`whiteboard.md`, to get there at all.
**Verdict: keep**, because the underlying idea, a structured, citation-linked path to "ask my
meetings" that is safer than free-text RAG, correctly answers the trust problem
[idea-backlog-ranked.md](../idea-backlog-ranked.md) flagged for idea 1 (hallucinated citations kill
trust). But re-rate feasibility from "medium" to "medium-high effort" and fix the mechanism before
scoping a build.

### P7. Realtime voice-to-voice AI panel — KILL

The STT half is real and separately verified: ElevenLabs Scribe v2 Realtime is a genuine ~150ms
WebSocket API ([ElevenLabs: Introducing Scribe v2 Realtime](https://elevenlabs.io/blog/introducing-scribe-v2-realtime)),
but that STT-only work is **already planned as its own item** in
[research/scribe-realtime-ws-plan.md](../scribe-realtime-ws-plan.md) and
[To-do.md's Scribe-path loop](../../To-do.md), scoped purely to transcription latency, not to the AI
panel talking back. P7 bundles that already-planned, already-justified work with a new, unjustified
claim: TTS voice *output* from the AI panel. That half fails on the project's own ranking discipline:
[idea-backlog-ranked.md](../idea-backlog-ranked.md) already adjudicated "voice control everywhere"
(idea 20) to near-zero value, explicitly because hotkeys and Ctrl+K are already faster and more
reliable, calling it "novelty, not gain." A voice-out mode adds new failure surface (barge-in,
turn-taking, ElevenLabs TTS cost on top of the separately-billed $0.28/hr realtime STT) for a need
nobody has asked for, and risks being audible near a client on a back-to-back call day, directly
against "invisible when active." Kill the voice-out (TTS-answer) framing; the STT-only Realtime WS
work should proceed exactly as already planned, under its existing name, not as part of this
proposal.

### P8. Computer-use for post-call desktop actions — KEEP, unchanged (low priority)

Verified real and current: computer-use is a genuine, actively-updated beta tool with newer
`computer_20250124`-class actions ([Claude Platform Docs: computer use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)).
The report already scopes this correctly (fallback only, gated by P3, "build only against a concrete
GUI-only target"). No over-claim found and no redundancy against anything shipped. Keep as the
lowest-priority, build-on-demand item it already is.

### P9. Managed Agents for scheduled/overnight handoff — KEEP the "defer" verdict, fix the citation

**Partially stale claim.** The report states flatly that "CMA executes tools in Anthropic's cloud
container." That was true when written but Anthropic shipped **self-hosted sandboxes** (public beta)
in the same window, letting a Managed Agent's *tool execution* happen on infrastructure you control
([Anthropic: self-hosted sandboxes and MCP tunnels](https://claude.com/blog/claude-managed-agents-updates),
[Claude Platform Docs: self-hosted sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)).
This does not flip the verdict, though: per Anthropic's own description, "the agent loop that handles
orchestration, context management, and error recovery stays on Anthropic's infrastructure" even with
a self-hosted sandbox, and MCP tunnels (the piece that would let a self-hosted sandbox reach Tandem's
local data without a public endpoint) are only in **research preview**, not GA. So the credential-vault
+ unattended-cron trust question the report raises is still real, just for a slightly different reason
than stated (orchestration/session custody, not solely tool execution locale). **Verdict unchanged:
defer for confidential client work**, but correct the "always cloud container" framing to "orchestration
and session state still leave the machine even where tool execution doesn't" before this doc is cited
again.

### Summary

**Kept (7):** P1 (n8n MCP write-path bridge, rescope send-capable tools + re-sequence behind a named
downstream flow), P2 (headless code-handoff, model claim corrected), P3 (privacy/audit hooks,
strongest item, build first), P4 (local browser MCP, unchanged), P6 (Tandem-as-MCP-server, citation
and feasibility corrected), P8 (computer-use, unchanged), P9 (Managed Agents, defer verdict
unchanged, citation corrected).

**Killed (2):** P5 (subagents in the AI panel: no demonstrated need, redundant with shipped I3
routing, fights the "invisible when active" principle). P7 (realtime voice-to-voice: TTS-answer half
re-litigates an idea the project's own backlog already killed for near-zero gain; the STT half is
legitimate but already tracked as separate, existing work).
