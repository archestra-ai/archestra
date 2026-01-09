import config from "@/lib/config";

// Client -> Server messages (defined locally to avoid dependency on generated types)
type ClientWebSocketMessage =
  | { type: "hello-world"; payload: Record<string, never> }
  | {
      type: "subscribe_browser_stream";
      payload: { conversationId: string };
    }
  | {
      type: "unsubscribe_browser_stream";
      payload: { conversationId: string };
    }
  | {
      type: "browser_navigate";
      payload: { conversationId: string; url: string };
    }
  | {
      type: "browser_click";
      payload: {
        conversationId: string;
        element?: string;
        x?: number;
        y?: number;
      };
    }
  | {
      type: "browser_type";
      payload: { conversationId: string; text: string; element?: string };
    }
  | {
      type: "browser_press_key";
      payload: { conversationId: string; key: string };
    }
  | {
      type: "browser_get_snapshot";
      payload: { conversationId: string };
    }
  | {
      type: "browser_navigate_back";
      payload: { conversationId: string };
    }
  | {
      type: "browser_set_zoom";
      payload: { conversationId: string; zoomPercent: number };
    };

// Server -> Client messages (not in OpenAPI spec)
type BrowserScreenshotMessage = {
  type: "browser_screenshot";
  payload: {
    conversationId: string;
    screenshot: string;
    url?: string;
  };
};

type BrowserNavigateResultMessage = {
  type: "browser_navigate_result";
  payload: {
    conversationId: string;
    success: boolean;
    url?: string;
    error?: string;
  };
};

type BrowserStreamErrorMessage = {
  type: "browser_stream_error";
  payload: {
    conversationId: string;
    error: string;
  };
};

type BrowserClickResultMessage = {
  type: "browser_click_result";
  payload: {
    conversationId: string;
    success: boolean;
    error?: string;
  };
};

type BrowserTypeResultMessage = {
  type: "browser_type_result";
  payload: {
    conversationId: string;
    success: boolean;
    error?: string;
  };
};

type BrowserPressKeyResultMessage = {
  type: "browser_press_key_result";
  payload: {
    conversationId: string;
    success: boolean;
    error?: string;
  };
};

type BrowserSnapshotMessage = {
  type: "browser_snapshot";
  payload: {
    conversationId: string;
    snapshot?: string;
    error?: string;
  };
};

type BrowserSetZoomResultMessage = {
  type: "browser_set_zoom_result";
  payload: {
    conversationId: string;
    success: boolean;
    error?: string;
  };
};

type BrowserNavigateBackResultMessage = {
  type: "browser_navigate_back_result";
  payload: {
    conversationId: string;
    success: boolean;
    error?: string;
  };
};

type ErrorMessage = {
  type: "error";
  payload: {
    message: string;
  };
};

type ServerWebSocketMessage =
  | BrowserScreenshotMessage
  | BrowserNavigateResultMessage
  | BrowserNavigateBackResultMessage
  | BrowserStreamErrorMessage
  | BrowserClickResultMessage
  | BrowserTypeResultMessage
  | BrowserPressKeyResultMessage
  | BrowserSnapshotMessage
  | BrowserSetZoomResultMessage
  | ErrorMessage;

// All message types that can be received
type IncomingWebSocketMessage = ClientWebSocketMessage | ServerWebSocketMessage;

type MessageHandler = (message: IncomingWebSocketMessage) => void;

class WebSocketService {
  private ws: WebSocket | null = null;
  private handlers: Map<IncomingWebSocketMessage["type"], Set<MessageHandler>> =
    new Map();
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = Infinity;
  private reconnectDelay = 1000; // Start with 1 second
  private maxReconnectDelay = 30000; // Max 30 seconds
  private isManuallyDisconnected = false;
  private isConnecting = false;
  private pendingMessages: ClientWebSocketMessage[] = [];

  async connect(): Promise<void> {
    if (
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING ||
      this.isConnecting
    ) {
      return;
    }

    this.isManuallyDisconnected = false;
    this.isConnecting = true;

    try {
      this.ws = new WebSocket(config.websocket.url);

      this.ws.addEventListener("open", () => {
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
        this.flushPendingMessages();
      });

      // this.ws.addEventListener("error", (_error) => {});

      this.ws.addEventListener("message", (event) => {
        try {
          const message: IncomingWebSocketMessage = JSON.parse(event.data);
          this.handleMessage(message);
        } catch (error) {
          console.error("[WebSocket] Failed to parse message:", error);
        }
      });

      this.ws.addEventListener("close", () => {
        this.ws = null;
        this.isConnecting = false;

        // Attempt to reconnect unless manually disconnected
        if (!this.isManuallyDisconnected) {
          this.scheduleReconnect();
        }
      });
    } catch (error) {
      this.isConnecting = false;
      console.error("[WebSocket] Connection failed:", error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[WebSocket] Max reconnect attempts reached, giving up");
      return;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.reconnectDelay * 1.3 ** this.reconnectAttempts,
      this.maxReconnectDelay,
    );

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  disconnect(): void {
    this.isManuallyDisconnected = true;
    this.pendingMessages = [];

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Subscribe to messages of a specific type (typed version for known types)
   */
  subscribe<T extends IncomingWebSocketMessage["type"]>(
    type: T,
    handler: (message: Extract<IncomingWebSocketMessage, { type: T }>) => void,
  ): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }

    const wrappedHandler = handler as unknown as MessageHandler;
    this.handlers.get(type)?.add(wrappedHandler);

    // Return unsubscribe function
    return () => {
      const handlers = this.handlers.get(type);
      if (handlers) {
        handlers.delete(wrappedHandler);
        if (handlers.size === 0) {
          this.handlers.delete(type);
        }
      }
    };
  }

  private handleMessage(message: IncomingWebSocketMessage): void {
    const handlers = this.handlers.get(message.type);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(message);
        } catch (error) {
          console.error("[WebSocket] Error in message handler:", error);
        }
      });
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private sendNow(message: ClientWebSocketMessage): void {
    if (!this.isConnected()) {
      this.pendingMessages.push(message);
      return;
    }

    try {
      this.ws?.send(JSON.stringify(message));
    } catch (error) {
      console.error("[WebSocket] Failed to send message:", error);
      this.pendingMessages.unshift(message);
    }
  }

  private flushPendingMessages(): void {
    if (!this.isConnected() || this.pendingMessages.length === 0) {
      return;
    }

    const queuedMessages = [...this.pendingMessages];
    this.pendingMessages = [];
    for (const message of queuedMessages) {
      this.sendNow(message);
    }
  }

  /**
   * Send a message to the server (only client messages allowed)
   */
  send(message: ClientWebSocketMessage): void {
    if (!this.isConnected()) {
      this.pendingMessages.push(message);
      if (!this.isManuallyDisconnected && !this.isConnecting && !this.ws) {
        this.connect().catch((error) => {
          console.error("[WebSocket] Auto-connect failed:", error);
        });
      }
      return;
    }

    this.sendNow(message);
  }
}

/**
 * Open a single websocket connection to WebSocket server when the app is loaded
 */
const websocketService = new WebSocketService();

export default websocketService;
