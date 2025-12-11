import fastifyHttpProxy from "@fastify/http-proxy";
import {
  type Content,
  type FunctionResponse,
  type GenerateContentParameters,
  GoogleGenAI,
} from "@google/genai";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
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
 * Inject assigned MCP tools into Gemini tools object
 * Assigned tools take priority and override tools with the same name from the request
 */
const injectTools = async (
  requestTools: Gemini.Types.Tool[] | undefined,
  agentId: string,
): Promise<Gemini.Types.Tool[] | undefined> => {
  const assignedTools = await utils.tools.getAssignedMCPTools(agentId);

  // Convert assigned tools to Gemini format (function declarations)
  const assignedGeminiFunctions: z.infer<
    typeof Gemini.Tools.FunctionDeclarationSchema
  >[] = assignedTools.map((tool) => ({
    name: tool.name,
    description: tool.description || "",
    parameters: tool.parameters,
  }));

  if (assignedGeminiFunctions.length === 0 && !requestTools) {
    return undefined;
  }

  // Handle case where requestTools is undefined or empty
  const requestFunctions: z.infer<
    typeof Gemini.Tools.FunctionDeclarationSchema
  >[] = [];
  if (requestTools && Array.isArray(requestTools) && requestTools.length > 0) {
    for (const tool of requestTools) {
      if (tool.functionDeclarations) {
        requestFunctions.push(...tool.functionDeclarations);
      }
    }
  }

  // Create a map of request functions by name
  const functionMap = new Map<
    string,
    z.infer<typeof Gemini.Tools.FunctionDeclarationSchema>
  >();
  for (const func of requestFunctions) {
    functionMap.set(func.name, func);
  }

  // Merge: assigned tools override request tools with same name
  for (const assignedFunc of assignedGeminiFunctions) {
    functionMap.set(assignedFunc.name, assignedFunc);
  }

  // Return as Gemini.Types.Tool array format
  const mergedFunctions = Array.from(functionMap.values());
  if (mergedFunctions.length === 0) {
    return undefined;
  }

  return [{ functionDeclarations: mergedFunctions }];
};

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
    const { "x-goog-api-key": geminiApiKey } = headers;
    const genAI = getObservableGenAI(
      new GoogleGenAI({
        apiKey: geminiApiKey,
        httpOptions: {
          baseUrl: config.llm.gemini.baseUrl,
          apiVersion: "v1beta",
        },
      }),
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

      // Persist tools if present
      await utils.tools.persistTools(
        (tools || [])
          .filter((tool) => tool.functionDeclarations !== undefined)
          .map((tool) => {
            return {
              toolName: tool.functionDeclarations?.[0].name ?? "unnamed_tool",
              toolParameters: tool.functionDeclarations?.[0].parameters || {},
              toolDescription: tool.functionDeclarations?.[0].description || "",
            };
          }),
        resolvedAgentId,
      );

      // Inject assigned MCP tools (assigned tools take priority)
      const mergedTools = await injectTools(body.tools, resolvedAgentId);

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
      const { toolResultUpdates, contextIsTrusted } =
        await utils.trustedData.evaluateIfContextIsTrusted(
          commonMessages,
          resolvedAgentId,
          geminiApiKey,
          "gemini",
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

      // Use filtered contents in request — convert REST body to SDK parameters
      const processedBody =
        utils.adapters.gemini.restToSdkGenerateContentParams(
          { ...body, contents: filteredContents },
          modelName,
          mergedTools,
        );

      logger.debug(
        { filteredContentsCount: filteredContents.length },
        "[GeminiProxy] Contents filtered after trusted data evaluation",
      );

      if (stream) {
        logger.debug(
          { modelName },
          "[GeminiProxy] Streaming not supported yet",
        );
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

        if (toolInvocationRefusal) {
          const [_refusalMessage, contentMessage] = toolInvocationRefusal;

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
            modelVersion: response.modelVersion || modelName,
            responseId: "blocked",
          };

          const tokenUsage = response.usageMetadata
            ? utils.adapters.gemini.getUsageTokens(response.usageMetadata)
            : { input: null, output: null };

          // Store the interaction with refusal
          await InteractionModel.create({
            profileId: resolvedAgentId,
            externalAgentId,
            type: "gemini:generateContent",
            request: body,
            response: refusalResponse,
            model: model,
            inputTokens: tokenUsage.input,
            outputTokens: tokenUsage.output,
          });

          return reply.send(refusalResponse);
        } else if (toolCalls.length > 0) {
          // Tool calls are allowed - execute MCP tools
          const commonToolCalls = toolCalls
            .filter(
              (tc): tc is { name: string; args?: Record<string, unknown> } =>
                Boolean(tc?.name),
            )
            .map((tc) => ({
              id: utils.adapters.gemini.generateToolCallId(tc.name),
              name: tc.name,
              arguments: tc.args || {},
            }));

          const mcpResults = await utils.tools.executeMcpToolCalls(
            commonToolCalls,
            resolvedAgentId,
          );

          fastify.log.info(
            {
              resolvedAgentId,
              results: mcpResults.map((r) => ({
                id: r.id,
                isError: r.isError,
                contentLength:
                  typeof r.content === "string"
                    ? r.content.length
                    : JSON.stringify(r.content).length,
              })),
            },
            "MCP tool calls completed (non-streaming)",
          );

          if (mcpResults.length > 0) {
            // Convert MCP results to Gemini format
            const toolResultParts: FunctionResponse[] =
              utils.adapters.gemini.toolResultsToMessages(
                mcpResults,
                commonToolCalls,
              );

            // Make another call with the tool results
            const updatedContents: Content[] = [
              ...(filteredContents as Content[]),
              {
                role: "model" as const,
                parts: response.candidates?.[0]?.content?.parts || [],
              },
              {
                role: "user" as const,
                parts: toolResultParts.map((fr) => ({
                  functionResponse: {
                    name: fr.name,
                    response: fr.response,
                  },
                })),
              },
            ];

            // Make final call with tool results
            const finalParams = {
              ...processedBody,
              contents: updatedContents as Content[],
            } as GenerateContentParameters;

            const finalResponse =
              await genAI.models.generateContent(finalParams);

            // Convert SDK response to REST format
            const restResponse =
              utils.adapters.gemini.sdkResponseToRestResponse(
                finalResponse,
                modelName,
              );

            const tokenUsage = finalResponse.usageMetadata
              ? utils.adapters.gemini.getUsageTokens(finalResponse.usageMetadata)
              : { input: null, output: null };

            // Store the interaction with final response
            await InteractionModel.create({
              profileId: resolvedAgentId,
              externalAgentId,
              type: "gemini:generateContent",
              request: body,
              model: model,
              response: {
                ...restResponse,
                candidates: [
                  ...(finalParams.contents as Content[]).map((c, idx) => ({
                    content: utils.adapters.gemini.sdkContentToRestContent(c),
                    index: idx,
                  })),
                  ...restResponse.candidates,
                ],
              },
              inputTokens: tokenUsage.input,
              outputTokens: tokenUsage.output,
            });

            return reply.send(restResponse);
          }
        }

        // Convert SDK response to REST format and store
        const restResponse = utils.adapters.gemini.sdkResponseToRestResponse(
          response,
          modelName,
        );

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
          profileId: resolvedAgentId,
          externalAgentId,
          type: "gemini:generateContent",
          request: body,
          response: restResponse,
          model: model,
          inputTokens: tokenUsage.input,
          outputTokens: tokenUsage.output,
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
      return handleGenerateContent(
        request.body,
        request.headers,
        reply,
        request.params.model,
        undefined,
        false,
        externalAgentId,
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
      return handleGenerateContent(
        request.body,
        request.headers,
        reply,
        request.params.model,
        undefined,
        true,
        externalAgentId,
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
      return handleGenerateContent(
        request.body,
        request.headers,
        reply,
        request.params.model,
        request.params.agentId,
        false,
        externalAgentId,
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
      return handleGenerateContent(
        request.body,
        request.headers,
        reply,
        request.params.model,
        request.params.agentId,
        true,
        externalAgentId,
      );
    },
  );
};

export default geminiProxyRoutes;
