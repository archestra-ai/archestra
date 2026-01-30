/**
 * Utility functions for handling MCP UI resources
 */

export interface MCPUIResource {
  resourceUri: string;
  resourceType?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolResultWithMeta {
  type: string;
  text?: string;
  url?: string;
  mimeType?: string;
  _meta?: {
    ui?: {
      resourceUri?: string;
      resourceType?: string;
    };
  };
}

/**
 * Detect if a tool output contains an MCP UI resource
 */
export function detectMCPUIResource(output: unknown): MCPUIResource | null {
  if (!output) {
    return null;
  }

  // Handle string output (JSON)
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      return extractMCPUIFromObject(parsed);
    } catch {
      return null;
    }
  }

  // Handle object output
  if (typeof output === "object") {
    return extractMCPUIFromObject(output);
  }

  return null;
}

/**
 * Extract MCP UI resource from an object
 */
function extractMCPUIFromObject(obj: Record<string, unknown>): MCPUIResource | null {
  // Check for _meta.ui.resourceUri pattern
  if (obj._meta && typeof obj._meta === "object") {
    const meta = obj._meta as Record<string, unknown>;
    if (meta.ui && typeof meta.ui === "object") {
      const ui = meta.ui as Record<string, unknown>;
      if (ui.resourceUri && typeof ui.resourceUri === "string") {
        return {
          resourceUri: ui.resourceUri,
          resourceType: (ui.resourceType as string) || "html",
          metadata: ui,
        };
      }
    }
  }

  // Check for nested content array (MCP standard response format)
  if (Array.isArray(obj.content)) {
    for (const item of obj.content) {
      if (item && typeof item === "object") {
        const resource = extractMCPUIFromObject(item as Record<string, unknown>);
        if (resource) {
          return resource;
        }
      }
    }
  }

  // Check for direct resourceUri property
  if (obj.resourceUri && typeof obj.resourceUri === "string") {
    return {
      resourceUri: obj.resourceUri,
      resourceType: (obj.resourceType as string) || "html",
      metadata: obj,
    };
  }

  return null;
}

/**
 * Check if output is a text-only result (not UI)
 */
export function isTextOnlyOutput(output: unknown): boolean {
  const mcpUI = detectMCPUIResource(output);
  return !mcpUI;
}

/**
 * Extract text content from tool output
 */
export function extractTextContent(output: unknown): string {
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      return extractTextFromObject(parsed);
    } catch {
      return output;
    }
  }

  if (typeof output === "object" && output !== null) {
    return extractTextFromObject(output as Record<string, unknown>);
  }

  return String(output);
}

/**
 * Extract text from an object
 */
function extractTextFromObject(obj: Record<string, unknown>): string {
  // Check for text property
  if (obj.text && typeof obj.text === "string") {
    return obj.text;
  }

  // Check for message property
  if (obj.message && typeof obj.message === "string") {
    return obj.message;
  }

  // Check for content array with text
  if (Array.isArray(obj.content)) {
    const textItems = obj.content
      .filter((item) => item && typeof item === "object" && "text" in item)
      .map((item) => (item as Record<string, unknown>).text);
    if (textItems.length > 0) {
      return textItems.join("\n");
    }
  }

  // Fallback to JSON string
  return JSON.stringify(obj);
}

/**
 * Validate MCP UI resource URI
 */
export function isValidMCPUIResourceUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    // Allow http, https, and data URIs
    return ["http:", "https:", "data:"].includes(url.protocol);
  } catch {
    return false;
  }
}
