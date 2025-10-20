import fastifyHttpProxy from "@fastify/http-proxy";
import { GoogleGenAI } from "@google/genai";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AgentModel, InteractionModel } from "@/models";
import { ErrorResponseSchema, Gemini, UuidIdSchema } from "@/types";
import { PROXY_API_PREFIX } from "./common";

import * as utils from "./utils";

/**
 * NOTE: Gemini uses colon-literals in their routes. For fastify, double colon is used to escape the colon-literal in
 * the route
 */
const geminiProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/gemini`;

  /**
   * Register HTTP proxy for all Gemini routes EXCEPT generateContent and streamGenerateContent
   * This will proxy routes like /v1/gemini/models to https://generativelanguage.googleapis.com/v1beta/models
   */
  await fastify.register(fastifyHttpProxy, {
    upstream: "https://generativelanguage.googleapis.com",
    prefix: API_PREFIX,
    rewritePrefix: "/v1beta",
    /**
     * Exclude generateContent and streamGenerateContent routes since we handle them below
     */
    preHandler: (request, _reply, next) => {
      if (
        request.method === "POST" &&
        (request.url.includes(":generateContent") ||
          request.url.includes(":streamGenerateContent"))
      ) {
        // Skip proxy for these routes - we handle them below
        next(new Error("skip"));
      } else {
        next();
      }
    },
  });

  const handleGenerateContent = async (
    body: Gemini.Types.GenerateContentRequest,
    headers: Gemini.Types.GenerateContentHeaders,
    reply: FastifyReply,
    model: string,
    agentId?: string,
    stream = false,
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

    const { "x-goog-api-key": geminiApiKey } = headers;
    const genAI = new GoogleGenAI({ apiKey: geminiApiKey });

    // Use the model from the URL path or default to gemini-pro
    const modelName = model || "gemini-2.5-pro";

    try {
      // TODO: Persist tools if present
      // await utils.persistTools(commonRequest.tools, resolvedAgentId);

      // Convert to common format and evaluate trusted data policies
      const commonMessages = utils.adapters.gemini.toCommonFormat(
        body.contents || [],
      );
      const { toolResultUpdates, contextIsTrusted: _contextIsTrusted } =
        await utils.trustedData.evaluateIfContextIsTrusted(
          commonMessages,
          resolvedAgentId,
          geminiApiKey,
          /**
           * TODO: gemini isn't properly supported yet...
           */
          "openai",
        );

      // Apply updates back to Gemini contents
      const filteredContents = utils.adapters.gemini.applyUpdates(
        body.contents || [],
        toolResultUpdates,
      );

      // Use filtered contents in request
      const processedBody = {
        ...body,
        contents: filteredContents,
      };

      if (stream) {
        // reply.header("Content-Type", "text/event-stream");
        // reply.header("Cache-Control", "no-cache");
        // reply.header("Connection", "keep-alive");

        // // Handle streaming response
        // const result = await genAI.models.generateContentStream({
        //   model: modelName,
        //   ...geminiRequest,
        // });

        // const chunks: Gemini.Types.GenerateContentResponse[] = [];
        // let accumulatedResponse:
        //   | Gemini.Types.GenerateContentResponse
        //   | undefined;

        // for await (const chunk of result) {
        //   chunks.push({
        //     candidates: chunk.candidates as any,
        //     modelVersion: modelName,
        //   });

        //   // Accumulate response for persistence
        //   if (!accumulatedResponse) {
        //     accumulatedResponse = {
        //       candidates: chunk.candidates as any,
        //       usageMetadata: chunk.usageMetadata as any,
        //       modelVersion: modelName,
        //     };
        //   } else if (chunk.candidates) {
        //     // Accumulate content from chunks
        //     for (let i = 0; i < chunk.candidates.length; i++) {
        //       const candidate = chunk.candidates[i];
        //       const accCandidate = accumulatedResponse.candidates![i];
        //       if (candidate.content && accCandidate?.content) {
        //         // Append parts
        //         accCandidate.content.parts = [
        //           ...(accCandidate.content.parts || []),
        //           ...(candidate.content.parts || []),
        //         ];
        //       }
        //     }
        //   }

        //   // Convert to common format for SSE
        //   const commonChunk = transformer.chunkToOpenAI
        //     ? transformer.chunkToOpenAI(chunk as any)
        //     : chunk;

        //   reply.raw.write(`data: ${JSON.stringify(commonChunk)}\n\n`);
        //   await new Promise((resolve) =>
        //     setTimeout(resolve, Math.random() * 10),
        //   );
        // }

        // // Evaluate tool invocation policies on the accumulated response
        // if (accumulatedResponse) {
        //   const commonResponse =
        //     transformer.responseToOpenAI(accumulatedResponse);

        //   // Check if tool invocation is blocked
        //   const assistantMessage = commonResponse.choices[0]?.message;
        //   if (assistantMessage) {
        //     const toolInvocationRefusal =
        //       await utils.toolInvocation.evaluatePolicies(
        //         assistantMessage,
        //         resolvedAgentId,
        //         contextIsTrusted,
        //       );

        //     if (toolInvocationRefusal) {
        //       // Send refusal as final chunk
        //       const refusalChunk = {
        //         id: "chatcmpl-blocked",
        //         object: "chat.completion.chunk" as const,
        //         created: Date.now() / 1000,
        //         model: modelName,
        //         choices: [
        //           {
        //             index: 0,
        //             delta: toolInvocationRefusal.message,
        //             finish_reason: "stop",
        //             logprobs: null,
        //           },
        //         ],
        //       };

        //       reply.raw.write(`data: ${JSON.stringify(refusalChunk)}\n\n`);

        //       // Update response for persistence
        //       commonResponse.choices = [toolInvocationRefusal];
        //       accumulatedResponse = transformer.responseFromOpenAI(
        //         commonResponse,
        //       );
        //     }
        //   }

        //   // Store the complete interaction
        //   await InteractionModel.create({
        //     agentId: resolvedAgentId,
        //     type: "gemini:generateContent",
        //     request: body,
        //     response: accumulatedResponse,
        //   });
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
        const response = await genAI.models.generateContent({
          model: modelName,
          ...processedBody,
        });

        // Convert to common format for policy evaluation
        // const commonResponse = transformer.responseToOpenAI(geminiResponse);

        // TODO:
        // Evaluate tool invocation policies
        // const assistantMessage = commonResponse.choices[0]?.message;
        // if (assistantMessage) {
        //   const toolInvocationRefusal =
        //     await utils.toolInvocation.evaluatePolicies(
        //       assistantMessage,
        //       resolvedAgentId,
        //       contextIsTrusted,
        //     );

        //   if (toolInvocationRefusal) {
        //     commonResponse.choices = [toolInvocationRefusal];
        //     // Convert back to Gemini format
        //     const refusalResponse =
        //       transformer.responseFromOpenAI(commonResponse);

        //     // Store the interaction with refusal
        //     await InteractionModel.create({
        //       agentId: resolvedAgentId,
        //       type: "gemini:generateContent",
        //       request: body,
        //       response: refusalResponse,
        //     });

        //     return reply.send(refusalResponse);
        //   }
        // }

        // Store the complete interaction
        await InteractionModel.create({
          agentId: resolvedAgentId,
          type: "gemini:generateContent",
          request: body,
          // biome-ignore lint/suspicious/noExplicitAny: Gemini still WIP
          response: response as any,
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
            error instanceof Error
              ? error.message
              : "An unexpected error occurred",
          type: "api_error",
        },
      });
    }
  };

  /**
   * TODO:
   *
   * This was a big PITA to get the fastify syntax JUST right
   *
   * See https://fastify.dev/docs/latest/Reference/Routes/#url-building
   *
   * Otherwise, without the regex param syntax, we were running into errors like this 👇 when starting up the server:
   *
   * ERROR: Method 'POST' already declared for route '/v1/gemini/models/:model:streamGenerateContent'
   */
  const generateRouteEndpoint = (
    verb: "generateContent" | "streamGenerateContent",
    includeAgentId = false,
  ) =>
    `${API_PREFIX}/${includeAgentId ? ":agentId/" : ""}models/:model(^[a-zA-Z0-9-.]+$)::${verb}`;

  /**
   * Default agent endpoint for Gemini generateContent
   */
  fastify.post(
    generateRouteEndpoint("generateContent"),
    {
      schema: {
        description: "Generate content using Gemini (default agent)",
        summary: "Generate content using Gemini",
        tags: ["Proxy"],
        params: z.object({
          model: z.string().describe("The model to use"),
        }),
        headers: Gemini.API.GenerateContentHeadersSchema,
        body: Gemini.API.GenerateContentRequestSchema,
        response: {
          200: Gemini.API.GenerateContentResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      return handleGenerateContent(
        request.body,
        request.headers,
        reply,
        request.params.model,
        undefined,
        false,
      );
    },
  );

  /**
   * Default agent endpoint for Gemini streamGenerateContent
   */
  fastify.post(
    generateRouteEndpoint("streamGenerateContent"),
    {
      schema: {
        description: "Stream generated content using Gemini (default agent)",
        summary: "Stream generated content using Gemini",
        tags: ["Proxy"],
        params: z.object({
          model: z.string().describe("The model to use"),
        }),
        headers: Gemini.API.GenerateContentHeadersSchema,
        body: Gemini.API.GenerateContentRequestSchema,
        response: {
          // Streaming responses don't have a schema
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      return handleGenerateContent(
        request.body,
        request.headers,
        reply,
        request.params.model,
        undefined,
        true,
      );
    },
  );

  /**
   * Agent-specific endpoint for Gemini generateContent
   */
  fastify.post(
    generateRouteEndpoint("generateContent", true),
    {
      schema: {
        description: "Generate content using Gemini with specific agent",
        summary: "Generate content using Gemini (specific agent)",
        tags: ["Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
          model: z.string().describe("The model to use"),
        }),
        headers: Gemini.API.GenerateContentHeadersSchema,
        body: Gemini.API.GenerateContentRequestSchema,
        response: {
          200: Gemini.API.GenerateContentResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      return handleGenerateContent(
        request.body,
        request.headers,
        reply,
        request.params.model,
        request.params.agentId,
        false,
      );
    },
  );

  /**
   * Agent-specific endpoint for Gemini streamGenerateContent
   */
  fastify.post(
    generateRouteEndpoint("streamGenerateContent", true),
    {
      schema: {
        description:
          "Stream generated content using Gemini with specific agent",
        summary: "Stream generated content using Gemini (specific agent)",
        tags: ["Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
          model: z.string().describe("The model to use"),
        }),
        headers: Gemini.API.GenerateContentHeadersSchema,
        body: Gemini.API.GenerateContentRequestSchema,
        response: {
          // Streaming responses don't have a schema
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      return handleGenerateContent(
        request.body,
        request.headers,
        reply,
        request.params.model,
        request.params.agentId,
        true,
      );
    },
  );
};

export default geminiProxyRoutes;
