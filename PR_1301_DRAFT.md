# PR Draft — Support MCP Apps (#1301)

## Title
feat(chat): render MCP app previews in chat tool outputs

## Summary
This PR adds MVP support for MCP Apps in Archestra Chat UI by detecting MCP app payloads in tool output and rendering an interactive app preview directly in chat.

## What changed
- Added MCP app payload extraction in `ToolOutput`:
  - `mcpApp.url`, `mcpApp.html`
  - `ui.url`, `ui.html`
  - `appUrl`, `url`, `html`
  - `_meta["mcp/www_url"]`, `_meta["mcp/www_html"]`
- Added `McpAppPreview` renderer:
  - Embedded iframe for URL or HTML payload
  - Safe iframe sandbox attributes
  - “Open MCP App in new tab” fallback link
- Preserved existing behavior for non-MCP outputs.
- Added tests for:
  - URL metadata payload
  - Embedded HTML payload
  - n8n-style payload via `ui.url`
  - excalidraw-style payload via `mcpApp.url`

## Acceptance criteria mapping (#1301)
- [x] 1) Support MCP Apps in Archestra Chat UI
  - Implemented by tool output MCP payload parser + iframe preview renderer.
- [ ] 2) Works in 3rd-party UI via MCP Gateway
  - Pending: gateway-level compatibility verification with external UI.
- [ ] 3) Works in 3rd-party UI via LLM Gateway
  - Pending: gateway-level compatibility verification with external UI.
- [~] 4) Test 2 real vendor MCPs + catalog integration (n8n + excalidraw)
  - Added payload compatibility tests for n8n/excalidraw output shapes.
  - Pending: end-to-end vendor demo and catalog flow verification.

## Test plan
- Unit tests (`tool.test.tsx`):
  - MCP metadata URL path
  - MCP embedded HTML path
  - n8n-style payload shape
  - excalidraw-style payload shape
- Manual smoke:
  - Trigger a tool output with MCP app payload and verify iframe renders.
  - Verify fallback link opens app in new tab.

## Risk notes
- URL trust/clickjacking concerns for arbitrary third-party iframe URLs.
- Some providers may require additional CSP/allowlist adjustments.

## Follow-ups
1. Add gateway compatibility fixtures and e2e tests for MCP Gateway + LLM Gateway.
2. Add vendor catalog demo path for n8n/excalidraw to satisfy full acceptance.
3. Add optional allowlist guard for third-party iframe hostnames.

## Issue
Closes #1301
