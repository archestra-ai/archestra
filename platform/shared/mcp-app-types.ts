/**
 * MCP Apps (SEP-1865) shared types.
 *
 * These types describe the `_meta.ui` metadata that MCP servers attach to
 * tools so that hosts can render interactive HTML UIs inline.
 */

/** CSP directives declared by a MCP App resource. */
export interface McpToolUiCsp {
  /** Allowed origins for fetch / XHR / WebSocket. */
  connectDomains?: string[];
  /** Allowed origins for images, scripts, stylesheets, fonts. */
  resourceDomains?: string[];
  /** Allowed origins for nested iframes. */
  frameDomains?: string[];
  /** Allowed base URIs. */
  baseUriDomains?: string[];
}

/** Browser permissions the MCP App may request. */
export interface McpToolUiPermissions {
  camera?: Record<string, never>;
  microphone?: Record<string, never>;
  geolocation?: Record<string, never>;
  clipboardWrite?: Record<string, never>;
}

/** The `_meta.ui` block on a UIResource. */
export interface McpToolUiResourceMeta {
  csp?: McpToolUiCsp;
  permissions?: McpToolUiPermissions;
  /** Dedicated sandbox origin for the app. */
  domain?: string;
  /** Whether the host should draw a visible border around the iframe. */
  prefersBorder?: boolean;
}

/** The `_meta.ui` block on a Tool definition. */
export interface McpToolUiMeta {
  /** Points to a `ui://` resource that provides the HTML UI for this tool. */
  resourceUri?: string;
  /** Controls who can see / invoke the tool: "model" (the LLM) or "app" (the iframe). */
  visibility?: Array<"model" | "app">;
}

/**
 * Shape of the `_meta` object stored on a tool row.
 * Only the `ui` sub-key is defined today; the rest is opaque pass-through.
 */
export interface McpToolMeta {
  ui?: McpToolUiMeta;
  [key: string]: unknown;
}

/**
 * Payload sent from the chat streaming backend to the frontend via
 * `data-tool-ui-meta` custom data part.
 *
 * Maps *slugified* tool names → their `_meta.ui` information.
 */
export type ToolUiMetaMap = Record<string, McpToolUiMeta>;
