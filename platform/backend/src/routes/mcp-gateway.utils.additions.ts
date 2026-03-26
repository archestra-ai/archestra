/**
 * mcp-gateway.utils.additions.ts
 *
 * Additions to mcp-gateway.utils.ts:
 *
 * 1. Register resources/read handler for ui:// URIs in the MCP Gateway
 *    (so external clients using the MCP Gateway get access to MCP App UIs)
 *
 * 2. Tool list now includes _meta from the DB (for LLM Gateway passthrough)
 *
 * HOW TO INTEGRATE:
 *   In your existing mcp-gateway.utils.ts, inside the function that builds
 *   the McpServer instance (e.g. createAgentServer or similar), add:
 *
 *   import { registerUiResourceHandler, toolWithMeta } from "./mcp-gateway.utils.additions";
 *
 *   Then call registerUiResourceHandler(server, mcpClient, agentId) after
 *   the server is created.
 *
 *   And wrap each tool definition with toolWithMeta(tool) when building
 *   the tools/list response.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { logger } from "../logging";

// ─── 1. ui:// Resource Handler ────────────────────────────────────────────

/**
 * Register a resources/read handler that forwards ui:// resource reads
 * to the upstream MCP server via the existing MCP client connection.
 *
 * This enables external clients (e.g. 3rd-party UIs using the MCP Gateway)
 * to retrieve MCP App HTML the same way the Archestra Chat UI does.
 */
export function registerUiResourceHandler(
  server: McpServer,
  getClient: (agentId: string) => Promise<Client | null>,
  agentId: string,
): void {
  server.resource(
    // Pattern matches all ui:// URIs
    "ui://{serverName}/{resourcePath}",
    async (uri: URL) => {
      const uriStr = uri.toString();

      logger.debug({ uri: uriStr, agentId }, "MCP Gateway: forwarding ui:// resource read");

      const client = await getClient(agentId);
      if (!client) {
        throw new Error(`No MCP client available for agent ${agentId}`);
      }

      try {
        const response = await client.readResource({ uri: uriStr });

        const content = response.contents?.[0];
        if (!content) {
          throw new Error(`MCP server returned no content for: ${uriStr}`);
        }

        return {
          contents: [
            {
              uri: uriStr,
              mimeType: content.mimeType ?? "text/html",
              text: content.text ?? "",
            },
          ],
        };
      } catch (err) {
        logger.error(
          { uri: uriStr, agentId, err },
          "MCP Gateway: ui:// resource read failed",
        );
        throw err;
      }
    },
  );
}

// ─── 2. Tool Meta Passthrough ──────────────────────────────────────────────

interface DbTool {
  name: string;
  description?: string | null;
  inputSchema?: Record<string, unknown> | null;
  /** Stored as JSONB — may contain _meta.ui.resourceUri etc. */
  meta?: Record<string, unknown> | null;
  annotations?: Record<string, unknown> | null;
}

/**
 * Convert a DB tool row to MCP tool format, preserving _meta and annotations.
 *
 * This ensures that when the MCP Gateway lists tools to external clients,
 * the _meta.ui.resourceUri field is present so MCP Apps-aware clients
 * can detect and render interactive UIs.
 */
export function toolWithMeta(dbTool: DbTool): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    name: dbTool.name,
    description: dbTool.description ?? undefined,
    inputSchema: dbTool.inputSchema ?? { type: "object", properties: {} },
  };

  // Preserve _meta from DB (set during tool sync from MCP server)
  if (dbTool.meta) {
    tool._meta = dbTool.meta;
  }

  // Preserve annotations from DB
  if (dbTool.annotations) {
    tool.annotations = dbTool.annotations;
  }

  return tool;
}

// ─── 3. LLM Gateway: _meta.ui passthrough ────────────────────────────────

interface OpenAiFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  // Non-standard extension preserved for MCP Apps-aware clients
  _meta?: Record<string, unknown>;
}

interface OpenAiTool {
  type: "function";
  function: OpenAiFunction;
}

/**
 * Convert an MCP tool (with _meta) to OpenAI format.
 *
 * Preserves _meta.ui so that 3rd-party hosts using Archestra as an LLM
 * proxy can detect tools with MCP App UIs and render them.
 *
 * This is the LLM Gateway passthrough that was missing from PR #2898.
 */
export function mcpToolToOpenAiFormat(tool: DbTool): OpenAiTool {
  const fn: OpenAiFunction = {
    name: tool.name,
    description: tool.description ?? undefined,
    parameters: (tool.inputSchema as Record<string, unknown>) ?? {
      type: "object",
      properties: {},
    },
  };

  // Preserve _meta.ui for MCP Apps-aware downstream clients
  if (tool.meta?.ui) {
    fn._meta = { ui: tool.meta.ui };
  }

  return { type: "function", function: fn };
}

/**
 * Convert OpenAI format tool back to MCP format.
 * Used when the LLM Gateway receives tool definitions from a 3rd party
 * and needs to forward them to Archestra's MCP client.
 */
export function openAiToolToMcpFormat(tool: OpenAiTool): DbTool {
  const dbTool: DbTool = {
    name: tool.function.name,
    description: tool.function.description,
    inputSchema: tool.function.parameters,
  };

  if (tool.function._meta?.ui) {
    dbTool.meta = { ui: tool.function._meta.ui };
  }

  return dbTool;
}
