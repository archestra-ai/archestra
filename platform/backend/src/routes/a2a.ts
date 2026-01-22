import { randomUUID } from "node:crypto";
import { SESSION_ID_HEADER } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { executeA2AMessage } from "@/agents/a2a-executor";
import config from "@/config";
import { AgentModel, UserModel } from "@/models";
import {
  extractBearerToken,
  validateMCPGatewayToken,
} from "@/routes/mcp-gateway.utils";
import { ApiError, UuidIdSchema } from "@/types";

/**
 * A2A (Agent-to-Agent) Protocol routes
 * Exposes internal agents as A2A agents with AgentCard discovery and JSON-RPC execution
 * Only internal agents (agentType='agent') can be used for A2A.
 */

const A2AAgentCardSchema = z.object({
  name: z.string(),
  description: z.string(),
  url: z.string(),
  version: z.string(),
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

const A2AMessagePartSchema = z.object({
  kind: z.literal("text"),
  text: z.string(),
});

// A2A Message schema for message/send response
const A2AMessageSchema = z.object({
  messageId: z.string(),
  role: z.enum(["user", "agent"]),
  parts: z.array(A2AMessagePartSchema),
  contextId: z.string().optional(),
  taskId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const A2AJsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z
    .object({
      message: z
        .object({
          parts: z.array(A2AMessagePartSchema).optional(),
        })
        .optional(),
    })
    .optional(),
});

const A2AJsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: A2AMessageSchema.optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
    })
    .optional(),
});

const a2aRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const { endpoint } = config.a2aGateway;

  // GET AgentCard for an internal agent
  fastify.get(
    `${endpoint}/:agentId/.well-known/agent.json`,
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
          "Authorization header required. Use: Bearer <archestra_token>",
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

      return reply.send({
        name: agent.name,
        description: agent.systemPrompt || agent.userPrompt || "",
        url: `${baseUrl}${endpoint}/${agent.id}`,
        version: String(agent.promptVersion || 1),
        capabilities: {
          streaming: false,
          pushNotifications: false,
          stateTransitionHistory: false,
        },
        defaultInputModes: ["text"],
        defaultOutputModes: ["text"],
        skills: [
          {
            id: `${agent.id}-skill`,
            name: agent.name,
            description: agent.userPrompt || "",
            tags: [],
            inputModes: ["text"],
            outputModes: ["text"],
          },
        ],
      });
    },
  );

  // POST JSON-RPC endpoint for A2A message execution
  fastify.post(
    `${endpoint}/:agentId`,
    {
      schema: {
        description:
          "Execute A2A JSON-RPC message on an internal agent (must be agentType='agent')",
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
      const { agentId } = request.params;
      const { id, params } = request.body;

      // Fetch the internal agent
      const agent = await AgentModel.findById(agentId);

      if (!agent) {
        return reply.send({
          jsonrpc: "2.0" as const,
          id,
          error: {
            code: -32602,
            message: "Agent not found",
          },
        });
      }

      // Only internal agents can be used for A2A
      if (agent.agentType !== "agent") {
        return reply.send({
          jsonrpc: "2.0" as const,
          id,
          error: {
            code: -32602,
            message:
              "Agent is not an internal agent (A2A requires agents with agentType='agent')",
          },
        });
      }

      // Validate token authentication (reuse MCP Gateway utilities)
      const token = extractBearerToken(request);
      if (!token) {
        return reply.send({
          jsonrpc: "2.0" as const,
          id,
          error: {
            code: -32600,
            message:
              "Authorization header required. Use: Bearer <archestra_token>",
          },
        });
      }

      const tokenAuth = await validateMCPGatewayToken(agent.id, token);
      if (!tokenAuth) {
        return reply.send({
          jsonrpc: "2.0" as const,
          id,
          error: {
            code: -32600,
            message: "Invalid or unauthorized token",
          },
        });
      }

      // Get user info - for user tokens we have userId, for team tokens we use system context
      let userId: string;
      const organizationId = tokenAuth.organizationId;

      if (tokenAuth.userId) {
        // User token - use the token's user
        userId = tokenAuth.userId;
        const user = await UserModel.getById(userId);
        if (!user) {
          return reply.send({
            jsonrpc: "2.0" as const,
            id,
            error: {
              code: -32600,
              message: "User not found for token",
            },
          });
        }
      } else {
        // Team/org token - we don't have a specific user, use a system context
        // The LLM client will work without user-specific API key resolution
        userId = "system";
      }

      // Extract user message from A2A message parts
      const userMessage =
        params?.message?.parts
          ?.filter((p) => p.kind === "text")
          .map((p) => p.text)
          .join("\n") || "";

      if (!userMessage) {
        return reply.send({
          jsonrpc: "2.0" as const,
          id,
          error: {
            code: -32602,
            message: "No message content provided",
          },
        });
      }

      try {
        // Extract session ID from headers to group A2A requests with calling session
        // If no session ID provided, generate a unique one for this A2A request
        // This ensures all tool calls within one A2A request are grouped together
        const headerSessionId =
          (request.headers[SESSION_ID_HEADER.toLowerCase()] as
            | string
            | undefined) ||
          (request.headers[SESSION_ID_HEADER] as string | undefined);
        const sessionId =
          headerSessionId || `a2a-${Date.now()}-${randomUUID()}`;

        // Execute using shared A2A service
        // Pass agentId as the initial delegation chain (will be extended by any delegated calls)
        const result = await executeA2AMessage({
          agentId,
          message: userMessage,
          organizationId,
          userId,
          sessionId,
          parentDelegationChain: undefined, // This is the root call, chain starts with agentId
        });

        return reply.send({
          jsonrpc: "2.0" as const,
          id,
          result: {
            messageId: result.messageId,
            role: "agent" as const,
            parts: [{ kind: "text" as const, text: result.text }],
          },
        });
      } catch (error) {
        return reply.send({
          jsonrpc: "2.0" as const,
          id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal error",
          },
        });
      }
    },
  );
};

export default a2aRoutes;
