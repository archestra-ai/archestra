import fastifyHttpProxy from "@fastify/http-proxy";
import type {
  GenerateContentParameters,
  GenerateContentResponse,
  GoogleGenAI,
} from "@google/genai";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import getDefaultPricing from "@/default-model-prices";
import {
  getObservableGenAI,
  reportBlockedTools,
  reportLLMCost,
  reportLLMTokens,
  reportTimeToFirstToken,
  reportTokensPerSecond,
} from "@/llm-metrics";
import logger from "@/logging";
import {
  AgentModel,
  InteractionModel,
  LimitValidationService,
  TokenPriceModel,
} from "@/models";

import {
  type Agent,
  constructResponseSchema,
  ErrorResponsesSchema,
  Gemini,
  UuidIdSchema,
} from "@/types";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "./common";
import * as utils from "./utils";
import { createGoogleGenAIClient } from "./utils/gemini-client";

/**
 * NOTE: Gemini uses colon-literals in their routes. For fastify, double colon is used to escape the colon-literal in
 * the route
 */
const geminiProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // WEIRD FIX : put v1beta at end fix n8n authentication
  const API_PREFIX = `${PROXY_API_PREFIX}/gemini`;

  /**
   * Register HTTP proxy for all Gemini routes EXCEPT generateContent and streamGenerateContent
   * This will proxy routes like /v1/gemini/models to https://generativelanguage.googleapis.com/v1beta/models
   */
  await fastify.register(fastifyHttpProxy, {
    upstream: "https://generativelanguage.googleapis.com",
    prefix: `${API_PREFIX}/v1beta`,
    rewritePrefix: "/v1",
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

  await fastify.register(fastifyHttpProxy, {
    upstream: "https://generativelanguage.googleapis.com",
    prefix: `${API_PREFIX}/:agentId/v1beta`,
    rewritePrefix: "/v1",
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
    externalAgentId?: string,
    userId?: string,
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
    if (body.tools && !Array.isArray(body.tools)) {
      body.tools = [body.tools];
    }
    const tools = Array.isArray(body.tools) ? body.tools : [];
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

    // Create GoogleGenAI client - supports both Vertex AI (ADC) and API key modes
    const { "x-goog-api-key": geminiApiKey } = headers;
    let genAIClient: GoogleGenAI;
    try {
      genAIClient = createGoogleGenAIClient(geminiApiKey, "[GeminiProxy]");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to initialize Gemini client";
      logger.error(
        { error },
        "[GeminiProxy] Failed to create GoogleGenAI client",
      );
      return reply.status(400).send({
        error: {
          message,
          type: "invalid_request_error",
        },
      });
    }

    const genAI = getObservableGenAI(
      genAIClient,
      resolvedAgent,
      externalAgentId,
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

        fastify.log.info(
          {
            resolvedAgentId,
            reason: "token_cost_limit_exceeded",
            contentMessage,
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

      // Persist tools if present (for tracking - clients handle tool execution via MCP Gateway)
      await utils.tools.persistTools(
        (tools || [])
          .filter((tool) => tool.functionDeclarations !== undefined)
          .flatMap((tool) =>
            (tool.functionDeclarations || []).map((fd) => ({
              toolName: fd.name ?? "unnamed_tool",
              toolParameters: fd.parameters || {},
              toolDescription: fd.description || "",
            })),
          ),
        resolvedAgentId,
      );

      // Client declares tools they want to use - no injection needed
      // Clients handle tool execution via MCP Gateway
      const mergedTools = tools || [];

      const baselineModel = modelName;
      let optimizedModelName = baselineModel;

      // Optimize model selection for cost using dynamic rules
      const hasTools = mergedTools.length > 0;
      const optimizedModel = await utils.costOptimization.getOptimizedModel(
        resolvedAgent,
        body.contents || [],
        "gemini",
        hasTools,
      );

      if (optimizedModel) {
        optimizedModelName = optimizedModel;
        fastify.log.info(
          { resolvedAgentId, optimizedModel },
          "Optimized model selected",
        );
      } else {
        fastify.log.info(
          { resolvedAgentId, baselineModel },
          "No matching optimized model found, proceeding with baseline model",
        );
      }

      // Ensure TokenPrice records exist for both baseline and optimized models
      const baselinePricing = getDefaultPricing(baselineModel);
      await TokenPriceModel.createIfNotExists(baselineModel, {
        provider: "gemini",
        ...baselinePricing,
      });

      if (optimizedModelName !== baselineModel) {
        const optimizedPricing = getDefaultPricing(optimizedModelName);
        await TokenPriceModel.createIfNotExists(optimizedModelName, {
          provider: "gemini",
          ...optimizedPricing,
        });
      }

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
        {
          resolvedAgentId,
          considerContextUntrusted: resolvedAgent.considerContextUntrusted,
        },
        "[GeminiProxy] Evaluating trusted data policies",
      );
      const { toolResultUpdates, contextIsTrusted } =
        await utils.trustedData.evaluateIfContextIsTrusted(
          commonMessages,
          resolvedAgentId,
          geminiApiKey,
          "gemini",
          resolvedAgent.considerContextUntrusted,
          stream
            ? () => {
                // Send initial indicator when dual LLM starts (streaming only)
                const startChunk: Gemini.Types.GenerateContentResponse = {
                  candidates: [
                    {
                      content: {
                        parts: [{ text: "Analyzing with Dual LLM:\n\n" }],
                        role: "model",
                      },
                      finishReason: undefined,
                      index: 0,
                    },
                  ],
                  modelVersion: optimizedModelName,
                };
                reply.raw.write(`data: ${JSON.stringify(startChunk)}\n\n`);
              }
            : undefined,
          stream
            ? (progress) => {
                // Stream Q&A progress with options
                const optionsText = progress.options
                  .map((opt, idx) => `  ${idx}: ${opt}`)
                  .join("\n");
                const progressChunk: Gemini.Types.GenerateContentResponse = {
                  candidates: [
                    {
                      content: {
                        parts: [
                          {
                            text: `Question: ${progress.question}\nOptions:\n${optionsText}\nAnswer: ${progress.answer}\n\n`,
                          },
                        ],
                        role: "model",
                      },
                      finishReason: undefined,
                      index: 0,
                    },
                  ],
                  modelVersion: optimizedModelName,
                };
                reply.raw.write(`data: ${JSON.stringify(progressChunk)}\n\n`);
              }
            : undefined,
        );

      // Apply updates back to Gemini contents
      logger.debug(
        { updateCount: Object.keys(toolResultUpdates).length },
        "[GeminiProxy] Applying tool result updates",
      );
      let filteredContents = utils.adapters.gemini.applyUpdates(
        body.contents || [],
        toolResultUpdates,
      );

      // Determine if TOON compression should be applied
      let toonTokensBefore: number | null = null;
      let toonTokensAfter: number | null = null;
      let toonCostSavings: number | null = null;
      const shouldApplyToonCompression =
        await utils.toonConversion.shouldApplyToonCompression(resolvedAgentId);

      if (shouldApplyToonCompression) {
        const { contents: convertedContents, stats } =
          await utils.adapters.gemini.convertToolResultsToToon(
            filteredContents,
            optimizedModelName,
          );
        filteredContents = convertedContents;
        toonTokensBefore = stats.toonTokensBefore;
        toonTokensAfter = stats.toonTokensAfter;
        toonCostSavings = stats.toonCostSavings;
      }

      fastify.log.info(
        {
          shouldApplyToonCompression,
          toonTokensBefore,
          toonTokensAfter,
          toonCostSavings,
        },
        "gemini proxy routes: handle generate content: tool results compression completed",
      );

      // Use filtered contents in request — convert REST body to SDK parameters
      const processedBody =
        utils.adapters.gemini.restToSdkGenerateContentParams(
          { ...body, contents: filteredContents },
          optimizedModelName,
          mergedTools.length > 0 ? mergedTools : undefined,
        );

      fastify.log.info(
        {
          resolvedAgentId,
          originalContentsCount: body.contents?.length || 0,
          filteredContentsCount: filteredContents.length,
          toolResultUpdatesCount: Object.keys(toolResultUpdates).length,
          contextIsTrusted,
        },
        "Contents filtered after trusted data evaluation",
      );

      if (stream) {
        logger.debug(
          { optimizedModelName, mergedToolsCount: mergedTools.length },
          "[GeminiProxy] Starting streaming request",
        );

        // Track timing for TTFT and tokens/sec metrics
        const streamStartTime = Date.now();
        let firstChunkTime: number | undefined;

        // Handle streaming response with span to measure LLM call duration
        const streamingResponse = await utils.tracing.startActiveLlmSpan(
          "gemini.generateContentStream",
          "gemini",
          optimizedModelName,
          true,
          resolvedAgent,
          async (llmSpan) => {
            const response = await genAI.models.generateContentStream(
              processedBody as GenerateContentParameters,
            );
            llmSpan.end();
            return response;
          },
        );

        // Set up SSE response headers
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        // Accumulate response for tool call evaluation and persistence
        let accumulatedText = "";
        const accumulatedFunctionCalls: Array<{
          name: string;
          args?: Record<string, unknown>;
        }> = [];
        const chunks: GenerateContentResponse[] = [];
        let tokenUsage: { input?: number; output?: number } = {};

        // Variables for interaction recording (accessible in finally block)
        let toolInvocationRefusal: [string, string] | null = null;
        let completeResponse: Gemini.Types.GenerateContentResponse | undefined;

        try {
          for await (const chunk of streamingResponse) {
            // Capture time to first token on first chunk
            if (!firstChunkTime) {
              firstChunkTime = Date.now();
              const ttftSeconds = (firstChunkTime - streamStartTime) / 1000;
              reportTimeToFirstToken(
                "gemini",
                resolvedAgent,
                optimizedModelName,
                ttftSeconds,
                externalAgentId,
              );
            }

            chunks.push(chunk);

            // Extract usage metadata if present
            if (chunk.usageMetadata) {
              tokenUsage = utils.adapters.gemini.getUsageTokens(
                chunk.usageMetadata,
              );
            }

            // Process parts from the chunk
            const candidate = chunk.candidates?.[0];
            if (candidate?.content?.parts) {
              for (const part of candidate.content.parts) {
                if (part.text) {
                  accumulatedText += part.text;
                }
                if (part.functionCall) {
                  accumulatedFunctionCalls.push({
                    name: part.functionCall.name || "",
                    args: part.functionCall.args as
                      | Record<string, unknown>
                      | undefined,
                  });
                }
              }
            }

            // Stream text content immediately (don't stream tool calls yet - need to evaluate policies)
            if (
              candidate?.content?.parts?.some((p) => p.text) &&
              !candidate?.content?.parts?.some((p) => p.functionCall)
            ) {
              const restChunk = utils.adapters.gemini.sdkResponseToRestResponse(
                chunk,
                optimizedModelName,
              );
              reply.raw.write(`data: ${JSON.stringify(restChunk)}\n\n`);
            }
          }

          logger.debug(
            {
              toolCallCount: accumulatedFunctionCalls.length,
              hasText: !!accumulatedText,
            },
            "[GeminiProxy] Stream completed, evaluating tool invocation policies",
          );

          // Evaluate tool invocation policies
          if (accumulatedFunctionCalls.length > 0) {
            const validToolCalls = accumulatedFunctionCalls
              .filter((tc) => tc.name)
              .map((toolCall) => ({
                toolCallName: toolCall.name,
                toolCallArgs: JSON.stringify(toolCall.args || {}),
              }));

            if (validToolCalls.length > 0) {
              toolInvocationRefusal =
                await utils.toolInvocation.evaluatePolicies(
                  validToolCalls,
                  resolvedAgentId,
                  contextIsTrusted,
                );
            }

            logger.debug(
              { toolInvocationRefused: !!toolInvocationRefusal },
              "[GeminiProxy] Tool invocation policy result",
            );

            if (toolInvocationRefusal) {
              const [_refusalMessage, contentMessage] = toolInvocationRefusal;

              // Stream the refusal as a single chunk
              const refusalChunk: Gemini.Types.GenerateContentResponse = {
                candidates: [
                  {
                    content: {
                      parts: [{ text: contentMessage }],
                      role: "model",
                    },
                    finishReason: "STOP",
                    index: 0,
                  },
                ],
                modelVersion: optimizedModelName,
              };
              reply.raw.write(`data: ${JSON.stringify(refusalChunk)}\n\n`);

              reportBlockedTools(
                "gemini",
                resolvedAgent,
                accumulatedFunctionCalls.length,
                optimizedModelName,
                externalAgentId,
              );
            } else {
              // Tool calls are allowed - stream the function calls
              for (const functionCall of accumulatedFunctionCalls) {
                const toolCallChunk: Gemini.Types.GenerateContentResponse = {
                  candidates: [
                    {
                      content: {
                        parts: [
                          {
                            functionCall: {
                              name: functionCall.name,
                              args: functionCall.args,
                            },
                          },
                        ],
                        role: "model",
                      },
                      finishReason: "STOP",
                      index: 0,
                    },
                  ],
                  modelVersion: optimizedModelName,
                };
                reply.raw.write(`data: ${JSON.stringify(toolCallChunk)}\n\n`);
              }
            }
          }

          // Send done marker
          reply.raw.write("data: [DONE]\n\n");

          // Build the complete response for persistence
          completeResponse = {
            candidates: [
              {
                content: {
                  parts: [
                    ...(accumulatedText ? [{ text: accumulatedText }] : []),
                    ...accumulatedFunctionCalls.map((fc) => ({
                      functionCall: { name: fc.name, args: fc.args },
                    })),
                  ],
                  role: "model",
                },
                finishReason: "STOP",
                index: 0,
              },
            ],
            modelVersion: optimizedModelName,
            usageMetadata: tokenUsage.input
              ? {
                  promptTokenCount: tokenUsage.input,
                  candidatesTokenCount: tokenUsage.output || 0,
                  totalTokenCount:
                    (tokenUsage.input || 0) + (tokenUsage.output || 0),
                }
              : undefined,
          };
        } finally {
          // Always record interaction (whether stream completed or was aborted)
          // If completeResponse wasn't built (stream aborted), build it from accumulated data
          if (!completeResponse) {
            fastify.log.info(
              "Stream was aborted before completion, building partial response",
            );
            completeResponse = {
              candidates: [
                {
                  content: {
                    parts: [
                      ...(accumulatedText ? [{ text: accumulatedText }] : []),
                      ...accumulatedFunctionCalls.map((fc) => ({
                        functionCall: { name: fc.name, args: fc.args },
                      })),
                    ],
                    role: "model",
                  },
                  finishReason: "STOP",
                  index: 0,
                },
              ],
              modelVersion: optimizedModelName,
              usageMetadata: tokenUsage.input
                ? {
                    promptTokenCount: tokenUsage.input,
                    candidatesTokenCount: tokenUsage.output || 0,
                    totalTokenCount:
                      (tokenUsage.input || 0) + (tokenUsage.output || 0),
                  }
                : undefined,
            };
          }

          // Calculate tokens per second if we have timing info
          if (firstChunkTime && tokenUsage.output && tokenUsage.output > 0) {
            const totalStreamTime = (Date.now() - firstChunkTime) / 1000;
            if (totalStreamTime > 0) {
              reportTokensPerSecond(
                "gemini",
                resolvedAgent,
                optimizedModelName,
                tokenUsage.output,
                totalStreamTime,
                externalAgentId,
              );
            }
          }

          // Report token usage metrics
          if (tokenUsage.input || tokenUsage.output) {
            reportLLMTokens(
              "gemini",
              resolvedAgent,
              tokenUsage,
              optimizedModelName,
              externalAgentId,
            );
          }

          // Calculate costs
          const baselineCost = await utils.costOptimization.calculateCost(
            baselineModel,
            tokenUsage.input || 0,
            tokenUsage.output || 0,
          );
          const costAfterModelOptimization =
            await utils.costOptimization.calculateCost(
              optimizedModelName,
              tokenUsage.input || 0,
              tokenUsage.output || 0,
            );

          fastify.log.info(
            {
              model: optimizedModelName,
              baselineModel,
              baselineCost,
              costAfterModelOptimization,
              inputTokens: tokenUsage.input,
              outputTokens: tokenUsage.output,
            },
            "gemini proxy routes: handle generate content: costs",
          );

          reportLLMCost(
            "gemini",
            resolvedAgent,
            optimizedModelName,
            costAfterModelOptimization,
            externalAgentId,
          );

          // Store the interaction
          await InteractionModel.create({
            profileId: resolvedAgentId,
            externalAgentId,
            userId,
            type: "gemini:generateContent",
            request: body,
            processedRequest: {
              ...body,
              contents: filteredContents,
            },
            response: toolInvocationRefusal
              ? {
                  candidates: [
                    {
                      content: {
                        parts: [{ text: toolInvocationRefusal[1] }],
                        role: "model",
                      },
                      finishReason: "STOP",
                      index: 0,
                    },
                  ],
                  modelVersion: optimizedModelName,
                }
              : completeResponse,
            model: optimizedModelName,
            inputTokens: tokenUsage.input,
            outputTokens: tokenUsage.output,
            cost: costAfterModelOptimization?.toFixed(10) ?? null,
            baselineCost: baselineCost?.toFixed(10) ?? null,
            toonTokensBefore,
            toonTokensAfter,
            toonCostSavings: toonCostSavings?.toFixed(10) ?? null,
          });

          reply.raw.end();
        }

        return;
      } else {
        logger.debug(
          { optimizedModelName },
          "[GeminiProxy] Starting non-streaming request",
        );
        // Non-streaming response with span to measure LLM call duration
        const response = await utils.tracing.startActiveLlmSpan(
          "gemini.generateContent",
          "gemini",
          optimizedModelName,
          false,
          resolvedAgent,
          async (llmSpan) => {
            const response = await genAI.models.generateContent(
              processedBody as GenerateContentParameters,
            );
            llmSpan.end();
            return response;
          },
        );

        // Extract tool calls from response
        const toolCalls = [];
        if (response.candidates) {
          toolCalls.push(
            ...(response.candidates[0]?.content?.parts
              ?.filter((p) => p.functionCall)
              .map((p) => p.functionCall) || []),
          );
        }

        logger.debug(
          { toolCallCount: toolCalls.length },
          "[GeminiProxy] Non-streaming response received, checking tool invocation policies",
        );

        // Evaluate tool invocation policies
        let toolInvocationRefusal: [string, string] | null = null;
        if (toolCalls.length > 0) {
          const validToolCalls = toolCalls
            .filter(
              (tc): tc is { name: string; args?: Record<string, unknown> } =>
                Boolean(tc?.name),
            )
            .map((toolCall) => ({
              toolCallName: toolCall.name,
              toolCallArgs: JSON.stringify(toolCall.args || {}),
            }));

          if (validToolCalls.length > 0) {
            toolInvocationRefusal = await utils.toolInvocation.evaluatePolicies(
              validToolCalls,
              resolvedAgentId,
              contextIsTrusted,
            );
          }
        }

        // Extract token usage
        const tokenUsage = response.usageMetadata
          ? utils.adapters.gemini.getUsageTokens(response.usageMetadata)
          : { input: null, output: null };

        // Always calculate baseline cost (original requested model)
        const baselineCost = await utils.costOptimization.calculateCost(
          baselineModel,
          tokenUsage.input,
          tokenUsage.output,
        );

        // Calculate actual cost (potentially optimized model)
        const costAfterModelOptimization =
          await utils.costOptimization.calculateCost(
            optimizedModelName,
            tokenUsage.input,
            tokenUsage.output,
          );

        fastify.log.info(
          {
            model: optimizedModelName,
            baselineModel,
            baselineCost,
            costAfterModelOptimization,
            inputTokens: tokenUsage.input,
            outputTokens: tokenUsage.output,
          },
          "gemini proxy routes: handle generate content: costs",
        );

        reportLLMCost(
          "gemini",
          resolvedAgent,
          optimizedModelName,
          costAfterModelOptimization,
          externalAgentId,
        );

        if (toolInvocationRefusal) {
          const [_refusalMessage, contentMessage] = toolInvocationRefusal;

          logger.debug(
            { toolCallCount: toolCalls.length },
            "[GeminiProxy] Tool invocation blocked by policy",
          );

          // Create refusal response in Gemini format
          const refusalResponse: Gemini.Types.GenerateContentResponse = {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: contentMessage,
                    },
                  ],
                  role: "model",
                },
                finishReason: "STOP" as const,
                index: 0,
              },
            ],
            modelVersion: response.modelVersion || optimizedModelName,
            responseId: "blocked",
          };

          reportBlockedTools(
            "gemini",
            resolvedAgent,
            toolCalls.length,
            optimizedModelName,
            externalAgentId,
          );

          // Store the interaction with refusal
          await InteractionModel.create({
            profileId: resolvedAgentId,
            externalAgentId,
            userId,
            type: "gemini:generateContent",
            request: body,
            processedRequest: {
              ...body,
              contents: filteredContents,
            },
            response: refusalResponse,
            model: optimizedModelName,
            inputTokens: tokenUsage.input,
            outputTokens: tokenUsage.output,
            cost: costAfterModelOptimization?.toFixed(10) ?? null,
            baselineCost: baselineCost?.toFixed(10) ?? null,
            toonTokensBefore,
            toonTokensAfter,
            toonCostSavings: toonCostSavings?.toFixed(10) ?? null,
          });

          return reply.send(refusalResponse);
        }
        // Tool calls are allowed - return response with function calls to client
        // Client is responsible for executing tools via MCP Gateway and sending results back

        // Convert SDK response to REST format and store
        const restResponse = utils.adapters.gemini.sdkResponseToRestResponse(
          response,
          optimizedModelName,
        );

        logger.debug(
          {
            resolvedAgentId,
            inputTokens: tokenUsage.input,
            outputTokens: tokenUsage.output,
          },
          "[GeminiProxy] Response received, storing interaction",
        );

        await InteractionModel.create({
          profileId: resolvedAgentId,
          externalAgentId,
          userId,
          type: "gemini:generateContent",
          request: body,
          processedRequest: {
            ...body,
            contents: filteredContents,
          },
          response: restResponse,
          model: optimizedModelName,
          inputTokens: tokenUsage.input,
          outputTokens: tokenUsage.output,
          cost: costAfterModelOptimization?.toFixed(10) ?? null,
          baselineCost: baselineCost?.toFixed(10) ?? null,
          toonTokensBefore,
          toonTokensAfter,
          toonCostSavings: toonCostSavings?.toFixed(10) ?? null,
        });

        return reply.send(restResponse);
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
    `${API_PREFIX}/${includeAgentId ? ":agentId/" : ""}v1beta/models/:model(^[a-zA-Z0-9-.]+$)::${verb}`;

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
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const userId = await utils.userId.getUserId(request.headers);
      return handleGenerateContent(
        request.body,
        request.headers,
        reply,
        request.params.model,
        undefined,
        false,
        externalAgentId,
        userId,
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
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const userId = await utils.userId.getUserId(request.headers);
      return handleGenerateContent(
        request.body,
        request.headers,
        reply,
        request.params.model,
        undefined,
        true,
        externalAgentId,
        userId,
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
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const userId = await utils.userId.getUserId(request.headers);
      return handleGenerateContent(
        request.body,
        request.headers,
        reply,
        request.params.model,
        request.params.agentId,
        false,
        externalAgentId,
        userId,
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
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const userId = await utils.userId.getUserId(request.headers);
      return handleGenerateContent(
        request.body,
        request.headers,
        reply,
        request.params.model,
        request.params.agentId,
        true,
        externalAgentId,
        userId,
      );
    },
  );
};

export default geminiProxyRoutes;
