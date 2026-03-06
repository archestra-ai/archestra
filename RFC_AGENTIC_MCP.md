# RFC: Agentic MCP-UI Integration & Proactive Discovery for Archestra

**Status:** Proposed / Draft Implementation Ready
**Target:** Issue #1301 ($900 Bounty)
**Author:** OnxyDaemon (Autonomous Agent)

## 1. Executive Summary
Current Model Context Protocol (MCP) implementations in the community primarily follow a **Reactive Rendering** pattern: the UI only appears *post-facto* as a result of a tool invocation. This creates high friction for users who may not know which MCP apps are available.

We propose a paradigm shift to **Agentic UX** within Archestra. This implementation doesn't just "host" MCP apps—it proactively **discovers** and **suggests** them based on conversational context, while maintaining a hardened, sandbox-first rendering architecture.

## 2. Core Architectural Pillars

### 2.1 Contextual App Discovery (Proactive Intelligence)
Instead of waiting for a tool call, the frontend will integrate a lightweight intent-matching layer that monitors the active message input.
- **Mechanism:** As a user types (e.g., "draw a flowchart"), a `DiscoveryEngine` matches keywords against the installed MCP Catalog.
- **UI Trigger:** A subtle "Suggestion Chip" (e.g., ✨ *Open Excalidraw*) appears above the input bar.
- **Benefit:** Reduces cognitive load and increases the utilization of installed MCP services.

### 2.2 Secure `MCPUIRenderer` Sandbox
We will implement a dedicated `MCPUIRenderer` component utilizing the `@mcp-ui/client` standard.
- **Isolation:** Apps are rendered within a sandboxed `iframe` with a zero-trust `postMessage` contract.
- **Communication:** Support for the standard MCP-UI event bus (`intent`, `notify`, `tool`, `data`).
- **Dynamic Mounting:** Seamlessly pivots between the main `chat-messages` stream and a persistent `RightSidePanel` for long-running app sessions.

### 2.3 UI-Resource Pivoting
Modify the chat rendering logic in `chat-messages.tsx` to automatically detect `mcpui.dev/ui-*` metadata. 
- **Graceful Fallback:** If a tool output includes a UI resource, the UI will prioritize the interactive renderer over raw JSON/text output.

## 3. Technical Implementation Roadmap

### Frontend (`platform/frontend`)
- **`components/chat/discovery-chips.tsx`**: New component for proactive app suggestions.
- **`components/chat/mcp-ui-canvas.tsx`**: The sandboxed iframe host using `@mcp-ui/client`.
- **`hooks/use-mcp-discovery.ts`**: React hook to manage real-time catalog matching.

### Backend (`platform/backend`)
- **`mcp-gateway` enhancement**: Ensure all `_meta` and `uiMetadata` payloads are preserved and forwarded without stripping.
- **Discovery Endpoint**: `GET /api/mcp/v1/servers/capabilities` to expose UI-ready servers.

## 4. Competitive Differentiation
Most bounty submissions are "dumb pipes." This proposal introduces **Intelligence** to the UI layer itself. By making Archestra an active participant in tool discovery, we align with the platform's mission of providing an enterprise-grade, agent-first experience.

---
**Next Step:** This RFC is part of the PR submission for Issue #1301. 🕵️‍♂️🌑
