# MCP Apps Catalog

This document describes MCP Apps supported in Archestra — third-party servers
that expose a graphical UI via the MCP UI protocol, accessible through the
Archestra Chat interface using MCP Gateway and LLM Gateway.

## Overview

MCP Apps extend the standard MCP tool protocol by also serving an interactive
web UI. Archestra's Chat UI detects `mcpAppUrl` on a tool and renders it inside
an embedded panel (`McpAppPanel`), giving users a rich graphical experience
alongside normal AI conversation.

Supported transports:
- **MCP Gateway** — connects Archestra agents to remote MCP servers
- **LLM Gateway** — routes LLM calls through Archestra's secure proxy

---

## Available MCP Apps

### n8n-mcp

**Catalog ID:** `n8n-mcp`  
**Repository:** https://github.com/czlonkowski/n8n-mcp  
**Description:** Exposes n8n workflow automation as MCP tools with a visual
workflow builder UI.

**Tools Provided:**
- `list_workflows` — List all n8n workflows
- `execute_workflow` — Execute a workflow by ID
- `get_workflow` — Get workflow details
- `create_workflow` — Create a new workflow

**MCP App URL:** Served at `/ui` on the deployed container endpoint.

**Installation:**
1. Go to MCP Registry at `/mcp/registry`
2. Find `n8n-mcp` in the catalog
3. Click Install
4. Configure your n8n instance URL and API key
5. Assign to an agent profile
6. Open Chat — a **Launch App** button appears when the tool is available

**Tested with:** Archestra Chat UI (MCP Gateway mode)

---

### excalidraw-mcp

**Catalog ID:** `excalidraw-mcp`  
**Repository:** https://github.com/excalidraw/excalidraw-mcp  
**Description:** Provides a collaborative whiteboard / diagram tool via MCP,
allowing AI agents to create and modify diagrams with user participation.

**Tools Provided:**
- `create_diagram` — Create a new Excalidraw diagram
- `update_diagram` — Update existing diagram elements
- `get_diagram` — Retrieve current diagram state
- `export_diagram` — Export diagram as SVG/PNG

**MCP App URL:** Served at `/ui` on the deployed container endpoint.

**Installation:**
1. Go to MCP Registry at `/mcp/registry`
2. Find `excalidraw-mcp` in the catalog
3. Click Install
4. No additional configuration required
5. Assign to an agent profile
6. Open Chat — a **Launch App** button appears when the tool is available

**Tested with:** Archestra Chat UI (LLM Gateway mode)

---

## Using MCP Apps in Chat

1. Install an MCP App server from the MCP Registry
2. Assign it to an agent profile
3. Open Chat with that profile
4. When the AI uses or suggests the MCP App tool, a **Launch App** button
   appears in the chat interface
5. Click **Launch App** to open the `McpAppPanel` iframe overlay
6. Interact with the third-party UI directly in the panel
7. Close the panel to return to the chat

## Architecture

```
User (Chat UI)
  │
  ├─ MCP Gateway ──► n8n-mcp container (tools + /ui)
  │
  └─ LLM Gateway ──► excalidraw-mcp container (tools + /ui)
```

The `mcpAppUrl` field on `AvailableTool` carries the URL of the UI endpoint.
The frontend `McpAppPanel` component renders this URL in a sandboxed iframe.
