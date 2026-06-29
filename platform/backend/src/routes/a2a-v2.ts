import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { type A2AActor, A2AError } from "@/agents/a2a/a2a-base";
import { A2AManager } from "@/agents/a2a/a2a-manager";
import {
  type A2AProtocolGetTaskRequest,
  A2AProtocolGetTaskRequestSchema,
  type A2AProtocolSendMessageRequest,
  A2AProtocolSendMessageRequestSchema,
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
          streaming: false,
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
          id: request.body.id,
          error: {
            code: -32600,
            message:
              "Authorization header required. Use: Bearer <platform_token>",
          },
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
        if (error instanceof A2AV2RouterError || error instanceof A2AError) {
          return reply.send({
            jsonrpc: "2.0" as const,
            id,
            error: {
              code: error.code,
              message: error.message,
            },
          });
        }

        if (error instanceof z.ZodError) {
          return reply.send({
            jsonrpc: "2.0" as const,
            id,
            error: {
              code: -32600,
              message: "Invalid Request",
              data: z.treeifyError(error),
            },
          });
        }

        // For unexpected errors, return a generic JSON-RPC error
        return reply.send({
          jsonrpc: "2.0" as const,
          id: request.body.id,
          error: {
            code: -32603,
            message: "Internal error",
            data: {
              reason: error instanceof Error ? error.message : String(error),
            },
          },
        });
      }
    },
  );
};

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
