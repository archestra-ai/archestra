import ReconnectingWebSocket from 'reconnecting-websocket';

import config from '@ui/config';
import { type WebSocketMessage } from '@ui/lib/clients/archestra/api/gen';

type MessageHandler<T extends WebSocketMessage = WebSocketMessage> = (message: T) => void;

class WebSocketService {
  private ws: ReconnectingWebSocket | null = null;
  private handlers: Map<WebSocketMessage['type'], Set<MessageHandler<any>>> = new Map();
  private connectionPromise: Promise<void> | null = null;

  async connect(): Promise<void> {
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = new Promise((resolve, reject) => {
      this.ws = new ReconnectingWebSocket(config.archestra.websocketUrl, [], {
        WebSocket: window.WebSocket,
        maxReconnectionDelay: 10000,
        minReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1.3,
        connectionTimeout: 10000,
        maxRetries: Infinity,
        debug: false,
      });

      this.ws.addEventListener('open', () => {
        resolve();
      });

      this.ws.addEventListener('error', (error) => {
        console.error('WebSocket error:', error);
        if (!this.ws) {
          reject(error);
        }
      });

      this.ws.addEventListener('message', (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          this.handleMessage(message);
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      });

      this.ws.addEventListener('close', () => {});
    });

    return this.connectionPromise;
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connectionPromise = null;
    }
  }

  subscribe<T extends WebSocketMessage['type']>(
    type: T,
    handler: MessageHandler<Extract<WebSocketMessage, { type: T }>>
  ): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }

    this.handlers.get(type)!.add(handler);

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
          console.error('Error in WebSocket message handler:', error);
        }
      });
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(message: WebSocketMessage): void {
    if (!this.isConnected()) {
      console.error('WebSocket not connected, cannot send message');
      return;
    }

    try {
      this.ws?.send(JSON.stringify(message));
    } catch (error) {
      console.error('Failed to send WebSocket message:', error);
    }
  }
}

// Create singleton instance
export default new WebSocketService();
