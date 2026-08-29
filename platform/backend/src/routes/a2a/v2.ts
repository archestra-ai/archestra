import { createHash, randomUUID } from "node:crypto";
import { DocsPage, getDocsUrl } from "@archestra/shared";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { type A2AActor, A2AError } from "@/agents/a2a/a2a-base";
import { A2AManager } from "@/agents/a2a/a2a-manager";
import {
  type A2AProtocolCancelTaskRequest,
  A2AProtocolCancelTaskRequestSchema,
  type A2AProtocolDeleteTaskPushNotificationConfigRequest,
  A2AProtocolDeleteTaskPushNotificationConfigRequestSchema,
  type A2AProtocolGetTaskPushNotificationConfigRequest,
  A2AProtocolGetTaskPushNotificationConfigRequestSchema,
  type A2AProtocolGetTaskRequest,
  A2AProtocolGetTaskRequestSchema,
  type A2AProtocolListTaskPushNotificationConfigsRequest,
  A2AProtocolListTaskPushNotificationConfigsRequestSchema,
  type A2AProtocolListTasksRequest,
  A2AProtocolListTasksRequestSchema,
  A2AProtocolRole,
  type A2AProtocolSendMessageRequest,
  A2AProtocolSendMessageRequestSchema,
  type A2AProtocolStreamResponse,
  A2AProtocolSubscribeToTaskRequestSchema,
  type A2AProtocolTask,
  type A2AProtocolTaskPushNotificationConfig,
  A2AProtocolTaskPushNotificationConfigSchema,
  A2AProtocolTaskState,
  type A2AProtocolVersion,
  resolveA2AProtocolVersion,
  SUPPORTED_A2A_VERSION_LIST,
} from "@/agents/a2a/a2a-protocol";
import { a2aTaskEventNotifier } from "@/agents/a2a/a2a-task-event-notifier";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import config from "@/config";
import { AgentModel } from "@/models";
import {
  extractBearerToken,
  resolveTokenOrganizationId,
  validateMCPGatewayToken,
} from "@/routes/mcp-gateway/utils";
import { resolveAgentDeployment } from "@/services/runners/pod-execution";
import { type Agent, ApiError, UuidIdSchema } from "@/types";
import { isTerminalA2ATaskState } from "@/types/a2a-task";

/**
 * A2A (Agent-to-Agent) Protocol routes
 */

const A2AAgentCardSupportedInterfaceSchema = z.object({
  url: z.string(),
  protocolBinding: z.string(),
  protocolVersion: z.string(),
});

/**
 * A2A v1.0 `SecurityScheme` entries the card advertises. The gateway accepts
 * all of these on the same `Authorization: Bearer` header — platform tokens,
 * external IdP JWTs, and OAuth access tokens are distinguished by the
 * validator, not by the client — so they are declared as HTTP bearer schemes
 * with descriptions that tell a human operator which credential to mint.
 */
const A2AAgentCardSecuritySchemeSchema = z.object({
  type: z.string(),
  scheme: z.string().optional(),
  bearerFormat: z.string().optional(),
  description: z.string().optional(),
});

const A2AAgentCardSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string(),
  documentationUrl: z.string().optional(),
  provider: z.object({
    url: z.string(),
    organization: z.string(),
  }),
  supportedInterfaces: z.array(A2AAgentCardSupportedInterfaceSchema),
  capabilities: z.object({
    streaming: z.boolean(),
    pushNotifications: z.boolean(),
    extendedAgentCard: z.boolean(),
  }),
  securitySchemes: z.record(z.string(), A2AAgentCardSecuritySchemeSchema),
  securityRequirements: z.array(z.record(z.string(), z.array(z.string()))),
  defaultInputModes: z.array(z.string()),
  defaultOutputModes: z.array(z.string()),
  skills: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      tags: z.array(z.string()),
      examples: z.array(z.string()).optional(),
      inputModes: z.array(z.string()),
      outputModes: z.array(z.string()),
    }),
  ),
});

/**
 * Media types the agent accepts and produces. `text/plain` is listed first
 * because the protocol's text parts are the primary shape; `application/json`
 * covers structured `data` parts.
 */
const A2A_DEFAULT_INPUT_MODES = ["text/plain", "application/json"];
const A2A_DEFAULT_OUTPUT_MODES = ["text/plain", "application/json"];

const A2AJsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.any().optional(),
});

const A2AJsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});

const a2aRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const { endpoint } = config.a2aV2Gateway;
  const router = new A2AV2Router();

  // Registry: every agent card this credential can reach. A gateway token
  // belongs to a user, team, or organization rather than to one agent, so
  // "which agents can I talk to" is a real question that otherwise has no
  // answer over A2A — the agent id has to travel out of band.
  fastify.get(
    `${endpoint}/agents`,
    {
      schema: {
        description:
          "List the A2A AgentCards the presented credential is allowed to reach",
        tags: ["A2A"],
        response: {
          200: z.object({ agents: z.array(A2AAgentCardSchema) }),
        },
      },
    },
    async (request, reply) => {
      const token = extractBearerToken(request);
      if (!token) {
        reply.header("WWW-Authenticate", 'Bearer realm="a2a"');
        throw new ApiError(
          401,
          "Authorization header required. Use: Bearer <platform_token>",
        );
      }

      const organizationId = await resolveTokenOrganizationId(token);
      if (!organizationId) {
        reply.header(
          "WWW-Authenticate",
          'Bearer realm="a2a", error="invalid_token"',
        );
        // Also the answer for a credential that is only meaningful against a
        // named agent (an IdP JWT, an OAuth token): those clients already know
        // their agent and can fetch its card directly.
        throw new ApiError(
          401,
          "Listing agents requires a platform token. Fetch a specific agent's card instead.",
        );
      }

      const candidates =
        await AgentModel.findA2ARegistryCandidates(organizationId);

      // Authorize with the very same check the per-agent card endpoint runs,
      // rather than a second implementation that could drift and disclose an
      // agent a direct fetch would refuse.
      const permitted = await Promise.all(
        candidates.map(async (agent) =>
          (await validateMCPGatewayToken(agent.id, token)) ? agent : null,
        ),
      );

      const baseUrl = resolveA2ABaseUrl(request);
      const agents = permitted
        .filter((agent) => agent !== null)
        .map((agent) => buildAgentCard({ agent, baseUrl, endpoint }));

      // Per-principal output, so any cache must be private. Short-lived
      // because the set changes with team membership, not just card content.
      reply.header("Cache-Control", "private, max-age=60");
      return { agents };
    },
  );

  // GET AgentCard for an internal agent
  fastify.get(
    `${endpoint}/:agentId/.well-known/agent-card.json`,
    {
      schema: {
        description:
          "Get A2A AgentCard for an internal agent (must be agentType='agent')",
        tags: ["A2A"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        response: {
          200: A2AAgentCardSchema,
          // Conditional-request hit: bodiless by definition.
          304: z.undefined(),
        },
      },
    },
    async (request, reply) => {
      const { agentId } = request.params;
      const agent = await AgentModel.findById(agentId);

      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      // Only internal agents can be used for A2A
      if (agent.agentType !== "agent") {
        throw new ApiError(
          400,
          "Agent is not an internal agent (A2A requires agents with agentType='agent')",
        );
      }

      // Validate token authentication (reuse MCP Gateway utilities). The
      // WWW-Authenticate header tells an unauthenticated client which scheme
      // to retry with, as the A2A enterprise-readiness guidance asks.
      const token = extractBearerToken(request);
      if (!token) {
        reply.header("WWW-Authenticate", 'Bearer realm="a2a"');
        throw new ApiError(
          401,
          "Authorization header required. Use: Bearer <platform_token>",
        );
      }

      const tokenAuth = await validateMCPGatewayToken(agent.id, token);
      if (!tokenAuth) {
        reply.header(
          "WWW-Authenticate",
          'Bearer realm="a2a", error="invalid_token"',
        );
        throw new ApiError(401, "Invalid or unauthorized token");
      }

      const card = buildAgentCard({
        agent,
        baseUrl: resolveA2ABaseUrl(request),
        endpoint,
      });

      // Cards are cheap to recompute but clients poll them; a weak validator
      // keyed on the content lets a conditional request answer 304.
      const etag = `W/"${createHash("sha256").update(JSON.stringify(card)).digest("hex").slice(0, 32)}"`;
      reply.header("Cache-Control", "public, max-age=300");
      reply.header("ETag", etag);
      if (request.headers["if-none-match"] === etag) {
        return reply.code(304).send(undefined);
      }

      return reply.send(card);
    },
  );

  fastify.post(
    `${endpoint}/:agentId`,
    {
      schema: {
        description: "Main A2A JSON-RPC endpoint",
        tags: ["A2A"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: A2AJsonRpcRequestSchema,
        response: {
          200: A2AJsonRpcResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.body;
      const { agentId } = request.params;

      // Validate token authentication (reuse MCP Gateway utilities)
      const token = extractBearerToken(request);
      if (!token) {
        return reply.send({
          jsonrpc: "2.0" as const,
          id,
          error: {
            code: -32600,
            message:
              "Authorization header required. Use: Bearer <platform_token>",
          },
        });
      }

      // A2A v1.0 requires honoring the requested Major.Minor version, and
      // answering VersionNotSupportedError for anything else — serving 1.0
      // semantics to a client that asked for 2.x would be a silent mismatch.
      const version = resolveA2AProtocolVersion(request.headers["a2a-version"]);
      if (version === null) {
        return reply.send(
          buildJsonRpcErrorEnvelope(
            id,
            new A2AV2RouterError(A2AV2RouterErrorKind.VersionNotSupported),
          ),
        );
      }

      // The streaming methods return an SSE stream (text/event-stream) rather
      // than a single buffered JSON-RPC reply; hand off to the dedicated
      // handler. Pre-flight failures there still surface as a normal JSON-RPC
      // error before any SSE frame is written.
      if (STREAMING_METHODS.has(request.body.method)) {
        return streamA2AResponse({
          router,
          agentId,
          token,
          body: request.body,
          version,
          reply,
        });
      }

      try {
        const result = await router.request(agentId, token, request.body);
        return reply.send({
          jsonrpc: "2.0" as const,
          id,
          result,
        });
      } catch (error) {
        return reply.send(buildJsonRpcErrorEnvelope(id, error));
      }
    },
  );
};

/**
 * JSON-RPC methods whose response is a `text/event-stream` of
 * {@link A2AProtocolStreamResponse} events rather than a single buffered reply.
 * Named to match the A2A protocol's method names, mirroring the buffered
 * `SendMessage`/`GetTask`/`CancelTask`/`ListTasks` methods this router
 * dispatches.
 */
const STREAMING_METHODS = new Set(["SendStreamingMessage", "SubscribeToTask"]);

type A2AJsonRpcId = string | number;

/**
 * Serve `SendStreamingMessage` / `SubscribeToTask` as Server-Sent Events. Each
 * SSE `data:` frame is a JSON-RPC response carrying one
 * {@link A2AProtocolStreamResponse}.
 *
 * Both methods share one engine: the durable per-task event log. A
 * SendStreamingMessage creates (or resumes) a task whose run continues in the
 * task run service, and this handler — like any later SubscribeToTask — just
 * follows the task's events until a terminal or input-required state. A client
 * disconnect therefore only detaches this subscriber; the run keeps going and
 * can be re-joined.
 *
 * The wire shape is version-switched (`A2A-Version` header): the legacy shape
 * reproduces the pre-task stream exactly (immediate Working signal, per-chunk
 * Working status updates with `final: false`, a `task` frame + `final: true`
 * status update at the end); the v1.0 shape is the spec's lifecycle stream
 * (initial `task` frame, statusUpdate/artifactUpdate events, no `final`).
 *
 * Pre-flight resolution/validation errors are returned as an ordinary
 * JSON-RPC error reply because no SSE frame has been written yet; a failure
 * during execution surfaces as the task's FAILED status event (and, for
 * blocking legacy compatibility, a JSON-RPC error frame on send failures).
 */
async function streamA2AResponse(params: {
  router: A2AV2Router;
  agentId: string;
  token: string;
  body: { id: A2AJsonRpcId };
  version: A2AProtocolVersion;
  reply: FastifyReply;
}): Promise<FastifyReply | undefined> {
  const { router, agentId, token, body, version, reply } = params;
  const { id } = body;

  // Pre-flight: validate the method/params and resolve the agent + actor before
  // committing to an SSE response, so these errors are returned as a normal
  // JSON-RPC reply the client can read as a plain 200 body. For
  // SubscribeToTask this includes the terminal-task check (-32004): the spec
  // says finished work is fetched with GetTask, not subscribed to.
  let prepared: Awaited<ReturnType<A2AV2Router["prepareStreamingRequest"]>>;
  try {
    prepared = await router.prepareStreamingRequest(agentId, token, body);
  } catch (error) {
    return reply.send(buildJsonRpcErrorEnvelope(id, error));
  }

  // From here the response is an SSE stream: take over the socket and set the
  // event-stream headers. Content-Encoding: none prevents compression
  // middleware/proxies from buffering the stream.
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Encoding": "none",
  });

  // The client can disconnect at any point mid-stream; writing to the
  // destroyed socket then throws ERR_STREAM_DESTROYED. Skip the write instead.
  const writeEvent = (result: A2AProtocolStreamResponse) => {
    if (raw.destroyed) return;
    raw.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`);
  };

  // A long agent turn can run for a minute-plus (e.g. a slow first tool call)
  // with no event to emit. Without traffic on the connection, an intermediary
  // (load balancer / reverse proxy) with an idle-read timeout will drop it
  // before the answer arrives. Emit an SSE comment heartbeat on an interval so
  // the connection keeps flowing bytes across those silent gaps. Comment lines
  // (`:`-prefixed) are ignored by SSE clients.
  const heartbeat = setInterval(() => {
    if (raw.destroyed) return;
    raw.write(`: keep-alive\n\n`);
  }, SSE_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  // A disconnect only detaches this subscriber — the run itself belongs to
  // the task run service and keeps going (rejoin with SubscribeToTask, poll
  // with GetTask, stop with CancelTask).
  // Aborted rather than just flagged: the follow loop parks on a notification
  // wait between reads, and must drop it the moment the client goes away
  // instead of holding the handler until the wait times out.
  const clientGone = new AbortController();
  raw.on("close", () => {
    clientGone.abort();
  });

  try {
    if (prepared.kind === "subscribe") {
      // SubscribeToTask: snapshot first, then follow the event log from the
      // snapshot's watermark. Always the v1.0 shape — the method itself is
      // v1.0-era, so there is no legacy stream contract to reproduce.
      writeEvent({ task: prepared.subscription.task });
      await followTaskEvents({
        router,
        agentId,
        actor: prepared.actor,
        taskId: prepared.subscription.taskId,
        fromSeq: prepared.subscription.watermark,
        version: "v1",
        writeEvent,
        clientGone: clientGone.signal,
        emitLegacyInterruptFraming: false,
      });
      return undefined;
    }

    // SendStreamingMessage. Legacy clients expect an immediate Working signal
    // before the first token; for v1.0 the stream MUST instead open with the
    // Task object, which is emitted as soon as the detached run hands us the
    // task snapshot below.
    const sendRequest = prepared.request;
    let detachedRun: { taskId: string; followFromSeq: number } | undefined;

    const response = await router.sendStreamingMessage({
      actor: prepared.actor,
      agentId: prepared.agentId,
      request: sendRequest,
      onDetachedTaskRun: (info) => {
        detachedRun = info;
      },
    });

    if (!response.task) {
      // Should not happen (a streaming send always produces a task in full
      // task mode) — but fail loudly rather than hanging the stream.
      throw new Error("Streaming send produced no task");
    }

    if (version === "v1") {
      writeEvent({ task: response.task });
    } else {
      writeEvent({
        statusUpdate: {
          taskId: response.task.id,
          contextId: response.task.contextId ?? "",
          status: { state: A2AProtocolTaskState.Working },
          final: false,
        },
      });
    }

    if (detachedRun) {
      await followTaskEvents({
        router,
        agentId,
        actor: prepared.actor,
        taskId: detachedRun.taskId,
        fromSeq: detachedRun.followFromSeq,
        version,
        writeEvent,
        clientGone: clientGone.signal,
        emitLegacyInterruptFraming: version === "legacy",
      });
    } else {
      // No run started (e.g. approval decisions applied with requests still
      // pending): the buffered task response is the whole story — emit it
      // terminally the way the legacy shape always has.
      writeEvent({
        statusUpdate: {
          taskId: response.task.id,
          contextId: response.task.contextId ?? "",
          status: response.task.status,
          ...(version === "legacy" ? { final: true } : {}),
        },
      });
    }
  } catch (error) {
    if (!raw.destroyed) {
      const { code, message } = jsonRpcErrorParts(error);
      raw.write(
        `data: ${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n\n`,
      );
    }
  } finally {
    clearInterval(heartbeat);
    if (!raw.destroyed) raw.end();
  }
}

/**
 * How long a stream waits for new task events before re-reading anyway.
 *
 * A cross-replica LISTEN/NOTIFY wake normally arrives the moment the writing
 * pod commits, so this is the safety net rather than the mechanism: it bounds
 * how long a stream can lag if a notification is missed (the listener was
 * reconnecting) or never sent (polling-compatibility mode behind a
 * transaction pooler). Seconds, not milliseconds, because the notify carries
 * the latency in the normal case.
 */
const TASK_EVENT_POLL_INTERVAL_MS = 5_000;

/**
 * Follow a task's durable event log from `fromSeq` until the task reaches a
 * terminal or input-required state, translating each event into the client's
 * negotiated wire shape. Events are strictly seq-ordered, and because terminal
 * events commit atomically with terminal states, observing a terminal state
 * guarantees the terminal event has been delivered — so concurrent subscribers
 * all see the same events in the same order.
 */
async function followTaskEvents(params: {
  router: A2AV2Router;
  agentId: string;
  actor: A2AActor;
  taskId: string;
  fromSeq: number;
  version: A2AProtocolVersion;
  writeEvent: (event: A2AProtocolStreamResponse) => void;
  clientGone: AbortSignal;
  /**
   * The legacy SendStreamingMessage contract ends an approval-interrupted
   * stream with a full `task` frame (carrying the approval metadata) followed
   * by a `final: true` status update — a completed stream just ends with its
   * terminal status update. SubscribeToTask never uses this framing.
   */
  emitLegacyInterruptFraming: boolean;
}): Promise<void> {
  const { router, taskId, version, writeEvent } = params;
  let lastSeq = params.fromSeq;

  while (!params.clientGone.aborted) {
    const snapshot = await router.readTaskEventsAfter({
      taskId,
      afterSeq: lastSeq,
    });
    if (!snapshot) {
      // Task row gone (its context was deleted): nothing left to follow.
      return;
    }

    for (const event of snapshot.events) {
      lastSeq = event.seq;
      for (const translated of translateEventForVersion(
        event.payload,
        version,
      )) {
        writeEvent(translated);
      }
    }

    if (snapshot.state === A2AProtocolTaskState.InputRequired) {
      if (params.emitLegacyInterruptFraming) {
        const task = await router.getTaskForStream({
          actor: params.actor,
          agentId: params.agentId,
          taskId,
        });
        writeEvent({ task });
        writeEvent({
          statusUpdate: {
            taskId,
            contextId: task.contextId ?? "",
            status: task.status,
            final: true,
          },
        });
      }
      return;
    }
    if (isTerminalA2ATaskState(snapshot.state)) {
      // The terminal status event committed with the state, so it has already
      // been written by the drain above.
      return;
    }

    // Woken by the writing pod's notify, or by the fallback timeout.
    await a2aTaskEventNotifier.wait({
      key: taskId,
      timeoutMs: TASK_EVENT_POLL_INTERVAL_MS,
      abortSignal: params.clientGone,
    });
  }
}

/**
 * Translate one persisted stream event into the client's wire shape.
 *
 * v1.0 clients receive events as persisted, except the legacy `final` flag is
 * never added. Legacy clients pre-date artifacts: artifact chunk events
 * become the Working status updates with per-chunk text the old stream
 * emitted (the artifact seal — `lastChunk`, a content REPLACE — must be
 * dropped, appending it would corrupt the concatenated text), and terminal
 * status updates gain `final: true`.
 */
function translateEventForVersion(
  payload: A2AProtocolStreamResponse,
  version: A2AProtocolVersion,
): A2AProtocolStreamResponse[] {
  if (version === "v1") {
    return [payload];
  }

  if (payload.artifactUpdate) {
    const { artifactUpdate } = payload;
    if (artifactUpdate.lastChunk) {
      return [];
    }
    const chunkText = artifactUpdate.artifact.parts
      .map((part) => part.text ?? "")
      .join("");
    return [
      {
        statusUpdate: {
          taskId: artifactUpdate.taskId,
          contextId: artifactUpdate.contextId,
          status: {
            state: A2AProtocolTaskState.Working,
            message: {
              messageId: randomUUID(),
              role: A2AProtocolRole.Agent,
              parts: [{ text: chunkText }],
            },
          },
          final: false,
        },
      },
    ];
  }

  if (payload.statusUpdate) {
    // Legacy interrupt framing (task frame + final status) covers
    // INPUT_REQUIRED, so the raw event is suppressed to avoid a stray
    // `final: false` frame the old stream never emitted.
    if (
      payload.statusUpdate.status.state === A2AProtocolTaskState.InputRequired
    ) {
      return [];
    }
    const terminal = isTerminalA2ATaskState(payload.statusUpdate.status.state);
    return [
      {
        statusUpdate: { ...payload.statusUpdate, final: terminal },
      },
    ];
  }

  return [payload];
}

/**
 * How often the streaming handler emits an SSE comment heartbeat while an agent
 * turn is in progress, to keep intermediaries from closing an otherwise-idle
 * connection during long silent gaps between text deltas.
 */
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Build one agent's card. Shared by the per-agent well-known endpoint and the
 * registry so the two can never describe the same agent differently.
 */
function buildAgentCard(params: {
  agent: Pick<
    Agent,
    "id" | "name" | "description" | "systemPrompt" | "updatedAt"
  >;
  baseUrl: string;
  endpoint: string;
}) {
  const { agent, baseUrl, endpoint } = params;
  const securitySchemes = buildA2ASecuritySchemes();

  // A single skill representing the agent. `tags` is REQUIRED by the spec and
  // is what LLM-driven agent selection reads, so derive something meaningful
  // rather than shipping an empty list.
  const skillId = agent.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

  return {
    name: agent.name,
    description: agent.description || agent.systemPrompt || "",
    // Clients cache the card against this value, so it must move whenever the
    // card's content can — the agent's own revision timestamp is the one
    // thing that does.
    version: buildCardVersion(agent.updatedAt),
    documentationUrl: getDocsUrl(DocsPage.PlatformAgentTriggersWebhookA2a),
    // Who runs this agent. `url` is the deployment itself rather than the
    // vendor documentation already carried by `documentationUrl` — for a
    // self-hosted install that is the part which actually identifies the
    // provider.
    provider: {
      url: baseUrl,
      organization: archestraMcpBranding.appName,
    },
    supportedInterfaces: [
      {
        url: `${baseUrl}${endpoint}/${agent.id}`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ],
    capabilities: {
      streaming: true,
      pushNotifications: true,
      // We serve exactly one card, and it is already authenticated, so there
      // is no separate extended card to fetch.
      extendedAgentCard: false,
    },
    securitySchemes,
    // Any one of the declared schemes is sufficient; each alternative is its
    // own requirement object per the spec's OpenAPI-style semantics.
    securityRequirements: Object.keys(securitySchemes).map((name) => ({
      [name]: [],
    })),
    defaultInputModes: A2A_DEFAULT_INPUT_MODES,
    defaultOutputModes: A2A_DEFAULT_OUTPUT_MODES,
    skills: [
      {
        id: skillId,
        name: agent.name,
        description: agent.description || agent.systemPrompt || agent.name,
        tags: buildSkillTags(agent.name),
        examples: [`Ask ${agent.name} a question and read the reply.`],
        inputModes: A2A_DEFAULT_INPUT_MODES,
        outputModes: A2A_DEFAULT_OUTPUT_MODES,
      },
    ],
  };
}

/**
 * Authentication schemes the gateway accepts, declared so a client can
 * discover how to authenticate instead of having to already know. All three
 * ride the same bearer header — the validator distinguishes them — so they
 * differ only in how the operator obtains the credential.
 */
function buildA2ASecuritySchemes() {
  const appName = archestraMcpBranding.appName;
  return {
    platformToken: {
      type: "http",
      scheme: "bearer",
      description: `${appName} platform token (personal, team, or organization) issued in the ${appName} UI.`,
    },
    identityProviderJwt: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
      description:
        "JWT issued by an identity provider bound to this agent, validated against the provider's JWKS.",
    },
    oauthAccessToken: {
      type: "http",
      scheme: "bearer",
      description: `Access token from an ${appName} OAuth client permitted to reach this agent.`,
    },
  };
}

/**
 * Base URL clients should dial, taken from the forwarded protocol. The spec
 * requires an absolute HTTPS URL outside local development, so a proxy that
 * forgot the header must not cause us to advertise a downgrade to http.
 */
function resolveA2ABaseUrl(request: {
  headers: Record<string, string | string[] | undefined>;
}): string {
  const host = (request.headers.host as string) || "localhost:9000";
  const forwarded = request.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (proto) {
    return `${proto}://${host}`;
  }
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  return `${isLocal ? "http" : "https"}://${host}`;
}

/** Card `version`, moved by anything that can change the card's content. */
function buildCardVersion(updatedAt: Date | null): string {
  return updatedAt ? String(Math.floor(updatedAt.getTime() / 1000)) : "1";
}

/** Lowercase word tags derived from the agent name, for agent selection. */
function buildSkillTags(agentName: string): string[] {
  const tags = agentName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);
  return tags.length > 0 ? Array.from(new Set(tags)) : ["agent"];
}

/** JSON-RPC error `code`/`message` for an error thrown during A2A handling. */
function jsonRpcErrorParts(error: unknown): { code: number; message: string } {
  if (error instanceof A2AV2RouterError || error instanceof A2AError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof z.ZodError) {
    return { code: -32600, message: "Invalid Request" };
  }
  return {
    code: -32603,
    message: error instanceof Error ? error.message : "Internal error",
  };
}

/** Full JSON-RPC error response envelope for a buffered (non-SSE) reply. */
function buildJsonRpcErrorEnvelope(id: A2AJsonRpcId, error: unknown) {
  if (error instanceof A2AV2RouterError || error instanceof A2AError) {
    return {
      jsonrpc: "2.0" as const,
      id,
      error: { code: error.code, message: error.message },
    };
  }
  if (error instanceof z.ZodError) {
    return {
      jsonrpc: "2.0" as const,
      id,
      error: {
        code: -32600,
        message: "Invalid Request",
        data: z.treeifyError(error),
      },
    };
  }
  return {
    jsonrpc: "2.0" as const,
    id,
    error: {
      code: -32603,
      message: "Internal error",
      data: {
        reason: error instanceof Error ? error.message : String(error),
      },
    },
  };
}

enum A2AV2RouterErrorKind {
  MethodNotFound,
  AgentNotFound,
  AgentNotInternal,
  FailedToResolveActor,
  VersionNotSupported,
}

const A2A_V2_ROUTER_ERRORS = {
  [A2AV2RouterErrorKind.MethodNotFound]: {
    code: -32601,
    message: "Method not found",
  },
  // -32006 is the spec's InvalidAgentResponseError; an unknown agent is a bad
  // request parameter, which is what the manager's own errors already use.
  [A2AV2RouterErrorKind.AgentNotFound]: {
    code: -32602,
    message: "Agent not found",
  },
  [A2AV2RouterErrorKind.VersionNotSupported]: {
    code: -32009,
    message: `Unsupported A2A-Version. This endpoint serves: ${SUPPORTED_A2A_VERSION_LIST.join(", ")}`,
  },
  [A2AV2RouterErrorKind.AgentNotInternal]: {
    code: -32602,
    message:
      "Agent is not an internal agent (A2A requires agents with agentType='agent')",
  },
  [A2AV2RouterErrorKind.FailedToResolveActor]: {
    code: -32602,
    message: "Failed to resolve actor from token",
  },
};

class A2AV2RouterError extends Error {
  public readonly code: number;
  public readonly message: string;

  constructor(kind: A2AV2RouterErrorKind, details?: string) {
    const baseError = A2A_V2_ROUTER_ERRORS[kind];
    super(details ? `${baseError.message}: ${details}` : baseError.message);
    this.code = baseError.code;
    this.message = details
      ? `${baseError.message}: ${details}`
      : baseError.message;
  }
}

type A2ARouteFunc = (params: {
  actor: A2AActor;
  agentId: string;
  request:
    | A2AProtocolSendMessageRequest
    | A2AProtocolGetTaskRequest
    | A2AProtocolCancelTaskRequest
    | A2AProtocolListTasksRequest
    | A2AProtocolTaskPushNotificationConfig
    | A2AProtocolGetTaskPushNotificationConfigRequest
    | A2AProtocolListTaskPushNotificationConfigsRequest
    | A2AProtocolDeleteTaskPushNotificationConfigRequest;
}) => Promise<unknown>;

/** A validated SSE request: a streaming send, or a task subscription. */
type PreparedStreamingRequest =
  | {
      kind: "send";
      actor: A2AActor;
      agentId: string;
      request: A2AProtocolSendMessageRequest;
    }
  | {
      kind: "subscribe";
      actor: A2AActor;
      agentId: string;
      subscription: {
        task: A2AProtocolTask;
        taskId: string;
        watermark: number;
      };
    };

class A2AV2Router {
  private readonly manager: A2AManager;

  constructor() {
    // The v2 protocol surface drives the full durable task lifecycle;
    // internal consumers (chatops) construct their own managers in the
    // default approval-only mode.
    this.manager = new A2AManager({ taskMode: "full" });
  }

  async request(agentId: string, token: string, request: unknown) {
    const { method, params } = A2AJsonRpcRequestSchema.parse(request);
    const agent = await this.getAgentById(agentId);
    const actor = await this.resolveActor(agentId, token);
    const { func, schema } = this.getRouteForMethod(
      method,
      Boolean(resolveAgentDeployment(agent)),
    );

    // Throws ZodError if request schema is invalid
    schema.parse(params);

    return await func({ actor, agentId: agent.id, request: params });
  }

  /**
   * Validate a `SendStreamingMessage` / `SubscribeToTask` request and resolve
   * its agent + actor, without starting a run. Split out from execution so the
   * route can surface resolution/validation failures (including
   * SubscribeToTask's terminal-task -32004) as an ordinary JSON-RPC error
   * before it commits to an SSE response.
   */
  async prepareStreamingRequest(
    agentId: string,
    token: string,
    request: unknown,
  ): Promise<PreparedStreamingRequest> {
    const { method, params } = A2AJsonRpcRequestSchema.parse(request);
    if (!STREAMING_METHODS.has(method)) {
      throw new A2AV2RouterError(A2AV2RouterErrorKind.MethodNotFound);
    }
    const agent = await this.getAgentById(agentId);
    const actor = await this.resolveActor(agentId, token);

    if (method === "SubscribeToTask") {
      const parsed = A2AProtocolSubscribeToTaskRequestSchema.parse(params);
      const subscription = await this.manager.subscribeToTask({
        actor,
        agentId: agent.id,
        request: parsed,
      });
      return { kind: "subscribe", actor, agentId: agent.id, subscription };
    }

    const parsed = A2AProtocolSendMessageRequestSchema.parse(params);
    return { kind: "send", actor, agentId: agent.id, request: parsed };
  }

  /**
   * Execute a prepared streaming send as a detached task run: the returned
   * response carries the task snapshot, and `onDetachedTaskRun` hands the
   * caller the event watermark to follow the run from.
   */
  async sendStreamingMessage(params: {
    actor: A2AActor;
    agentId: string;
    request: A2AProtocolSendMessageRequest;
    onDetachedTaskRun: (info: {
      taskId: string;
      followFromSeq: number;
    }) => void;
  }) {
    return this.manager.sendMessage({
      ...params,
      taskRun: { createTask: true, detached: true },
    });
  }

  /** Poll step for SSE streams following a task's event log. */
  async readTaskEventsAfter(params: { taskId: string; afterSeq: number }) {
    return this.manager.readTaskEventsAfter(params);
  }

  /** Task refresh for the legacy stream's terminal `task` frame. */
  async getTaskForStream(params: {
    actor: A2AActor;
    agentId: string;
    taskId: string;
  }): Promise<A2AProtocolTask> {
    return this.manager.getTask({
      actor: params.actor,
      agentId: params.agentId,
      request: { id: params.taskId },
    });
  }

  private getRouteForMethod(method: string, usesBackgroundExecution = false) {
    const mapper: Record<string, { func: A2ARouteFunc; schema: z.ZodSchema }> =
      {
        SendMessage: {
          func: async (params) => {
            const request = params.request as A2AProtocolSendMessageRequest;
            return this.manager.sendMessage({
              ...params,
              request,
              // `return_immediately` (A2A v1.0): hand back the task the
              // moment it exists and run detached; the default (blocking)
              // keeps the pre-existing await-the-answer behavior.
              ...(usesBackgroundExecution ||
              request.configuration?.returnImmediately
                ? {
                    taskRun: {
                      createTask: true,
                      detached: Boolean(
                        request.configuration?.returnImmediately,
                      ),
                    },
                  }
                : {}),
            });
          },
          schema: A2AProtocolSendMessageRequestSchema,
        },
        GetTask: {
          func: async (params) =>
            this.manager.getTask({
              ...params,
              request: params.request as A2AProtocolGetTaskRequest,
            }),
          schema: A2AProtocolGetTaskRequestSchema,
        },
        CancelTask: {
          func: async (params) =>
            this.manager.cancelTask({
              ...params,
              request: params.request as A2AProtocolCancelTaskRequest,
            }),
          schema: A2AProtocolCancelTaskRequestSchema,
        },
        ListTasks: {
          func: async (params) =>
            this.manager.listTasks({
              ...params,
              request: params.request as A2AProtocolListTasksRequest,
            }),
          schema: A2AProtocolListTasksRequestSchema,
        },
        CreateTaskPushNotificationConfig: {
          func: async (params) =>
            this.manager.createTaskPushNotificationConfig({
              ...params,
              request: params.request as A2AProtocolTaskPushNotificationConfig,
            }),
          schema: A2AProtocolTaskPushNotificationConfigSchema,
        },
        GetTaskPushNotificationConfig: {
          func: async (params) =>
            this.manager.getTaskPushNotificationConfig({
              ...params,
              request:
                params.request as A2AProtocolGetTaskPushNotificationConfigRequest,
            }),
          schema: A2AProtocolGetTaskPushNotificationConfigRequestSchema,
        },
        ListTaskPushNotificationConfigs: {
          func: async (params) =>
            this.manager.listTaskPushNotificationConfigs({
              ...params,
              request:
                params.request as A2AProtocolListTaskPushNotificationConfigsRequest,
            }),
          schema: A2AProtocolListTaskPushNotificationConfigsRequestSchema,
        },
        DeleteTaskPushNotificationConfig: {
          func: async (params) =>
            this.manager.deleteTaskPushNotificationConfig({
              ...params,
              request:
                params.request as A2AProtocolDeleteTaskPushNotificationConfigRequest,
            }),
          schema: A2AProtocolDeleteTaskPushNotificationConfigRequestSchema,
        },
      };
    const route = mapper[method];
    if (!route) {
      throw new A2AV2RouterError(A2AV2RouterErrorKind.MethodNotFound);
    }
    return route;
  }

  private async getAgentById(agentId: string) {
    const agent = await AgentModel.findById(agentId);
    if (!agent) {
      throw new A2AV2RouterError(A2AV2RouterErrorKind.AgentNotFound);
    }
    if (agent.agentType !== "agent") {
      throw new A2AV2RouterError(A2AV2RouterErrorKind.AgentNotInternal);
    }
    return agent;
  }

  private async resolveActor(
    agentId: string,
    token: string,
  ): Promise<A2AActor> {
    try {
      return await this.manager.resolveActorByMCPGatewayToken(agentId, token);
    } catch (error) {
      if (error instanceof A2AError) {
        throw new A2AV2RouterError(A2AV2RouterErrorKind.FailedToResolveActor);
      }
      throw error;
    }
  }
}

export default a2aRoutes;
