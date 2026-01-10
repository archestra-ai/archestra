import { z } from "zod";

/**
 * WebSocket Message Payload Schemas
 */
const HelloWorldWebsocketPayloadSchema = z.object({});

// Browser stream payloads
const SubscribeBrowserStreamPayloadSchema = z.object({
  conversationId: z.string().uuid(),
  // Deprecated: tabIndex was derived from chat list ordering and is ignored.
  tabIndex: z.number().int().min(0).optional(),
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

/**
 * Discriminated union of all possible websocket messages (client -> server)
 */
export const WebSocketMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello-world"),
    payload: HelloWorldWebsocketPayloadSchema,
  }),
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
]);

export type WebSocketMessage = z.infer<typeof WebSocketMessageSchema>;

/**
 * Server -> Client message types (not validated, just typed)
 */
export type BrowserScreenshotMessage = {
  type: "browser_screenshot";
  payload: {
    conversationId: string;
    screenshot: string;
    url?: string;
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
  | { type: "error"; payload: { message: string } };
