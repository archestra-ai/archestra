import AnthropicProvider from "@anthropic-ai/sdk";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AgentModel, InteractionModel } from "@/models";
import { Anthropic, ErrorResponseSchema, RouteId, UuidIdSchema } from "@/types";
import { PROXY_API_PREFIX } from "./common";
import * as utils from "./utils";

const anthropicProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/anthropic`;
  const MESSAGES_SUFFIX = "/messages";

  /**
   * Register HTTP proxy for all Anthropic API routes EXCEPT messages routes
   * This will proxy routes like /v1/anthropic/models to https://api.anthropic.com/v1/models
   */
  await fastify.register(fastifyHttpProxy, {
    upstream: "https://api.anthropic.com",
    prefix: API_PREFIX,
    rewritePrefix: "/v1",
    // Exclude messages route since we handle it specially below
    preHandler: (request, _reply, next) => {
      // Support Anthropic SDK standard format:
      // /v1/anthropic/v1/messages or /v1/anthropic/v1/:agentId/messages
      const isMessagesRoute =
        request.method === "POST" &&
        (request.url.match(/\/v1\/anthropic\/v1\/messages$/) ||
          request.url.match(/\/v1\/anthropic\/v1\/[^/]+\/messages$/));

      if (isMessagesRoute) {
        // Skip proxy for this route - we handle it below
        next(new Error("skip"));
      } else {
        next();
      }
    },
  });

  const handleMessages = async (
    body: Anthropic.Types.MessagesRequest,
    headers: Anthropic.Types.MessagesHeaders,
    reply: FastifyReply,
    agentId?: string,
  ) => {
    const { stream } = body;

    let resolvedAgentId: string;
    if (agentId) {
      // If agentId provided via URL, validate it exists
      const agent = await AgentModel.findById(agentId);
      if (!agent) {
        return reply.status(404).send({
          error: {
            message: `Agent with ID ${agentId} not found`,
            type: "not_found",
          },
        });
      }
      resolvedAgentId = agentId;
    } else {
      // Otherwise get or create default agent
      resolvedAgentId = await utils.getAgentIdFromRequest(
        headers["user-agent"],
      );
    }

    const { "x-api-key": anthropicApiKey } = headers;
    const anthropicClient = new AnthropicProvider({ apiKey: anthropicApiKey });

    try {
      if (body.tools) {
        const transformedTools: Parameters<typeof utils.persistTools>[0] = [];

        for (const tool of body.tools) {
          // null/undefine/type === custom essentially all mean the same thing for Anthropic tools...
          if (
            tool.type === undefined ||
            tool.type === null ||
            tool.type === "custom"
          ) {
            transformedTools.push({
              toolName: tool.name,
              toolParameters: tool.input_schema,
              toolDescription: tool.description,
            });
          }
        }

        await utils.persistTools(transformedTools, resolvedAgentId);
      }

      // Convert to common format and evaluate trusted data policies
      const commonMessages = utils.adapters.anthropic.toCommonFormat(
        body.messages,
      );
      const { toolResultUpdates, contextIsTrusted } =
        await utils.trustedData.evaluateIfContextIsTrusted(
          commonMessages,
          resolvedAgentId,
          anthropicApiKey,
          "anthropic",
        );

      // Apply updates back to Anthropic messages
      const filteredMessages = utils.adapters.anthropic.applyUpdates(
        body.messages,
        toolResultUpdates,
      );

      if (stream) {
        return reply.code(400).send({
          error: {
            message: "Streaming is not supported for Anthropic. Coming soon!",
            type: "not_supported",
          },
        });
      } else {
        // Non-streaming response
        const response = await anthropicClient.messages.create({
          // biome-ignore lint/suspicious/noExplicitAny: Anthropic still WIP
          ...(body as any),
          messages: filteredMessages,
          stream: false,
        });

        const toolCalls = response.content.filter(
          (content) => content.type === "tool_use",
        );

        if (toolCalls) {
          const toolInvocationRefusal =
            await utils.toolInvocation.evaluatePolicies(
              toolCalls.map((toolCall) => ({
                toolCallName: toolCall.name,
                toolCallArgs: JSON.stringify(toolCall.input),
              })),
              resolvedAgentId,
              contextIsTrusted,
            );

          if (toolInvocationRefusal) {
            const [_refusalMessage, contentMessage] = toolInvocationRefusal;
            response.content = [
              {
                type: "text",
                text: contentMessage,
                citations: null,
              },
            ];

            // Store the interaction with refusal
            await InteractionModel.create({
              agentId: resolvedAgentId,
              type: "anthropic:messages",
              request: body,
              response: response,
            });

            return reply.send(response);
          }
        }

        // Store the complete interaction
        await InteractionModel.create({
          agentId: resolvedAgentId,
          type: "anthropic:messages",
          request: body,
          response: response,
        });

        return reply.send(response);
      }
    } catch (error) {
      fastify.log.error(error);

      const statusCode =
        error instanceof Error && "status" in error
          ? (error.status as 200 | 400 | 404 | 403 | 500)
          : 500;

      return reply.status(statusCode).send({
        error: {
          message:
            error instanceof Error ? error.message : "Internal server error",
          type: "api_error",
        },
      });
    }
  };

  /**
   * Anthropic SDK standard format (with /v1 prefix)
   * No agentId is provided -- agent is created/fetched based on the user-agent header
   */
  fastify.post(
    `${API_PREFIX}/v1${MESSAGES_SUFFIX}`,
    {
      schema: {
        operationId: RouteId.AnthropicMessagesWithDefaultAgent,
        description: "Send a message to Anthropic using the default agent",
        tags: ["llm-proxy"],
        body: Anthropic.API.MessagesRequestSchema,
        headers: Anthropic.API.MessagesHeadersSchema,
        response: {
          200: Anthropic.API.MessagesResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ body, headers }, reply) => {
      return handleMessages(body, headers, reply);
    },
  );

  /**
   * Anthropic SDK standard format (with /v1 prefix)
   * An agentId is provided -- agent is fetched based on the agentId
   */
  fastify.post(
    `${API_PREFIX}/v1/:agentId${MESSAGES_SUFFIX}`,
    {
      schema: {
        operationId: RouteId.AnthropicMessagesWithAgent,
        description: "Send a message to Anthropic using a specific agent",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Anthropic.API.MessagesRequestSchema,
        headers: Anthropic.API.MessagesHeadersSchema,
        response: {
          200: Anthropic.API.MessagesResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ body, headers, params }, reply) => {
      return handleMessages(body, headers, reply, params.agentId);
    },
  );
};

export default anthropicProxyRoutes;
