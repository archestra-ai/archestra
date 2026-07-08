import { SEEDED_APP_RENDER_META_KEY } from "@archestra/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { structuredSuccessResult } from "@/archestra-mcp-server/helpers";
import type { App } from "@/types";

/**
 * The `render_app` tool result for an app: its summary in `structuredContent`
 * (the chat reads `structuredContent.id` to mount the app inline) plus the human
 * text. Shared by the `render_app` tool handler and the deep-link conversation
 * seeding so a server-seeded render is byte-for-byte what a model-driven render
 * produces — the chat can't tell them apart.
 */
export function buildAppRenderResult(app: App): CallToolResult {
  const summary = {
    id: app.id,
    name: app.name,
    description: app.description,
    scope: app.scope,
    latestVersion: app.latestVersion,
  };
  return structuredSuccessResult(
    summary,
    `${JSON.stringify(summary, null, 2)}\nWill render inline when opened in chat; standalone page: /a/${app.id}`,
  );
}

/**
 * The tool result for an external (MCP-server) UI app, byte-compatible with what
 * a live MCP-UI tool call persists: a text string in `content` plus the UI
 * pointer in `_meta.ui.resourceUri`. We additionally stamp `_meta.ui.mcpServerId`
 * so the chat mounts the app against that concrete install via the server
 * endpoint (`/api/mcp/server/<id>`) — independent of the conversation's agent.
 * Used by the external open-in-chat conversation seeding.
 *
 * The result also carries the platform-reserved seeded-render marker so the
 * trusted-data guardrail recognizes it as platform-authored — without it, the
 * seeded result of an external tool has no trusted-data evaluation and would
 * silently flip the whole conversation to sensitive context on its first turn.
 */
export function buildExternalAppRenderResult(params: {
  mcpServerId: string;
  resourceUri: string;
  label: string;
}): {
  content: string;
  _meta: {
    ui: { resourceUri: string; mcpServerId: string };
    [SEEDED_APP_RENDER_META_KEY]: true;
  };
} {
  return {
    content: `${params.label}\nWill render inline when opened in chat.`,
    _meta: {
      ui: {
        resourceUri: params.resourceUri,
        mcpServerId: params.mcpServerId,
      },
      [SEEDED_APP_RENDER_META_KEY]: true,
    },
  };
}
