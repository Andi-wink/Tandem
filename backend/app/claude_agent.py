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
import sys
from dataclasses import dataclass, field
from threading import Event, Thread
from typing import AsyncIterator, Optional

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
# Session state
# ---------------------------------------------------------------------------

@dataclass
class SessionState:
    """Tracks state for one meeting's AI assistant session."""
    meeting_id: str
    project_dir: str
    session_id: Optional[str] = None
    cancel_event: Event = field(default_factory=Event)


# In-memory store: meeting_id -> SessionState
_sessions: dict[str, SessionState] = {}


def get_session(meeting_id: str) -> Optional[SessionState]:
    return _sessions.get(meeting_id)


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

def _build_options(
    api_key: str,
    project_dir: str,
    session_id: Optional[str] = None,
    system_prompt: Optional[str] = None,
    model: str = "claude-opus-4-6",
) -> ClaudeAgentOptions:
    opts = ClaudeAgentOptions(
        model=model,
        allowed_tools=["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
        permission_mode="acceptEdits",
        cwd=project_dir,
        env={
            "ANTHROPIC_API_KEY": api_key,
            # Unset CLAUDECODE to avoid "nested session" detection when
            # the backend itself runs inside a Claude Code environment.
            "CLAUDECODE": "",
        },
        include_partial_messages=True,
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
    """Thread target: run SDK query() on a ProactorEventLoop (Windows subprocess support)."""
    if sys.platform == "win32":
        loop = asyncio.ProactorEventLoop()
    else:
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
    """
    # Get or create session state
    session = _sessions.get(meeting_id)
    if session is None:
        session = SessionState(meeting_id=meeting_id, project_dir=project_dir)
        _sessions[meeting_id] = session

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
        system_prompt = (
            f"You are an AI assistant embedded in Tandem, a meeting assistant app. "
            f'You are helping with the meeting: "{meeting_title}". '
            f"The project directory is: {project_dir}. "
            f"You have access to file tools (Read, Write, Edit, Glob, Grep) and Bash. "
            f"Be concise and helpful."
        )

    options = _build_options(
        api_key=api_key,
        project_dir=project_dir,
        session_id=session.session_id,
        system_prompt=system_prompt,
        model=model,
    )

    # Reset cancel flag for this run
    session.cancel_event.clear()

    session_init_sent = False
    tool_call_map: dict[str, str] = {}  # tool_use_id -> tool_name

    try:
        async for msg in _query_bridge(prompt, options, session.cancel_event):

            # --- StreamEvent: real-time partial updates -----------------
            if isinstance(msg, StreamEvent):
                # Emit session_init on first sight of session_id
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

                # Text streaming
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

    except asyncio.CancelledError:
        yield _make_event(
            meeting_id,
            event_type="done",
            session_id=session.session_id,
        )
    except Exception as e:
        logger.error("Claude agent error for meeting %s: %s", meeting_id, e, exc_info=True)
        yield _make_event(
            meeting_id,
            event_type="error",
            text=str(e),
        )
    finally:
        session.cancel_event.clear()
