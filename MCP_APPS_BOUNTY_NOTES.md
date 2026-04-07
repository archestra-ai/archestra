# MCP Apps bounty notes (issue #1301)

## Goal

Support MCP Apps in Archestra and make sure real MCP App servers can be surfaced through the product catalog and used by clients through the existing MCP Gateway / chat stack.

Issue reference: `archestra-ai/archestra#1301`

## What I found in the codebase

The core MCP Apps plumbing is already present:

- **Chat UI rendering exists already** via `platform/frontend/src/components/chat/mcp-app-container.tsx`
- **Client extension capabilities exist already** via `MCP_APPS_CLIENT_EXTENSION_CAPABILITIES`
- **Server extension capabilities exist already** via `MCP_APPS_SERVER_EXTENSION_CAPABILITIES`
- **MCP Gateway initialize already returns MCP Apps extensions** in `platform/backend/src/routes/mcp-gateway.utils.ts`
- **Structured tool output is already propagated** through the backend and consumed in the frontend (`structuredContent`, `rawContent`, `_meta`)

In other words, the MCP Apps protocol support is already largely implemented in the product.

## Gap addressed in this change

This change focuses on the missing product-level discoverability / adoption piece from the issue:

- add real MCP App-compatible servers to the Archestra internal MCP catalog
- make them available as ready-to-install catalog entries

## Catalog entries added

### 1. `n8n-mcp`

Seeded as a **local MCP server** using stdio.

Configuration:
- command: `npx`
- args: `-y n8n-mcp`
- transport: `stdio`
- env defaults:
  - `MCP_MODE=stdio`
  - `LOG_LEVEL=error`
  - `DISABLE_CONSOLE_OUTPUT=true`
- optional install-time settings:
  - `N8N_API_URL`
  - `N8N_API_KEY`

Why this matters:
- gives users an immediately installable n8n-oriented MCP server
- aligns with the issue requirement to test with a real MCP ecosystem server
- uses the upstream-recommended stdio launch shape from the public README

### 2. `excalidraw-mcp-app`

Seeded as a **remote MCP server**.

Configuration:
- server type: `remote`
- URL: `https://mcp.excalidraw.com`
- auth: not required

Why this matters:
- this is a direct MCP Apps-native server
- it is ideal for validating interactive UI rendering in clients
- it gives Archestra a real visual / interactive MCP App server in catalog immediately

## Files changed

- `platform/backend/src/database/seed.ts`

## Commit

- `f793868` — `feat: seed MCP Apps catalog entries`

## Suggested PR summary

This PR seeds two MCP Apps-compatible servers into Archestra’s internal MCP catalog:

- `n8n-mcp` (local stdio server)
- `excalidraw-mcp-app` (remote MCP App server)

While reviewing issue #1301, I verified that the core MCP Apps support is already present across the codebase:

- chat rendering (`mcp-app-container.tsx`)
- MCP client/server extension capabilities
- gateway initialize response advertising MCP Apps support
- `structuredContent` propagation from backend tool calls to the frontend

Because that protocol-level support already exists, this PR focuses on the missing catalog/discoverability layer by adding real MCP App-compatible servers that teams can install and test.

## Suggested PR checklist

- [x] Chat-side MCP Apps rendering already present
- [x] MCP Gateway advertises MCP Apps extensions
- [x] Added real MCP App-compatible servers to catalog
- [ ] Follow-up demo screenshots / walkthrough
- [ ] Validate install flow in a running Archestra environment

## Caveats

This change does **not** yet add new protocol code because the main MCP Apps support path appears to already exist in the current codebase. Instead, it adds practical installable catalog entries so the existing support can be exercised with real servers.

If maintainers want a broader interpretation of the issue, the next follow-up would be:

1. add an end-to-end test that installs one of these servers and verifies MCP App rendering
2. add product documentation or screenshots showing the interactive app flow
3. confirm behavior through both MCP Gateway and LLM Gateway examples
