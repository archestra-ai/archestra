/**
 * MCP-UI types for rendering interactive UI from MCP tool results.
 *
 * When an MCP server returns a tool result with `_meta.ui.resourceUri`,
 * the Chat UI renders the linked UIResource in a sandboxed iframe
 * instead of showing raw JSON output.
 *
 * @see https://mcpui.dev
 */

/** MIME types supported by MCP-UI rendering */
type McpUiMimeType =
  | "text/html"
  | "text/uri-list"
  | "application/vnd.mcp-ui.remote-dom";

/** A UI resource returned by an MCP-UI-enabled server */
interface McpUiResource {
  uri: string;
  mimeType: McpUiMimeType;
  text?: string;
  blob?: string;
}

/** The _meta.ui field in an MCP tool result that signals UI availability */
interface McpUiMeta {
  ui: {
    resourceUri: string;
  };
}

/**
 * Extract MCP-UI metadata from a tool result output.
 * Returns the resourceUri if present, undefined otherwise.
 */
function extractMcpUiResourceUri(output: unknown): string | undefined {
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      return extractFromObject(parsed);
    } catch {
      return undefined;
    }
  }

  if (typeof output === "object" && output !== null) {
    return extractFromObject(output);
  }

  return undefined;
}

/**
 * Check if an MCP tool result contains embedded UIResource content.
 * This handles the case where the resource is inline in the tool result
 * rather than referenced by URI.
 */
function extractInlineMcpUiResource(
  output: unknown,
): McpUiResource | undefined {
  const obj = parseOutput(output);
  if (!obj) return undefined;

  // Check for content array with resource items (MCP SDK format)
  if (Array.isArray(obj.content)) {
    for (const item of obj.content) {
      if (item?.type === "resource" && item?.resource) {
        const r = item.resource as Record<string, unknown>;
        if (r.uri && r.mimeType && (r.text || r.blob)) {
          return {
            uri: r.uri as string,
            mimeType: r.mimeType as McpUiMimeType,
            text: r.text as string | undefined,
            blob: r.blob as string | undefined,
          };
        }
      }
    }
  }

  // Check for direct resource object
  if (obj.type === "resource" && obj.resource) {
    const r = obj.resource as Record<string, unknown>;
    if (r.uri && r.mimeType && (r.text || r.blob)) {
      return {
        uri: r.uri as string,
        mimeType: r.mimeType as McpUiMimeType,
        text: r.text as string | undefined,
        blob: r.blob as string | undefined,
      };
    }
  }

  return undefined;
}

// =============================================================================
// Internal helpers
// =============================================================================

function parseOutput(output: unknown): Record<string, unknown> | undefined {
  if (typeof output === "string") {
    try {
      return JSON.parse(output);
    } catch {
      return undefined;
    }
  }
  if (typeof output === "object" && output !== null) {
    return output as Record<string, unknown>;
  }
  return undefined;
}

function extractFromObject(obj: unknown): string | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;

  const record = obj as Record<string, unknown>;

  // Check _meta.ui.resourceUri
  const meta = record._meta;
  if (typeof meta === "object" && meta !== null) {
    const ui = (meta as Record<string, unknown>).ui;
    if (typeof ui === "object" && ui !== null) {
      const resourceUri = (ui as Record<string, unknown>).resourceUri;
      if (typeof resourceUri === "string") {
        return resourceUri;
      }
    }
  }

  return undefined;
}

export type { McpUiMimeType, McpUiResource, McpUiMeta };
export { extractMcpUiResourceUri, extractInlineMcpUiResource };
