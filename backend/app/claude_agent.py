"""
Claude Agent SDK service for the AI Assistant panel.

Uses the claude-agent-sdk package with user-provided Anthropic API keys.
Sessions are managed in-memory keyed by meeting_id, with session_id
persisted for resume across backend restarts.
"""

import asyncio
import json
import logging
import os
import queue
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from threading import Event, Thread
from typing import Any, AsyncIterator, Optional

from claude_agent_sdk import (
    query,
    ClaudeAgentOptions,
    AssistantMessage,
    UserMessage,
    ResultMessage,
    ToolUseBlock,
    ToolResultBlock,
)
from claude_agent_sdk.types import StreamEvent

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# MCP server configuration (loaded once at import time)
# ---------------------------------------------------------------------------

_ENV_VAR_RE = re.compile(r"\$\{([^}]+)\}")


def _expand_env_vars(value: Any) -> Any:
    """Recursively expand ${VAR} references in strings, dicts, and lists."""
    if isinstance(value, str):
        return _ENV_VAR_RE.sub(lambda m: os.environ.get(m.group(1), ""), value)
    if isinstance(value, dict):
        return {k: _expand_env_vars(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_expand_env_vars(v) for v in value]
    return value


def _load_mcp_servers() -> dict[str, Any]:
    """
    Load MCP server configs from backend/mcp_servers.json (if it exists).

    The file uses the same format as .mcp.json:
        { "mcpServers": { "name": { "command": "...", "args": [...], "env": {...} } } }

    API keys should use ${ENV_VAR} syntax — they get expanded from environment
    variables at load time, so secrets never appear in the config file.
    """
    config_path = Path(__file__).resolve().parent.parent / "mcp_servers.json"
    if not config_path.exists():
        return {}

    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
        servers = raw.get("mcpServers", {})
        expanded = _expand_env_vars(servers)
        names = ", ".join(expanded.keys()) if expanded else "(none)"
        logger.info("Loaded MCP servers from %s: %s", config_path, names)
        return expanded
    except Exception as e:
        logger.warning("Failed to load MCP servers from %s: %s", config_path, e)
        return {}


_MCP_SERVERS: dict[str, Any] = _load_mcp_servers()

# B034: Valid model IDs for validation
_VALID_MODELS = {
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-sonnet-4-20250514",
    "claude-haiku-4-5-20251001",
}

# ---------------------------------------------------------------------------
# Session state
# ---------------------------------------------------------------------------

_SESSION_TTL_SECS = 2 * 60 * 60  # R012: 2 hours (was 24h)
_SESSION_MAX_SIZE = 50  # R012: LRU cap


@dataclass
class SessionState:
    """Tracks state for one meeting's AI assistant session."""
    meeting_id: str
    project_dir: str
    session_id: Optional[str] = None
    cancel_event: Event = field(default_factory=Event)
    last_active: float = field(default_factory=time.monotonic)


# In-memory store: meeting_id -> SessionState
_sessions: dict[str, SessionState] = {}
# B007: Lock to prevent concurrent session creation for same meeting_id
_sessions_lock = asyncio.Lock()


def get_session(meeting_id: str) -> Optional[SessionState]:
    session = _sessions.get(meeting_id)
    if session:
        session.last_active = time.monotonic()
    return session


def clear_session(meeting_id: str) -> None:
    session = _sessions.pop(meeting_id, None)
    if session:
        session.cancel_event.set()


async def cancel_session(meeting_id: str) -> bool:
    session = _sessions.get(meeting_id)
    if session and not session.cancel_event.is_set():
        session.cancel_event.set()
        return True
    return False


def _cleanup_expired_sessions() -> None:
    """R012: Remove sessions inactive for more than _SESSION_TTL_SECS."""
    now = time.monotonic()
    expired = [mid for mid, s in _sessions.items()
               if now - s.last_active > _SESSION_TTL_SECS]
    for mid in expired:
        session = _sessions.pop(mid, None)
        if session:
            session.cancel_event.set()
            logger.info("Expired inactive session for meeting %s", mid)


def _evict_lru_sessions_if_needed() -> None:
    """R012: If sessions exceed max size, evict the least recently used."""
    while len(_sessions) > _SESSION_MAX_SIZE:
        oldest_mid = min(_sessions, key=lambda mid: _sessions[mid].last_active)
        session = _sessions.pop(oldest_mid, None)
        if session:
            session.cancel_event.set()
            logger.info("Evicted LRU session for meeting %s", oldest_mid)


# ---------------------------------------------------------------------------
# CLAUDE.md generation (ported from Rust session.rs)
# ---------------------------------------------------------------------------

def generate_claude_md(meeting_id: str, meeting_title: str, project_dir: str) -> None:
    """Create a CLAUDE.md in the project directory if it doesn't already exist."""
    claude_md_path = os.path.join(project_dir, "CLAUDE.md")
    if os.path.exists(claude_md_path):
        logger.info("CLAUDE.md already exists at %s, skipping", claude_md_path)
        return

    content = f"""# Meeting Context

## Meeting: {meeting_title}
Meeting ID: {meeting_id}

## Available Files
- `transcript.json` — Full meeting transcript with timestamps
- `screenshots/` — Screenshots captured during the meeting
- `clipboard.json` — Clipboard captures during the meeting

## Your Role
You are an AI assistant helping analyze this meeting.
You have access to the transcript, screenshots, and clipboard captures.
When the user shares context from the meeting, use it to provide insights,
answer questions, and help with follow-up actions.

## Guidelines
- Reference specific parts of the transcript when answering questions
- Be concise and actionable in your responses
- Flag any action items, decisions, or commitments mentioned
- When discussing people, use the names as they appear in the transcript
"""
    os.makedirs(os.path.dirname(claude_md_path) or project_dir, exist_ok=True)
    with open(claude_md_path, "w", encoding="utf-8") as f:
        f.write(content)
    logger.info("Generated CLAUDE.md at %s", claude_md_path)


# ---------------------------------------------------------------------------
# Streaming query with Windows ProactorEventLoop bridge
# ---------------------------------------------------------------------------

def _stderr_handler(line: str) -> None:
    """Capture stderr output from the bundled claude.exe CLI for debugging."""
    stripped = line.strip()
    if stripped:
        logger.debug("claude-cli stderr: %s", stripped)


def _build_options(
    api_key: str,
    project_dir: str,
    session_id: Optional[str] = None,
    system_prompt: Optional[str] = None,
    model: str = "claude-opus-4-6",
) -> ClaudeAgentOptions:
    allowed = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite", "AskUserQuestion"]
    # Wildcard-allow all tools from each configured MCP server
    for name in _MCP_SERVERS:
        allowed.append(f"mcp__{name}__*")

    opts = ClaudeAgentOptions(
        model=model,
        allowed_tools=allowed,
        permission_mode="acceptEdits",
        cwd=project_dir,
        env={
            "ANTHROPIC_API_KEY": api_key,
            # Unset CLAUDECODE to avoid "nested session" detection when
            # the backend itself runs inside a Claude Code environment.
            "CLAUDECODE": "",
        },
        stderr=_stderr_handler,
        include_partial_messages=True,
        **({"mcp_servers": _MCP_SERVERS} if _MCP_SERVERS else {}),
    )
    if session_id:
        opts.resume = session_id
    if system_prompt:
        opts.system_prompt = system_prompt
    return opts


def _make_event(meeting_id: str, *, event_type: str, **kwargs) -> dict:
    """Build a flat SSE event dict matching ClaudeFrontendEvent shape."""
    return {
        "event_type": event_type,
        "text": None,
        "tool_name": None,
        "tool_input": None,
        "tool_output": None,
        "session_id": None,
        "cost_usd": None,
        "meeting_id": meeting_id,
        **kwargs,
    }


# Sentinel to signal end of stream from the thread
_STREAM_END = object()


def _run_query_in_proactor(
    prompt: str, options: ClaudeAgentOptions, q: queue.Queue, cancel: Event,
) -> None:
    """Thread target: run SDK query() on a new event loop (Windows gets ProactorEventLoop by default)."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    async def _collect():
        try:
            async for msg in query(prompt=prompt, options=options):
                if cancel.is_set():
                    break
                q.put(msg)
        except Exception as e:
            q.put(e)
        finally:
            q.put(_STREAM_END)

    try:
        loop.run_until_complete(_collect())
    except Exception as e:
        q.put(e)
        q.put(_STREAM_END)
    finally:
        loop.close()


async def _query_bridge(
    prompt: str, options: ClaudeAgentOptions, cancel: Event,
) -> AsyncIterator:
    """
    Async generator that runs SDK query() in a dedicated thread with
    ProactorEventLoop (required on Windows for subprocess support) and
    bridges results back to the caller's event loop via a queue.
    """
    q: queue.Queue = queue.Queue()
    thread = Thread(
        target=_run_query_in_proactor,
        args=(prompt, options, q, cancel),
        daemon=True,
    )
    thread.start()

    loop = asyncio.get_event_loop()
    while True:
        item = await loop.run_in_executor(None, q.get)
        if item is _STREAM_END:
            break
        if isinstance(item, Exception):
            raise item
        if cancel.is_set():
            break
        yield item

    thread.join(timeout=5)
    # B011: Warn if thread didn't stop
    if thread.is_alive():
        logger.warning("Claude query thread for session did not stop within 5s timeout")


def _build_system_prompt(meeting_title: str, project_dir: str) -> str:
    """Build a system prompt for brand-new sessions."""
    platform_note = (
        "The user is on Windows. Use PowerShell-compatible commands in Bash. "
        "Prefer Read, Glob, and Grep tools over Bash for file exploration."
    ) if sys.platform == "win32" else ""

    # Resolve the skills directory relative to this file
    skills_dir = str(Path(__file__).resolve().parent.parent / "skills" / "excalidraw")

    # Use the project's .venv Python so playwright is available for rendering
    venv_dir = Path(__file__).resolve().parent.parent.parent / ".venv"
    if sys.platform == "win32":
        venv_python = str(venv_dir / "Scripts" / "python.exe")
    else:
        venv_python = str(venv_dir / "bin" / "python")

    return (
        f"You are an AI co-pilot embedded in Tandem, a collaborative AI workspace for calls. "
        f'You are working in tandem with the user on: "{meeting_title}". '
        f"The project directory is: {project_dir}. "
        f"You have access to file tools (Read, Write, Edit, Glob, Grep) and Bash. "
        f"{platform_note}"
        f"Be concise and helpful.\n\n"
        f"## Diagram Creation Capability\n"
        f"You have TWO diagram modes. Choose based on the user's request:\n\n"
        f"### Quick Mode (DEFAULT) — Mermaid\n"
        f"Use this for any diagram request UNLESS the user explicitly asks for Excalidraw or says 'detailed'.\n"
        f"Output a Mermaid code block in your response text — the frontend renders it instantly in-browser.\n"
        f"Example:\n"
        f"```mermaid\n"
        f"flowchart TD\n"
        f"    A[Start] --> B[Process]\n"
        f"    B --> C[End]\n"
        f"```\n"
        f"Supported Mermaid types: flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, gantt, pie, mindmap, timeline.\n"
        f"NEVER install or use @mermaid-js/mermaid-cli or any CLI tool. Just write the code block.\n\n"
        f"### Detailed Mode — Excalidraw\n"
        f"Use ONLY when the user explicitly mentions 'excalidraw' (or misspellings like 'excolidraw', 'excali draw') "
        f"OR when they specifically ask for a 'detailed' diagram.\n"
        f"When using Excalidraw:\n"
        f"1. Read the skill prompt at {skills_dir}/SKILL_PROMPT.md for the full design methodology.\n"
        f"2. Read the color palette at {skills_dir}/references/color-palette.md.\n"
        f"3. Read element templates at {skills_dir}/references/element-templates.md.\n"
        f"4. Generate Excalidraw JSON section-by-section using the Write tool.\n"
        f'5. Render with: "{venv_python}" "{skills_dir}/render_excalidraw.py" <path-to-file.excalidraw>\n'
        f"6. Read the resulting PNG to visually validate. Fix issues and re-render (2-4 iterations).\n"
    )


async def _run_query_stream(
    meeting_id: str,
    session: SessionState,
    prompt: str,
    options: ClaudeAgentOptions,
) -> AsyncIterator[dict]:
    """
    Core streaming loop: runs the SDK query and yields SSE event dicts.
    Extracted to allow retry logic in stream_session.
    """
    session_init_sent = False
    tool_call_map: dict[str, str] = {}

    async for msg in _query_bridge(prompt, options, session.cancel_event):

        # --- StreamEvent: real-time partial updates -----------------
        if isinstance(msg, StreamEvent):
            if msg.session_id and not session_init_sent:
                session.session_id = msg.session_id
                session_init_sent = True
                yield _make_event(
                    meeting_id,
                    event_type="session_init",
                    session_id=msg.session_id,
                )

            event_data = msg.event or {}
            etype = event_data.get("type", "")

            if etype == "content_block_delta":
                delta = event_data.get("delta", {})
                if delta.get("type") == "text_delta":
                    text = delta.get("text", "")
                    if text:
                        yield _make_event(
                            meeting_id,
                            event_type="text_delta",
                            text=text,
                        )

        # --- AssistantMessage: complete message with content blocks -
        elif isinstance(msg, AssistantMessage):
            for block in msg.content:
                if isinstance(block, ToolUseBlock):
                    tool_call_map[block.id] = block.name
                    yield _make_event(
                        meeting_id,
                        event_type="tool_call",
                        tool_name=block.name,
                        tool_input=(
                            json.dumps(block.input)
                            if isinstance(block.input, dict)
                            else str(block.input)
                        ),
                    )

        # --- UserMessage: contains ToolResultBlock from SDK --------
        elif isinstance(msg, UserMessage):
            content = msg.content
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, ToolResultBlock):
                        name = tool_call_map.get(block.tool_use_id, "unknown")
                        output = block.content
                        if isinstance(output, list):
                            output = json.dumps(output)
                        yield _make_event(
                            meeting_id,
                            event_type="tool_result",
                            tool_name=name,
                            tool_output=str(output) if output else "",
                        )

        # --- ResultMessage: final result with session_id & cost ----
        elif isinstance(msg, ResultMessage):
            session.session_id = msg.session_id
            yield _make_event(
                meeting_id,
                event_type="done",
                session_id=msg.session_id,
                cost_usd=msg.total_cost_usd,
            )


async def stream_session(
    meeting_id: str,
    project_dir: str,
    message: str,
    api_key: str,
    context_block: Optional[str] = None,
    meeting_title: Optional[str] = None,
    model: str = "claude-opus-4-6",
) -> AsyncIterator[dict]:
    """
    Stream an AI assistant session, yielding SSE-compatible event dicts.
    Handles both new sessions and session resume automatically.
    If resume fails, automatically falls back to a fresh session.
    """
    # B034: Validate model parameter
    if model not in _VALID_MODELS:
        yield _make_event(
            meeting_id,
            event_type="error",
            text=f"Invalid model: {model}. Valid models: {', '.join(sorted(_VALID_MODELS))}",
        )
        return

    # R012: Clean up expired and LRU sessions on each request
    _cleanup_expired_sessions()
    _evict_lru_sessions_if_needed()

    # B007: Lock to prevent concurrent session creation for same meeting_id
    async with _sessions_lock:
        session = _sessions.get(meeting_id)
        if session is None:
            session = SessionState(meeting_id=meeting_id, project_dir=project_dir)
            _sessions[meeting_id] = session
        session.last_active = time.monotonic()

    # Generate CLAUDE.md for new sessions
    if not session.session_id and meeting_title:
        try:
            generate_claude_md(meeting_id, meeting_title, project_dir)
        except Exception as e:
            logger.warning("Failed to generate CLAUDE.md: %s", e)

    # Build prompt with optional context block
    prompt = message
    if context_block:
        prompt = f"{context_block}\n\n---\n\n{message}"

    # System prompt for brand-new sessions
    system_prompt = None
    if not session.session_id and meeting_title:
        system_prompt = _build_system_prompt(meeting_title, project_dir)

    was_resuming = bool(session.session_id)

    options = _build_options(
        api_key=api_key,
        project_dir=project_dir,
        session_id=session.session_id,
        system_prompt=system_prompt,
        model=model,
    )

    # Reset cancel flag for this run
    session.cancel_event.clear()

    try:
        async for event in _run_query_stream(meeting_id, session, prompt, options):
            yield event

    except asyncio.CancelledError:
        yield _make_event(
            meeting_id,
            event_type="done",
            session_id=session.session_id,
        )
    except Exception as e:
        error_str = str(e)
        if api_key and len(api_key) > 8:
            error_str = error_str.replace(api_key, "sk-ant-***")

        # If resume failed, fall back to a fresh session automatically
        if was_resuming and "exit code" in error_str:
            logger.warning(
                "Resume failed for meeting %s (%s), retrying as new session",
                meeting_id, error_str,
            )
            session.session_id = None
            session.cancel_event.clear()

            # Rebuild options without resume, with system prompt
            system_prompt = _build_system_prompt(
                meeting_title or "Meeting", project_dir,
            )
            retry_options = _build_options(
                api_key=api_key,
                project_dir=project_dir,
                session_id=None,
                system_prompt=system_prompt,
                model=model,
            )

            try:
                async for event in _run_query_stream(
                    meeting_id, session, prompt, retry_options,
                ):
                    yield event
            except Exception as retry_err:
                retry_str = str(retry_err)
                if api_key and len(api_key) > 8:
                    retry_str = retry_str.replace(api_key, "sk-ant-***")
                logger.error(
                    "Claude agent retry also failed for meeting %s: %s",
                    meeting_id, retry_str,
                )
                yield _make_event(
                    meeting_id,
                    event_type="error",
                    text=retry_str,
                )
        else:
            logger.error(
                "Claude agent error for meeting %s: %s", meeting_id, error_str,
            )
            yield _make_event(
                meeting_id,
                event_type="error",
                text=error_str,
            )
    finally:
        session.cancel_event.clear()
