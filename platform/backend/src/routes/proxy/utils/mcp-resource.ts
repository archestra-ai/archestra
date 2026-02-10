export type McpResourceBlock = {
  type: "resource";
  resource: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
};

/**
 * Check if item is an MCP resource block.
 */
export function isMcpResourceBlock(item: unknown): item is McpResourceBlock {
  if (typeof item !== "object" || item === null) return false;
  const candidate = item as Record<string, unknown>;
  if (candidate.type !== "resource") return false;
  if (typeof candidate.resource !== "object" || candidate.resource === null) {
    return false;
  }
  const resource = candidate.resource as Record<string, unknown>;
  return typeof resource.uri === "string";
}

/**
 * Check if content contains MCP resource blocks.
 */
export function hasResourceContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((item) => isMcpResourceBlock(item));
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * Convert an MCP resource block into a short text summary safe to forward to LLM providers.
 */
export function formatMcpResourceBlockAsText(item: McpResourceBlock): string {
  const uri = item.resource.uri;
  const mimeType = item.resource.mimeType;

  const parts: string[] = [];

  if (uri.startsWith("ui://")) {
    parts.push(`UI resource: ${uri}`);
  } else {
    parts.push(`Resource: ${uri}`);
  }

  if (mimeType) {
    parts.push(`mimeType=${mimeType}`);
  }

  // Never include full HTML/blob in the model context; at most include a short preview of non-HTML text.
  if (
    typeof item.resource.text === "string" &&
    item.resource.text.length > 0 &&
    (!mimeType || !mimeType.toLowerCase().includes("text/html"))
  ) {
    parts.push(`text=${truncate(item.resource.text, 200)}`);
  }

  return parts.join(" ");
}
