import type { IncomingMessage, Server } from "node:http";
import type { WebSocket, WebSocketServer } from "ws";
import { WebSocket as WS, WebSocketServer as WSS } from "ws";
import { betterAuth } from "@/auth";
import config from "@/config";
import logger from "@/logging";
import { ConversationModel, UserModel } from "@/models";
import { BrowserStreamService } from "@/services/browser-stream";
import {
  type ServerWebSocketMessage,
  type WebSocketMessage,
  WebSocketMessageSchema,
} from "@/types";

const SCREENSHOT_INTERVAL_MS = 1000; // Stream at ~1 FPS

interface BrowserStreamSubscription {
  conversationId: string;
  agentId: string;
  tabIndex: number;
  intervalId: NodeJS.Timeout;
}

interface WebSocketClientContext {
  userId: string;
  organizationId: string;
}

class WebSocketService {
  private wss: WebSocketServer | null = null;
  private browserService = new BrowserStreamService();
  // Track browser stream subscriptions per client
  private browserSubscriptions: Map<WebSocket, BrowserStreamSubscription> =
    new Map();
  private clientContexts: Map<WebSocket, WebSocketClientContext> = new Map();

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

    this.wss.on(
      "connection",
      async (ws: WebSocket, request: IncomingMessage) => {
        const clientContext = await this.authenticateConnection(request);

        if (!clientContext) {
          logger.warn(
            {
              clientAddress:
                request.socket.remoteAddress ?? "unknown_websocket_client",
            },
            "Unauthorized WebSocket connection attempt",
          );
          this.sendUnauthorized(ws);
          return;
        }

        this.clientContexts.set(ws, clientContext);

        logger.info(
          {
            connections: this.wss?.clients.size,
            userId: clientContext.userId,
            organizationId: clientContext.organizationId,
          },
          "WebSocket client connected",
        );

        ws.on("message", async (data) => {
          try {
            const message = JSON.parse(data.toString());

            // Validate the message against our schema
            const validatedMessage = WebSocketMessageSchema.parse(message);

            // Handle different message types
            await this.handleMessage(validatedMessage, ws);
          } catch (error) {
            logger.error({ error }, "Failed to parse WebSocket message");

            // Send error back to client
            this.sendToClient(ws, {
              type: "error",
              payload: {
                message:
                  error instanceof Error ? error.message : "Invalid message",
              },
            });
          }
        });

        ws.on("close", () => {
          // Clean up browser stream subscription
          this.unsubscribeBrowserStream(ws);

          logger.info(
            `WebSocket client disconnected. Remaining connections: ${this.wss?.clients.size}`,
          );
          this.clientContexts.delete(ws);
        });

        ws.on("error", (error) => {
          logger.error({ error }, "WebSocket error");
          // Clean up browser stream subscription on error
          this.unsubscribeBrowserStream(ws);
          this.clientContexts.delete(ws);
        });
      },
    );

    this.wss.on("error", (error) => {
      logger.error({ error }, "WebSocket server error");
    });
  }

  /**
   * Handle incoming websocket messages
   */
  private async handleMessage(
    message: WebSocketMessage,
    ws: WebSocket,
  ): Promise<void> {
    const clientContext = this.getClientContext(ws);
    if (!clientContext) {
      return;
    }

    switch (message.type) {
      case "hello-world":
        logger.info("Received hello-world message");
        break;

      case "subscribe_browser_stream":
        await this.handleSubscribeBrowserStream(
          ws,
          message.payload.conversationId,
          message.payload.tabIndex,
          clientContext,
        );
        break;

      case "unsubscribe_browser_stream":
        this.unsubscribeBrowserStream(ws);
        break;

      case "browser_navigate":
        await this.handleBrowserNavigate(
          ws,
          message.payload.conversationId,
          message.payload.url,
        );
        break;

      case "browser_navigate_back":
        await this.handleBrowserNavigateBack(
          ws,
          message.payload.conversationId,
        );
        break;

      case "browser_click":
        await this.handleBrowserClick(
          ws,
          message.payload.conversationId,
          message.payload.element,
          message.payload.x,
          message.payload.y,
        );
        break;

      case "browser_type":
        await this.handleBrowserType(
          ws,
          message.payload.conversationId,
          message.payload.text,
          message.payload.element,
        );
        break;

      case "browser_press_key":
        await this.handleBrowserPressKey(
          ws,
          message.payload.conversationId,
          message.payload.key,
        );
        break;

      case "browser_get_snapshot":
        await this.handleBrowserGetSnapshot(ws, message.payload.conversationId);
        break;

      default:
        logger.warn({ message }, "Unknown WebSocket message type");
    }
  }

  /**
   * Subscribe client to browser stream for a conversation
   */
  private async handleSubscribeBrowserStream(
    ws: WebSocket,
    conversationId: string,
    tabIndex: number,
    clientContext: WebSocketClientContext,
  ): Promise<void> {
    // Unsubscribe from any existing stream first
    this.unsubscribeBrowserStream(ws);

    // Get agentId from conversation with user/org scoping
    const agentId = await ConversationModel.getAgentIdForUser(
      conversationId,
      clientContext.userId,
      clientContext.organizationId,
    );
    if (!agentId) {
      logger.warn(
        {
          conversationId,
          userId: clientContext.userId,
          organizationId: clientContext.organizationId,
        },
        "Unauthorized or missing conversation for browser stream",
      );
      this.sendToClient(ws, {
        type: "browser_stream_error",
        payload: {
          conversationId,
          error: "Conversation not found",
        },
      });
      return;
    }

    logger.info(
      { conversationId, agentId, tabIndex },
      "Browser stream client subscribed",
    );

    // Select or create the tab for this chat index
    const tabResult = await this.browserService.selectOrCreateTab(
      agentId,
      tabIndex,
    );
    if (!tabResult.success) {
      logger.warn(
        { conversationId, agentId, tabIndex, error: tabResult.error },
        "Failed to select/create browser tab",
      );
      // Continue anyway - screenshot will work on current tab
    }

    // Send initial screenshot
    this.sendScreenshot(ws, agentId, conversationId);

    // Set up interval for continuous streaming
    const intervalId = setInterval(() => {
      if (ws.readyState === WS.OPEN) {
        this.sendScreenshot(ws, agentId, conversationId);
      } else {
        this.unsubscribeBrowserStream(ws);
      }
    }, SCREENSHOT_INTERVAL_MS);

    // Store subscription
    this.browserSubscriptions.set(ws, {
      conversationId,
      agentId,
      tabIndex,
      intervalId,
    });
  }

  /**
   * Unsubscribe client from browser stream
   */
  private unsubscribeBrowserStream(ws: WebSocket): void {
    const subscription = this.browserSubscriptions.get(ws);
    if (subscription) {
      clearInterval(subscription.intervalId);
      this.browserSubscriptions.delete(ws);
      logger.info(
        { conversationId: subscription.conversationId },
        "Browser stream client unsubscribed",
      );
    }
  }

  /**
   * Handle browser navigation request
   */
  private async handleBrowserNavigate(
    ws: WebSocket,
    conversationId: string,
    url: string,
  ): Promise<void> {
    const subscription = this.browserSubscriptions.get(ws);
    if (!subscription || subscription.conversationId !== conversationId) {
      this.sendToClient(ws, {
        type: "browser_navigate_result",
        payload: {
          conversationId,
          success: false,
          error: "Not subscribed to this conversation's browser stream",
        },
      });
      return;
    }

    try {
      const result = await this.browserService.navigate(
        subscription.agentId,
        conversationId,
        url,
      );
      this.sendToClient(ws, {
        type: "browser_navigate_result",
        payload: {
          conversationId,
          success: result.success,
          url: result.url,
          error: result.error,
        },
      });
    } catch (error) {
      logger.error({ error, conversationId, url }, "Browser navigation failed");
      this.sendToClient(ws, {
        type: "browser_navigate_result",
        payload: {
          conversationId,
          success: false,
          error: error instanceof Error ? error.message : "Navigation failed",
        },
      });
    }
  }

  /**
   * Handle browser navigate back request
   */
  private async handleBrowserNavigateBack(
    ws: WebSocket,
    conversationId: string,
  ): Promise<void> {
    const subscription = this.browserSubscriptions.get(ws);
    if (!subscription || subscription.conversationId !== conversationId) {
      this.sendToClient(ws, {
        type: "browser_navigate_back_result",
        payload: {
          conversationId,
          success: false,
          error: "Not subscribed to this conversation's browser stream",
        },
      });
      return;
    }

    try {
      const result = await this.browserService.navigateBack(
        subscription.agentId,
        conversationId,
      );
      this.sendToClient(ws, {
        type: "browser_navigate_back_result",
        payload: {
          conversationId,
          success: result.success,
          error: result.error,
        },
      });
    } catch (error) {
      logger.error({ error, conversationId }, "Browser navigate back failed");
      this.sendToClient(ws, {
        type: "browser_navigate_back_result",
        payload: {
          conversationId,
          success: false,
          error:
            error instanceof Error ? error.message : "Navigate back failed",
        },
      });
    }
  }

  /**
   * Handle browser click request
   */
  private async handleBrowserClick(
    ws: WebSocket,
    conversationId: string,
    element?: string,
    x?: number,
    y?: number,
  ): Promise<void> {
    const subscription = this.browserSubscriptions.get(ws);
    if (!subscription || subscription.conversationId !== conversationId) {
      this.sendToClient(ws, {
        type: "browser_click_result",
        payload: {
          conversationId,
          success: false,
          error: "Not subscribed to this conversation's browser stream",
        },
      });
      return;
    }

    try {
      const result = await this.browserService.click(
        subscription.agentId,
        conversationId,
        element,
        x,
        y,
      );
      this.sendToClient(ws, {
        type: "browser_click_result",
        payload: {
          conversationId,
          success: result.success,
          error: result.error,
        },
      });
    } catch (error) {
      logger.error(
        { error, conversationId, element, x, y },
        "Browser click failed",
      );
      this.sendToClient(ws, {
        type: "browser_click_result",
        payload: {
          conversationId,
          success: false,
          error: error instanceof Error ? error.message : "Click failed",
        },
      });
    }
  }

  /**
   * Handle browser type request
   */
  private async handleBrowserType(
    ws: WebSocket,
    conversationId: string,
    text: string,
    element?: string,
  ): Promise<void> {
    const subscription = this.browserSubscriptions.get(ws);
    if (!subscription || subscription.conversationId !== conversationId) {
      this.sendToClient(ws, {
        type: "browser_type_result",
        payload: {
          conversationId,
          success: false,
          error: "Not subscribed to this conversation's browser stream",
        },
      });
      return;
    }

    try {
      const result = await this.browserService.type(
        subscription.agentId,
        conversationId,
        text,
        element,
      );
      this.sendToClient(ws, {
        type: "browser_type_result",
        payload: {
          conversationId,
          success: result.success,
          error: result.error,
        },
      });
    } catch (error) {
      logger.error({ error, conversationId }, "Browser type failed");
      this.sendToClient(ws, {
        type: "browser_type_result",
        payload: {
          conversationId,
          success: false,
          error: error instanceof Error ? error.message : "Type failed",
        },
      });
    }
  }

  /**
   * Handle browser press key request
   */
  private async handleBrowserPressKey(
    ws: WebSocket,
    conversationId: string,
    key: string,
  ): Promise<void> {
    const subscription = this.browserSubscriptions.get(ws);
    if (!subscription || subscription.conversationId !== conversationId) {
      this.sendToClient(ws, {
        type: "browser_press_key_result",
        payload: {
          conversationId,
          success: false,
          error: "Not subscribed to this conversation's browser stream",
        },
      });
      return;
    }

    try {
      const result = await this.browserService.pressKey(
        subscription.agentId,
        conversationId,
        key,
      );
      this.sendToClient(ws, {
        type: "browser_press_key_result",
        payload: {
          conversationId,
          success: result.success,
          error: result.error,
        },
      });
    } catch (error) {
      logger.error({ error, conversationId, key }, "Browser press key failed");
      this.sendToClient(ws, {
        type: "browser_press_key_result",
        payload: {
          conversationId,
          success: false,
          error: error instanceof Error ? error.message : "Press key failed",
        },
      });
    }
  }

  /**
   * Handle browser get snapshot request
   */
  private async handleBrowserGetSnapshot(
    ws: WebSocket,
    conversationId: string,
  ): Promise<void> {
    const subscription = this.browserSubscriptions.get(ws);
    if (!subscription || subscription.conversationId !== conversationId) {
      this.sendToClient(ws, {
        type: "browser_snapshot",
        payload: {
          conversationId,
          error: "Not subscribed to this conversation's browser stream",
        },
      });
      return;
    }

    try {
      const result = await this.browserService.getSnapshot(
        subscription.agentId,
        conversationId,
      );
      this.sendToClient(ws, {
        type: "browser_snapshot",
        payload: {
          conversationId,
          snapshot: result.snapshot,
          error: result.error,
        },
      });
    } catch (error) {
      logger.error({ error, conversationId }, "Browser get snapshot failed");
      this.sendToClient(ws, {
        type: "browser_snapshot",
        payload: {
          conversationId,
          error: error instanceof Error ? error.message : "Snapshot failed",
        },
      });
    }
  }

  /**
   * Take and send a screenshot to a client
   */
  private async sendScreenshot(
    ws: WebSocket,
    agentId: string,
    conversationId: string,
  ): Promise<void> {
    if (ws.readyState !== WS.OPEN) {
      return;
    }

    try {
      const result = await this.browserService.takeScreenshot(
        agentId,
        conversationId,
      );

      if (result.screenshot) {
        this.sendToClient(ws, {
          type: "browser_screenshot",
          payload: {
            conversationId,
            screenshot: result.screenshot,
            url: result.url,
          },
        });
      } else if (result.error) {
        this.sendToClient(ws, {
          type: "browser_stream_error",
          payload: {
            conversationId,
            error: result.error,
          },
        });
      }
    } catch (error) {
      logger.error(
        { error, conversationId },
        "Error taking screenshot for stream",
      );
    }
  }

  /**
   * Send a message to a specific client
   */
  private sendToClient(ws: WebSocket, message: ServerWebSocketMessage): void {
    if (ws.readyState === WS.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Broadcast a message to all connected clients
   */
  broadcast(message: ServerWebSocketMessage) {
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
    message: ServerWebSocketMessage,
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
    // Clear all browser stream subscriptions
    for (const [ws, subscription] of this.browserSubscriptions) {
      clearInterval(subscription.intervalId);
      this.browserSubscriptions.delete(ws);
    }
    this.clientContexts.clear();

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

  /**
   * Authenticate websocket connections using the same auth mechanisms as HTTP routes.
   */
  private async authenticateConnection(
    request: IncomingMessage,
  ): Promise<WebSocketClientContext | null> {
    const headers = new Headers(request.headers as HeadersInit);

    try {
      const session = await betterAuth.api.getSession({
        headers,
        query: { disableCookieCache: true },
      });

      if (session?.user?.id) {
        const { organizationId, ...user } = await UserModel.getById(
          session.user.id,
        );
        return { userId: user.id, organizationId };
      }
    } catch (_sessionError) {
      // Fall through to API key verification
    }

    const authHeader = headers.get("authorization");
    if (authHeader) {
      try {
        const apiKeyResult = await betterAuth.api.verifyApiKey({
          body: { key: authHeader },
        });

        if (apiKeyResult?.valid && apiKeyResult.key?.userId) {
          const { organizationId, ...user } = await UserModel.getById(
            apiKeyResult.key.userId,
          );
          return { userId: user.id, organizationId };
        }
      } catch (_apiKeyError) {
        return null;
      }
    }

    return null;
  }

  private getClientContext(ws: WebSocket): WebSocketClientContext | null {
    const context = this.clientContexts.get(ws);
    if (!context) {
      this.sendUnauthorized(ws);
      return null;
    }

    return context;
  }

  private sendUnauthorized(ws: WebSocket): void {
    this.sendToClient(ws, {
      type: "error",
      payload: { message: "Unauthorized" },
    });
    ws.close(4401, "Unauthorized");
  }
}

export default new WebSocketService();
