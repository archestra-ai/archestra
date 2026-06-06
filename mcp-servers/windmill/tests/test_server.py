"""Unit tests for the MCP server tool handlers.

Tests invoke the server via the MCP request_handlers dict (the same path
used by the stdio transport) rather than calling internal methods directly.
"""
from __future__ import annotations

import json
import os
from unittest.mock import AsyncMock, patch

import pytest
import mcp.types as types

os.environ.setdefault("WINDMILL_BASE_URL", "https://windmill.example.com")
os.environ.setdefault("WINDMILL_TOKEN", "test-token")
os.environ.setdefault("WINDMILL_WORKSPACE", "test-ws")

from windmill_mcp.client import WindmillClient, WindmillError  # noqa: E402
from windmill_mcp.server import create_server  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_call_request(name: str, arguments: dict) -> types.CallToolRequest:
    return types.CallToolRequest(
        method="tools/call",
        params=types.CallToolRequestParams(name=name, arguments=arguments),
    )


async def call_tool(server, name: str, arguments: dict):
    """Dispatch a CallToolRequest through the registered handler."""
    handler = server.request_handlers[types.CallToolRequest]
    result = await handler(make_call_request(name, arguments))
    # result.root is a CallToolResult
    return result.root


async def list_tools(server):
    handler = server.request_handlers[types.ListToolsRequest]
    result = await handler(
        types.ListToolsRequest(method="tools/list", params=None)
    )
    return result.root.tools


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def server():
    return create_server()


# ---------------------------------------------------------------------------
# list_tools
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_tools_returns_all(server):
    tools = await list_tools(server)
    names = {t.name for t in tools}
    assert "windmill_list_flows" in names
    assert "windmill_run_flow" in names
    assert "windmill_get_flow" in names
    assert "windmill_run_flow_and_wait" in names
    assert "windmill_get_job" in names
    assert "windmill_list_jobs" in names
    assert "windmill_list_scripts" in names
    assert len(names) == 7


# ---------------------------------------------------------------------------
# windmill_list_flows
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_call_list_flows(server):
    mock_flows = [{"path": "u/admin/flow1", "summary": "Test flow"}]
    with patch("windmill_mcp.server.WindmillClient") as MockClient:
        instance = MockClient.return_value
        instance.list_flows = AsyncMock(return_value=mock_flows)
        instance.flow_editor_url = lambda path: (
            f"https://windmill.example.com/flows/edit/{path}?workspace=test-ws"
        )
        instance.workspace = "test-ws"

        result = await call_tool(server, "windmill_list_flows", {})

    assert not result.isError
    text = result.content[0].text
    assert "1 flows" in text
    assert "flow1" in text


# ---------------------------------------------------------------------------
# windmill_run_flow
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_call_run_flow(server):
    with patch("windmill_mcp.server.WindmillClient") as MockClient:
        instance = MockClient.return_value
        instance.run_flow = AsyncMock(return_value="job-uuid-1234")
        instance.workspace = "test-ws"

        result = await call_tool(
            server,
            "windmill_run_flow",
            {"path": "u/admin/my_flow", "args": {"x": 1}},
        )

    assert not result.isError
    text = result.content[0].text
    assert "job-uuid-1234" in text
    assert "u/admin/my_flow" in text


@pytest.mark.asyncio
async def test_call_run_flow_missing_path_returns_error(server):
    with patch("windmill_mcp.server.WindmillClient"):
        result = await call_tool(server, "windmill_run_flow", {})

    assert result.isError
    assert "path" in result.content[0].text.lower()


# ---------------------------------------------------------------------------
# windmill_get_flow — must return embedded resource URI (MCP Apps)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_call_get_flow_includes_resource_uri(server):
    flow_data = {
        "path": "u/admin/my_flow",
        "summary": "My awesome flow",
        "value": {"modules": []},
    }
    with patch("windmill_mcp.server.WindmillClient") as MockClient:
        instance = MockClient.return_value
        instance.get_flow = AsyncMock(return_value=flow_data)
        instance.flow_editor_url = lambda path: (
            f"https://windmill.example.com/flows/edit/{path}?workspace=test-ws"
        )
        instance.workspace = "test-ws"

        result = await call_tool(
            server, "windmill_get_flow", {"path": "u/admin/my_flow"}
        )

    assert not result.isError
    # Should contain both text and an embedded resource
    content_types = {c.type for c in result.content}
    assert "text" in content_types
    assert "resource" in content_types

    resource_content = next(c for c in result.content if c.type == "resource")
    assert "flows/edit/u/admin/my_flow" in str(resource_content.resource.uri)


# ---------------------------------------------------------------------------
# windmill_get_job
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_call_get_job(server):
    job = {"id": "job-999", "type": "CompletedJob", "success": True}
    with patch("windmill_mcp.server.WindmillClient") as MockClient:
        instance = MockClient.return_value
        instance.get_job = AsyncMock(return_value=job)
        instance.workspace = "test-ws"

        result = await call_tool(server, "windmill_get_job", {"job_id": "job-999"})

    assert not result.isError
    assert "CompletedJob" in result.content[0].text


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_windmill_api_error_returns_isError(server):
    with patch("windmill_mcp.server.WindmillClient") as MockClient:
        instance = MockClient.return_value
        instance.list_flows = AsyncMock(
            side_effect=WindmillError(403, "Forbidden: insufficient permissions")
        )
        instance.workspace = "test-ws"

        result = await call_tool(server, "windmill_list_flows", {})

    assert result.isError
    assert "403" in result.content[0].text
    assert "Forbidden" in result.content[0].text


@pytest.mark.asyncio
async def test_unknown_tool_returns_error(server):
    with patch("windmill_mcp.server.WindmillClient"):
        result = await call_tool(server, "non_existent_tool", {})

    assert result.isError
    assert "Unknown tool" in result.content[0].text
