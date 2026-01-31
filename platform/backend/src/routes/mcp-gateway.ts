import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { clearChatMcpClient } from "@/clients/chat-mcp-client";
import type { TokenAuthContext } from "@/clients/mcp-client";
import config from "@/config";
import { McpToolCallModel, UserModel } from "@/models";
import { UuidIdSchema } from "@/types";
import {
  createAgentServer,
  createStatelessTransport,
  extractProfileIdAndTokenFromRequest,
  validateMCPGatewayToken,
  validateSessionAuth,
} from "./mcp-gateway.utils";
import { betterAuth } from "@/auth";

// =============================================================================
// MCP Gateway request handling (stateless mode)
// =============================================================================

/**
 * Handle MCP POST requests in stateless mode
 * Creates a fresh Server and Transport for each request
 */
async function handleMcpPostRequest(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  profileId: string,
  tokenAuthContext: TokenAuthContext | undefined,
): Promise<unknown> {
  const body = request.body as Record<string, unknown>;
  const isInitialize =
    typeof body?.method === "string" && body.method === "initialize";

  fastify.log.info(
    {
      profileId,
      method: body?.method,
      isInitialize,
      hasTokenAuth: !!tokenAuthContext,
    },
    "MCP gateway POST request received (stateless)",
  );

  try {
    // Create fresh server and transport for each request (stateless mode)
    const { server } = await createAgentServer(
      profileId,
      fastify.log,
      undefined,
      tokenAuthContext,
    );
    const transport = createStatelessTransport(profileId, fastify.log);

    fastify.log.info({ profileId }, "Connecting server to transport");
    await server.connect(transport);
    fastify.log.info({ profileId }, "Server connected to transport");

    fastify.log.info({ profileId }, "Calling transport.handleRequest");

    // Hijack reply to let SDK handle raw response
    reply.hijack();

    await transport.handleRequest(
      request.raw as IncomingMessage,
      reply.raw as ServerResponse,
      body,
    );

    fastify.log.info({ profileId }, "Transport.handleRequest completed");

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
        fastify.log.info({ profileId }, "✅ Saved initialize request");
      } catch (dbError) {
        fastify.log.error(
          { err: dbError },
          "Failed to persist initialize request:",
        );
      }
    }

    fastify.log.info({ profileId }, "Request handled successfully");
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
 * Handle DELETE cache request for a profile
 * Clears cached MCP client for the profile
 */
async function handleDeleteCache(
  fastify: FastifyInstance,
  reply: FastifyReply,
  profileId: string,
): Promise<{ message: string }> {
  fastify.log.info({ profileId }, "DELETE cache - Request received");

  // Clear cached MCP client
  clearChatMcpClient(profileId);

  fastify.log.info(
    { profileId },
    "DELETE cache - ✅ Client cache cleared successfully",
  );

  reply.type("application/json");
  return {
    message: "Cache cleared successfully",
  };
}

// =============================================================================
// MCP Gateway endpoints with token authentication (stateless)
// /v1/mcp/<profile_id>
// Authorization header: Bearer <archestra_token>
// =============================================================================
export const mcpGatewayRoutes: FastifyPluginAsyncZod = async (fastify) => {
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
      let finalProfileId = profileId;
      let tokenAuth = token
        ? await validateMCPGatewayToken(profileId!, token)
        : null;

      // If no token auth, try session auth
      if (!tokenAuth) {
        finalProfileId =
          profileId || request.url.split("/").at(-1)?.split("?")[0];

        if (finalProfileId) {
          try {
            const headers = new Headers(request.headers as HeadersInit);
            const session = await betterAuth.api.getSession({
              headers,
              query: { disableCookieCache: true },
            });

            if (session?.user?.id) {
               const user = await UserModel.getById(session.user.id);
               tokenAuth = await validateSessionAuth(finalProfileId, user.id, user.organizationId);
            }
          } catch (e) {
            // ignore
          }
        }
      }

      if (!finalProfileId || !tokenAuth) {
        reply.status(401);
        return {
          error: "Unauthorized",
          message:
            "Missing or invalid Authorization header/Session. Expected: Bearer <archestra_token> or valid Session",
        };
      }

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
      let finalProfileId = profileId;
      let tokenAuth: TokenAuthContext | undefined;
      let rawTokenAuthResult: any = null;

      if (profileId && token) {
        rawTokenAuthResult = await validateMCPGatewayToken(profileId, token);
      }

      // If no token auth, try session auth
      if (!rawTokenAuthResult) {
         finalProfileId = profileId || request.url.split("/").at(-1)?.split("?")[0];
         
         if (finalProfileId) {
             try {
                const headers = new Headers(request.headers as HeadersInit);
                const session = await betterAuth.api.getSession({
                  headers,
                  query: { disableCookieCache: true },
                });

                if (session?.user?.id) {
                   const user = await UserModel.getById(session.user.id);
                   rawTokenAuthResult = await validateSessionAuth(finalProfileId, user.id, user.organizationId);
                }
             } catch (e) {}
         }
      }

      if (!finalProfileId || !rawTokenAuthResult) {
        reply.status(401);
        return {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              "Unauthorized: Missing or invalid Authorization header/Session. Expected: Bearer <archestra_token> or valid Session",
          },
          id: null,
        };
      }

      // Map TokenAuthResult to TokenAuthContext
      tokenAuth = {
        tokenId: rawTokenAuthResult.tokenId,
        teamId: rawTokenAuthResult.teamId,
        isOrganizationToken: rawTokenAuthResult.isOrganizationToken,
        organizationId: rawTokenAuthResult.organizationId,
        ...(rawTokenAuthResult.isUserToken && { isUserToken: true }),
        ...(rawTokenAuthResult.userId && { userId: rawTokenAuthResult.userId }),
      };

      return handleMcpPostRequest(
        fastify,
        request,
        reply,
        finalProfileId!, // Validated above
        tokenAuth,
      );
    },
  );

  // DELETE endpoint to clear cache for a profile
  fastify.delete(
    `${endpoint}/cache/:profileId`,
    {
      schema: {
        tags: ["mcp-gateway"],
        params: z.object({
          profileId: UuidIdSchema,
        }),
        response: {
          200: z.object({
            message: z.string(),
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
            "Missing or invalid Authorization header. Expected: Bearer <archestra_token>",
        };
      }

      return handleDeleteCache(fastify, reply, profileId);
    },
  );
};
