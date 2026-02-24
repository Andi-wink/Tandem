"""Tests for DatabaseManager using temporary SQLite files."""

import pytest

from db import DatabaseManager


@pytest.fixture
def db(tmp_path):
    """Create a DatabaseManager with a temporary database file."""
    db_path = str(tmp_path / "test.db")
    return DatabaseManager(db_path=db_path)


class TestDatabaseManager:
    def test_init_creates_tables(self, db):
        """Database initialization should create required tables."""
        import sqlite3
        conn = sqlite3.connect(db.db_path)
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = {row[0] for row in cursor.fetchall()}
        conn.close()

        assert 'meetings' in tables

    @pytest.mark.asyncio
    async def test_get_all_meetings_empty(self, db):
        """Should return empty list when no meetings exist."""
        meetings = await db.get_all_meetings()
        assert meetings == []

    @pytest.mark.asyncio
    async def test_save_and_retrieve_meeting(self, db):
        """Should save a meeting and retrieve it."""
        await db.save_meeting("test-123", "Test Meeting")
        await db.save_meeting_transcript(
            meeting_id="test-123",
            transcript="Hello world",
            timestamp="2026-01-01T00:00:00Z",
        )

        meetings = await db.get_all_meetings()
        assert len(meetings) >= 1
        titles = [m["title"] for m in meetings]
        assert "Test Meeting" in titles

    @pytest.mark.asyncio
    async def test_get_meeting_returns_none_for_missing(self, db):
        """Should return None for non-existent meeting ID."""
        meeting = await db.get_meeting("nonexistent-id")
        assert meeting is None

    @pytest.mark.asyncio
    async def test_get_meeting_with_transcripts(self, db):
        """Should return meeting details with transcripts."""
        await db.save_meeting("meeting-1", "My Meeting")
        await db.save_meeting_transcript(
            meeting_id="meeting-1",
            transcript="First segment",
            timestamp="2026-01-01T00:00:00Z",
        )
        await db.save_meeting_transcript(
            meeting_id="meeting-1",
            transcript="Second segment",
            timestamp="2026-01-01T00:01:00Z",
        )

        meeting = await db.get_meeting("meeting-1")
        assert meeting is not None
        assert meeting["title"] == "My Meeting"
        assert len(meeting["transcripts"]) == 2

    @pytest.mark.asyncio
    async def test_update_meeting_title(self, db):
        """Should update a meeting's title."""
        await db.save_meeting("meeting-2", "Original Title")

        await db.update_meeting_title("meeting-2", "Updated Title")

        meeting = await db.get_meeting("meeting-2")
        assert meeting["title"] == "Updated Title"

    @pytest.mark.asyncio
    async def test_delete_meeting(self, db):
        """Should delete a meeting and its data."""
        await db.save_meeting("meeting-3", "To Delete")
        await db.save_meeting_transcript(
            meeting_id="meeting-3",
            transcript="delete me",
            timestamp="2026-01-01T00:00:00Z",
        )

        result = await db.delete_meeting("meeting-3")
        assert result is True

        meeting = await db.get_meeting("meeting-3")
        assert meeting is None
