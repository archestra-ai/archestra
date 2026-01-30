/**
 * MCP Gateway UI Support
 * 
 * This module enhances the MCP Gateway to support MCP UI resources.
 * It ensures that UI resource metadata is preserved through the gateway
 * and provides endpoints for UI capability discovery.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CommonToolResult } from "@/types";

/**
 * MCP UI Resource metadata structure
 */
export interface MCPUIResourceMeta {
  ui?: {
    resourceUri?: string;
    resourceType?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Tool with UI capabilities
 */
export interface ToolWithUICapabilities extends Tool {
  _meta?: MCPUIResourceMeta;
  uiCapabilities?: {
    supportsUI: boolean;
    resourceTypes?: string[];
  };
}

/**
 * Preserve UI metadata in tool result
 * Ensures that _meta.ui.resourceUri and other UI metadata passes through unchanged
 */
export function preserveUIMetadata(result: CommonToolResult): CommonToolResult {
  if (!Array.isArray(result.content)) {
    return result;
  }

  // Preserve _meta for each content item
  const preservedContent = result.content.map((item: any) => {
    if (item && typeof item === "object") {
      return {
        ...item,
        // Ensure _meta is preserved
        _meta: item._meta || {},
      };
    }
    return item;
  });

  return {
    ...result,
    content: preservedContent,
  };
}

/**
 * Detect if a tool supports UI resources
 */
export function toolSupportsUI(tool: Tool): boolean {
  // Check for UI metadata in tool definition
  const meta = (tool as any)._meta;
  if (meta?.ui?.resourceUri) {
    return true;
  }

  // Check for UI capabilities annotation
  const annotations = (tool as any).annotations;
  if (annotations?.ui?.supportsUI) {
    return true;
  }

  // Check tool description for UI hints
  const description = tool.description || "";
  if (
    description.includes("UI") ||
    description.includes("interactive") ||
    description.includes("iframe")
  ) {
    return true;
  }

  return false;
}

/**
 * Extract UI capabilities from tool metadata
 */
export function extractUICapabilities(tool: Tool): {
  supportsUI: boolean;
  resourceTypes?: string[];
} {
  const meta = (tool as any)._meta;
  if (meta?.ui) {
    return {
      supportsUI: true,
      resourceTypes: meta.ui.resourceTypes || ["html"],
    };
  }

  return {
    supportsUI: false,
  };
}

/**
 * Enhance tool definition with UI capabilities
 */
export function enhanceToolWithUICapabilities(
  tool: Tool
): ToolWithUICapabilities {
  const uiCapabilities = extractUICapabilities(tool);

  return {
    ...tool,
    _meta: (tool as any)._meta || {},
    uiCapabilities,
  };
}

/**
 * Validate MCP UI resource URI
 */
export function isValidUIResourceUri(uri: unknown): uri is string {
  if (typeof uri !== "string") {
    return false;
  }

  try {
    const url = new URL(uri);
    // Allow http, https, and data URIs
    return ["http:", "https:", "data:"].includes(url.protocol);
  } catch {
    return false;
  }
}

/**
 * Extract UI resource from tool result content
 */
export function extractUIResourceFromContent(
  content: unknown[]
): { resourceUri: string; resourceType: string } | null {
  if (!Array.isArray(content)) {
    return null;
  }

  for (const item of content) {
    if (item && typeof item === "object") {
      const itemObj = item as any;

      // Check for _meta.ui.resourceUri
      if (
        itemObj._meta?.ui?.resourceUri &&
        isValidUIResourceUri(itemObj._meta.ui.resourceUri)
      ) {
        return {
          resourceUri: itemObj._meta.ui.resourceUri,
          resourceType: itemObj._meta.ui.resourceType || "html",
        };
      }

      // Check for direct resourceUri
      if (itemObj.resourceUri && isValidUIResourceUri(itemObj.resourceUri)) {
        return {
          resourceUri: itemObj.resourceUri,
          resourceType: itemObj.resourceType || "html",
        };
      }
    }
  }

  return null;
}

/**
 * Create a UI resource response for MCP
 */
export function createUIResourceResponse(
  resourceUri: string,
  resourceType: string = "html"
): any {
  return {
    type: "resource",
    resource: {
      uri: resourceUri,
      mimeType: resourceType === "html" ? "text/html" : "application/json",
      _meta: {
        ui: {
          resourceUri,
          resourceType,
        },
      },
    },
  };
}

/**
 * Transform tool result to include UI metadata in proper format
 */
export function transformToolResultForUI(
  result: CommonToolResult
): CommonToolResult {
  // Preserve UI metadata
  const preserved = preserveUIMetadata(result);

  // Ensure content items have proper structure
  if (Array.isArray(preserved.content)) {
    preserved.content = preserved.content.map((item: any) => {
      if (item && typeof item === "object") {
        // Ensure _meta exists
        if (!item._meta) {
          item._meta = {};
        }
        // Ensure ui object exists if resourceUri is present
        if (item.resourceUri && !item._meta.ui) {
          item._meta.ui = {
            resourceUri: item.resourceUri,
            resourceType: item.resourceType || "html",
          };
        }
      }
      return item;
    });
  }

  return preserved;
}
