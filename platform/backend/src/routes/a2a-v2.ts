import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { type A2AActor, A2AError } from "@/agents/a2a/a2a-base";
import { A2AManager } from "@/agents/a2a/a2a-manager";
import {
  type A2AProtocolGetTaskRequest,
  A2AProtocolGetTaskRequestSchema,
  A2AProtocolRole,
  type A2AProtocolSendMessageRequest,
  A2AProtocolSendMessageRequestSchema,
  type A2AProtocolSendMessageResponse,
  type A2AProtocolStreamResponse,
  A2AProtocolTaskState,
} from "@/agents/a2a/a2a-protocol";
import config from "@/config";
import { AgentModel } from "@/models";
import {
  extractBearerToken,
  validateMCPGatewayToken,
} from "@/routes/mcp-gateway.utils";
import { ApiError, UuidIdSchema } from "@/types";

/**
 * A2A (Agent-to-Agent) Protocol routes
 */

const A2AAgentCardSupportedInterfaceSchema = z.object({
  url: z.string(),
  protocolBinding: z.string(),
  protocolVersion: z.string(),
});

const A2AAgentCardSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string(),
  supportedInterfaces: z.array(A2AAgentCardSupportedInterfaceSchema),
  capabilities: z.object({
    streaming: z.boolean(),
    pushNotifications: z.boolean(),
    stateTransitionHistory: z.boolean(),
  }),
  defaultInputModes: z.array(z.string()),
  defaultOutputModes: z.array(z.string()),
  skills: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      tags: z.array(z.string()),
      inputModes: z.array(z.string()),
      outputModes: z.array(z.string()),
    }),
  ),
});

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

      // Validate token authentication (reuse MCP Gateway utilities)
      const token = extractBearerToken(request);
      if (!token) {
        throw new ApiError(
          401,
          "Authorization header required. Use: Bearer <platform_token>",
        );
      }

      const tokenAuth = await validateMCPGatewayToken(agent.id, token);
      if (!tokenAuth) {
        throw new ApiError(401, "Invalid or unauthorized token");
      }

      // Construct base URL from request
      const protocol = request.headers["x-forwarded-proto"] || "http";
      const host = request.headers.host || "localhost:9000";
      const baseUrl = `${protocol}://${host}`;

      // Build skills array with a single skill representing the agent
      const skillId = agent.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
      const skills = [
        {
          id: skillId,
          name: agent.name,
          description: agent.description || "",
          tags: [],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
        },
      ];

      return reply.send({
        name: agent.name,
        description: agent.description || agent.systemPrompt || "",
        version: "1",
        supportedInterfaces: [
          {
            url: `${baseUrl}${endpoint}/${agent.id}`,
            protocolBinding: "JSONRPC",
            protocolVersion: "1.0",
          },
        ],
        capabilities: {
          streaming: true,
          pushNotifications: false,
          stateTransitionHistory: false,
        },
        defaultInputModes: ["application/json"],
        defaultOutputModes: ["application/json"],
        skills,
      });
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

      // The streaming method returns an SSE stream (text/event-stream) rather
      // than a single buffered JSON-RPC reply; hand off to its dedicated
      // handler. Pre-flight failures there still surface as a normal JSON-RPC
      // error before any SSE frame is written.
      if (request.body.method === STREAMING_METHOD) {
        return streamA2AResponse({
          router,
          agentId,
          token,
          body: request.body,
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
 * The JSON-RPC method whose response is a `text/event-stream` of
 * {@link A2AProtocolStreamResponse} events rather than a single buffered reply.
 * Named to match the A2A protocol's gRPC-transport streaming method, mirroring
 * the buffered `SendMessage`/`GetTask` methods this router already dispatches.
 */
const STREAMING_METHOD = "SendStreamingMessage";

type A2AJsonRpcId = string | number;

/**
 * Stream an agent response as Server-Sent Events for a `SendStreamingMessage`
 * request. Each SSE `data:` frame is a JSON-RPC response carrying one
 * {@link A2AProtocolStreamResponse}: an incremental `Working` status update per
 * text delta, then a terminal `final: true` status update (plus the full task
 * when the run ends input-required). Pre-flight resolution/validation errors are
 * returned as an ordinary JSON-RPC error reply because no SSE frame has been
 * written yet; a failure during execution is emitted as a JSON-RPC error frame.
 */
async function streamA2AResponse(params: {
  router: A2AV2Router;
  agentId: string;
  token: string;
  body: { id: A2AJsonRpcId };
  reply: FastifyReply;
}): Promise<FastifyReply | undefined> {
  const { router, agentId, token, body, reply } = params;
  const { id } = body;

  // Pre-flight: validate the method/params and resolve the agent + actor before
  // committing to an SSE response, so these errors are returned as a normal
  // JSON-RPC reply the client can read as a plain 200 body.
  let prepared: {
    actor: A2AActor;
    agentId: string;
    request: A2AProtocolSendMessageRequest;
  };
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

  // The client can disconnect at any point mid-stream; writing to the destroyed
  // socket then throws ERR_STREAM_DESTROYED. Skip the write instead — the run is
  // already being aborted by the "close" handler below. This guards the initial
  // and terminal frames written directly here; the per-delta writes are further
  // shielded by the executor's own try/catch around onTextDelta.
  const writeEvent = (result: A2AProtocolStreamResponse) => {
    if (raw.destroyed) return;
    raw.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`);
  };

  // A long agent turn can run for a minute-plus (e.g. a slow first tool call)
  // with no text delta to emit. Without traffic on the connection, an
  // intermediary (load balancer / reverse proxy) with an idle-read timeout will
  // drop it before the answer arrives — the failure mode a synchronous request
  // hits. Emit an SSE comment heartbeat on an interval so the connection keeps
  // flowing bytes across those silent gaps. Comment lines (`:`-prefixed) are
  // ignored by SSE clients, so they never interleave with the JSON-RPC events.
  const heartbeat = setInterval(() => {
    // A write here after the client disconnects would throw inside the timer
    // callback and escape as an unhandled exception, so guard the socket.
    if (raw.destroyed) return;
    raw.write(`: keep-alive\n\n`);
  }, SSE_HEARTBEAT_INTERVAL_MS);
  // Don't let the heartbeat timer hold the event loop open on its own.
  heartbeat.unref?.();

  // Cancel the underlying agent run if the client disconnects before the stream
  // completes, so a dropped SSE connection does not leave the LLM call running.
  const abortController = new AbortController();
  let finished = false;
  raw.on("close", () => {
    if (!finished) {
      abortController.abort();
    }
  });

  // Correlates every status update of this stream. Reuse the client-supplied
  // taskId when resuming a task; otherwise a fresh id frames the updates (the
  // stateless completion path persists no task).
  const contextId = prepared.request.message.contextId;
  const streamTaskId = prepared.request.message.taskId ?? randomUUID();

  // Immediate "working" signal so the client sees the stream is live before the
  // first token arrives.
  writeEvent({
    statusUpdate: {
      taskId: streamTaskId,
      contextId,
      status: { state: A2AProtocolTaskState.Working },
      final: false,
    },
  });

  try {
    const response = await router.streamMessage({
      actor: prepared.actor,
      agentId: prepared.agentId,
      request: prepared.request,
      abortSignal: abortController.signal,
      onTextDelta: (delta) => {
        writeEvent({
          statusUpdate: {
            taskId: streamTaskId,
            contextId,
            status: {
              state: A2AProtocolTaskState.Working,
              message: {
                messageId: randomUUID(),
                role: A2AProtocolRole.Agent,
                parts: [{ text: delta }],
              },
            },
            final: false,
          },
        });
      },
    });

    // Terminal frame(s). The buffered response is authoritative: emit the full
    // task when the run ended input-required (approval flow), otherwise close
    // with a completed status update carrying the final agent message.
    if (response.task) {
      writeEvent({ task: response.task });
      writeEvent({
        statusUpdate: {
          taskId: response.task.id,
          contextId: response.task.contextId ?? contextId,
          status: response.task.status,
          final: true,
        },
      });
    } else {
      const message = response.message;
      writeEvent({
        statusUpdate: {
          taskId: streamTaskId,
          contextId: message?.contextId ?? contextId,
          status: {
            state: A2AProtocolTaskState.Completed,
            ...(message ? { message } : {}),
          },
          final: true,
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
    finished = true;
    clearInterval(heartbeat);
    if (!raw.destroyed) raw.end();
  }
}

/**
 * How often the streaming handler emits an SSE comment heartbeat while an agent
 * turn is in progress, to keep intermediaries from closing an otherwise-idle
 * connection during long silent gaps between text deltas.
 */
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

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
}

const A2A_V2_ROUTER_ERRORS = {
  [A2AV2RouterErrorKind.MethodNotFound]: {
    code: -32601,
    message: "Method not found",
  },
  [A2AV2RouterErrorKind.AgentNotFound]: {
    code: -32006,
    message: "Agent not found",
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
  request: A2AProtocolSendMessageRequest | A2AProtocolGetTaskRequest;
}) => Promise<unknown>;

class A2AV2Router {
  private readonly manager: A2AManager;

  constructor() {
    this.manager = new A2AManager();
  }

  async request(agentId: string, token: string, request: unknown) {
    const { method, params } = A2AJsonRpcRequestSchema.parse(request);
    const agent = await this.getAgentById(agentId);
    const actor = await this.resolveActor(agentId, token);
    const { func, schema } = this.getRouteForMethod(method);

    // Throws ZodError if request schema is invalid
    schema.parse(params);

    return await func({ actor, agentId: agent.id, request: params });
  }

  /**
   * Validate a `SendStreamingMessage` request and resolve its agent + actor,
   * without executing. Split out from execution so the route can surface
   * resolution/validation failures as an ordinary JSON-RPC error before it
   * commits to an SSE response.
   */
  async prepareStreamingRequest(
    agentId: string,
    token: string,
    request: unknown,
  ): Promise<{
    actor: A2AActor;
    agentId: string;
    request: A2AProtocolSendMessageRequest;
  }> {
    const { method, params } = A2AJsonRpcRequestSchema.parse(request);
    if (method !== STREAMING_METHOD) {
      throw new A2AV2RouterError(A2AV2RouterErrorKind.MethodNotFound);
    }
    const agent = await this.getAgentById(agentId);
    const actor = await this.resolveActor(agentId, token);
    const parsed = A2AProtocolSendMessageRequestSchema.parse(params);
    return { actor, agentId: agent.id, request: parsed };
  }

  /**
   * Execute a prepared streaming request, forwarding each text delta to the
   * caller. Returns the same buffered response as `SendMessage` (the caller
   * frames it as the terminal SSE event).
   */
  async streamMessage(params: {
    actor: A2AActor;
    agentId: string;
    request: A2AProtocolSendMessageRequest;
    abortSignal: AbortSignal;
    onTextDelta: (delta: string) => void;
  }): Promise<A2AProtocolSendMessageResponse> {
    return this.manager.sendMessage(params);
  }

  private getRouteForMethod(method: string) {
    const mapper: Record<string, { func: A2ARouteFunc; schema: z.ZodSchema }> =
      {
        SendMessage: {
          func: async (params) =>
            this.manager.sendMessage({
              ...params,
              request: params.request as A2AProtocolSendMessageRequest,
            }),
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
