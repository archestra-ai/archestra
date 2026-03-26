import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import type { TokenAuthContext } from "@/clients/mcp-client";
import config from "@/config";
import { McpToolCallModel } from "@/models";
import { UuidIdSchema } from "@/types";
import {
  createAgentServer,
  createStatelessTransport,
  deriveAuthMethod,
  extractProfileIdAndTokenFromRequest,
  validateMCPGatewayToken,
} from "./mcp-gateway.utils";

// =============================================================================
// MCP Gateway request handling (stateless mode)
// =============================================================================

/**
 * Sets the WWW-Authenticate header with the OAuth protected resource metadata URL.
 * Per RFC 9728, this tells clients where to discover the authorization server.
 */
function setWWWAuthenticateHeader(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const resourceMetadataUrl = `${request.protocol}://${request.headers.host}/.well-known/oauth-protected-resource${request.url}`;
  reply.header(
    "WWW-Authenticate",
    `Bearer resource_metadata="${resourceMetadataUrl}"`,
  );
}

/**
 * Handle MCP POST requests in stateless mode
 * Creates a fresh Server and Transport for each request
 */
async function handleMcpPostRequest(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  profileId: string,
  tokenIdAuthContext: TokenAuthContext | undefined,
): Promise<unknown> {
  const body = request.body as Record<string, unknown>;
  const isInitialize =
    typeof body?.method === "string" && body.method === "initialize";

  fastify.log.trace(
    {
      profileId,
      method: body?.method,
      isInitialize,
      hasTokenAuth: !!tokenIdAuthContext,
    },
    "MCP gateway POST request received (stateless)",
  );

  try {
    // Create fresh server and transport for each request (stateless mode)
    const { server } = await createAgentServer(profileId, tokenIdAuthContext);
    const transport = createStatelessTransport(profileId);

    fastify.log.trace({ profileId }, "Connecting server to transport");
    await server.connect(transport);
    fastify.log.trace({ profileId }, "Server connected to transport");

    fastify.log.trace({ profileId }, "Calling transport.handleRequest");

    // Hijack reply to let SDK handle raw response
    reply.hijack();

    await transport.handleRequest(
      request.raw as IncomingMessage,
      reply.raw as ServerResponse,
      body,
    );

    fastify.log.trace({ profileId }, "Transport.handleRequest completed");

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
          userId: tokenIdAuthContext?.userId ?? null,
          authMethod: deriveAuthMethod(tokenIdAuthContext) ?? null,
        });
        fastify.log.trace({ profileId }, "Saved initialize request");
      } catch (dbError) {
        fastify.log.error(
          { err: dbError },
          "Failed to persist initialize request:",
        );
      }
    }

    fastify.log.trace({ profileId }, "Request handled successfully");
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
        },
        id: null,
      };
    }
  }
}

// =============================================================================
// MCP Gateway endpoints with tokenId authentication (stateless)
// /v1/mcp/<profile_id>
// Authorization header: Bearer <archestra_tokenId>
// =============================================================================
export const mcpGatewayRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const { endpoint } = config.mcpGateway;

  // GET endpoint for server discovery with profile ID in URL
  fastify.get(
    `${endpoint}/:profileId`,
    {
      schema: {
        operationId: "mcpGatewayGet",
        tags: ["MCP Gateway"],
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
            tokenIdAuth: z
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
      const { profileId, tokenId } =
        extractProfileIdAndTokenFromRequest(request) ?? {};

      if (!profileId || !tokenId) {
        setWWWAuthenticateHeader(request, reply);
        reply.status(401);
        return {
          error: "Unauthorized",
          message:
            "Missing or invalid Authorization header. Expected: Bearer <archestra_tokenId> or Bearer <agent-id>",
        };
      }

      const tokenIdAuth = await validateMCPGatewayToken(profileId, tokenId);

      reply.type("application/json");
      return {
        name: `archestra-agent-${profileId}`,
        version: config.api.version,
        agentId: profileId,
        transport: "http",
        capabilities: {
          tools: true,
        },
        ...(tokenIdAuth && {
          tokenIdAuth: {
            tokenId: tokenIdAuth.tokenId,
            teamId: tokenIdAuth.teamId,
            isOrganizationToken: tokenIdAuth.isOrganizationToken,
            ...(tokenIdAuth.isUserToken && { isUserToken: true }),
            ...(tokenIdAuth.userId && { userId: tokenIdAuth.userId }),
          },
        }),
      };
    },
  );

  // POST endpoint for JSON-RPC requests with profile ID in URL
  // New auth: Validates archestra tokenId for the profile
  fastify.post(
    `${endpoint}/:profileId`,
    {
      schema: {
        operationId: "mcpGatewayPost",
        tags: ["MCP Gateway"],
        params: z.object({
          profileId: UuidIdSchema,
        }),
        body: z.record(z.string(), z.unknown()),
      },
    },
    async (request, reply) => {
      const { profileId, tokenId } =
        extractProfileIdAndTokenFromRequest(request) ?? {};

      if (!profileId || !tokenId) {
        setWWWAuthenticateHeader(request, reply);
        reply.status(401);
        return {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              "Unauthorized: Missing or invalid Authorization header. Expected: Bearer <archestra_tokenId> or Bearer <agent-id>",
          },
          id: null,
        };
      }

      const tokenIdAuth = await validateMCPGatewayToken(profileId, tokenId);
      if (!tokenIdAuth) {
        setWWWAuthenticateHeader(request, reply);
        reply.status(401);
        return {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Unauthorized: Invalid tokenId for this profile",
          },
          id: null,
        };
      }

      const tokenIdAuthContext: TokenAuthContext = {
        tokenId: tokenIdAuth.tokenId,
        teamId: tokenIdAuth.teamId,
        isOrganizationToken: tokenIdAuth.isOrganizationToken,
        organizationId: tokenIdAuth.organizationId,
        ...(tokenIdAuth.isUserToken && { isUserToken: true }),
        ...(tokenIdAuth.userId && { userId: tokenIdAuth.userId }),
        ...(tokenIdAuth.isExternalIdp && { isExternalIdp: true }),
        ...(tokenIdAuth.rawToken && { rawToken: tokenIdAuth.rawToken }),
      };

      return handleMcpPostRequest(
        fastify,
        request,
        reply,
        profileId,
        tokenIdAuthContext,
      );
    },
  );
};
