import type { IncomingMessage, ServerResponse } from "node:http";
import { RUN_ID_HEADER } from "@archestra/shared";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import type { TokenAuthContext } from "@/clients/mcp-client";
import config from "@/config";
import logger from "@/logging";
import { AgentModel, AgentRunModel, McpToolCallModel } from "@/models";
import {
  APPA_SESSION_HEADER,
  isWellFormedAppaId,
  sessionFromHeaders,
} from "@/openappa/service";
import { skillsSurfaceEnabled } from "@/services/agent-skill-resolution";
import {
  AgentRunAttentionStateSchema,
  type AgentRunRecord,
  ApiError,
  constructResponseSchema,
  UuidOrSlugSchema,
} from "@/types";
import { trackBackgroundWork } from "@/utils/background-work";
import { getPublicRequestOrigin } from "../request-origin";
import {
  clientCapabilityKey,
  clientCapabilityStore,
  encodeCapabilitySession,
  readCapabilitySession,
} from "./client-capabilities";
import {
  dispatchLegacySseMessage,
  LEGACY_SSE_MESSAGES_SEGMENT,
  LegacySseSessionRegistry,
  loadLegacySseSession,
  openLegacySseStream,
  wantsLegacySseStream,
} from "./legacy-sse";
import {
  clientSupportsInputRequest,
  deriveStatePrincipal,
  extractMrtrParams,
  readClientCapabilities,
  supportsInputRequired,
  verifyRequestState,
} from "./mrtr";
import { pendingInboundRequests } from "./pending-inbound-requests";
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
  extractBearerToken,
  extractPassthroughHeaders,
  extractProfileIdAndTokenFromRequest,
  validateMCPGatewayToken,
} from "./utils";

// =============================================================================
// MCP Gateway request handling (stateless mode)
// =============================================================================

/** Where a legacy client echoes the session id the gateway gave it. */
const MCP_SESSION_ID_HEADER = "mcp-session-id";

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
 * An external client may explicitly supply a logical call id for remedy
 * idempotency. JSON-RPC ids are transport correlation values and are reusable,
 * so they must never become durable receipt keys.
 */
function logicalToolCallId(body: Record<string, unknown>): string | undefined {
  if (body.method !== "tools/call") return;
  const params = body.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const meta = (params as Record<string, unknown>)._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return;
  const value = (meta as Record<string, unknown>)[
    "com.archestra/logicalToolCallId"
  ];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 256 ||
    !isWellFormedAppaId(value)
  )
    return;
  return value;
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
  runId?: string;
}): Promise<void> {
  const { fastify, profileId, method, revision, tokenAuthContext, runId } =
    params;

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
      runId: runId ?? null,
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
  const principal = deriveStatePrincipal({
    userId: tokenAuthContext?.userId,
    tokenId: tokenAuthContext?.tokenId,
    organizationId: tokenAuthContext?.organizationId,
  });
  // This client of this caller on this gateway: the key for its
  // initialize-time capabilities. Pending server-initiated requests bind to
  // the authenticated principal instead, so a User-Agent change cannot lose
  // the caller's answer.
  const capabilityKey = clientCapabilityKey({
    profileId,
    tokenId: tokenAuthContext?.tokenId,
    userId: tokenAuthContext?.userId,
    userAgent: readHeader(request, "user-agent"),
  });

  // Cancellation is a notification, so its target id lives in params rather
  // than the envelope. Route it to the same live transport as the original
  // server-initiated request and forget the admission slot immediately.
  const cancellationParams = body.params;
  if (
    body.method === "notifications/cancelled" &&
    typeof cancellationParams === "object" &&
    cancellationParams !== null &&
    "requestId" in cancellationParams
  ) {
    const requestId = (cancellationParams as Record<string, unknown>).requestId;
    if (typeof requestId === "string" || typeof requestId === "number") {
      const pending = pendingInboundRequests.consume({
        wireId: requestId,
        agentId: profileId,
        caller: principal,
      });
      if (pending) {
        pending.transport.onmessage?.({
          ...body,
          params: { ...cancellationParams, requestId: pending.id },
        } as unknown as JSONRPCMessage);
        reply.status(202);
        return;
      }
    }
  }

  // A JSON-RPC response or error without a method answers a server-initiated
  // request sent during an earlier POST call. Because each POST creates a fresh
  // server, route the answer back to the active transport waiting for it.
  // Unknown IDs or answers from other callers fall through to default handling.
  if (body.method === undefined && body.id !== undefined && body.id !== null) {
    const pending = pendingInboundRequests.consume({
      wireId: body.id as string | number,
      agentId: profileId,
      caller: principal,
    });
    if (pending) {
      pending.transport.onmessage?.({
        ...body,
        id: pending.id,
      } as unknown as JSONRPCMessage);
      reply.status(202);
      return;
    }
  }

  const runId = readHeader(request, RUN_ID_HEADER);
  const currentToolCallId = logicalToolCallId(body);

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

  let capabilitySessionId: string | undefined;
  if (isInitialize) {
    // A legacy client declares capabilities once at initialize.
    // Store capabilities so later tool calls know if the client supports
    // server-initiated requests (elicitation, sampling).
    const capabilities = (
      body?.params as { capabilities?: unknown } | undefined
    )?.capabilities;
    if (capabilities !== undefined) {
      clientCapabilityStore.remember({ key: capabilityKey, capabilities });
    }
    // A client that can be asked something also gets them back as its
    // session id, which it echoes on every request: that record outlives
    // this process and reaches every replica.
    if (
      (["elicitation/create", "sampling/createMessage"] as const).some(
        (method) =>
          clientSupportsInputRequest({
            clientCapabilities: capabilities,
            request: { method, params: {} },
          }),
      )
    ) {
      capabilitySessionId = encodeCapabilitySession({
        profileId,
        principal,
        capabilities,
      });
      if (!capabilitySessionId) {
        fastify.log.warn(
          { profileId },
          "Could not encode MCP capability session id",
        );
      }
    }
  }

  // Capabilities for this call: per-request `_meta` (2026-07-28 clients)
  // first, then the initialize-time declaration (legacy clients) from the
  // session id the client echoes, then from this process's memory.
  const clientCapabilities =
    readClientCapabilities(body) ??
    readCapabilitySession({
      sessionId: readHeader(request, MCP_SESSION_ID_HEADER),
      profileId,
      principal,
    }) ??
    clientCapabilityStore.lookup({ key: capabilityKey });

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

  // Validate and parse OpenAPPA session headers.
  let openappaSession: ReturnType<typeof sessionFromHeaders>;
  try {
    // Scope header-named sessions to the authenticated user principal.
    // Tokens without a user identity execute offers by offer_id alone.
    const namedSession = request.headers[APPA_SESSION_HEADER.toLowerCase()];
    if (namedSession !== undefined && !isWellFormedAppaId(namedSession))
      throw new ApiError(
        400,
        "OpenAPPA requires valid X-Appa-Session-ID and optional X-Appa-Parent-ID headers",
      );
    openappaSession =
      namedSession !== undefined &&
      tokenAuthContext?.organizationId &&
      tokenAuthContext.userId
        ? sessionFromHeaders({
            headers: request.headers,
            organizationId: tokenAuthContext.organizationId,
            callerId: `user:${tokenAuthContext.userId}`,
            scope: `user:${tokenAuthContext.userId}`,
          })
        : undefined;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    reply.status(error.statusCode);
    return {
      jsonrpc: "2.0",
      error: { code: -32600, message: error.message },
      id: (request.body as { id?: string | number })?.id ?? null,
    };
  }

  try {
    // Create fresh server and transport for each request (stateless mode)
    const { server } = await createAgentServer({
      openappaSession,
      currentToolCallId,
      agentId: profileId,
      tokenAuth: tokenAuthContext,
      runId,
      mrtr: {
        // Only a 2026-07-28 client can act on an InputRequiredResult. A legacy
        // client keeps the in-band elicitation it has always used.
        enabled: revision === STATELESS_MCP_PROTOCOL_REVISION,
        inputResponses: mrtrParams.inputResponses,
        round: mrtrRound,
        clientCapabilities,
      },
    });
    // A client that declares a server-initiated capability may be asked a
    // question mid-call (elicitation/create, sampling, ...). That needs an
    // SSE response stream: in JSON-response mode the transport silently drops
    // the mid-call request and the call hangs until the SDK timeout.
    const declaresServerInitiated = SERVER_INITIATED_METHODS.some((method) =>
      clientSupportsInputRequest({
        clientCapabilities,
        request: { method, params: {} },
      }),
    );
    // A call that may detach as a task keeps JSON: after detach there is no
    // live stream to elicit on, and the task must fail instead of elicit.
    const declaresTasks = (() => {
      if (typeof clientCapabilities !== "object" || clientCapabilities === null)
        return false;
      const extensions = (clientCapabilities as Record<string, unknown>)
        .extensions;
      return (
        typeof extensions === "object" &&
        extensions !== null &&
        "io.modelcontextprotocol/tasks" in extensions
      );
    })();
    const sseResponse = declaresServerInitiated && !declaresTasks;

    const transport = createStatelessTransport(profileId, { sseResponse });

    fastify.log.trace({ profileId }, "Connecting server to transport");
    await server.connect(transport);
    fastify.log.trace({ profileId }, "Server connected to transport");

    // Server.connect installs its own close hook. Compose with it so every
    // outstanding request loses its live transport as soon as it closes.
    const onTransportClose = transport.onclose;
    transport.onclose = () => {
      pendingInboundRequests.forgetTransport({ transport });
      onTransportClose?.();
    };

    // Register every server-initiated request the call sends so the client's
    // answer POST (a separate request in stateless mode) can be routed back
    // to this Server instead of a fresh one. The request goes out under the
    // wire id the registry issues, and so does a cancellation of it.
    const originalSend = transport.send.bind(transport);
    transport.send = async (message, options) => {
      if (isServerInitiatedRequestMessage(message)) {
        let wireId: string | undefined;
        try {
          wireId = pendingInboundRequests.register({
            id: message.id,
            transport,
            agentId: profileId,
            caller: principal,
          });
          return await originalSend({ ...message, id: wireId }, options);
        } catch (error) {
          if (wireId !== undefined) pendingInboundRequests.forget({ wireId });
          throw error;
        }
      }
      const cancelled = cancelledRequestId(message);
      const wireId =
        cancelled === undefined
          ? undefined
          : pendingInboundRequests.wireIdOf({ transport, id: cancelled });
      if (wireId !== undefined) {
        pendingInboundRequests.forget({ wireId });
        return originalSend(
          {
            ...message,
            params: {
              ...(message as { params: Record<string, unknown> }).params,
              requestId: wireId,
            },
          } as JSONRPCMessage,
          options,
        );
      }
      return originalSend(message, options);
    };

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
    if (capabilitySessionId) {
      reply.raw.setHeader(MCP_SESSION_ID_HEADER, capabilitySessionId);
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
        runId,
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

  // Legacy HTTP+SSE streams this process holds. Ended from `preClose`, before
  // Fastify drains the HTTP server: a held stream IS one of the in-flight
  // requests being drained, so ending it any later deadlocks the shutdown.
  // Clients then reconnect to a live replica instead of a dead socket.
  const legacySseSessions = new LegacySseSessionRegistry();
  fastify.addHook("preClose", async () => {
    legacySseSessions.close();
  });

  // GET opens the legacy HTTP+SSE stream for a client that asks for one. Any
  // other GET is answered 405: the gateway offers nothing else on GET, and a
  // Streamable HTTP client reads 405 as "no standalone stream" and stops.
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
          405: z.object({
            jsonrpc: z.literal("2.0"),
            error: z.object({
              code: z.number(),
              message: z.string(),
            }),
            id: z.null(),
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

      const { result: tokenAuth, reason } = await authenticateMCPGatewayRequest(
        profileId,
        token,
      );
      if (!tokenAuth) {
        setWWWAuthenticateHeader(request, reply);
        reply.status(401);
        return {
          error: "Unauthorized",
          message: describeGatewayAuthFailure(reason),
        };
      }

      // A legacy client reads its message endpoint from the stream. A
      // Streamable HTTP client that opens the optional standalone stream gets
      // the same stream and ignores the `endpoint` event; nothing is ever
      // pushed to it unasked.
      if (wantsLegacySseStream(request)) {
        await openLegacySseStream({
          request,
          reply,
          profileId,
          principal: deriveStatePrincipal(tokenAuth),
          registry: legacySseSessions,
        });
        return;
      }

      reply.header("Allow", "POST");
      reply.status(405);
      return {
        jsonrpc: "2.0" as const,
        error: {
          code: -32000,
          message:
            "Method not allowed. Use POST for MCP requests, or GET with Accept: text/event-stream for the legacy HTTP+SSE transport.",
        },
        id: null,
      };
    },
  );

  // Legacy HTTP+SSE message endpoint. The stream opened by GET announces this
  // URL, and the client POSTs every JSON-RPC message here. The answer goes
  // back on the stream, never in this response.
  fastify.post(
    `${endpoint}/:profileId/${LEGACY_SSE_MESSAGES_SEGMENT}`,
    {
      schema: {
        operationId: "mcpGatewaySseMessage",
        tags: ["MCP Gateway"],
        params: z.object({
          profileId: UuidOrSlugSchema,
        }),
        querystring: z.object({
          sessionId: z.string().uuid(),
        }),
        body: z.record(z.string(), z.unknown()),
        response: {
          202: z.object({ accepted: z.literal(true) }),
          401: z.object({
            error: z.string(),
            message: z.string(),
          }),
          404: z.object({
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const token = extractBearerToken(request);
      const profileId = await AgentModel.resolveIdFromIdOrSlug(
        request.params.profileId,
      );

      if (!profileId || !token) {
        setWWWAuthenticateHeader(request, reply);
        reply.status(401);
        return {
          error: "Unauthorized",
          message:
            "Missing or invalid Authorization header. Expected: Bearer <platform_token> or Bearer <agent-id>",
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
          error: "Unauthorized",
          message: describeGatewayAuthFailure(reason),
        };
      }

      // Bind the stream to its gateway and principal. Unknown sessions return
      // 404, avoiding an unnecessary OAuth retry for valid credentials.
      const session = await loadLegacySseSession(request.query.sessionId);
      if (
        !session ||
        session.profileId !== profileId ||
        session.principal !== deriveStatePrincipal(tokenAuth)
      ) {
        reply.status(404);
        return { error: "Not Found", message: "Unknown session" };
      }

      // Acknowledged now, answered on the stream: the client's POST must not
      // wait on a tool call, and the SDK's own SSE server answers 202 too.
      trackBackgroundWork(
        dispatchLegacySseMessage({
          request,
          registry: legacySseSessions,
          sessionId: request.query.sessionId,
          profileId,
          message: request.body,
        }).catch((error) => {
          fastify.log.error(
            { error, profileId },
            "Legacy SSE message dispatch failed",
          );
        }),
      );

      reply.status(202);
      return { accepted: true as const };
    },
  );

  // Native Agent Runtime clients use their existing MCP gateway credential to
  // publish a non-lifecycle attention signal. This stays separate from A2A
  // task state: a CLI waiting at its prompt is still a live, completable run.
  fastify.post(
    `${endpoint}/:profileId/runtime-status`,
    {
      schema: {
        operationId: "reportAgentRuntimeStatus",
        tags: ["MCP Gateway"],
        params: z.object({ profileId: UuidOrSlugSchema }),
        body: z.object({
          taskId: z.string().uuid(),
          attentionState: z.union([AgentRunAttentionStateSchema, z.null()]),
        }),
        response: constructResponseSchema(z.object({ updated: z.boolean() })),
      },
    },
    async (request, reply) => {
      const token = extractBearerToken(request);
      const profileId = await AgentModel.resolveIdFromIdOrSlug(
        request.params.profileId,
      );
      if (!profileId || !token) {
        throw new ApiError(401, "Unauthorized");
      }

      const tokenAuth = await validateMCPGatewayToken(profileId, token);
      if (!tokenAuth) {
        throw new ApiError(401, "Unauthorized");
      }

      const run = await AgentRunModel.findByTaskId(request.body.taskId);
      if (
        !run ||
        run.agentId !== profileId ||
        !runtimeTokenMatchesRun({ run, tokenAuth })
      ) {
        // Do not disclose another actor's task to a token that merely reaches
        // the same Agent.
        throw new ApiError(404, "Run not found");
      }

      const updated = await AgentRunModel.updateAttentionState({
        taskId: request.body.taskId,
        attentionState: request.body.attentionState,
      });
      return reply.send({ updated });
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
          error: {
            code: resolution.code,
            message: resolution.message,
            ...(resolution.data && { data: resolution.data }),
          },
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
            callerUserId: tokenAuth.userId ?? null,
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
        // Clients probe discover on a short timeout (Claude Code allows at
        // most five seconds), so the handshake log never delays the reply.
        trackBackgroundWork(
          logHandshake({
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
            runId: readHeader(request, RUN_ID_HEADER),
          }),
        );
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

      const runId = readHeader(request, RUN_ID_HEADER);
      const tokenAuthContext: TokenAuthContext = {
        tokenId: tokenAuth.tokenId,
        teamId: tokenAuth.teamId,
        isOrganizationToken: tokenAuth.isOrganizationToken,
        organizationId: tokenAuth.organizationId,
        ...(tokenAuth.isUserToken && { isUserToken: true }),
        ...(tokenAuth.userId && { userId: tokenAuth.userId }),
        ...(tokenAuth.isExternalIdp && { isExternalIdp: true }),
        ...(tokenAuth.rawToken && { rawToken: tokenAuth.rawToken }),
        ...(runId && { runId }),
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

const SERVER_INITIATED_METHODS = [
  "elicitation/create",
  "sampling/createMessage",
  "roots/list",
] as const;

function isServerInitiatedRequestMessage(
  message: JSONRPCMessage,
): message is JSONRPCMessage & { id: string | number } {
  return (
    typeof message === "object" &&
    message !== null &&
    "method" in message &&
    typeof message.method === "string" &&
    (SERVER_INITIATED_METHODS as readonly string[]).includes(message.method) &&
    "id" in message &&
    message.id !== undefined
  );
}

/** The request a `notifications/cancelled` message cancels, if it is one. */
function cancelledRequestId(
  message: JSONRPCMessage,
): string | number | undefined {
  if (
    !("method" in message) ||
    message.method !== "notifications/cancelled" ||
    "id" in message
  ) {
    return undefined;
  }
  const requestId = (message.params as { requestId?: unknown } | undefined)
    ?.requestId;
  return typeof requestId === "string" || typeof requestId === "number"
    ? requestId
    : undefined;
}

function runtimeTokenMatchesRun(params: {
  run: Pick<AgentRunRecord, "actorId" | "actorKind" | "organizationId">;
  tokenAuth: TokenAuthContext;
}): boolean {
  if (params.tokenAuth.organizationId !== params.run.organizationId) {
    return false;
  }
  switch (params.run.actorKind) {
    case "user":
      return params.tokenAuth.userId === params.run.actorId;
    case "team":
      return params.tokenAuth.teamId === params.run.actorId;
    case "organization":
    case "system":
      return params.tokenAuth.isOrganizationToken;
  }
}

export default mcpGatewayRoutes;
