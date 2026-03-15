"""
F048: Task extraction from meeting transcripts using Anthropic API.

Extracts structured tasks with autonomy classification (auto/review)
from transcript text, screenshots, and clipboard context.
"""

import json
import logging
import uuid
from typing import Optional

import anthropic

logger = logging.getLogger(__name__)

TASK_EXTRACTION_PROMPT = """You are an expert at extracting actionable tasks from meeting transcripts.

Analyze the transcript and any additional context (screenshots, clipboard items) to identify concrete tasks that were discussed, agreed upon, or implied.

For each task, classify it as:
- **autonomy: "auto"** — Research, lookups, fact-finding, comparisons, analysis. These can be executed by an AI assistant without human review.
- **autonomy: "review"** — Creating content (emails, documents, code), making decisions, contacting people. These need human review before execution.

Categories:
- **research** — Look something up, compare options, gather data
- **email** — Draft or send an email
- **code** — Write, modify, or review code
- **document** — Create or update a document, proposal, report
- **followup** — Schedule a meeting, set a reminder, follow up with someone

Respond with a JSON array of tasks. Each task has:
- "description": Clear, actionable description of what needs to be done
- "autonomy": "auto" or "review"
- "category": one of "research", "email", "code", "document", "followup"
- "context": The relevant quote or paraphrase from the transcript that triggered this task (1-2 sentences max)
- "priority": "high", "medium", or "low"

If no tasks are found, return an empty array.

IMPORTANT: Only extract tasks that were explicitly discussed or clearly implied. Do not invent tasks. Be conservative — fewer accurate tasks are better than many speculative ones.

Respond with ONLY the JSON array, no other text."""


async def extract_tasks(
    transcript: str,
    api_key: str,
    screenshots: Optional[list[str]] = None,
    clipboard: Optional[list[str]] = None,
    model: str = "claude-sonnet-4-20250514",
) -> list[dict]:
    """Extract structured tasks from a meeting transcript.

    Args:
        transcript: The meeting transcript text.
        api_key: Anthropic API key.
        screenshots: Optional list of screenshot descriptions/paths.
        clipboard: Optional list of clipboard text items.
        model: Anthropic model to use (default: claude-sonnet-4-20250514).

    Returns:
        List of task dicts with id, description, autonomy, category, context, priority.
    """
    if not transcript.strip():
        logger.info("Empty transcript, no tasks to extract")
        return []

    # Build the user message with all available context
    parts = [f"## Meeting Transcript\n\n{transcript}"]

    if screenshots:
        parts.append("\n## Screenshots Captured\n")
        for i, s in enumerate(screenshots, 1):
            parts.append(f"{i}. {s}")

    if clipboard:
        parts.append("\n## Clipboard Items\n")
        for i, c in enumerate(clipboard, 1):
            parts.append(f"{i}. {c}")

    user_message = "\n".join(parts)

    try:
        client = anthropic.Anthropic(api_key=api_key)
        response = client.messages.create(
            model=model,
            max_tokens=2048,
            system=TASK_EXTRACTION_PROMPT,
            messages=[{"role": "user", "content": user_message}],
        )

        # Parse the JSON response
        response_text = response.content[0].text.strip()

        # Handle potential markdown code block wrapping
        if response_text.startswith("```"):
            lines = response_text.split("\n")
            # Remove first and last lines (```json and ```)
            response_text = "\n".join(lines[1:-1])

        tasks = json.loads(response_text)

        if not isinstance(tasks, list):
            logger.warning("Task extraction returned non-list: %s", type(tasks))
            return []

        # Add UUIDs to each task
        for task in tasks:
            task["id"] = str(uuid.uuid4())

        logger.info("Extracted %d tasks from transcript (%d chars)", len(tasks), len(transcript))
        return tasks

    except json.JSONDecodeError as e:
        logger.error("Failed to parse task extraction response as JSON: %s", e)
        return []
    except anthropic.APIError as e:
        logger.error("Anthropic API error during task extraction: %s", e)
        raise
    except Exception as e:
        logger.error("Unexpected error during task extraction: %s", e)
        raise
