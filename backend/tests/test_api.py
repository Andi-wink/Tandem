"""Tests for FastAPI endpoints using httpx AsyncClient."""

import pytest
import tempfile
from httpx import AsyncClient, ASGITransport
from unittest.mock import patch

# Use a temp file for the DB so tables persist across sync/async connections
_test_db = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
_test_db.close()

with patch('transcript_processor.TranscriptProcessor'):
    with patch.dict('os.environ', {'DATABASE_PATH': _test_db.name}):
        from main import app


@pytest.fixture
def anyio_backend():
    return 'asyncio'


@pytest.mark.asyncio
async def test_get_meetings_returns_list():
    """GET /get-meetings should return a list."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/get-meetings")
    assert response.status_code == 200
    assert isinstance(response.json(), list)


@pytest.mark.asyncio
async def test_get_meeting_not_found():
    """GET /get-meeting/<bad-id> should return 404."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/get-meeting/nonexistent-id-12345")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_delete_meeting_nonexistent():
    """POST /delete-meeting with bad ID should return 500."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/delete-meeting",
            json={"meeting_id": "nonexistent-id-12345"}
        )
    assert response.status_code == 500


@pytest.mark.asyncio
async def test_save_and_get_meeting():
    """POST /save-transcript then GET /get-meetings should include the meeting."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        save_response = await client.post(
            "/save-transcript",
            json={
                "meeting_title": "API Test Meeting",
                "transcripts": [
                    {
                        "id": "t1",
                        "text": "Hello from API test",
                        "timestamp": "2026-01-01T00:00:00Z"
                    }
                ]
            }
        )
        assert save_response.status_code == 200
        meeting_id = save_response.json().get("meeting_id")
        assert meeting_id is not None

        list_response = await client.get("/get-meetings")
        assert list_response.status_code == 200
        titles = [m["title"] for m in list_response.json()]
        assert "API Test Meeting" in titles


@pytest.mark.asyncio
async def test_save_meeting_title():
    """POST /save-meeting-title should update the title."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        save_response = await client.post(
            "/save-transcript",
            json={
                "meeting_title": "Before Rename",
                "transcripts": [
                    {
                        "id": "t1",
                        "text": "test",
                        "timestamp": "2026-01-01T00:00:00Z"
                    }
                ]
            }
        )
        meeting_id = save_response.json()["meeting_id"]

        rename_response = await client.post(
            "/save-meeting-title",
            json={"meeting_id": meeting_id, "title": "After Rename"}
        )
        assert rename_response.status_code == 200

        detail_response = await client.get(f"/get-meeting/{meeting_id}")
        assert detail_response.status_code == 200
        assert detail_response.json()["title"] == "After Rename"
