"""Windmill MCP server entry point.

Exposes Windmill workflow automation as MCP tools, enabling AI agents in
Archestra to list, create, and run Windmill flows.  When a flow is shown
the server returns the Windmill visual-editor URL as a ``_meta.ui``
resource URI so Archestra can render it as an interactive MCP App.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import (
    CallToolResult,
    EmbeddedResource,
    TextContent,
    TextResourceContents,
    Tool,
)

from .client import WindmillClient, WindmillError

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Tool schemas
# ---------------------------------------------------------------------------

TOOLS: list[Tool] = [
    Tool(
        name="windmill_list_flows",
        description=(
            "List all flows (workflows) in the configured Windmill workspace. "
            "Returns flow paths, summaries, and editor URLs."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "page": {
                    "type": "integer",
                    "description": "Page number (1-based). Default: 1.",
                    "default": 1,
                },
                "per_page": {
                    "type": "integer",
                    "description": "Results per page (max 100). Default: 50.",
                    "default": 50,
                },
            },
        },
    ),
    Tool(
        name="windmill_get_flow",
        description=(
            "Get the full definition of a Windmill flow, including its node graph. "
            "Also returns an interactive editor URL for rendering in Archestra MCP Apps."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": (
                        "Flow path within the workspace "
                        "(e.g. 'u/admin/my_flow' or 'f/team/email_confluence')."
                    ),
                }
            },
            "required": ["path"],
        },
    ),
    Tool(
        name="windmill_run_flow",
        description=(
            "Trigger a Windmill flow with optional input arguments. "
            "Returns the job ID which can be polled with windmill_get_job."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Flow path within the workspace.",
                },
                "args": {
                    "type": "object",
                    "description": "Input arguments for the flow (key-value pairs).",
                    "default": {},
                },
            },
            "required": ["path"],
        },
    ),
    Tool(
        name="windmill_run_flow_and_wait",
        description=(
            "Trigger a Windmill flow and wait for it to complete, returning the result. "
            "Use for short-running flows (under 60 s). "
            "For long flows use windmill_run_flow + windmill_get_job."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Flow path within the workspace.",
                },
                "args": {
                    "type": "object",
                    "description": "Input arguments for the flow.",
                    "default": {},
                },
            },
            "required": ["path"],
        },
    ),
    Tool(
        name="windmill_get_job",
        description="Get the current status and result of a Windmill job by its ID.",
        inputSchema={
            "type": "object",
            "properties": {
                "job_id": {
                    "type": "string",
                    "description": "UUID of the job returned by windmill_run_flow.",
                }
            },
            "required": ["job_id"],
        },
    ),
    Tool(
        name="windmill_list_jobs",
        description="List recently completed Windmill jobs.",
        inputSchema={
            "type": "object",
            "properties": {
                "page": {"type": "integer", "default": 1},
                "per_page": {"type": "integer", "default": 20},
            },
        },
    ),
    Tool(
        name="windmill_list_scripts",
        description="List all scripts in the Windmill workspace.",
        inputSchema={
            "type": "object",
            "properties": {
                "page": {"type": "integer", "default": 1},
                "per_page": {"type": "integer", "default": 50},
            },
        },
    ),
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _text(content: str) -> list[TextContent]:
    return [TextContent(type="text", text=content)]


def _error(msg: str) -> CallToolResult:
    return CallToolResult(isError=True, content=_text(msg))


def _ok(data: Any, extra_text: str | None = None) -> CallToolResult:
    text = json.dumps(data, indent=2, default=str)
    if extra_text:
        text = extra_text + "\n\n" + text
    return CallToolResult(content=_text(text))


def _flow_with_editor(client: WindmillClient, path: str, flow_data: dict) -> CallToolResult:
    """Return flow data with an embedded MCP App resource URI for the visual editor."""
    editor_url = client.flow_editor_url(path)
    summary = flow_data.get("summary") or path

    # Embed the editor URL as a resource so Archestra can render the flow
    # editor as an interactive MCP App (iframe with node-editing capability).
    resource = EmbeddedResource(
        type="resource",
        resource=TextResourceContents(
            uri=editor_url,  # type: ignore[arg-type]
            mimeType="text/html",
            text=(
                f"Interactive Windmill flow editor for '{path}'. "
                "Open this URL to inspect and edit workflow nodes visually."
            ),
        ),
    )

    text_summary = (
        f"Flow: {summary}\n"
        f"Path: {path}\n"
        f"Editor URL: {editor_url}\n\n"
        + json.dumps(flow_data, indent=2, default=str)
    )

    return CallToolResult(
        content=[
            TextContent(type="text", text=text_summary),
            resource,
        ]
    )


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------


def create_server() -> Server:
    server = Server("windmill-mcp")
    client: WindmillClient | None = None

    def get_client() -> WindmillClient:
        nonlocal client
        if client is None:
            client = WindmillClient()
        return client

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        return TOOLS

    @server.call_tool()
    async def call_tool(name: str, arguments: dict) -> CallToolResult:
        wc = get_client()
        try:
            if name == "windmill_list_flows":
                flows = await wc.list_flows(
                    page=arguments.get("page", 1),
                    per_page=arguments.get("per_page", 50),
                )
                # Augment each entry with its editor URL
                for f in flows:
                    if "path" in f:
                        f["editor_url"] = wc.flow_editor_url(f["path"])
                return _ok(flows, f"Found {len(flows)} flows in workspace '{wc.workspace}'.")

            elif name == "windmill_get_flow":
                path = arguments["path"]
                flow = await wc.get_flow(path)
                return _flow_with_editor(wc, path, flow)

            elif name == "windmill_run_flow":
                path = arguments["path"]
                args = arguments.get("args") or {}
                job_id = await wc.run_flow(path, args)
                return _ok(
                    {"job_id": job_id, "path": path},
                    f"Flow '{path}' triggered. Job ID: {job_id}\n"
                    "Poll status with windmill_get_job.",
                )

            elif name == "windmill_run_flow_and_wait":
                path = arguments["path"]
                args = arguments.get("args") or {}
                result = await wc.run_flow_and_wait(path, args)
                return _ok(result, f"Flow '{path}' completed.")

            elif name == "windmill_get_job":
                job_id = arguments["job_id"]
                job = await wc.get_job(job_id)
                status = job.get("type", "unknown")
                return _ok(job, f"Job {job_id} — status: {status}")

            elif name == "windmill_list_jobs":
                jobs = await wc.list_jobs(
                    page=arguments.get("page", 1),
                    per_page=arguments.get("per_page", 20),
                )
                return _ok(jobs, f"Found {len(jobs)} recent jobs.")

            elif name == "windmill_list_scripts":
                scripts = await wc.list_scripts(
                    page=arguments.get("page", 1),
                    per_page=arguments.get("per_page", 50),
                )
                return _ok(scripts, f"Found {len(scripts)} scripts in workspace '{wc.workspace}'.")

            else:
                return _error(f"Unknown tool: {name}")

        except WindmillError as exc:
            return _error(str(exc))
        except KeyError as exc:
            return _error(f"Missing required argument: {exc}")
        except Exception as exc:
            logger.exception("Unexpected error in tool '%s'", name)
            return _error(f"Unexpected error: {exc}")

    return server


def main() -> None:
    """Entry point — run the MCP server over stdio."""
    logging.basicConfig(level=logging.INFO)

    for var in ("WINDMILL_BASE_URL", "WINDMILL_TOKEN", "WINDMILL_WORKSPACE"):
        if not os.environ.get(var):
            raise SystemExit(
                f"Missing required environment variable: {var}\n"
                "Set WINDMILL_BASE_URL, WINDMILL_TOKEN, and WINDMILL_WORKSPACE."
            )

    server = create_server()

    async def run() -> None:
        async with stdio_server() as (read, write):
            await server.run(read, write, server.create_initialization_options())

    asyncio.run(run())


if __name__ == "__main__":
    main()
