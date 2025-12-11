import type { archestraApiTypes } from "@shared";
import config from "@/lib/config";

type WebSocketMessage = archestraApiTypes.WebSocketMessage;

type MessageHandler<T extends WebSocketMessage = WebSocketMessage> = (
  message: T,
) => void;

class WebSocketService {
  private ws: WebSocket | null = null;
  // biome-ignore lint/suspicious/noExplicitAny: Generic message handler
  private handlers: Map<WebSocketMessage["type"], Set<MessageHandler<any>>> =
    new Map();
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = Infinity;
  private reconnectDelay = 1000; // Start with 1 second
  private maxReconnectDelay = 30000; // Max 30 seconds
  private isManuallyDisconnected = false;

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.isManuallyDisconnected = false;

    try {
      this.ws = new WebSocket(config.websocket.url);

      this.ws.addEventListener("open", () => {
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
      });

      // this.ws.addEventListener("error", (_error) => {});

      this.ws.addEventListener("message", (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          this.handleMessage(message);
        } catch (error) {
          console.error("[WebSocket] Failed to parse message:", error);
        }
      });

      this.ws.addEventListener("close", () => {
        this.ws = null;

        // Attempt to reconnect unless manually disconnected
        if (!this.isManuallyDisconnected) {
          this.scheduleReconnect();
        }
      });
    } catch (error) {
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

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  subscribe<T extends WebSocketMessage["type"]>(
    type: T,
    handler: MessageHandler<Extract<WebSocketMessage, { type: T }>>,
  ): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }

    this.handlers.get(type)?.add(handler);

    // Return unsubscribe function
    return () => {
      const handlers = this.handlers.get(type);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.handlers.delete(type);
        }
      }
    };
  }

  private handleMessage(message: WebSocketMessage): void {
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

  send(message: WebSocketMessage): void {
    if (!this.isConnected()) {
      console.error("[WebSocket] Not connected, cannot send message");
      return;
    }

    try {
      this.ws?.send(JSON.stringify(message));
    } catch (error) {
      console.error("[WebSocket] Failed to send message:", error);
    }
  }
}

/**
 * Open a single websocket connection to WebSocket server when the app is loaded
 */
const websocketService = new WebSocketService();

export default websocketService;
