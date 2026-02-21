import { z } from "zod";

/**
 * MCP Apps metadata schema matching the MCP specification.
 * Tools declare a UI resource in _meta.ui so hosts can render interactive HTML.
 * @see https://modelcontextprotocol.io/docs/extensions/apps
 */
export const McpAppUiMetaSchema = z.object({
  resourceUri: z.string(),
  permissions: z.array(z.string()).optional(),
  csp: z.record(z.string(), z.string()).optional(),
});

export const McpAppToolMetaSchema = z.object({
  ui: McpAppUiMetaSchema.optional(),
});

export type McpAppUiMeta = z.infer<typeof McpAppUiMetaSchema>;
export type McpAppToolMeta = z.infer<typeof McpAppToolMetaSchema>;

/**
 * Extract the MCP App UI resource URI from a tool's _meta field.
 * Returns null if the tool has no MCP App metadata or the URI is not a ui:// scheme.
 */
export function extractMcpAppResourceUri(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const parsed = McpAppToolMetaSchema.safeParse(meta);
  if (!parsed.success) return null;
  const uri = parsed.data.ui?.resourceUri;
  if (!uri || !uri.startsWith("ui://")) return null;
  return uri;
}

/**
 * Check if a tool result contains inline MCP App HTML content.
 * MCP servers can embed UI resources directly in the tool result content array
 * as either `{ type: "resource", uri: "ui://…", text: "<html>" }` items or
 * `{ type: "text", mimeType: "text/html", text: "<html>" }` items.
 */
export function extractInlineMcpAppHtml(output: unknown): string | null {
  if (output == null) return null;

  let parsed: unknown = output;
  if (typeof output === "string") {
    try {
      parsed = JSON.parse(output);
    } catch {
      return null;
    }
  }

  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.content)) return null;

  for (const item of record.content as Array<Record<string, unknown>>) {
    if (
      item.type === "resource" &&
      typeof item.uri === "string" &&
      item.uri.startsWith("ui://") &&
      typeof item.text === "string"
    ) {
      return item.text;
    }
    if (
      item.type === "text" &&
      item.mimeType === "text/html" &&
      typeof item.text === "string"
    ) {
      return item.text;
    }
  }

  return null;
}

/**
 * Type guard: does this tool's _meta contain MCP App UI metadata?
 */
export function hasMcpAppMeta(
  meta: unknown,
): meta is McpAppToolMeta & { ui: McpAppUiMeta } {
  return extractMcpAppResourceUri(meta) !== null;
}
