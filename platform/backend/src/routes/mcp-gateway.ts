import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { clearChatMcpClient } from "@/clients/chat-mcp-client";
import type { TokenAuthContext } from "@/clients/mcp-client";
import config from "@/config";
import { McpToolCallModel } from "@/models";
import { UuidIdSchema } from "@/types";
import {
  activeSessions,
  cleanupExpiredSessions,
  createAgentServer,
  createTransport,
  extractProfileIdAndTokenFromRequest,
  validateProfileToken,
} from "./mcp-gateway.utils";

// =============================================================================
// LEGACY: MCP Gateway endpoints with UUID token authentication where profileID and token are the same from Authorization header
// /v1/mcp
// Authorization header: Bearer <profile_id_and_token_combined_as_uuid>
// =============================================================================
export const legacyMcpGatewayRoutes: FastifyPluginAsyncZod = async (
  fastify,
) => {
  const { endpoint } = config.mcpGateway;

  // GET endpoint for server discovery
  fastify.get(
    endpoint,
    {
      schema: {
        tags: ["mcp-gateway"],
        response: {
          200: z.object({
            name: z.string(),
            version: z.string(),
            agentId: z.string(),
            transport: z.string(),
            capabilities: z.object({
              tools: z.boolean(),
            }),
          }),
          401: z.object({
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { profileId: agentId, token } =
        extractProfileIdAndTokenFromRequest(request) ?? {};

      if (!agentId || !token) {
        reply.status(401);
        return {
          error: "Unauthorized",
          message:
            "Missing or invalid Authorization header. Expected: Bearer <agent-id>",
        };
      }

      reply.type("application/json");
      return {
        name: `archestra-agent-${agentId}`,
        version: config.api.version,
        agentId,
        transport: "http",
        capabilities: {
          tools: true,
        },
      };
    },
  );

  // POST endpoint for JSON-RPC requests (handled by MCP SDK)
  fastify.post(
    endpoint,
    {
      schema: {
        tags: ["mcp-gateway"],
        // Accept any JSON body - will be validated by MCP SDK
        body: z.record(z.string(), z.unknown()),
      },
    },
    async (request, reply) => {
      const { profileId: agentId, token } =
        extractProfileIdAndTokenFromRequest(request) ?? {};

      if (!agentId || !token) {
        reply.status(401);
        return {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              "Unauthorized: Missing or invalid Authorization header. Expected: Bearer <agent-id>",
          },
          id: null,
        };
      }
      const sessionId = request.headers["mcp-session-id"] as string | undefined;
      const isInitialize =
        typeof request.body?.method === "string" &&
        request.body.method === "initialize";

      fastify.log.info(
        {
          agentId,
          sessionId,
          method: request.body?.method,
          isInitialize,
          bodyKeys: Object.keys(request.body || {}),
          bodySize: JSON.stringify(request.body || {}).length,
          allHeaders: request.headers,
        },
        "MCP gateway POST request received",
      );

      try {
        let server: Server | undefined;
        let transport: StreamableHTTPServerTransport | undefined;

        /**
         * Check if we have an existing session
         *
         * we trust the session if it exists - stale sessions are cleaned up by:
         * 1. transport.onclose handler when the client disconnects
         * 2. SESSION_TIMEOUT_MS periodic cleanup (30 min)
         */
        if (sessionId && activeSessions.has(sessionId)) {
          const sessionData = activeSessions.get(sessionId);
          if (!sessionData) {
            throw new Error("Session data not found");
          }

          fastify.log.info(
            {
              agentId,
              sessionId,
            },
            "Reusing existing session",
          );

          transport = sessionData.transport;
          server = sessionData.server;
          // Update last access time
          sessionData.lastAccess = Date.now();

          /**
           * If this is a re-initialize request on an existing session,
           * we can just reuse the existing server/transport
           */
          if (isInitialize) {
            fastify.log.info(
              { agentId, sessionId },
              "Re-initialize on existing session - will reuse existing server",
            );
          }
        } else if (isInitialize) {
          /**
           * Initialize request - create new session
           *
           * Generate session ID upfront if not provided by client
           * This prevents race condition where notifications/initialized arrives
           * before session is stored
           */
          const effectiveSessionId =
            sessionId || `session-${Date.now()}-${randomUUID()}`;

          fastify.log.info(
            {
              agentId,
              sessionId: effectiveSessionId,
              clientProvided: !!sessionId,
              sessionExists: activeSessions.has(effectiveSessionId),
              activeSessions: Array.from(activeSessions.keys()),
            },
            "Initialize request - creating NEW session",
          );
          const { server: newServer, agent } = await createAgentServer(
            agentId,
            fastify.log,
            undefined, // No cached agent
            undefined, // No token auth for legacy endpoint
          );
          server = newServer;
          transport = createTransport(agentId, effectiveSessionId, fastify.log);

          /**
           * Set up transport close handler to clean up session immediately
           *
           * This ensures stale sessions are removed when the client disconnects
           * Capture transport reference to prevent race condition where old transport's
           * onclose handler deletes a newly created session with the same ID
           */
          const thisTransport = transport;
          transport.onclose = () => {
            fastify.log.info(
              { agentId, sessionId: effectiveSessionId },
              "Transport closed - checking if session should be cleaned up",
            );
            /**
             * Only delete if this session still has the same transport
             *
             * This prevents race condition where old transport's onclose fires after
             * a new session was created with the same sessionId
             */
            const currentSession = activeSessions.get(effectiveSessionId);
            if (currentSession && currentSession.transport === thisTransport) {
              activeSessions.delete(effectiveSessionId);
              fastify.log.info(
                {
                  agentId,
                  sessionId: effectiveSessionId,
                  remainingSessions: activeSessions.size,
                },
                "Session cleaned up after transport close",
              );
            } else {
              fastify.log.info(
                {
                  agentId,
                  sessionId: effectiveSessionId,
                  sessionExists: !!currentSession,
                  transportMatches: currentSession?.transport === thisTransport,
                },
                "Transport close ignored - session already replaced or removed",
              );
            }
          };

          // Connect server to transport (this also starts the transport)
          fastify.log.info({ agentId }, "Connecting server to transport");
          await server.connect(transport);
          fastify.log.info({ agentId }, "Server connected to transport");

          /**
           * Store session immediately before handleRequest
           *
           * This ensures the session exists when notifications/initialized arrives
           * to prevent race condition where notifications/initialized arrives
           * before session is stored
           */
          activeSessions.set(effectiveSessionId, {
            server,
            transport,
            lastAccess: Date.now(),
            agentId,
            agent, // Cache the agent data
          });
          fastify.log.info(
            {
              agentId,
              sessionId: effectiveSessionId,
              clientProvided: !!sessionId,
            },
            "Session stored before handleRequest",
          );
        } else if (!server || !transport) {
          // Non-initialize request without a valid session (server/transport not assigned)
          fastify.log.error(
            { agentId, sessionId, method: request.body?.method },
            "Request received without valid session",
          );
          reply.status(400);
          return {
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: Invalid or expired session",
            },
            id: null,
          };
        }

        /**
         * Let the MCP SDK handle the request/response
         *
         * Cast Fastify request/reply to Node.js types expected by SDK
         */
        fastify.log.info(
          { agentId, sessionId },
          "Calling transport.handleRequest",
        );

        // We need to hijack Fastify's reply to let the SDK handle the raw response
        reply.hijack();

        await transport.handleRequest(
          request.raw as IncomingMessage,
          reply.raw as ServerResponse,
          request.body,
        );
        fastify.log.info(
          { agentId, sessionId },
          "Transport.handleRequest completed",
        );

        // Log initialize request after successful handling
        if (isInitialize) {
          try {
            await McpToolCallModel.create({
              agentId,
              mcpServerName: "mcp-gateway",
              method: "initialize",
              toolCall: null,
              toolResult: {
                capabilities: {
                  tools: { listChanged: false },
                },
                serverInfo: {
                  name: `archestra-agent-${agentId}`,
                  version: config.api.version,
                },
                // biome-ignore lint/suspicious/noExplicitAny: toolResult structure varies by method type
              } as any,
            });
            fastify.log.info(
              { agentId, sessionId },
              "✅ Saved initialize request",
            );
          } catch (dbError) {
            fastify.log.error(
              { err: dbError },
              "Failed to persist initialize request:",
            );
          }
        }

        // Session was already stored before handleRequest to prevent race condition
        // No need to store again here

        fastify.log.info(
          { agentId, sessionId },
          "Request handled successfully",
        );
      } catch (error) {
        fastify.log.error(
          {
            error,
            errorMessage: error instanceof Error ? error.message : "Unknown",
            errorStack: error instanceof Error ? error.stack : undefined,
            agentId,
          },
          "Error handling MCP request",
        );

        // Only send error response if headers not already sent
        if (!reply.sent) {
          reply.status(500);
          return {
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal server error",
              data: error instanceof Error ? error.message : "Unknown error",
            },
            id: null,
          };
        }
      }
    },
  );

  // DELETE endpoint to clear sessions for an agent
  fastify.delete(
    `${endpoint}/sessions`,
    {
      schema: {
        tags: ["mcp-gateway"],
        response: {
          200: z.object({
            message: z.string(),
            clearedCount: z.number(),
          }),
          401: z.object({
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { profileId } = extractProfileIdAndTokenFromRequest(request) ?? {};

      fastify.log.info(
        {
          profileId,
          totalActiveSessions: activeSessions.size,
        },
        "DELETE /v1/mcp/sessions - Request received",
      );

      if (!profileId) {
        fastify.log.warn("DELETE /v1/mcp/sessions - Unauthorized request");
        reply.status(401);
        return {
          error: "Unauthorized",
          message:
            "Missing or invalid Authorization header. Expected: Bearer <agent-id>",
        };
      }

      const sessionsToClear: string[] = [];
      const allAgentIds: string[] = [];

      // Find all sessions for this agent
      for (const [sessionId, sessionData] of activeSessions.entries()) {
        allAgentIds.push(sessionData.agentId);
        if (sessionData.agentId === profileId) {
          sessionsToClear.push(sessionId);
        }
      }

      fastify.log.info(
        {
          profileId,
          allAgentIds,
          sessionsToClear,
          totalSessions: activeSessions.size,
          matchingSessionsCount: sessionsToClear.length,
        },
        "DELETE /v1/mcp/sessions - Found sessions to clear",
      );

      // Delete all matching sessions
      for (const sessionId of sessionsToClear) {
        fastify.log.info(
          { profileId, sessionId },
          "DELETE /v1/mcp/sessions - Clearing session",
        );
        activeSessions.delete(sessionId);
      }

      fastify.log.info(
        {
          profileId,
          clearedCount: sessionsToClear.length,
          remainingSessions: activeSessions.size,
        },
        "DELETE /v1/mcp/sessions - All sessions cleared, now clearing cached MCP client",
      );

      // Also clear the cached MCP client so it will reconnect with a new session
      clearChatMcpClient(profileId);

      fastify.log.info(
        {
          profileId,
          clearedCount: sessionsToClear.length,
          remainingSessions: activeSessions.size,
        },
        "DELETE /v1/mcp/sessions - ✅ Sessions and client cache cleared successfully",
      );

      reply.type("application/json");
      return {
        message: "Sessions cleared successfully",
        clearedCount: sessionsToClear.length,
      };
    },
  );
};

// =============================================================================
// NEW: Profile-specific MCP Gateway endpoints with token authentication
// /mcp/v1/<profile_id>
// Authorization header: Bearer <archestra_token>
// =============================================================================
export const newMcpGatewayRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const { endpoint } = config.mcpGateway;

  // GET endpoint for server discovery with profile ID in URL
  fastify.get(
    `${endpoint}/:profileId`,
    {
      schema: {
        tags: ["mcp-gateway"],
        params: z.object({
          profileId: UuidIdSchema,
        }),
        response: {
          200: z.object({
            name: z.string(),
            version: z.string(),
            agentId: z.string(),
            transport: z.string(),
            capabilities: z.object({
              tools: z.boolean(),
            }),
            tokenAuth: z
              .object({
                tokenId: z.string(),
                isOrganizationToken: z.boolean(),
                hasTeam: z.boolean(),
              })
              .optional(),
          }),
          401: z.object({
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { profileId, token } =
        extractProfileIdAndTokenFromRequest(request) ?? {};

      if (!profileId || !token) {
        reply.status(401);
        return {
          error: "Unauthorized",
          message:
            "Missing or invalid Authorization header. Expected: Bearer <archestra_token> or Bearer <agent-id>",
        };
      }

      const tokenAuth = await validateProfileToken(profileId, token);

      reply.type("application/json");
      return {
        name: `archestra-agent-${profileId}`,
        version: config.api.version,
        agentId: profileId,
        transport: "http",
        capabilities: {
          tools: true,
        },
        ...(tokenAuth && {
          tokenAuth: {
            tokenId: tokenAuth.tokenId,
            isOrganizationToken: tokenAuth.isOrganizationToken,
            hasTeam: tokenAuth.tokenTeamId !== null,
          },
        }),
      };
    },
  );

  // POST endpoint for JSON-RPC requests with profile ID in URL
  fastify.post(
    `${endpoint}/:profileId`,
    {
      schema: {
        tags: ["mcp-gateway"],
        params: z.object({
          profileId: UuidIdSchema,
        }),
        // Accept any JSON body - will be validated by MCP SDK
        body: z.record(z.string(), z.unknown()),
      },
    },
    async (request, reply) => {
      const { profileId, token } =
        extractProfileIdAndTokenFromRequest(request) ?? {};

      if (!profileId || !token) {
        reply.status(401);
        return {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              "Unauthorized: Missing or invalid Authorization header. Expected: Bearer <archestra_token> or Bearer <agent-id>",
          },
          id: null,
        };
      }

      const tokenAuth = await validateProfileToken(profileId, token);
      if (!tokenAuth) {
        reply.status(401);
        return {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Unauthorized: Invalid token for this profile",
          },
          id: null,
        };
      }

      const sessionId = request.headers["mcp-session-id"] as string | undefined;
      const isInitialize =
        typeof request.body?.method === "string" &&
        request.body.method === "initialize";

      fastify.log.info(
        {
          agentId: profileId,
          profileId,
          sessionId,
          method: request.body?.method,
          isInitialize,
          hasTokenAuth: !!tokenAuth,
        },
        "MCP gateway POST request received (profile route)",
      );

      try {
        let server: Server | undefined;
        let transport: StreamableHTTPServerTransport | undefined;

        // Check if we have an existing session
        if (sessionId && activeSessions.has(sessionId)) {
          const sessionData = activeSessions.get(sessionId);
          if (!sessionData) {
            throw new Error("Session data not found");
          }

          fastify.log.info(
            { profileId, sessionId },
            "Reusing existing session (profile route)",
          );

          transport = sessionData.transport;
          server = sessionData.server;
          sessionData.lastAccess = Date.now();

          if (isInitialize) {
            fastify.log.info(
              { profileId, sessionId },
              "Re-initialize on existing session - will reuse existing server",
            );
          }
        } else if (isInitialize) {
          const effectiveSessionId =
            sessionId || `session-${Date.now()}-${randomUUID()}`;

          fastify.log.info(
            {
              profileId,
              sessionId: effectiveSessionId,
              hasTokenAuth: !!tokenAuth,
            },
            "Initialize request - creating NEW session (profile route)",
          );

          // Convert TokenAuthResult to TokenAuthContext for the server
          const tokenAuthContext: TokenAuthContext | undefined = tokenAuth
            ? {
                tokenId: tokenAuth.tokenId,
                tokenTeamId: tokenAuth.tokenTeamId,
                isOrganizationToken: tokenAuth.isOrganizationToken,
              }
            : undefined;

          const { server: newServer, agent } = await createAgentServer(
            profileId,
            fastify.log,
            undefined, // No cached agent
            tokenAuthContext, // Pass token auth for dynamic credential resolution
          );
          server = newServer;
          transport = createTransport(
            profileId,
            effectiveSessionId,
            fastify.log,
          );

          const thisTransport = transport;
          transport.onclose = () => {
            fastify.log.info(
              { profileId, sessionId: effectiveSessionId },
              "Transport closed - checking if session should be cleaned up",
            );
            const currentSession = activeSessions.get(effectiveSessionId);
            if (currentSession && currentSession.transport === thisTransport) {
              activeSessions.delete(effectiveSessionId);
              fastify.log.info(
                {
                  profileId,
                  sessionId: effectiveSessionId,
                  remainingSessions: activeSessions.size,
                },
                "Session cleaned up after transport close",
              );
            }
          };

          fastify.log.info({ profileId }, "Connecting server to transport");
          await server.connect(transport);
          fastify.log.info({ profileId }, "Server connected to transport");

          // Store session with token auth info
          activeSessions.set(effectiveSessionId, {
            server,
            transport,
            lastAccess: Date.now(),
            agentId: profileId,
            agent,
            // Include token auth info if using archestra_ token
            ...(tokenAuth && {
              tokenAuth: {
                tokenId: tokenAuth.tokenId,
                tokenTeamId: tokenAuth.tokenTeamId,
                isOrganizationToken: tokenAuth.isOrganizationToken,
              },
            }),
          });

          fastify.log.info(
            {
              profileId,
              sessionId: effectiveSessionId,
              hasTokenAuth: !!tokenAuth,
            },
            "Session stored before handleRequest",
          );
        } else if (!server || !transport) {
          fastify.log.error(
            { profileId, sessionId, method: request.body?.method },
            "Request received without valid session (profile route)",
          );
          reply.status(400);
          return {
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: Invalid or expired session",
            },
            id: null,
          };
        }

        fastify.log.info(
          { profileId, sessionId },
          "Calling transport.handleRequest (profile route)",
        );

        reply.hijack();

        await transport.handleRequest(
          request.raw as IncomingMessage,
          reply.raw as ServerResponse,
          request.body,
        );

        fastify.log.info(
          { profileId, sessionId },
          "Transport.handleRequest completed (profile route)",
        );

        if (isInitialize) {
          try {
            await McpToolCallModel.create({
              agentId: profileId,
              mcpServerName: "mcp-gateway",
              method: "initialize",
              toolCall: null,
              toolResult: {
                capabilities: {
                  tools: { listChanged: false },
                },
                serverInfo: {
                  name: `archestra-agent-${profileId}`,
                  version: config.api.version,
                },
                // biome-ignore lint/suspicious/noExplicitAny: toolResult structure varies by method type
              } as any,
            });
            fastify.log.info(
              { profileId, sessionId },
              "✅ Saved initialize request (profile route)",
            );
          } catch (dbError) {
            fastify.log.error(
              { err: dbError },
              "Failed to persist initialize request:",
            );
          }
        }

        fastify.log.info(
          { profileId, sessionId },
          "Request handled successfully (profile route)",
        );
      } catch (error) {
        fastify.log.error(
          {
            error,
            errorMessage: error instanceof Error ? error.message : "Unknown",
            profileId,
          },
          "Error handling MCP request (profile route)",
        );

        if (!reply.sent) {
          reply.status(500);
          return {
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal server error",
              data: error instanceof Error ? error.message : "Unknown error",
            },
            id: null,
          };
        }
      }
    },
  );

  // DELETE endpoint to clear sessions for an agent
  fastify.delete(
    `${endpoint}/sessions/:profileId`,
    {
      schema: {
        tags: ["mcp-gateway"],
        response: {
          200: z.object({
            message: z.string(),
            clearedCount: z.number(),
          }),
          401: z.object({
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { profileId } = extractProfileIdAndTokenFromRequest(request) ?? {};

      fastify.log.info(
        {
          profileId,
          totalActiveSessions: activeSessions.size,
        },
        "DELETE /v1/mcp/sessions - Request received",
      );

      if (!profileId) {
        fastify.log.warn(
          "DELETE /v1/mcp/sessions/:profileId - Unauthorized request",
        );
        reply.status(401);
        return {
          error: "Unauthorized",
          message:
            "Missing or invalid Authorization header. Expected: Bearer <agent-id>",
        };
      }

      const sessionsToClear: string[] = [];
      const allAgentIds: string[] = [];

      // Find all sessions for this agent
      for (const [sessionId, sessionData] of activeSessions.entries()) {
        allAgentIds.push(sessionData.agentId);
        if (sessionData.agentId === profileId) {
          sessionsToClear.push(sessionId);
        }
      }

      fastify.log.info(
        {
          profileId,
          allAgentIds,
          sessionsToClear,
          totalSessions: activeSessions.size,
          matchingSessionsCount: sessionsToClear.length,
        },
        "DELETE /v1/mcp/sessions/:profileId - Found sessions to clear",
      );

      // Delete all matching sessions
      for (const sessionId of sessionsToClear) {
        fastify.log.info(
          { profileId, sessionId },
          "DELETE /v1/mcp/sessions/:profileId - Clearing session",
        );
        activeSessions.delete(sessionId);
      }

      fastify.log.info(
        {
          profileId,
          clearedCount: sessionsToClear.length,
          remainingSessions: activeSessions.size,
        },
        "DELETE /v1/mcp/sessions/:profileId - All sessions cleared, now clearing cached MCP client",
      );

      // Also clear the cached MCP client so it will reconnect with a new session
      clearChatMcpClient(profileId);

      fastify.log.info(
        {
          profileId,
          clearedCount: sessionsToClear.length,
          remainingSessions: activeSessions.size,
        },
        "DELETE /v1/mcp/sessions/:profileId - ✅ Sessions and client cache cleared successfully",
      );

      reply.type("application/json");
      return {
        message: "Sessions cleared successfully",
        clearedCount: sessionsToClear.length,
      };
    },
  );
};

/**
 * Run session cleanup every 5 minutes
 */
setInterval(
  () => {
    cleanupExpiredSessions();
  },
  5 * 60 * 1000,
);
