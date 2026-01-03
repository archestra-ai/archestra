import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { clearChatMcpClient } from "@/clients/chat-mcp-client";
import type { TokenAuthContext } from "@/clients/mcp-client";
import config from "@/config";
import { McpToolCallModel, TeamTokenModel } from "@/models";
import { UuidIdSchema } from "@/types";
import {
  activeSessions,
  cleanupExpiredSessions,
  createAgentServer,
  createTransport,
  extractProfileIdAndTokenFromRequest,
  validateMCPGatewayToken,
} from "./mcp-gateway.utils";

// =============================================================================
// SHARED: Core MCP Gateway request handling logic
// =============================================================================

/**
 * Shared handler for MCP POST requests
 * Used by both legacy (/v1/mcp) and new (/v1/mcp/:profileId) endpoints
 */
async function handleMcpPostRequest(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  profileId: string,
  tokenAuthContext: TokenAuthContext | undefined,
): Promise<unknown> {
  const body = request.body as Record<string, unknown>;
  const sessionId = request.headers["mcp-session-id"] as string | undefined;
  const isInitialize =
    typeof body?.method === "string" && body.method === "initialize";

  fastify.log.info(
    {
      profileId,
      sessionId,
      method: body?.method,
      isInitialize,
      hasTokenAuth: !!tokenAuthContext,
    },
    "MCP gateway POST request received",
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

      fastify.log.info({ profileId, sessionId }, "Reusing existing session");

      transport = sessionData.transport;
      server = sessionData.server;
      sessionData.lastAccess = Date.now();

      if (isInitialize) {
        fastify.log.info(
          { profileId, sessionId },
          "Re-initialize on existing session - will reuse existing server",
        );
      }
    } else {
      // Either initialize request OR request with invalid/expired session
      // In both cases, create a new session
      const effectiveSessionId =
        sessionId || `session-${Date.now()}-${randomUUID()}`;

      if (isInitialize) {
        fastify.log.info(
          {
            profileId,
            sessionId: effectiveSessionId,
            hasTokenAuth: !!tokenAuthContext,
          },
          "Initialize request - creating NEW session",
        );
      } else {
        fastify.log.info(
          {
            profileId,
            sessionId: effectiveSessionId,
            method: body?.method,
            hasTokenAuth: !!tokenAuthContext,
          },
          "Request received with invalid/expired session - auto-creating new session",
        );
      }

      const { server: newServer, agent } = await createAgentServer(
        profileId,
        fastify.log,
        undefined, // No cached agent
        tokenAuthContext,
      );
      server = newServer;
      transport = createTransport(profileId, effectiveSessionId, fastify.log);

      // Set up transport close handler
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

      // Store session
      activeSessions.set(effectiveSessionId, {
        server,
        transport,
        lastAccess: Date.now(),
        agentId: profileId,
        agent,
        ...(tokenAuthContext && { tokenAuth: tokenAuthContext }),
      });

      fastify.log.info(
        {
          profileId,
          sessionId: effectiveSessionId,
          hasTokenAuth: !!tokenAuthContext,
        },
        "Session stored before handleRequest",
      );
    }

    fastify.log.info(
      { profileId, sessionId },
      "Calling transport.handleRequest",
    );

    // Hijack reply to let SDK handle raw response
    reply.hijack();

    await transport.handleRequest(
      request.raw as IncomingMessage,
      reply.raw as ServerResponse,
      body,
    );

    fastify.log.info(
      { profileId, sessionId },
      "Transport.handleRequest completed",
    );

    // Log initialize request
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
          "✅ Saved initialize request",
        );
      } catch (dbError) {
        fastify.log.error(
          { err: dbError },
          "Failed to persist initialize request:",
        );
      }
    }

    fastify.log.info({ profileId, sessionId }, "Request handled successfully");
  } catch (error) {
    fastify.log.error(
      {
        error,
        errorMessage: error instanceof Error ? error.message : "Unknown",
        profileId,
      },
      "Error handling MCP request",
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
}

/**
 * Shared handler for DELETE sessions requests
 */
async function handleDeleteSessions(
  fastify: FastifyInstance,
  reply: FastifyReply,
  profileId: string,
): Promise<{ message: string; clearedCount: number }> {
  fastify.log.info(
    {
      profileId,
      totalActiveSessions: activeSessions.size,
    },
    "DELETE sessions - Request received",
  );

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
    "DELETE sessions - Found sessions to clear",
  );

  // Delete all matching sessions
  for (const sessionId of sessionsToClear) {
    fastify.log.info(
      { profileId, sessionId },
      "DELETE sessions - Clearing session",
    );
    activeSessions.delete(sessionId);
  }

  // Clear cached MCP client
  clearChatMcpClient(profileId);

  fastify.log.info(
    {
      profileId,
      clearedCount: sessionsToClear.length,
      remainingSessions: activeSessions.size,
    },
    "DELETE sessions - ✅ Sessions and client cache cleared successfully",
  );

  reply.type("application/json");
  return {
    message: "Sessions cleared successfully",
    clearedCount: sessionsToClear.length,
  };
}

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
  // Legacy auth: Uses profile ID as bearer token
  fastify.post(
    endpoint,
    {
      schema: {
        tags: ["mcp-gateway"],
        body: z.record(z.string(), z.unknown()),
      },
    },
    async (request, reply) => {
      const { profileId } = extractProfileIdAndTokenFromRequest(request) ?? {};

      if (!profileId) {
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

      const orgToken = await TeamTokenModel.findOrganizationToken();
      const tokenAuthContext: TokenAuthContext | undefined = orgToken
        ? {
            tokenId: orgToken.id,
            teamId: null,
            isOrganizationToken: true,
          }
        : undefined;

      return handleMcpPostRequest(
        fastify,
        request,
        reply,
        profileId,
        tokenAuthContext,
      );
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

      if (!profileId) {
        reply.status(401);
        return {
          error: "Unauthorized",
          message:
            "Missing or invalid Authorization header. Expected: Bearer <agent-id>",
        };
      }

      return handleDeleteSessions(fastify, reply, profileId);
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
                teamId: z.string().nullable(),
                isOrganizationToken: z.boolean(),
                isUserToken: z.boolean().optional(),
                userId: z.string().optional(),
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

      const tokenAuth = await validateMCPGatewayToken(profileId, token);

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
            teamId: tokenAuth.teamId,
            isOrganizationToken: tokenAuth.isOrganizationToken,
            ...(tokenAuth.isUserToken && { isUserToken: true }),
            ...(tokenAuth.userId && { userId: tokenAuth.userId }),
          },
        }),
      };
    },
  );

  // POST endpoint for JSON-RPC requests with profile ID in URL
  // New auth: Validates archestra token for the profile
  fastify.post(
    `${endpoint}/:profileId`,
    {
      schema: {
        tags: ["mcp-gateway"],
        params: z.object({
          profileId: UuidIdSchema,
        }),
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

      const tokenAuth = await validateMCPGatewayToken(profileId, token);
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

      const tokenAuthContext: TokenAuthContext = {
        tokenId: tokenAuth.tokenId,
        teamId: tokenAuth.teamId,
        isOrganizationToken: tokenAuth.isOrganizationToken,
        ...(tokenAuth.isUserToken && { isUserToken: true }),
        ...(tokenAuth.userId && { userId: tokenAuth.userId }),
      };

      return handleMcpPostRequest(
        fastify,
        request,
        reply,
        profileId,
        tokenAuthContext,
      );
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

      if (!profileId) {
        reply.status(401);
        return {
          error: "Unauthorized",
          message:
            "Missing or invalid Authorization header. Expected: Bearer <agent-id>",
        };
      }

      return handleDeleteSessions(fastify, reply, profileId);
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
