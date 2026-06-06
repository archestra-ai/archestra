"""Unit tests for WindmillClient."""
from __future__ import annotations

import json
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import httpx

# Set required env vars before importing the module
os.environ.setdefault("WINDMILL_BASE_URL", "https://windmill.example.com")
os.environ.setdefault("WINDMILL_TOKEN", "test-token")
os.environ.setdefault("WINDMILL_WORKSPACE", "test-ws")

from windmill_mcp.client import WindmillClient, WindmillError  # noqa: E402


@pytest.fixture
def client():
    with patch.dict(
        os.environ,
        {
            "WINDMILL_BASE_URL": "https://windmill.example.com",
            "WINDMILL_TOKEN": "tok_abc123",
            "WINDMILL_WORKSPACE": "acme",
        },
    ):
        c = WindmillClient()
    return c


# ---------------------------------------------------------------------------
# flow_editor_url
# ---------------------------------------------------------------------------


def test_flow_editor_url(client):
    url = client.flow_editor_url("u/admin/my_flow")
    assert url == "https://windmill.example.com/flows/edit/u/admin/my_flow?workspace=acme"


def test_flow_editor_url_nested_path(client):
    url = client.flow_editor_url("f/team/confluece_to_email")
    assert "f/team/confluece_to_email" in url
    assert "workspace=acme" in url


# ---------------------------------------------------------------------------
# _raise_for_status
# ---------------------------------------------------------------------------


def _mock_response(status_code: int, body: dict | str) -> httpx.Response:
    if isinstance(body, dict):
        content = json.dumps(body).encode()
        headers = {"content-type": "application/json"}
    else:
        content = body.encode()
        headers = {"content-type": "text/plain"}
    return httpx.Response(status_code, content=content, headers=headers)


def test_raise_for_status_ok(client):
    resp = _mock_response(200, {"ok": True})
    client._raise_for_status(resp)  # Should not raise


def test_raise_for_status_404(client):
    resp = _mock_response(404, {"detail": "Flow not found"})
    with pytest.raises(WindmillError) as exc_info:
        client._raise_for_status(resp)
    assert "404" in str(exc_info.value)
    assert "Flow not found" in str(exc_info.value)


def test_raise_for_status_500_text(client):
    resp = _mock_response(500, "Internal server error")
    with pytest.raises(WindmillError) as exc_info:
        client._raise_for_status(resp)
    assert exc_info.value.status_code == 500


# ---------------------------------------------------------------------------
# list_flows
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_flows_returns_list(client):
    mock_flows = [
        {"path": "u/admin/flow1", "summary": "Flow 1"},
        {"path": "f/team/flow2", "summary": "Flow 2"},
    ]
    with patch.object(client, "_get", new=AsyncMock(return_value=mock_flows)):
        result = await client.list_flows()
    assert result == mock_flows
    assert len(result) == 2


@pytest.mark.asyncio
async def test_list_flows_passes_pagination(client):
    with patch.object(client, "_get", new=AsyncMock(return_value=[])) as mock_get:
        await client.list_flows(page=2, per_page=10)
    mock_get.assert_called_once_with(
        "/api/w/acme/flows/list", page=2, per_page=10
    )


# ---------------------------------------------------------------------------
# run_flow
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_flow_returns_job_id(client):
    job_id = "550e8400-e29b-41d4-a716-446655440000"
    with patch.object(client, "_post", new=AsyncMock(return_value=job_id)):
        result = await client.run_flow("u/admin/my_flow", {"key": "value"})
    assert result == job_id


@pytest.mark.asyncio
async def test_run_flow_empty_args(client):
    with patch.object(client, "_post", new=AsyncMock(return_value="job-123")) as mock_post:
        await client.run_flow("u/admin/my_flow")
    # Should pass empty dict when args is None
    mock_post.assert_called_once_with(
        "/api/w/acme/jobs/run/f/u/admin/my_flow", json={}
    )


# ---------------------------------------------------------------------------
# get_job
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_job_returns_data(client):
    job_data = {"id": "job-123", "type": "CompletedJob", "success": True}
    with patch.object(client, "_get", new=AsyncMock(return_value=job_data)):
        result = await client.get_job("job-123")
    assert result["type"] == "CompletedJob"


# ---------------------------------------------------------------------------
# WindmillError
# ---------------------------------------------------------------------------


def test_windmill_error_message():
    err = WindmillError(422, "Validation failed")
    assert "422" in str(err)
    assert "Validation failed" in str(err)
    assert err.status_code == 422
