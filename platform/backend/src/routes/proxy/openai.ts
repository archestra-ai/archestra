import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema } from "@ai-sdk/provider-utils";
import fastifyHttpProxy from "@fastify/http-proxy";
import {
  generateText,
  type ModelMessage,
  type ToolChoice,
  type ToolSet,
} from "ai";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AgentModel, InteractionModel } from "@/models";
import {
  ErrorResponseSchema,
  type MagicalType,
  OpenAi,
  UuidIdSchema,
} from "@/types";
import { PROXY_API_PREFIX } from "./common";
import * as utils from "./utils";

const convertOpenAiFormatToAiSdkFormat = (
  request: OpenAi.Types.ChatCompletionsRequest,
): MagicalType => {
  // Convert OpenAI tools array format to AI SDK Record format
  const tools: MagicalType["tools"] = {};

  if (request.tools && Array.isArray(request.tools)) {
    for (const tool of request.tools) {
      if (tool.type === "function") {
        const { name, description, parameters } = tool.function;

        // Ensure parameters has type: "object" at the root and wrap in jsonSchema()
        const schema = parameters
          ? { type: "object" as const, ...parameters }
          : {
              type: "object" as const,
              properties: {},
              additionalProperties: false,
            };

        tools[name] = {
          description,
          inputSchema: jsonSchema(schema),
        };
      }
    }
  }

  return {
    messages: request.messages as unknown as ModelMessage[],
    tools,
    toolChoice: request.tool_choice as ToolChoice<ToolSet>,
    temperature: request.temperature ?? undefined,
    maxOutputTokens: request.max_tokens ?? undefined,
  };
};

const openAiProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/openai`;
  const CHAT_COMPLETIONS_SUFFIX = "chat/completions";

  /**
   * Register HTTP proxy for all OpenAI routes EXCEPT chat/completions
   * This will proxy routes like /v1/openai/models to https://api.openai.com/v1/models
   */
  await fastify.register(fastifyHttpProxy, {
    upstream: "https://api.openai.com",
    prefix: API_PREFIX,
    rewritePrefix: "/v1",
    // Exclude chat/completions route since we handle it specially below
    preHandler: (request, _reply, next) => {
      if (
        request.method === "POST" &&
        request.url.includes(CHAT_COMPLETIONS_SUFFIX)
      ) {
        // Skip proxy for this route - we handle it below
        next(new Error("skip"));
      } else {
        next();
      }
    },
  });

  const handleChatCompletion = async (
    body: OpenAi.Types.ChatCompletionsRequest,
    headers: OpenAi.Types.ChatCompletionsHeaders,
    reply: FastifyReply,
    agentId?: string,
  ) => {
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

    const { authorization: openAiApiKey } = headers;
    const openAiProvider = createOpenAI({ apiKey: openAiApiKey });

    const vercelAiSdkRequest = convertOpenAiFormatToAiSdkFormat(body);

    try {
      await utils.persistTools(vercelAiSdkRequest.tools, resolvedAgentId);

      // Process messages with trusted data policies dynamically
      const { filteredMessages, contextIsTrusted } =
        await utils.trustedData.evaluateIfContextIsTrusted(
          vercelAiSdkRequest.messages,
          resolvedAgentId,
          openAiApiKey,
        );

      if (body.stream) {
        // reply.header("Content-Type", "text/event-stream");
        // reply.header("Cache-Control", "no-cache");
        // reply.header("Connection", "keep-alive");
        // // Handle streaming response
        // const stream = await openAiClient.chat.completions.create({
        //   ...body,
        //   messages: filteredMessages,
        //   stream: true,
        // });
        // const chatCompletionChunksAndMessage =
        //   await utils.streaming.handleChatCompletions(stream);
        // let assistantMessage = chatCompletionChunksAndMessage.message;
        // let chunks: OpenAIProvider.Chat.Completions.ChatCompletionChunk[] =
        //   chatCompletionChunksAndMessage.chunks;
        // // Evaluate tool invocation policies dynamically
        // const toolInvocationRefusal =
        //   await utils.toolInvocation.evaluatePolicies(
        //     assistantMessage,
        //     resolvedAgentId,
        //     contextIsTrusted,
        //   );
        // if (toolInvocationRefusal) {
        //   /**
        //    * Tool invocation was blocked
        //    *
        //    * Overwrite the assistant message that will be persisted
        //    * Plus send a single chunk, representing the refusal message instead of original chunks
        //    */
        //   assistantMessage = toolInvocationRefusal.message;
        //   chunks = [
        //     {
        //       id: "chatcmpl-blocked",
        //       object: "chat.completion.chunk",
        //       created: Date.now() / 1000, // the type annotation for created mentions that it is in seconds
        //       model: body.model,
        //       choices: [
        //         {
        //           index: 0,
        //           delta:
        //             toolInvocationRefusal.message as OpenAIProvider.Chat.Completions.ChatCompletionChunk.Choice.Delta,
        //           finish_reason: "stop",
        //           logprobs: null,
        //         },
        //       ],
        //     },
        //   ];
        // }
        // // Store the complete interaction
        // await InteractionModel.create({
        //   agentId: resolvedAgentId,
        //   type: "openai:chatCompletions",
        //   request: body,
        //   response: {
        //     id: chunks[0]?.id || "chatcmpl-unknown",
        //     object: "chat.completion",
        //     created: chunks[0]?.created || Date.now() / 1000,
        //     model: body.model,
        //     choices: [
        //       {
        //         index: 0,
        //         message: assistantMessage,
        //         finish_reason: "stop",
        //         logprobs: null,
        //       },
        //     ],
        //   },
        // });
        // for (const chunk of chunks) {
        //   /**
        //    * The setTimeout here is used simply to simulate the streaming delay (and make it look more natural)
        //    */
        //   reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
        //   await new Promise((resolve) =>
        //     setTimeout(resolve, Math.random() * 10),
        //   );
        // }
        // reply.raw.write("data: [DONE]\n\n");
        // reply.raw.end();
        // return reply;
      } else {
        // const response = await openAiClient.chat.completions.create({
        //   ...body,
        //   messages: filteredMessages,
        //   stream: false,
        // });
        const results = await generateText({
          model: openAiProvider.chat(body.model), // use OpenAI chat completions API
          ...vercelAiSdkRequest,
          messages: filteredMessages,
        });

        // const rawResponse = results.response
        //   .body as OpenAi.Types.ChatCompletionsResponse;

        // if (rawResponse.choices[0].message.role === "tool") {
        //   // Evaluate tool invocation policies dynamically
        //   const toolInvocationRefusal =
        //     await utils.toolInvocation.evaluatePolicies(
        //       assistantMessage,
        //       resolvedAgentId,
        //       contextIsTrusted,
        //     );
        //   if (toolInvocationRefusal) {
        //     assistantMessage = toolInvocationRefusal.message;
        //     response.choices = [toolInvocationRefusal];
        //   }
        // }

        // Store the complete interaction
        await InteractionModel.create({
          agentId: resolvedAgentId,
          type: "openai:chatCompletions",
          request: body,
          response: results.response.body,
        });

        return reply.send(results.response.body);
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
   * No agentId is provided -- agent is created/fetched based on the user-agent header
   * or if the user-agent header is not present, a default agent is used
   */
  fastify.post(
    `${API_PREFIX}/${CHAT_COMPLETIONS_SUFFIX}`,
    {
      schema: {
        operationId: "openAiChatCompletionsWithDefaultAgent",
        description:
          "Create a chat completion with OpenAI (uses default agent)",
        tags: ["llm-proxy"],
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: {
          200: OpenAi.API.ChatCompletionResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ body, headers }, reply) => {
      return handleChatCompletion(body, headers, reply);
    },
  );

  /**
   * An agentId is provided -- agent is fetched based on the agentId
   */
  fastify.post(
    `${API_PREFIX}/:agentId/${CHAT_COMPLETIONS_SUFFIX}`,
    {
      schema: {
        operationId: "openAiChatCompletionsWithAgent",
        description:
          "Create a chat completion with OpenAI for a specific agent",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: {
          200: OpenAi.API.ChatCompletionResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ body, headers, params }, reply) => {
      return handleChatCompletion(body, headers, reply, params.agentId);
    },
  );
};

export default openAiProxyRoutes;
