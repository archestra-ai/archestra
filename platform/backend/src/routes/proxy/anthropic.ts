import AnthropicProvider from "@anthropic-ai/sdk";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AgentModel, InteractionModel } from "@/models";
import { Anthropic, ErrorResponseSchema, RouteId, UuidIdSchema } from "@/types";
import { PROXY_API_PREFIX } from "./common";
import * as utils from "./utils";

/**
 * Inject assigned MCP tools into Anthropic tools array
 * Assigned tools take priority and override tools with the same name from the request
 */
const injectTools = async (
  requestTools: z.infer<typeof Anthropic.Tools.ToolSchema>[] | undefined,
  agentId: string,
): Promise<z.infer<typeof Anthropic.Tools.ToolSchema>[]> => {
  const assignedTools = await utils.tools.getAssignedMCPTools(agentId);

  // Convert assigned tools to Anthropic format (CustomTool)
  const assignedAnthropicTools: z.infer<
    typeof Anthropic.Tools.CustomToolSchema
  >[] = assignedTools.map((tool) => ({
    name: tool.name,
    description: tool.description || undefined,
    input_schema: tool.parameters || {},
    type: "custom" as const,
  }));

  // Create a map of request tools by name
  const requestToolMap = new Map<
    string,
    z.infer<typeof Anthropic.Tools.ToolSchema>
  >();
  for (const tool of requestTools || []) {
    requestToolMap.set(tool.name, tool);
  }

  // Merge: assigned tools override request tools with same name
  const mergedToolMap = new Map<
    string,
    z.infer<typeof Anthropic.Tools.ToolSchema>
  >(requestToolMap);
  for (const assignedTool of assignedAnthropicTools) {
    mergedToolMap.set(assignedTool.name, assignedTool);
  }

  return Array.from(mergedToolMap.values());
};

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
    const { tools, stream } = body;

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
      if (tools) {
        const transformedTools: Parameters<typeof utils.tools.persistTools>[0] =
          [];

        for (const tool of tools) {
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

        await utils.tools.persistTools(transformedTools, resolvedAgentId);
      }

      // Inject assigned MCP tools (assigned tools take priority)
      const mergedTools = await injectTools(tools, resolvedAgentId);

      // Convert to common format and evaluate trusted data policies
      const commonMessages = utils.adapters.anthropic.toCommonFormat(
        body.messages,
      );

      // For streaming requests, set headers first
      if (stream) {
        reply.header("Content-Type", "text/event-stream");
        reply.header("Cache-Control", "no-cache");
        reply.header("Connection", "keep-alive");
      }

      const { toolResultUpdates, contextIsTrusted, usedDualLlm } =
        await utils.trustedData.evaluateIfContextIsTrusted(
          commonMessages,
          resolvedAgentId,
          anthropicApiKey,
          "anthropic",
          stream
            ? () => {
                // Send initial indicator when dual LLM starts (streaming only)
                const startEvent = {
                  type: "content_block_delta",
                  index: 0,
                  delta: {
                    type: "text_delta",
                    text: "Analyzing with Dual LLM:\n\n",
                  },
                };
                reply.raw.write(
                  `event: content_block_delta\ndata: ${JSON.stringify(startEvent)}\n\n`,
                );
              }
            : undefined,
          stream
            ? (progress) => {
                // Stream Q&A progress with options
                const optionsText = progress.options
                  .map((opt, idx) => `  ${idx}: ${opt}`)
                  .join("\n");
                const progressEvent = {
                  type: "content_block_delta",
                  index: 0,
                  delta: {
                    type: "text_delta",
                    text: `Question: ${progress.question}\nOptions:\n${optionsText}\nAnswer: ${progress.answer}\n\n`,
                  },
                };
                reply.raw.write(
                  `event: content_block_delta\ndata: ${JSON.stringify(progressEvent)}\n\n`,
                );
              }
            : undefined,
        );

      // Apply updates back to Anthropic messages
      const filteredMessages = utils.adapters.anthropic.applyUpdates(
        body.messages,
        toolResultUpdates,
      );

      if (stream) {
        // Handle streaming response
        const messageStream = anthropicClient.messages.stream({
          // biome-ignore lint/suspicious/noExplicitAny: Anthropic still WIP
          ...(body as any),
          messages: filteredMessages,
        });

        // Accumulate tool calls and track content for persistence
        let accumulatedText = "";
        const accumulatedToolCalls: AnthropicProvider.Messages.ToolUseBlock[] =
          [];
        const events: AnthropicProvider.Messages.MessageStreamEvent[] = [];

        for await (const event of messageStream) {
          events.push(event);

          // Stream text content immediately
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            reply.raw.write(
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            );
            accumulatedText += event.delta.text;
          }

          // Accumulate tool calls (don't stream yet - need to evaluate policies first)
          if (
            event.type === "content_block_start" &&
            event.content_block.type === "tool_use"
          ) {
            accumulatedToolCalls.push(event.content_block);
          } else if (
            event.type === "content_block_delta" &&
            event.delta.type === "input_json_delta"
          ) {
            // Accumulate tool input JSON
            const lastToolCall =
              accumulatedToolCalls[accumulatedToolCalls.length - 1];
            if (lastToolCall) {
              lastToolCall.input =
                (lastToolCall.input || "") + event.delta.partial_json;
            }
          }
        }

        // Parse accumulated tool inputs
        for (const toolCall of accumulatedToolCalls) {
          try {
            toolCall.input = JSON.parse(toolCall.input as string);
          } catch {
            // If parsing fails, leave as string
          }
        }

        // Evaluate tool invocation policies dynamically
        let toolInvocationRefusal: [string, string] | null = null;
        if (accumulatedToolCalls.length > 0) {
          toolInvocationRefusal = await utils.toolInvocation.evaluatePolicies(
            accumulatedToolCalls.map((toolCall) => ({
              toolCallName: toolCall.name,
              toolCallArgs: JSON.stringify(toolCall.input),
            })),
            resolvedAgentId,
            contextIsTrusted,
          );
        }

        // Build the final response for persistence
        let responseContent: AnthropicProvider.Messages.ContentBlock[];

        if (toolInvocationRefusal) {
          const [_refusalMessage, contentMessage] = toolInvocationRefusal;
          responseContent = [
            {
              type: "text",
              text: contentMessage,
              citations: null,
            },
          ];

          // Stream the refusal
          const refusalEvent = {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: contentMessage,
            },
          };
          reply.raw.write(
            `event: content_block_delta\ndata: ${JSON.stringify(refusalEvent)}\n\n`,
          );
        } else {
          // Tool calls are allowed - stream them now
          if (accumulatedToolCalls.length > 0) {
            responseContent = [
              ...(accumulatedText
                ? [
                    {
                      type: "text" as const,
                      text: accumulatedText,
                      citations: null,
                    },
                  ]
                : []),
              ...accumulatedToolCalls,
            ];

            for (const event of events) {
              if (
                event.type === "content_block_start" &&
                event.content_block.type === "tool_use"
              ) {
                reply.raw.write(
                  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                );
              } else if (
                event.type === "content_block_delta" &&
                event.delta.type === "input_json_delta"
              ) {
                reply.raw.write(
                  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                );
              }
            }
          } else {
            responseContent = [
              {
                type: "text",
                text: accumulatedText,
                citations: null,
              },
            ];
          }
        }

        // Get the message ID and other metadata from the stream
        const messageStartEvent = events.find(
          (e) => e.type === "message_start",
        ) as AnthropicProvider.Messages.MessageStartEvent | undefined;

        // Store the complete interaction
        await InteractionModel.create({
          agentId: resolvedAgentId,
          type: "anthropic:messages",
          request: body,
          response: {
            id: messageStartEvent?.message.id || "msg-unknown",
            type: "message",
            role: "assistant",
            content: responseContent,
            model: body.model,
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: messageStartEvent?.message.usage || {
              input_tokens: 0,
              output_tokens: 0,
            },
          },
        });

        // Send message_delta with stop_reason
        const messageDeltaEvent = {
          type: "message_delta",
          delta: {
            stop_reason: "end_turn",
            stop_sequence: null,
          },
        };
        reply.raw.write(
          `event: message_delta\ndata: ${JSON.stringify(messageDeltaEvent)}\n\n`,
        );

        // Send message_stop event
        reply.raw.write(`event: message_stop\ndata: {}\n\n`);

        reply.raw.end();
        return reply;
      } else {
        // Non-streaming response
        const response = await anthropicClient.messages.create({
          // biome-ignore lint/suspicious/noExplicitAny: Anthropic still WIP
          ...(body as any),
          messages: filteredMessages,
          tools: mergedTools.length > 0 ? mergedTools : undefined,
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
