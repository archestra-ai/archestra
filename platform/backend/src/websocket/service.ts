import type { WebSocket, WebSocketServer } from "ws";
import { WebSocket as WS, WebSocketServer as WSS } from "ws";
import type { Server } from "node:http";
import config from "@/config";
import logger from "@/logging";
import {
  WebSocketMessageSchema,
  type WebSocketMessage,
} from "./schemas";

class WebSocketService {
  private wss: WebSocketServer | null = null;

  /**
   * Start the WebSocket server
   */
  start(httpServer: Server) {
    const { path } = config.websocket;

    this.wss = new WSS({
      server: httpServer,
      path,
    });

    logger.info(
      `WebSocket server started on path ${path}`
    );

    this.wss.on("connection", (ws: WebSocket) => {
      logger.info(
        `WebSocket client connected. Total connections: ${this.wss?.clients.size}`
      );

      ws.on("message", async (data) => {
        try {
          const message = JSON.parse(data.toString());
          logger.info("Received WebSocket message:", message);

          // Validate the message against our schema
          const validatedMessage = WebSocketMessageSchema.parse(message);

          // Handle different message types
          await this.handleMessage(validatedMessage, ws);
        } catch (error) {
          logger.error("Failed to parse WebSocket message:", error);

          // Send error back to client
          ws.send(
            JSON.stringify({
              type: "error",
              payload: {
                message:
                  error instanceof Error ? error.message : "Invalid message",
              },
            })
          );
        }
      });

      ws.on("close", () => {
        logger.info(
          `WebSocket client disconnected. Remaining connections: ${this.wss?.clients.size}`
        );
      });

      ws.on("error", (error) => {
        logger.error("WebSocket error:", error);
      });
    });

    this.wss.on("error", (error) => {
      logger.error("WebSocket server error:", error);
    });
  }

  /**
   * Handle incoming websocket messages
   */
  private async handleMessage(
    message: WebSocketMessage,
    ws: WebSocket
  ): Promise<void> {
    switch (message.type) {
      case "mcp-installation-response":
        logger.info("Received MCP installation response:", message.payload);
        // The response from the frontend is just for logging/tracking
        // The actual installation happens via the regular HTTP API
        break;

      default:
        logger.warn("Unknown WebSocket message type:", message);
    }
  }

  /**
   * Broadcast a message to all connected clients
   */
  broadcast(message: WebSocketMessage) {
    if (!this.wss) {
      logger.warn("WebSocket server not initialized");
      return;
    }

    const messageStr = JSON.stringify(message);
    const clientCount = this.wss.clients.size;

    let sentCount = 0;
    this.wss.clients.forEach((client) => {
      if (client.readyState === WS.OPEN) {
        client.send(messageStr);
        sentCount++;
      }
    });

    if (sentCount < clientCount) {
      logger.info(
        `Only sent to ${sentCount}/${clientCount} clients (some were not ready)`
      );
    }

    logger.info(`Broadcasted message to ${sentCount} client(s)`, { type: message.type });
  }

  /**
   * Send a message to specific clients (filtered by a predicate)
   */
  sendToClients(
    message: WebSocketMessage,
    filter?: (client: WebSocket) => boolean
  ) {
    if (!this.wss) {
      logger.warn("WebSocket server not initialized");
      return;
    }

    const messageStr = JSON.stringify(message);
    let sentCount = 0;

    this.wss.clients.forEach((client) => {
      if (
        client.readyState === WS.OPEN &&
        (!filter || filter(client))
      ) {
        client.send(messageStr);
        sentCount++;
      }
    });

    logger.info(`Sent message to ${sentCount} client(s)`, { type: message.type });
  }

  /**
   * Stop the WebSocket server
   */
  stop() {
    if (this.wss) {
      this.wss.clients.forEach((client) => {
        client.close();
      });

      this.wss.close(() => {
        logger.info("WebSocket server closed");
      });
      this.wss = null;
    }
  }

  /**
   * Get the number of connected clients
   */
  getClientCount(): number {
    return this.wss?.clients.size ?? 0;
  }
}

export default new WebSocketService();
