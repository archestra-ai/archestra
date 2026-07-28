import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import type { TokenAuthContext } from "@/clients/mcp-client";
import config from "@/config";
import { AgentModel, McpToolCallModel } from "@/models";
import { UuidOrSlugSchema } from "@/types";
import {
  buildDiscoverResult,
  isDiscoverRequest,
  MCP_PROTOCOL_VERSION_HEADER,
  type McpProtocolRevision,
  type ProtocolResolution,
  resolveProtocolRevision,
  SERVER_DISCOVER_METHOD,
  STATELESS_MCP_PROTOCOL_REVISION,
  SUPPORTED_MCP_PROTOCOL_REVISIONS,
  validateRoutingHeaders,
} from "./mcp-gateway.protocol";
import {
  authenticateMCPGatewayRequest,
  createAgentServer,
  createStatelessTransport,
  deriveAuthMethod,
  describeGatewayAuthFailure,
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
 * Remove a header from a Node request so downstream consumers cannot see it.
 *
 * Both representations have to be cleared: the SDK's Node transport is a
 * wrapper that rebuilds a web `Request` from `rawHeaders`, so deleting only
 * from the parsed `headers` map leaves the value visible to it.
 */
function stripRequestHeader(request: IncomingMessage, name: string): void {
  delete request.headers[name];

  const raw = request.rawHeaders;
  if (!Array.isArray(raw)) return;

  for (let index = raw.length - 2; index >= 0; index -= 2) {
    if (raw[index]?.toLowerCase() === name) {
      raw.splice(index, 2);
    }
  }
}

/**
 * Record a gateway handshake.
 *
 * Both revisions produce one: `initialize` for 2025-11-25 and `server/discover`
 * for 2026-07-28. Logging both keeps gateway-connection telemetry continuous
 * across the migration instead of going dark as clients move off the handshake.
 */
async function logHandshake(params: {
  fastify: FastifyInstance;
  profileId: string;
  method: "initialize" | typeof SERVER_DISCOVER_METHOD;
  revision: McpProtocolRevision;
  tokenAuthContext: TokenAuthContext | undefined;
}): Promise<void> {
  const { fastify, profileId, method, revision, tokenAuthContext } = params;

  try {
    await McpToolCallModel.create({
      agentId: profileId,
      mcpServerName: "mcp-gateway",
      method,
      toolCall: null,
      toolResult: buildDiscoverResult({
        agentId: profileId,
        version: config.api.version,
        revision,
        // biome-ignore lint/suspicious/noExplicitAny: toolResult structure varies by method type
      }) as any,
      userId: tokenAuthContext?.userId ?? null,
      authMethod: deriveAuthMethod(tokenAuthContext) ?? null,
    });
    fastify.log.trace({ profileId, method }, "Saved handshake request");
  } catch (dbError) {
    fastify.log.error(
      { err: dbError, method },
      "Failed to persist handshake request:",
    );
  }
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
  resolution: ProtocolResolution,
): Promise<unknown> {
  const { revision } = resolution;
  const body = request.body as Record<string, unknown>;
  const isInitialize =
    typeof body?.method === "string" && body.method === "initialize";

  fastify.log.trace(
    {
      profileId,
      method: body?.method,
      isInitialize,
      revision,
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

    // Echo the version so a dual-revision client can confirm what it got. A
    // declared version is echoed verbatim — a legacy client may have asked for
    // something older than 2025-11-25, and the response must not claim a newer
    // version than it requested. An undeclared legacy request is left alone:
    // the SDK negotiates it from the initialize body and is the authority.
    // Set before the SDK writes the head, which Node merges with.
    const echoVersion =
      resolution.declaredVersion ??
      (revision === STATELESS_MCP_PROTOCOL_REVISION ? revision : undefined);
    if (echoVersion) {
      reply.raw.setHeader(MCP_PROTOCOL_VERSION_HEADER, echoVersion);
    }

    // The bundled SDK transport validates this header against its own supported
    // list, which ends at 2025-11-25, and rejects anything newer with a 400.
    // The gateway — not the transport — is what answers for 2026-07-28, and the
    // JSON-RPC body underneath is unchanged between the two revisions, so the
    // header is withheld from the transport rather than letting it refuse a
    // request the gateway has already accepted. Without it the transport falls
    // back to its own default negotiated version.
    if (revision === STATELESS_MCP_PROTOCOL_REVISION) {
      stripRequestHeader(request.raw, MCP_PROTOCOL_VERSION_HEADER);
    }

    ensureRequestSocketDestroySoon(request.raw);
    await transport.handleRequest(
      request.raw as IncomingMessage,
      reply.raw as ServerResponse,
      body,
    );

    fastify.log.trace({ profileId }, "Transport.handleRequest completed");

    // Log initialize request
    if (isInitialize) {
      await logHandshake({
        fastify,
        profileId,
        method: "initialize",
        revision,
        tokenAuthContext,
      });
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
            protocolVersions: z.array(z.string()),
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
        (await extractProfileIdAndTokenFromRequest(request)) ?? {};

      if (!profileId || !token) {
        setWWWAuthenticateHeader(request, reply);
        reply.status(401);
        return {
          error: "Unauthorized",
          message:
            "Missing or invalid Authorization header. Expected: Bearer <platform_token> or Bearer <agent-id>",
        };
      }

      const tokenAuth = await validateMCPGatewayToken(profileId, token);

      reply.type("application/json");
      return {
        name: `archestra-agent-${profileId}`,
        version: config.api.version,
        agentId: profileId,
        transport: "http",
        protocolVersions: [...SUPPORTED_MCP_PROTOCOL_REVISIONS],
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
      const { profileId, token } =
        (await extractProfileIdAndTokenFromRequest(request)) ?? {};

      if (!profileId || !token) {
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

      const { result: tokenAuth, reason } = await authenticateMCPGatewayRequest(
        profileId,
        token,
      );
      if (!tokenAuth) {
        setWWWAuthenticateHeader(request, reply);
        reply.status(401);
        return {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: `Unauthorized: ${describeGatewayAuthFailure(reason)}`,
          },
          id: null,
        };
      }

      // Negotiate the protocol revision before touching the body. A 2025-11-25
      // client is unaffected: it declares nothing, sends no routing headers,
      // and resolves to the legacy revision.
      const resolution = resolveProtocolRevision({
        headers: request.headers,
        body: request.body as Record<string, unknown>,
      });

      if ("code" in resolution) {
        reply.status(400);
        return {
          jsonrpc: "2.0",
          error: { code: resolution.code, message: resolution.message },
          id: null,
        };
      }

      const routingError = validateRoutingHeaders({
        headers: request.headers,
        body: request.body as Record<string, unknown>,
        resolution,
      });

      if (routingError) {
        reply.status(400);
        reply.header(MCP_PROTOCOL_VERSION_HEADER, resolution.revision);
        return {
          jsonrpc: "2.0",
          error: { code: routingError.code, message: routingError.message },
          id: (request.body as { id?: string | number })?.id ?? null,
        };
      }

      // `server/discover` replaces the `initialize` handshake under 2026-07-28.
      // The SDK on this version has no handler for it, so answer it here from
      // the same capability builder `initialize` uses.
      if (isDiscoverRequest(request.body)) {
        reply.header(MCP_PROTOCOL_VERSION_HEADER, resolution.revision);
        await logHandshake({
          fastify,
          profileId,
          method: SERVER_DISCOVER_METHOD,
          revision: resolution.revision,
          tokenAuthContext: {
            tokenId: tokenAuth.tokenId,
            teamId: tokenAuth.teamId,
            isOrganizationToken: tokenAuth.isOrganizationToken,
            organizationId: tokenAuth.organizationId,
            ...(tokenAuth.userId && { userId: tokenAuth.userId }),
          },
        });
        return {
          jsonrpc: "2.0",
          result: buildDiscoverResult({
            agentId: profileId,
            version: config.api.version,
            revision: resolution.revision,
          }),
          id: (request.body as { id?: string | number })?.id ?? null,
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
        resolution,
      );
    },
  );
};

export default mcpGatewayRoutes;
