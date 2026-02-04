import { z } from "zod";

/**
 * MCP Logs defaults
 */
export const MCP_DEFAULT_LOG_LINES = 500;

/**
 * WebSocket Message Payload Schemas (Client -> Server)
 */

// Browser stream payloads
const SubscribeBrowserStreamPayloadSchema = z.object({
  conversationId: z.string().uuid(),
  // Deprecated: tabIndex was derived from chat list ordering and is ignored.
  tabIndex: z.number().int().min(0).optional(),
  // Viewport dimensions for screenshots - frontend sends container size
  viewportWidth: z.number().int().min(100).max(2000).optional(),
  viewportHeight: z.number().int().min(100).max(2000).optional(),
  // Initial URL to navigate to (for new conversations created from URL bar)
  initialUrl: z.string().url().optional(),
});

const UnsubscribeBrowserStreamPayloadSchema = z.object({
  conversationId: z.string().uuid(),
});

const BrowserNavigatePayloadSchema = z.object({
  conversationId: z.string().uuid(),
  url: z.string().url(),
});

const BrowserClickPayloadSchema = z.object({
  conversationId: z.string().uuid(),
  // Either element ref OR coordinates
  element: z.string().optional(), // Element ref like "e123" from snapshot
  x: z.number().optional(), // X coordinate for click
  y: z.number().optional(), // Y coordinate for click
});

const BrowserTypePayloadSchema = z.object({
  conversationId: z.string().uuid(),
  text: z.string(),
  element: z.string().optional(), // Optional element ref to focus first
});

const BrowserPressKeyPayloadSchema = z.object({
  conversationId: z.string().uuid(),
  key: z.string(), // Key name like "Enter", "Tab", "ArrowDown", "PageDown"
});

const BrowserGetSnapshotPayloadSchema = z.object({
  conversationId: z.string().uuid(),
});

const BrowserNavigateBackPayloadSchema = z.object({
  conversationId: z.string().uuid(),
});

const BrowserSetZoomPayloadSchema = z.object({
  conversationId: z.string().uuid(),
  zoomPercent: z.number().min(10).max(200), // Zoom percentage (10% to 200%)
});

// MCP Server Logs payloads
const SubscribeMcpLogsPayloadSchema = z.object({
  serverId: z.string().uuid(),
  lines: z.number().int().min(1).max(10000).default(MCP_DEFAULT_LOG_LINES), // Number of initial lines to fetch
});

const UnsubscribeMcpLogsPayloadSchema = z.object({
  serverId: z.string().uuid(),
});

/**
 * Discriminated union of all possible websocket messages (client -> server)
 */
export const ClientWebSocketMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe_browser_stream"),
    payload: SubscribeBrowserStreamPayloadSchema,
  }),
  z.object({
    type: z.literal("unsubscribe_browser_stream"),
    payload: UnsubscribeBrowserStreamPayloadSchema,
  }),
  z.object({
    type: z.literal("browser_navigate"),
    payload: BrowserNavigatePayloadSchema,
  }),
  z.object({
    type: z.literal("browser_click"),
    payload: BrowserClickPayloadSchema,
  }),
  z.object({
    type: z.literal("browser_type"),
    payload: BrowserTypePayloadSchema,
  }),
  z.object({
    type: z.literal("browser_press_key"),
    payload: BrowserPressKeyPayloadSchema,
  }),
  z.object({
    type: z.literal("browser_get_snapshot"),
    payload: BrowserGetSnapshotPayloadSchema,
  }),
  z.object({
    type: z.literal("browser_navigate_back"),
    payload: BrowserNavigateBackPayloadSchema,
  }),
  z.object({
    type: z.literal("browser_set_zoom"),
    payload: BrowserSetZoomPayloadSchema,
  }),
  z.object({
    type: z.literal("subscribe_mcp_logs"),
    payload: SubscribeMcpLogsPayloadSchema,
  }),
  z.object({
    type: z.literal("unsubscribe_mcp_logs"),
    payload: UnsubscribeMcpLogsPayloadSchema,
  }),
]);

export type ClientWebSocketMessage = z.infer<
  typeof ClientWebSocketMessageSchema
>;

/**
 * All possible client message types (for handler maps)
 */
export type ClientWebSocketMessageType = ClientWebSocketMessage["type"];

/**
 * Server -> Client message types
 */
export type BrowserScreenshotMessage = {
  type: "browser_screenshot";
  payload: {
    conversationId: string;
    screenshot: string;
    url?: string;
    // Screenshot dimensions for accurate click mapping
    viewportWidth?: number;
    viewportHeight?: number;
    // Navigation state for back button
    canGoBack?: boolean;
  };
};

export type BrowserNavigateResultMessage = {
  type: "browser_navigate_result";
  payload: {
    conversationId: string;
    success: boolean;
    url?: string;
    error?: string;
  };
};

export type BrowserStreamErrorMessage = {
  type: "browser_stream_error";
  payload: {
    conversationId: string;
    error: string;
  };
};

export type BrowserClickResultMessage = {
  type: "browser_click_result";
  payload: {
    conversationId: string;
    success: boolean;
    error?: string;
  };
};

export type BrowserTypeResultMessage = {
  type: "browser_type_result";
  payload: {
    conversationId: string;
    success: boolean;
    error?: string;
  };
};

export type BrowserPressKeyResultMessage = {
  type: "browser_press_key_result";
  payload: {
    conversationId: string;
    success: boolean;
    error?: string;
  };
};

export type BrowserSnapshotMessage = {
  type: "browser_snapshot";
  payload: {
    conversationId: string;
    snapshot?: string;
    error?: string;
  };
};

export type BrowserSetZoomResultMessage = {
  type: "browser_set_zoom_result";
  payload: {
    conversationId: string;
    success: boolean;
    error?: string;
  };
};

export type BrowserNavigateBackResultMessage = {
  type: "browser_navigate_back_result";
  payload: {
    conversationId: string;
    success: boolean;
    error?: string;
  };
};

// MCP Logs server -> client messages
export type McpLogsMessage = {
  type: "mcp_logs";
  payload: {
    serverId: string;
    logs: string;
    command?: string; // kubectl command for manual execution
  };
};

export type McpLogsErrorMessage = {
  type: "mcp_logs_error";
  payload: {
    serverId: string;
    error: string;
  };
};

export type ErrorMessage = {
  type: "error";
  payload: {
    message: string;
  };
};

export type ServerWebSocketMessage =
  | BrowserScreenshotMessage
  | BrowserNavigateResultMessage
  | BrowserNavigateBackResultMessage
  | BrowserStreamErrorMessage
  | BrowserClickResultMessage
  | BrowserTypeResultMessage
  | BrowserPressKeyResultMessage
  | BrowserSnapshotMessage
  | BrowserSetZoomResultMessage
  | McpLogsMessage
  | McpLogsErrorMessage
  | ErrorMessage;

/**
 * All possible server message types (for handler maps)
 */
export type ServerWebSocketMessageType = ServerWebSocketMessage["type"];
