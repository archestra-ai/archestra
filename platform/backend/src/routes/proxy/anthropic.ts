import AnthropicProvider from "@anthropic-ai/sdk";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AgentModel, InteractionModel } from "@/models";
import { Anthropic, ErrorResponseSchema, UuidIdSchema } from "@/types";
import { PROXY_API_PREFIX } from "./common";
import { AnthropicMessagesTransformer } from "./transformers";
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
      if (request.method === "POST" && request.url.includes(MESSAGES_SUFFIX)) {
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

    const { authorization: anthropicApiKey } = headers;
    const anthropicClient = new AnthropicProvider({ apiKey: anthropicApiKey });
    const transformer = new AnthropicMessagesTransformer();

    try {
      // Convert Anthropic request to common format for processing
      const commonRequest = transformer.requestToOpenAI(body);

      await utils.persistTools(commonRequest.tools, resolvedAgentId);

      // Process messages with trusted data policies dynamically
      const { filteredMessages, contextIsTrusted } =
        await utils.trustedData.evaluateIfContextIsTrusted(
          commonRequest.messages,
          resolvedAgentId,
          anthropicApiKey,
        );

      if (stream) {
        // reply.header("Content-Type", "text/event-stream");
        // reply.header("Cache-Control", "no-cache");
        // reply.header("Connection", "keep-alive");

        // // Handle streaming response
        // const stream = await anthropicClient.messages.create({
        //   ...body,
        //   messages: filteredMessages,
        //   stream: true,
        // });

        // const chatCompletionChunksAndMessage =
        //   await utils.streaming.handleChatCompletions(stream);

        // let assistantMessage = chatCompletionChunksAndMessage.message;
        // // Chat.Completions.ChatCompletionChunk
        // let chunks: AnthropicProvider[] = chatCompletionChunksAndMessage.chunks;

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
        //             toolInvocationRefusal.message as OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta,
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
        //   type: "anthropic:messages",
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

        return reply.code(400).send({
          error: {
            message: "Streaming is not supported for Anthropic. Coming soon!",
            type: "not_supported",
          },
        });
      } else {
        // Non-streaming response
        const response = await anthropicClient.messages.create({
          ...body,
          messages: filteredMessages,
          stream: false,
        });

        // Convert to common format for policy evaluation
        const commonResponse = transformer.responseToOpenAI(response);

        // Evaluate tool invocation policies
        const assistantMessage = commonResponse.choices[0]?.message;
        if (assistantMessage) {
          const toolInvocationRefusal =
            await utils.toolInvocation.evaluatePolicies(
              assistantMessage,
              resolvedAgentId,
              contextIsTrusted,
            );

          if (toolInvocationRefusal) {
            commonResponse.choices = [toolInvocationRefusal];
            // Convert back to Anthropic format
            const refusalResponse =
              transformer.responseFromOpenAI(commonResponse);

            // Store the interaction with refusal
            await InteractionModel.create({
              agentId: resolvedAgentId,
              type: "anthropic:messages",
              request: body,
              response: refusalResponse,
            });

            return reply.send(refusalResponse);
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
   * No agentId is provided -- agent is created/fetched based on the user-agent header
   * or if the user-agent header is not present, a default agent is used
   */
  fastify.post(
    `${API_PREFIX}/${MESSAGES_SUFFIX}`,
    {
      schema: {
        operationId: "anthropicMessagesWithDefaultAgent",
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
   * An agentId is provided -- agent is fetched based on the agentId
   */
  fastify.post(
    `${API_PREFIX}/:agentId/${MESSAGES_SUFFIX}`,
    {
      schema: {
        operationId: "anthropicMessagesWithAgent",
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
