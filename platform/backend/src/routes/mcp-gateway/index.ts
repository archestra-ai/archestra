import type { IncomingMessage, ServerResponse } from "node:http";
import { EXECUTION_ID_HEADER } from "@archestra/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import type { TokenAuthContext } from "@/clients/mcp-client";
import config from "@/config";
import logger from "@/logging";
import { AgentModel, McpToolCallModel } from "@/models";
import { skillsSurfaceEnabled } from "@/services/agent-skill-resolution";
import { UuidOrSlugSchema } from "@/types";
import { getPublicRequestOrigin } from "../request-origin";
import {
  deriveStatePrincipal,
  extractMrtrParams,
  readClientCapabilities,
  supportsInputRequired,
  verifyRequestState,
} from "./mrtr";
import {
  buildDiscoverResult,
  extractTraceContext,
  isDiscoverRequest,
  isMethodRemovedForRevision,
  MCP_PROTOCOL_VERSION_HEADER,
  type McpProtocolRevision,
  type ProtocolResolution,
  resolveProtocolRevision,
  SERVER_DISCOVER_METHOD,
  STATELESS_MCP_PROTOCOL_REVISION,
  SUPPORTED_MCP_PROTOCOL_REVISIONS,
  validateRoutingHeaders,
  withCompleteResultEnvelope,
} from "./protocol";
import { handleSkillMethod, isSkillMethod } from "./skills";
import {
  isSubscriptionsListenRequest,
  parseSubscriptionFilter,
  runSubscriptionStream,
} from "./subscriptions";
import { handleTaskMethod, isTaskMethod } from "./tasks";
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
} from "./utils";

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
  executionId?: string;
}): Promise<void> {
  const {
    fastify,
    profileId,
    method,
    revision,
    tokenAuthContext,
    executionId,
  } = params;

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
      executionId: executionId ?? null,
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
  /** Rounds already spent on this call, from a verified requestState. */
  mrtrRound: number,
): Promise<unknown> {
  const { revision } = resolution;
  const body = request.body as Record<string, unknown>;
  const executionId = readHeader(request, EXECUTION_ID_HEADER);

  // Read from the raw body: the SDK's request schemas drop unknown params, so
  // these are gone by the time a request handler runs.
  const mrtrParams = extractMrtrParams(body);

  // SEP-414: a client may attach W3C trace context, which lets its spans, the
  // gateway's, and the upstream server's join one trace. Logged on the request
  // so a trace id present in the client is findable here.
  const traceContext = extractTraceContext(body);
  if (traceContext) {
    fastify.log.debug(
      { profileId, traceparent: traceContext.traceparent },
      "MCP request carries W3C trace context",
    );
  }
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
    const { server } = await createAgentServer({
      agentId: profileId,
      tokenAuth: tokenAuthContext,
      executionId,
      mrtr: {
        // Only a 2026-07-28 client can act on an InputRequiredResult. A legacy
        // client keeps the in-band elicitation it has always used.
        enabled: revision === STATELESS_MCP_PROTOCOL_REVISION,
        inputResponses: mrtrParams.inputResponses,
        round: mrtrRound,
        clientCapabilities: readClientCapabilities(body),
      },
    });
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
        executionId,
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

      // An MRTR retry carries state the gateway minted. It travels through the
      // client, so it is verified — signature, principal, expiry, and the
      // originating request — before anything acts on it.
      let mrtrRound = 0;
      const retryState = extractMrtrParams(request.body).requestState;
      if (retryState) {
        const method = (request.body as { method?: string })?.method;
        if (!supportsInputRequired(method)) {
          reply.status(400);
          return {
            jsonrpc: "2.0",
            error: {
              code: -32602,
              message: `requestState is not valid on "${method}".`,
            },
            id: (request.body as { id?: string | number })?.id ?? null,
          };
        }

        const verified = verifyRequestState({
          state: retryState,
          principal: deriveStatePrincipal({
            userId: tokenAuth.userId,
            tokenId: tokenAuth.tokenId,
            organizationId: tokenAuth.organizationId,
          }),
          method: method as string,
          requestParams: (request.body as { params?: unknown })?.params,
        });

        if (verified.ok) {
          mrtrRound = verified.payload.round;
        }

        if (!verified.ok) {
          reply.status(400);
          return {
            jsonrpc: "2.0",
            error: {
              code: -32602,
              message: `Invalid requestState (${verified.reason}).`,
            },
            id: (request.body as { id?: string | number })?.id ?? null,
          };
        }
      }

      // 2026-07-28 removes ping, logging/setLevel, and resources
      // subscription methods. A client that declared that revision gets
      // method-not-found rather than an answer from a surface it opted out
      // of; legacy clients are untouched.
      const bodyMethod = (request.body as { method?: string })?.method;
      if (
        isMethodRemovedForRevision({
          method: bodyMethod,
          revision: resolution.revision,
        })
      ) {
        reply.header(MCP_PROTOCOL_VERSION_HEADER, resolution.revision);
        return {
          jsonrpc: "2.0",
          error: {
            code: -32601,
            message: `Method "${bodyMethod}" was removed in protocol version ${resolution.revision}.`,
          },
          id: (request.body as { id?: string | number })?.id ?? null,
        };
      }

      // Tasks extension methods, served from the durable row so any replica
      // can answer. Stateless clients only — the extension's per-request
      // capability mechanics do not exist earlier, so a legacy client falls
      // through to the SDK and gets method-not-found.
      if (
        resolution.revision === STATELESS_MCP_PROTOCOL_REVISION &&
        isTaskMethod(request.body)
      ) {
        reply.header(MCP_PROTOCOL_VERSION_HEADER, resolution.revision);
        const outcome = await handleTaskMethod({
          body: request.body,
          agentId: profileId,
          principal: deriveStatePrincipal({
            userId: tokenAuth.userId,
            tokenId: tokenAuth.tokenId,
            organizationId: tokenAuth.organizationId,
          }),
        });
        return {
          jsonrpc: "2.0",
          ...outcome,
          id: (request.body as { id?: string | number })?.id ?? null,
        };
      }

      // Skills extension methods (SEP-2640). Handled at the route because the
      // SDK has no handler slot for extension methods. Gated on the same
      // predicate as the capability declaration, so when the surface is off
      // these fall through to the SDK and get method-not-found — a client that
      // was shown no capability is never given a half-open surface.
      // `resources/read` of a `skill://` URI is deliberately *not* here: it is
      // an ordinary SDK request, and its skill branch lives in utils.ts.
      // Requests only: `isSkillMethod` refuses a body without an id, so a
      // notification spelling of these methods falls through to the SDK
      // transport, which answers 202 with no body — a notification must never
      // get a JSON-RPC response.
      if (skillsSurfaceEnabled() && isSkillMethod(request.body)) {
        reply.header(MCP_PROTOCOL_VERSION_HEADER, resolution.revision);
        // Nothing downstream of here turns a throw into a JSON-RPC error: this
        // surface is dispatched ahead of the SDK, so an unexpected failure
        // would reach Fastify's error handler and answer HTTP 500 with a body
        // that is not JSON-RPC at all — a client mid-listing cannot even read
        // which request failed. The message is logged, never returned:
        // internal failure text is not the caller's to read.
        let outcome: Awaited<ReturnType<typeof handleSkillMethod>>;
        try {
          outcome = await handleSkillMethod({
            body: request.body,
            agentId: profileId,
          });
        } catch (error) {
          logger.error(
            {
              agentId: profileId,
              method: (request.body as { method?: string })?.method,
              err: error,
            },
            "Skills gateway method failed",
          );
          outcome = { error: { code: -32603, message: "Internal error" } };
        }
        return {
          jsonrpc: "2.0",
          ...("result" in outcome
            ? {
                result: withCompleteResultEnvelope(outcome.result, {
                  name: `archestra-agent-${profileId}`,
                  version: config.api.version,
                }),
              }
            : outcome),
          id: (request.body as { id?: string | number })?.id ?? null,
        };
      }

      // `subscriptions/listen` (2026-07-28) opens a long-lived notification
      // stream. Handled at the route because the SDK transport answers with a
      // single JSON body, and this is the one method that must not. Requires
      // the stateless revision: a legacy client falls through to the SDK and
      // gets method-not-found, since the method does not exist there.
      if (
        resolution.revision === STATELESS_MCP_PROTOCOL_REVISION &&
        isSubscriptionsListenRequest(request.body)
      ) {
        const subscriptionId =
          (request.body as { id?: string | number })?.id ?? null;
        if (subscriptionId === null) {
          reply.status(400);
          return {
            jsonrpc: "2.0",
            error: {
              code: -32600,
              message:
                "subscriptions/listen must be a request with an id; the id becomes the subscription id.",
            },
            id: null,
          };
        }

        await runSubscriptionStream({
          request,
          reply,
          agentId: profileId,
          subscriptionId,
          requested: parseSubscriptionFilter(request.body),
        });
        return;
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
          executionId: readHeader(request, EXECUTION_ID_HEADER),
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

      const executionId = readHeader(request, EXECUTION_ID_HEADER);
      const tokenAuthContext: TokenAuthContext = {
        tokenId: tokenAuth.tokenId,
        teamId: tokenAuth.teamId,
        isOrganizationToken: tokenAuth.isOrganizationToken,
        organizationId: tokenAuth.organizationId,
        ...(tokenAuth.isUserToken && { isUserToken: true }),
        ...(tokenAuth.userId && { userId: tokenAuth.userId }),
        ...(tokenAuth.isExternalIdp && { isExternalIdp: true }),
        ...(tokenAuth.rawToken && { rawToken: tokenAuth.rawToken }),
        ...(executionId && { executionId }),
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
        mrtrRound,
      );
    },
  );
};

function readHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export default mcpGatewayRoutes;
