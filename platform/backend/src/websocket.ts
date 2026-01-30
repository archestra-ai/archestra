import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { PassThrough } from "node:stream";
import {
  type ClientWebSocketMessage,
  ClientWebSocketMessageSchema,
  type ClientWebSocketMessageType,
  MCP_DEFAULT_LOG_LINES,
  type ServerWebSocketMessage,
} from "@shared";
import type { WebSocket, WebSocketServer } from "ws";
import { WebSocket as WS, WebSocketServer as WSS } from "ws";
import { betterAuth, hasPermission } from "@/auth";
import config from "@/config";
import logger from "@/logging";
import McpServerRuntimeManager from "@/mcp-server-runtime/manager";
import {
  ConversationModel,
  McpServerModel,
  MessageModel,
  UserModel,
} from "@/models";
import type { BrowserUserContext } from "@/services/browser-stream";
import { browserStreamFeature } from "@/services/browser-stream-feature";

const SCREENSHOT_INTERVAL_MS = 3000; // Stream at ~0.33 FPS (every 3 seconds)

interface BrowserStreamSubscription {
  conversationId: string;
  agentId: string;
  userContext: BrowserUserContext;
  intervalId: NodeJS.Timeout;
  isSending: boolean;
}

interface McpLogsSubscription {
  serverId: string;
  stream: PassThrough;
  abortController: AbortController;
}

interface WebSocketClientContext {
  userId: string;
  organizationId: string;
  userIsProfileAdmin: boolean;
  userIsMcpServerAdmin: boolean;
}

type MessageHandler = (
  ws: WebSocket,
  message: ClientWebSocketMessage,
  clientContext: WebSocketClientContext,
) => Promise<void> | void;

class WebSocketService {
  private wss: WebSocketServer | null = null;
  private browserSubscriptions: Map<WebSocket, BrowserStreamSubscription> =
    new Map();
  private mcpLogsSubscriptions: Map<WebSocket, McpLogsSubscription> = new Map();
  private clientContexts: Map<WebSocket, WebSocketClientContext> = new Map();

  private messageHandlers: Record<ClientWebSocketMessageType, MessageHandler> =
    {
      subscribe_browser_stream: (ws, message, clientContext) => {
        if (message.type !== "subscribe_browser_stream") return;
        return this.handleSubscribeBrowserStream(
          ws,
          message.payload.conversationId,
          clientContext,
        );
      },
      unsubscribe_browser_stream: (ws) => {
        this.unsubscribeBrowserStream(ws);
      },
      browser_navigate: (ws, message) => {
        if (message.type !== "browser_navigate") return;
        return this.handleBrowserNavigate(
          ws,
          message.payload.conversationId,
          message.payload.url,
        );
      },
      browser_navigate_back: (ws, message) => {
        if (message.type !== "browser_navigate_back") return;
        return this.handleBrowserNavigateBack(
          ws,
          message.payload.conversationId,
        );
      },
      browser_click: (ws, message) => {
        if (message.type !== "browser_click") return;
        return this.handleBrowserClick(
          ws,
          message.payload.conversationId,
          message.payload.element,
          message.payload.x,
          message.payload.y,
        );
      },
      browser_type: (ws, message) => {
        if (message.type !== "browser_type") return;
        return this.handleBrowserType(
          ws,
          message.payload.conversationId,
          message.payload.text,
          message.payload.element,
        );
      },
      browser_press_key: (ws, message) => {
        if (message.type !== "browser_press_key") return;
        return this.handleBrowserPressKey(
          ws,
          message.payload.conversationId,
          message.payload.key,
        );
      },
      browser_get_snapshot: (ws, message) => {
        if (message.type !== "browser_get_snapshot") return;
        return this.handleBrowserGetSnapshot(
          ws,
          message.payload.conversationId,
        );
      },
      browser_set_zoom: (ws, message) => {
        if (message.type !== "browser_set_zoom") return;
        // TODO: Implement setZoom when browserStreamFeature supports it
        this.sendToClient(ws, {
          type: "browser_set_zoom_result",
          payload: {
            conversationId: message.payload.conversationId,
            success: false,
            error: "Set zoom is not yet implemented",
          },
        });
      },
      subscribe_mcp_logs: (ws, message, clientContext) => {
        if (message.type !== "subscribe_mcp_logs") return;
        return this.handleSubscribeMcpLogs(
          ws,
          message.payload.serverId,
          message.payload.lines ?? MCP_DEFAULT_LOG_LINES,
          clientContext,
        );
      },
      unsubscribe_mcp_logs: (ws) => {
        this.unsubscribeMcpLogs(ws);
      },
    };

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
            const validatedMessage =
              ClientWebSocketMessageSchema.parse(message);
            await this.handleMessage(validatedMessage, ws);
          } catch (error) {
            logger.error({ error }, "Failed to parse WebSocket message");
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
          this.unsubscribeBrowserStream(ws);
          this.unsubscribeMcpLogs(ws);
          logger.info(
            `WebSocket client disconnected. Remaining connections: ${this.wss?.clients.size}`,
          );
          this.clientContexts.delete(ws);
        });

        ws.on("error", (error) => {
          logger.error({ error }, "WebSocket error");
          this.unsubscribeBrowserStream(ws);
          this.unsubscribeMcpLogs(ws);
          this.clientContexts.delete(ws);
        });
      },
    );

    this.wss.on("error", (error) => {
      logger.error({ error }, "WebSocket server error");
    });
  }

  private async handleMessage(
    message: ClientWebSocketMessage,
    ws: WebSocket,
  ): Promise<void> {
    const clientContext = this.getClientContext(ws);
    if (!clientContext) {
      return;
    }

    // Check if browser streaming feature is enabled for browser-related messages
    if (
      browserStreamFeature.isBrowserWebSocketMessage(message.type) &&
      !browserStreamFeature.isEnabled()
    ) {
      this.sendToClient(ws, {
        type: "browser_stream_error",
        payload: {
          conversationId:
            "conversationId" in message.payload
              ? String(message.payload.conversationId)
              : "",
          error: "Browser streaming feature is disabled",
        },
      });
      return;
    }

    const handler = this.messageHandlers[message.type];
    if (handler) {
      await handler(ws, message, clientContext);
    } else {
      logger.warn({ message }, "Unknown WebSocket message type");
    }
  }

  private async handleSubscribeBrowserStream(
    ws: WebSocket,
    conversationId: string,
    clientContext: WebSocketClientContext,
  ): Promise<void> {
    this.unsubscribeBrowserStream(ws);

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
      { conversationId, agentId },
      "Browser stream client subscribed",
    );

    const userContext: BrowserUserContext = {
      userId: clientContext.userId,
      userIsProfileAdmin: clientContext.userIsProfileAdmin,
    };

    const tabResult = await browserStreamFeature.selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
    );
    if (!tabResult.success) {
      logger.warn(
        { conversationId, agentId, error: tabResult.error },
        "Failed to select/create browser tab",
      );
    }

    const sendTick = async () => {
      const subscription = this.browserSubscriptions.get(ws);
      if (!subscription) return;
      if (subscription.isSending) return;

      subscription.isSending = true;
      try {
        await this.sendScreenshot(ws, agentId, conversationId, userContext);
      } finally {
        subscription.isSending = false;
      }
    };

    const intervalId = setInterval(() => {
      if (ws.readyState === WS.OPEN) {
        void sendTick();
      } else {
        this.unsubscribeBrowserStream(ws);
      }
    }, SCREENSHOT_INTERVAL_MS);

    this.browserSubscriptions.set(ws, {
      conversationId,
      agentId,
      userContext,
      intervalId,
      isSending: false,
    });

    void sendTick();
  }

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
      const result = await browserStreamFeature.navigate(
        subscription.agentId,
        conversationId,
        url,
        subscription.userContext,
      );

      if (result.success) {
        await this.addNavigationMessageToConversation(conversationId, url);
      }

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
      const result = await browserStreamFeature.navigateBack(
        subscription.agentId,
        conversationId,
        subscription.userContext,
      );

      if (result.success) {
        await this.addNavigationBackMessageToConversation(conversationId);
      }

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
      const result = await browserStreamFeature.click(
        subscription.agentId,
        conversationId,
        subscription.userContext,
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
      const result = await browserStreamFeature.type(
        subscription.agentId,
        conversationId,
        subscription.userContext,
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
      const result = await browserStreamFeature.pressKey(
        subscription.agentId,
        conversationId,
        subscription.userContext,
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
      const result = await browserStreamFeature.getSnapshot(
        subscription.agentId,
        conversationId,
        subscription.userContext,
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

  private async handleSubscribeMcpLogs(
    ws: WebSocket,
    serverId: string,
    lines: number,
    clientContext: WebSocketClientContext,
  ): Promise<void> {
    // Unsubscribe from any existing MCP logs stream first
    this.unsubscribeMcpLogs(ws);

    // Verify the user has access to this MCP server
    // Note: findById checks access control based on userId and admin status
    const mcpServer = await McpServerModel.findById(
      serverId,
      clientContext.userId,
      clientContext.userIsMcpServerAdmin,
    );

    if (!mcpServer) {
      logger.warn(
        { serverId, organizationId: clientContext.organizationId },
        "MCP server not found or unauthorized for logs streaming",
      );
      this.sendToClient(ws, {
        type: "mcp_logs_error",
        payload: {
          serverId,
          error: "MCP server not found",
        },
      });
      return;
    }

    logger.info({ serverId, lines }, "MCP logs client subscribed");

    const abortController = new AbortController();
    const stream = new PassThrough();

    // Store subscription
    this.mcpLogsSubscriptions.set(ws, {
      serverId,
      stream,
      abortController,
    });

    // Get the appropriate kubectl command based on pod status
    const command = await McpServerRuntimeManager.getAppropriateCommand(
      serverId,
      lines,
    );
    // Send an initial message to confirm subscription and provide the command
    this.sendToClient(ws, {
      type: "mcp_logs",
      payload: {
        serverId,
        logs: "",
        command,
      },
    });

    // Set up stream data handler
    stream.on("data", (chunk: Buffer) => {
      if (ws.readyState === WS.OPEN) {
        this.sendToClient(ws, {
          type: "mcp_logs",
          payload: {
            serverId,
            logs: chunk.toString(),
          },
        });
      }
    });

    stream.on("error", (error) => {
      logger.error({ error, serverId }, "MCP logs stream error");
      if (ws.readyState === WS.OPEN) {
        this.sendToClient(ws, {
          type: "mcp_logs_error",
          payload: {
            serverId,
            error: error.message,
          },
        });
      }
      this.unsubscribeMcpLogs(ws);
    });

    stream.on("end", () => {
      logger.info({ serverId }, "MCP logs stream ended");
      this.unsubscribeMcpLogs(ws);
    });

    try {
      // Start streaming logs
      await McpServerRuntimeManager.streamMcpServerLogs(
        serverId,
        stream,
        lines,
        abortController.signal,
      );
    } catch (error) {
      logger.error({ error, serverId }, "Failed to start MCP logs stream");
      this.sendToClient(ws, {
        type: "mcp_logs_error",
        payload: {
          serverId,
          error:
            error instanceof Error ? error.message : "Failed to stream logs",
        },
      });
      this.unsubscribeMcpLogs(ws);
    }
  }

  private unsubscribeMcpLogs(ws: WebSocket): void {
    const subscription = this.mcpLogsSubscriptions.get(ws);
    if (subscription) {
      subscription.abortController.abort();
      subscription.stream.destroy();
      this.mcpLogsSubscriptions.delete(ws);
      logger.info(
        { serverId: subscription.serverId },
        "MCP logs client unsubscribed",
      );
    }
  }

  private async sendScreenshot(
    ws: WebSocket,
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
  ): Promise<void> {
    if (ws.readyState !== WS.OPEN) {
      return;
    }

    try {
      const result = await browserStreamFeature.takeScreenshot(
        agentId,
        conversationId,
        userContext,
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
      } else {
        this.sendToClient(ws, {
          type: "browser_stream_error",
          payload: {
            conversationId,
            error: result.error ?? "No screenshot returned from browser tool",
          },
        });
      }
    } catch (error) {
      logger.error(
        { error, conversationId },
        "Error taking screenshot for stream",
      );
      this.sendToClient(ws, {
        type: "browser_stream_error",
        payload: {
          conversationId,
          error:
            error instanceof Error
              ? error.message
              : "Screenshot capture failed",
        },
      });
    }
  }

  private sendToClient(ws: WebSocket, message: ServerWebSocketMessage): void {
    if (ws.readyState === WS.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

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

  stop() {
    // Clear all subscriptions
    for (const [ws, subscription] of this.browserSubscriptions) {
      clearInterval(subscription.intervalId);
      this.browserSubscriptions.delete(ws);
    }
    for (const [ws] of this.mcpLogsSubscriptions) {
      this.unsubscribeMcpLogs(ws);
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

  getClientCount(): number {
    return this.wss?.clients.size ?? 0;
  }

  private async authenticateConnection(
    request: IncomingMessage,
  ): Promise<WebSocketClientContext | null> {
    const [{ success: userIsProfileAdmin }, { success: userIsMcpServerAdmin }] =
      await Promise.all([
        hasPermission({ profile: ["admin"] }, request.headers),
        hasPermission({ mcpServer: ["admin"] }, request.headers),
      ]);
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
        return {
          userId: user.id,
          organizationId,
          userIsProfileAdmin,
          userIsMcpServerAdmin,
        };
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
          return {
            userId: user.id,
            organizationId,
            userIsProfileAdmin,
            userIsMcpServerAdmin,
          };
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

  private async addNavigationMessageToConversation(
    conversationId: string,
    url: string,
  ): Promise<void> {
    try {
      const navigationMessage = {
        id: randomUUID(),
        role: "user",
        parts: [
          {
            type: "text",
            text: `[User manually navigated browser to: ${url}]`,
          },
        ],
      };

      await MessageModel.create({
        conversationId,
        role: "user",
        content: navigationMessage,
      });

      logger.info(
        { conversationId, url },
        "Added navigation context message to conversation",
      );
    } catch (error) {
      logger.error(
        { error, conversationId, url },
        "Failed to add navigation message to conversation",
      );
    }
  }

  private async addNavigationBackMessageToConversation(
    conversationId: string,
  ): Promise<void> {
    try {
      const navigationMessage = {
        id: randomUUID(),
        role: "user",
        parts: [
          {
            type: "text",
            text: "[User navigated browser back to previous page]",
          },
        ],
      };

      await MessageModel.create({
        conversationId,
        role: "user",
        content: navigationMessage,
      });

      logger.info(
        { conversationId },
        "Added navigation back context message to conversation",
      );
    } catch (error) {
      logger.error(
        { error, conversationId },
        "Failed to add navigation back message to conversation",
      );
    }
  }
}

export default new WebSocketService();
