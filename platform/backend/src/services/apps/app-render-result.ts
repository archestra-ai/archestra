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
    `${JSON.stringify(summary, null, 2)}\nRendered inline when viewed in chat; standalone page: /a/${app.id}`,
  );
}
