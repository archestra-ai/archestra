import fastifyHttpProxy from "@fastify/http-proxy";
import { GoogleGenAI } from "@google/genai";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getObservableGenAI } from "@/llm-metrics";
import logger from "@/logging";
import { AgentModel, InteractionModel, LimitValidationService } from "@/models";

import {
  type Agent,
  ApiError,
  constructResponseSchema,
  ErrorResponsesSchema,
  Gemini,
  UuidIdSchema,
} from "@/types";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "./common";
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
    logger.debug(
      {
        agentId,
        model,
        stream,
        contentsCount: body.contents?.length || 0,
        hasTools: !!body.tools,
      },
      "[GeminiProxy] handleGenerateContent: request received",
    );

    let resolvedAgent: Agent;
    if (agentId) {
      // If agentId provided via URL, validate it exists
      logger.debug({ agentId }, "[GeminiProxy] Resolving explicit agent by ID");
      const agent = await AgentModel.findById(agentId);
      if (!agent) {
        logger.debug({ agentId }, "[GeminiProxy] Agent not found");
        return reply.status(404).send({
          error: {
            message: `Agent with ID ${agentId} not found`,
            type: "not_found",
          },
        });
      }
      resolvedAgent = agent;
    } else {
      // Otherwise get or create default agent
      logger.debug(
        { userAgent: headers["user-agent"] },
        "[GeminiProxy] Resolving default agent by user-agent",
      );
      resolvedAgent = await AgentModel.getAgentOrCreateDefault(
        headers["user-agent"],
      );
    }

    const resolvedAgentId = resolvedAgent.id;
    logger.debug(
      {
        resolvedAgentId,
        agentName: resolvedAgent.name,
        wasExplicit: !!agentId,
      },
      "[GeminiProxy] Agent resolved",
    );
    const { "x-goog-api-key": geminiApiKey } = headers;
    const genAI = getObservableGenAI(
      new GoogleGenAI({ apiKey: geminiApiKey }),
      resolvedAgent,
    );

    // Use the model from the URL path or default to gemini-pro
    const modelName = model || "gemini-2.5-pro";

    try {
      // Check if current usage limits are already exceeded
      logger.debug({ resolvedAgentId }, "[GeminiProxy] Checking usage limits");
      const limitViolation =
        await LimitValidationService.checkLimitsBeforeRequest(resolvedAgentId);

      if (limitViolation) {
        const [_refusalMessage, contentMessage] = limitViolation;

        logger.debug(
          { resolvedAgentId, contentMessage },
          "[GeminiProxy] Request blocked due to limit violation",
        );
        fastify.log.info(
          {
            resolvedAgentId,
            reason: "token_cost_limit_exceeded",
          },
          "Gemini request blocked due to token cost limit",
        );

        // Return error response similar to tool call blocking
        return reply.status(429).send({
          error: {
            message: contentMessage,
            type: "rate_limit_exceeded",
            code: "token_cost_limit_exceeded",
          },
        });
      }
      logger.debug({ resolvedAgentId }, "[GeminiProxy] Limit check passed");

      // TODO: Persist tools if present
      // await utils.tools.persistTools(commonRequest.tools, resolvedAgentId);

      // TODO: Inject assigned MCP tools (assigned tools take priority)
      // const _mergedTools = await injectTools(
      //   body.tools,
      //   resolvedAgentId,
      // );

      // Convert to common format and evaluate trusted data policies
      logger.debug(
        { contentsCount: body.contents?.length || 0 },
        "[GeminiProxy] Converting contents to common format",
      );
      const commonMessages = utils.adapters.gemini.toCommonFormat(
        body.contents || [],
      );
      logger.debug(
        { commonMessageCount: commonMessages.length },
        "[GeminiProxy] Contents converted to common format",
      );

      logger.debug(
        { resolvedAgentId },
        "[GeminiProxy] Evaluating trusted data policies",
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
      logger.debug(
        { updateCount: Object.keys(toolResultUpdates).length },
        "[GeminiProxy] Applying tool result updates",
      );
      const filteredContents = utils.adapters.gemini.applyUpdates(
        body.contents || [],
        toolResultUpdates,
      );

      // Use filtered contents in request
      const processedBody = {
        ...body,
        contents: filteredContents,
      };

      logger.debug(
        { filteredContentsCount: filteredContents.length },
        "[GeminiProxy] Contents filtered after trusted data evaluation",
      );

      if (stream) {
        logger.debug(
          { modelName },
          "[GeminiProxy] Streaming not supported yet",
        );
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

        throw new ApiError(
          400,
          "Streaming is not supported for Gemini. Coming soon!",
        );
      } else {
        logger.debug(
          { modelName },
          "[GeminiProxy] Starting non-streaming request",
        );
        // Non-streaming response with span to measure LLM call duration
        const response = await utils.tracing.startActiveLlmSpan(
          "gemini.generateContent",
          "gemini",
          modelName,
          false,
          resolvedAgent,
          async (llmSpan) => {
            const response = await genAI.models.generateContent({
              model: modelName,
              ...processedBody,
              // tools: mergedTools,
            });
            llmSpan.end();
            return response;
          },
        );

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

        // Extract token usage and store the complete interaction
        const tokenUsage = response.usageMetadata
          ? utils.adapters.gemini.getUsageTokens(response.usageMetadata)
          : { input: null, output: null };

        logger.debug(
          {
            resolvedAgentId,
            inputTokens: tokenUsage.input,
            outputTokens: tokenUsage.output,
          },
          "[GeminiProxy] Response received, storing interaction",
        );

        await InteractionModel.create({
          agentId: resolvedAgentId,
          type: "gemini:generateContent",
          request: body,
          // biome-ignore lint/suspicious/noExplicitAny: Gemini still WIP
          response: response as any,
          model: model,
          inputTokens: tokenUsage.input,
          outputTokens: tokenUsage.output,
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
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        description: "Generate content using Gemini (default agent)",
        summary: "Generate content using Gemini",
        tags: ["llm-proxy"],
        params: z.object({
          model: z.string().describe("The model to use"),
        }),
        headers: Gemini.API.GenerateContentHeadersSchema,
        body: Gemini.API.GenerateContentRequestSchema,
        response: constructResponseSchema(
          Gemini.API.GenerateContentResponseSchema,
        ),
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
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        description: "Stream generated content using Gemini (default agent)",
        summary: "Stream generated content using Gemini",
        tags: ["llm-proxy"],
        params: z.object({
          model: z.string().describe("The model to use"),
        }),
        headers: Gemini.API.GenerateContentHeadersSchema,
        body: Gemini.API.GenerateContentRequestSchema,
        // Streaming responses don't have a schema
        response: ErrorResponsesSchema,
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
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        description: "Generate content using Gemini with specific agent",
        summary: "Generate content using Gemini (specific agent)",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
          model: z.string().describe("The model to use"),
        }),
        headers: Gemini.API.GenerateContentHeadersSchema,
        body: Gemini.API.GenerateContentRequestSchema,
        response: constructResponseSchema(
          Gemini.API.GenerateContentResponseSchema,
        ),
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
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        description:
          "Stream generated content using Gemini with specific agent",
        summary: "Stream generated content using Gemini (specific agent)",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
          model: z.string().describe("The model to use"),
        }),
        headers: Gemini.API.GenerateContentHeadersSchema,
        body: Gemini.API.GenerateContentRequestSchema,
        // Streaming responses don't have a schema
        response: ErrorResponsesSchema,
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
