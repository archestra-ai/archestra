import type { IncomingMessage, ServerResponse } from "node:http";
import {
  MCP_APPS_SERVER_EXTENSION_CAPABILITIES,
  MCP_ENTERPRISE_AUTH_EXTENSION_CAPABILITIES,
  MCP_OAUTH_CLIENT_CREDENTIALS_SERVER_EXTENSION_CAPABILITIES,
} from "@archestra/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import type { TokenAuthContext } from "@/clients/mcp-client";
import config from "@/config";
import { AgentModel, McpToolCallModel } from "@/models";
import { UuidOrSlugSchema } from "@/types";
import {
  createAgentServer,
  createStatelessTransport,
  deriveAuthMethod,
  ensureRequestSocketDestroySoon,
  extractPassthroughHeaders,
  extractProfileIdAndTokenFromRequest,
  validateMCPGatewayToken,
} from "./mcp-gateway.utils";
import { getPublicRequestOrigin } from "./request-origin";

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
  const origin = getPublicRequestOrigin(request);
  const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource${request.url}`;
  reply.header(
    "WWW-Authenticate",
    `Bearer resource_metadata="${resourceMetadataUrl}"`,
  );
}

/**
 * Body message for the 503 the gateway returns when token validation itself
 * failed (e.g. the database was unreachable during a pod restart). Worded so a
 * client developer reading the error knows the token was not rejected.
 *
 * @public — asserted by mcp-gateway.token-validation-unavailable.test.ts (knip --production ignores tests)
 */
export const MCP_GATEWAY_TOKEN_VALIDATION_UNAVAILABLE_MESSAGE =
  "Unable to verify the access token right now due to a temporary backend issue. Retry with the same token; it has not been rejected.";

type GatewayAuthOutcome =
  | { outcome: "unauthorized" }
  | { outcome: "unavailable" }
  | {
      outcome: "ok";
      profileId: string;
      token: string;
      tokenAuth: Awaited<ReturnType<typeof validateMCPGatewayToken>>;
    };

/**
 * Resolve the profile and token auth for a gateway request, separating "the
 * token is invalid" (401 territory) from "we could not check the token".
 *
 * The distinction is what keeps a pod restart from logging every MCP client
 * out: a 401 (+ WWW-Authenticate) tells clients like Claude Code to discard
 * their — perfectly valid, database-backed — tokens and re-run the OAuth flow,
 * while a 503 makes them retry with the same token once the backend is
 * reachable again. So transient validation failures must never surface as 401.
 */
async function resolveGatewayAuth(
  fastify: FastifyInstance,
  request: FastifyRequest,
): Promise<GatewayAuthOutcome> {
  try {
    const extracted = await extractProfileIdAndTokenFromRequest(request);
    if (!extracted) {
      return { outcome: "unauthorized" };
    }
    const tokenAuth = await validateMCPGatewayToken(
      extracted.profileId,
      extracted.token,
    );
    return { outcome: "ok", ...extracted, tokenAuth };
  } catch (error) {
    fastify.log.error(
      { err: error, url: request.url },
      "MCP gateway token validation errored — answering 503 so the client retries with the same token instead of re-authenticating",
    );
    return { outcome: "unavailable" };
  }
}

/** 503 + Retry-After, deliberately without WWW-Authenticate (see resolveGatewayAuth). */
function setServiceUnavailableReply(reply: FastifyReply) {
  reply.header("Retry-After", "5");
  reply.status(503);
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
  tokenAuthContext: TokenAuthContext | undefined,
): Promise<unknown> {
  const body = request.body as Record<string, unknown>;
  const isInitialize =
    typeof body?.method === "string" && body.method === "initialize";

  fastify.log.trace(
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
    const { server } = await createAgentServer(profileId, tokenAuthContext);
    const transport = createStatelessTransport(profileId);

    fastify.log.trace({ profileId }, "Connecting server to transport");
    await server.connect(transport);
    fastify.log.trace({ profileId }, "Server connected to transport");

    fastify.log.trace({ profileId }, "Calling transport.handleRequest");

    // Hijack reply to let SDK handle raw response
    reply.hijack();

    ensureRequestSocketDestroySoon(request.raw);
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
              extensions: {
                ...MCP_APPS_SERVER_EXTENSION_CAPABILITIES,
                ...MCP_ENTERPRISE_AUTH_EXTENSION_CAPABILITIES,
                ...MCP_OAUTH_CLIENT_CREDENTIALS_SERVER_EXTENSION_CAPABILITIES,
              },
              tools: { listChanged: false },
            },
            serverInfo: {
              name: `archestra-agent-${profileId}`,
              version: config.api.version,
            },
            // biome-ignore lint/suspicious/noExplicitAny: toolResult structure varies by method type
          } as any,
          userId: tokenAuthContext?.userId ?? null,
          authMethod: deriveAuthMethod(tokenAuthContext) ?? null,
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
// MCP Gateway endpoints with token authentication (stateless)
// /v1/mcp/<profile_id>
// Authorization header: Bearer <platform_token>
// =============================================================================
const mcpGatewayRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const { endpoint } = config.mcpGateway;

  // GET endpoint for server discovery with profile ID in URL
  fastify.get(
    `${endpoint}/:profileId`,
    {
      schema: {
        operationId: "mcpGatewayGet",
        tags: ["MCP Gateway"],
        params: z.object({
          profileId: UuidOrSlugSchema,
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
          503: z.object({
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const auth = await resolveGatewayAuth(fastify, request);

      if (auth.outcome === "unavailable") {
        setServiceUnavailableReply(reply);
        return {
          error: "Service Unavailable",
          message: MCP_GATEWAY_TOKEN_VALIDATION_UNAVAILABLE_MESSAGE,
        };
      }

      if (auth.outcome === "unauthorized") {
        setWWWAuthenticateHeader(request, reply);
        reply.status(401);
        return {
          error: "Unauthorized",
          message:
            "Missing or invalid Authorization header. Expected: Bearer <platform_token> or Bearer <agent-id>",
        };
      }

      const { profileId, tokenAuth } = auth;

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
  // New auth: Validates a platform-managed token for the profile
  fastify.post(
    `${endpoint}/:profileId`,
    {
      schema: {
        operationId: "mcpGatewayPost",
        tags: ["MCP Gateway"],
        params: z.object({
          profileId: UuidOrSlugSchema,
        }),
        body: z.record(z.string(), z.unknown()),
      },
    },
    async (request, reply) => {
      const auth = await resolveGatewayAuth(fastify, request);

      if (auth.outcome === "unavailable") {
        setServiceUnavailableReply(reply);
        return {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: MCP_GATEWAY_TOKEN_VALIDATION_UNAVAILABLE_MESSAGE,
          },
          id: null,
        };
      }

      if (auth.outcome === "unauthorized") {
        setWWWAuthenticateHeader(request, reply);
        reply.status(401);
        return {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              "Unauthorized: Missing or invalid Authorization header. Expected: Bearer <platform_token> or Bearer <agent-id>",
          },
          id: null,
        };
      }

      const { profileId, tokenAuth } = auth;
      if (!tokenAuth) {
        setWWWAuthenticateHeader(request, reply);
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
        organizationId: tokenAuth.organizationId,
        ...(tokenAuth.isUserToken && { isUserToken: true }),
        ...(tokenAuth.userId && { userId: tokenAuth.userId }),
        ...(tokenAuth.isExternalIdp && { isExternalIdp: true }),
        ...(tokenAuth.rawToken && { rawToken: tokenAuth.rawToken }),
      };

      // Extract passthrough headers from the incoming request per the agent's allowlist
      const agent = await AgentModel.findGatewayAgentById(profileId);
      if (agent) {
        const passthroughHeaders = extractPassthroughHeaders(
          agent.passthroughHeaders,
          request.headers,
        );
        if (passthroughHeaders) {
          tokenAuthContext.passthroughHeaders = passthroughHeaders;
          fastify.log.info(
            { profileId, passthroughHeaders: Object.keys(passthroughHeaders) },
            "Passthrough headers forwarded to MCP servers",
          );
        }
      }

      return handleMcpPostRequest(
        fastify,
        request,
        reply,
        profileId,
        tokenAuthContext,
      );
    },
  );
};

export default mcpGatewayRoutes;
