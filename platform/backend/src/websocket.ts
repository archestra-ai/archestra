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
import { BrowserStreamSocketClientContext } from "@/features/browser-stream/websocket/browser-stream.websocket";
import logger from "@/logging";
import McpServerRuntimeManager from "@/mcp-server-runtime/manager";
import { McpServerModel, UserModel } from "@/models";

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
  private mcpLogsSubscriptions: Map<WebSocket, McpLogsSubscription> = new Map();
  private clientContexts: Map<WebSocket, WebSocketClientContext> = new Map();
  private browserStreamContext: BrowserStreamSocketClientContext | null = null;

  /**
   * Proxy object for browser subscriptions - exposes Map-like interface for testing.
   * Delegates to browserStreamContext when enabled, otherwise uses empty Map behavior.
   */
  get browserSubscriptions() {
    const context = this.browserStreamContext;
    return {
      clear: () => context?.clearSubscriptions(),
      has: (ws: WebSocket) => context?.hasSubscription(ws) ?? false,
      get: (ws: WebSocket) => context?.getSubscription(ws),
    };
  }

  /**
   * Initialize browser stream context for testing without starting the full WebSocket server.
   * Only call this in test environments.
   */
  initBrowserStreamContextForTesting(): void {
    if (BrowserStreamSocketClientContext.isBrowserStreamEnabled()) {
      this.browserStreamContext = new BrowserStreamSocketClientContext({
        wss: null,
        sendToClient: (ws, message) => this.sendToClient(ws, message),
      });
    }
  }

  // Browser messages are handled by browserStreamContext - see handleMessage()
  private messageHandlers: Partial<
    Record<ClientWebSocketMessageType, MessageHandler>
  > = {
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
    if (BrowserStreamSocketClientContext.isBrowserStreamEnabled()) {
      this.browserStreamContext = new BrowserStreamSocketClientContext({
        wss: this.wss,
        sendToClient: (ws, message) => this.sendToClient(ws, message),
      });
    } else {
      this.browserStreamContext?.stop();
      this.browserStreamContext = null;
    }

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
          this.unsubscribeMcpLogs(ws);
          logger.info(
            `WebSocket client disconnected. Remaining connections: ${this.wss?.clients.size}`,
          );
          this.clientContexts.delete(ws);
        });

        ws.on("error", (error) => {
          logger.error({ error }, "WebSocket error");
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

    // Delegate browser messages to browserStreamContext
    if (
      BrowserStreamSocketClientContext.isBrowserWebSocketMessage(message.type)
    ) {
      if (this.browserStreamContext) {
        await this.browserStreamContext.handleMessage(
          message,
          ws,
          clientContext,
        );
      } else {
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
      }
      return;
    }

    const handler = this.messageHandlers[message.type];
    if (handler) {
      await handler(ws, message, clientContext);
    } else {
      logger.warn({ message }, "Unknown WebSocket message type");
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
}

export default new WebSocketService();
