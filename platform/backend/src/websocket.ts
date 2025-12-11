import type { Server } from "node:http";
import type { WebSocket, WebSocketServer } from "ws";
import { WebSocket as WS, WebSocketServer as WSS } from "ws";
import config from "@/config";
import logger from "@/logging";
import { type WebSocketMessage, WebSocketMessageSchema } from "@/types";

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

    logger.info(`WebSocket server started on path ${path}`);

    this.wss.on("connection", (ws: WebSocket) => {
      logger.info(
        `WebSocket client connected. Total connections: ${this.wss?.clients.size}`,
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
          logger.error({ error }, "Failed to parse WebSocket message");

          // Send error back to client
          ws.send(
            JSON.stringify({
              type: "error",
              payload: {
                message:
                  error instanceof Error ? error.message : "Invalid message",
              },
            }),
          );
        }
      });

      ws.on("close", () => {
        logger.info(
          `WebSocket client disconnected. Remaining connections: ${this.wss?.clients.size}`,
        );
      });

      ws.on("error", (error) => {
        logger.error({ error }, "WebSocket error");
      });
    });

    this.wss.on("error", (error) => {
      logger.error({ error }, "WebSocket server error");
    });
  }

  /**
   * Handle incoming websocket messages
   */
  private async handleMessage(
    message: WebSocketMessage,
    _ws: WebSocket,
  ): Promise<void> {
    switch (message.type) {
      default:
        logger.warn({ message }, "Unknown WebSocket message type");
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
        `Only sent to ${sentCount}/${clientCount} clients (some were not ready)`,
      );
    }

    logger.info(
      { message, sentCount },
      `Broadcasted message to ${sentCount} client(s)`,
    );
  }

  /**
   * Send a message to specific clients (filtered by a predicate)
   */
  sendToClients(
    message: WebSocketMessage,
    filter?: (client: WebSocket) => boolean,
  ) {
    if (!this.wss) {
      logger.warn("WebSocket server not initialized");
      return;
    }

    const messageStr = JSON.stringify(message);
    let sentCount = 0;

    this.wss.clients.forEach((client) => {
      if (client.readyState === WS.OPEN && (!filter || filter(client))) {
        client.send(messageStr);
        sentCount++;
      }
    });

    logger.info(
      { message, sentCount },
      `Sent message to ${sentCount} client(s)`,
    );
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
