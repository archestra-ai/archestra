import fastifyHttpProxy from "@fastify/http-proxy";
import {
  type Candidate,
  type GenerateContentParameters,
  GoogleGenAI,
} from "@google/genai";
import { trace } from "@opentelemetry/api";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import { AgentModel, InteractionModel } from "@/models";
import { getObservableGenAI } from "@/models/llm-metrics";
import { ErrorResponseSchema, Gemini, UuidIdSchema } from "@/types";
import { PROXY_API_PREFIX } from "./common";
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
    if (body.tools && !Array.isArray(body.tools)) {
      body.tools = [body.tools];
    }
    const tools = Array.isArray(body.tools) ? body.tools : [];
    // Add OpenTelemetry span attribute for filtering in Jaeger
    const span = trace.getActiveSpan();
    if (span) {
      span.setAttribute("route.category", "llm-proxy");
      span.setAttribute("llm.provider", "gemini");
    }

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
    const genAI = getObservableGenAI(
      new GoogleGenAI({
        apiKey: geminiApiKey,
        httpOptions: { baseUrl: config.llm.gemini.baseUrl },
      }),
      resolvedAgentId,
    );

    // Use the model from the URL path or default to gemini-pro
    const modelName = model || "gemini-2.5-pro";

    try {
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

      const mergedTools = await injectTools(body.tools, resolvedAgentId);

      // Convert to common format and evaluate trusted data policies
      const commonMessages = utils.adapters.gemini.toCommonFormat(
        body.contents || [],
      );
      const { toolResultUpdates, contextIsTrusted } =
        await utils.trustedData.evaluateIfContextIsTrusted(
          commonMessages,
          resolvedAgentId,
          geminiApiKey,
          "gemini",
          stream
            ? () => {
                // Send initial indicator when dual LLM starts (streaming only)
                const startChunk = {
                  candidates: [
                    {
                      content: {
                        parts: [
                          {
                            text: "Analyzing with Dual LLM:\n\n",
                          },
                        ],
                        role: "model",
                      },
                      finishReason: "STOP",
                      index: 0,
                    },
                  ],
                };
                reply.raw.write(`data: ${JSON.stringify(startChunk)}\n`);
              }
            : undefined,
          stream
            ? (progress) => {
                // Stream Q&A progress with options
                const optionsText = progress.options
                  .map((opt, idx) => `  ${idx}: ${opt}`)
                  .join("\n");
                const progressChunk = {
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
                      finishReason: "STOP",
                      index: 0,
                    },
                  ],
                };
                reply.raw.write(`data: ${JSON.stringify(progressChunk)}\n`);
              }
            : undefined,
        );

      // Apply updates back to Gemini contents
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

      if (stream) {
        reply.header("Content-Type", "text/event-stream");
        reply.header("Cache-Control", "no-cache");
        reply.header("Connection", "keep-alive");

        // Handle streaming response
        // Log outbound URL we expect the SDK to call (helps debug WireMock path mismatches)
        try {
          const outbound = new URL(
            `/v1beta/models/${modelName}:streamGenerateContent`,
            config.llm.gemini.baseUrl,
          );
          fastify.log.info({
            msg: "gemini proxy outbound (stream)",
            outbound: outbound.toString(),
          });
        } catch (e) {
          fastify.log.warn({
            msg: "failed to compute outbound gemini url (stream)",
            err: String(e),
          });
        }

        // SDK expects a GenerateContentParameters object. processedBody already
        // contains model and config.tools when mergedTools was provided, so pass
        // it directly to avoid duplicate keys.
        const result = await genAI.models.generateContentStream(
          processedBody as GenerateContentParameters,
        );

        // Accumulate response for policy evaluation and persistence
        const accumulatedToolCalls: Array<{
          id: string;
          name: string;
          arguments: string;
        }> = [];
        const chunks: Array<{ candidates?: Candidate[] }> = [];

        for await (const chunk of result) {
          chunks.push(chunk);

          // Accumulate tool calls but don't stream them yet (need to evaluate policies first)
          if (chunk.candidates?.[0]?.content?.parts) {
            for (const part of chunk.candidates[0].content.parts) {
              if (
                "functionCall" in part &&
                part.functionCall &&
                part.functionCall.name
              ) {
                const toolCallId = utils.adapters.gemini.generateToolCallId(
                  part.functionCall.name,
                );
                accumulatedToolCalls.push({
                  id: toolCallId,
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args || {}),
                });
              } else {
                // Stream non-tool content immediately
                reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
              }
            }
          } else {
            // Stream chunks without parts immediately
            reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
        }

        // Evaluate tool invocation policies
        let toolInvocationRefusal: [string, string] | null = null;
        if (accumulatedToolCalls.length > 0) {
          const validToolCalls = accumulatedToolCalls.map((tc) => ({
            toolCallName: tc.name,
            toolCallArgs: tc.arguments,
          }));

          toolInvocationRefusal = await utils.toolInvocation.evaluatePolicies(
            validToolCalls,
            resolvedAgentId,
            contextIsTrusted,
          );
        }

        if (toolInvocationRefusal) {
          const [_refusalMessage, contentMessage] = toolInvocationRefusal;

          // Stream refusal message
          const refusalChunk = {
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
                finishReason: "STOP",
                index: 0,
              },
            ],
          };
          reply.raw.write(`data: ${JSON.stringify(refusalChunk)}\n\n`);

          // Store the interaction with refusal
          await InteractionModel.create({
            agentId: resolvedAgentId,
            type: "gemini:generateContent",
            request: body,
            // biome-ignore lint/suspicious/noExplicitAny: Gemini still WIP
            response: { chunks, refusal: contentMessage } as any,
          });
        } else if (accumulatedToolCalls.length > 0) {
          // Tool calls are allowed - execute MCP tools
          const commonToolCalls = accumulatedToolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: JSON.parse(tc.arguments),
          }));

          const mcpResults = await utils.tools.executeMcpToolCalls(
            commonToolCalls,
            resolvedAgentId,
          );

          if (mcpResults.length > 0) {
            // Stream the tool calls first
            const lastChunkWithToolCalls = chunks.find((c) =>
              c.candidates?.[0]?.content?.parts?.some(
                (p) => "functionCall" in p,
              ),
            );
            if (lastChunkWithToolCalls) {
              reply.raw.write(
                `data: ${JSON.stringify(lastChunkWithToolCalls)}\n\n`,
              );
            }

            // Convert MCP results to Gemini format
            const toolResultParts = mcpResults.map((result) => ({
              functionResponse: {
                name:
                  commonToolCalls.find((tc) => tc.id === result.id)?.name ||
                  "unknown",
                response: result.isError
                  ? ({
                      error: result.error || "Tool execution failed",
                    } as Record<string, unknown>)
                  : (result.content as Record<string, unknown>),
              },
            }));

            // Make another streaming call with the tool results
            const modelResponse = chunks
              .flatMap((c) => c.candidates?.[0]?.content?.parts || [])
              .filter((p) => "functionCall" in p || "text" in p);

            const updatedContents = [
              ...filteredContents,
              {
                role: "model" as const,
                parts: modelResponse,
              },
              {
                role: "user" as const,
                parts: toolResultParts,
              },
            ];

            // Make final streaming call with tool results
            const finalParams = {
              ...processedBody,
              contents: updatedContents,
            } as GenerateContentParameters;
            const finalResult =
              await genAI.models.generateContentStream(finalParams);

            const finalChunks: Array<{ candidates?: Candidate[] }> = [];
            for await (const finalChunk of finalResult) {
              finalChunks.push(finalChunk);
              reply.raw.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
            }

            // Store the interaction with final response
            await InteractionModel.create({
              agentId: resolvedAgentId,
              type: "gemini:generateContent",
              request: body,
              // biome-ignore lint/suspicious/noExplicitAny: Gemini still WIP
              response: { chunks: finalChunks } as any,
            });
          } else {
            // No MCP results, stream the tool calls
            const lastChunkWithToolCalls = chunks.find((c) =>
              c.candidates?.[0]?.content?.parts?.some(
                (p) => "functionCall" in p,
              ),
            );
            if (lastChunkWithToolCalls) {
              reply.raw.write(
                `data: ${JSON.stringify(lastChunkWithToolCalls)}\n\n`,
              );
            }

            // Store the interaction
            await InteractionModel.create({
              agentId: resolvedAgentId,
              type: "gemini:generateContent",
              request: body,
              // biome-ignore lint/suspicious/noExplicitAny: Gemini still WIP
              response: { chunks } as any,
            });
          }
        } else {
          // No tool calls, just store the interaction
          await InteractionModel.create({
            agentId: resolvedAgentId,
            type: "gemini:generateContent",
            request: body,
            // biome-ignore lint/suspicious/noExplicitAny: Gemini still WIP
            response: { chunks } as any,
          });
        }

        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
        return reply;
      } else {
        const response = await genAI.models.generateContent(
          processedBody as GenerateContentParameters,
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
          const refusalResponse = {
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
                finishReason: "STOP",
                index: 0,
              },
            ],
          };

          // Store the interaction with refusal
          await InteractionModel.create({
            agentId: resolvedAgentId,
            type: "gemini:generateContent",
            request: body,
            // biome-ignore lint/suspicious/noExplicitAny: Gemini still WIP
            response: refusalResponse as any,
          });

          return reply.send(refusalResponse);
        } else if (toolCalls.length > 0) {
          // Tool calls are allowed - execute MCP tools
          const commonToolCalls = toolCalls
            .filter(
              (tc): tc is { name: string; args?: Record<string, unknown> } =>
                Boolean(tc?.name),
            )
            .map((tc, index) => ({
              id: `gemini-${Date.now()}-${index}`,
              name: tc.name,
              arguments: tc.args || {},
            }));

          const mcpResults = await utils.tools.executeMcpToolCalls(
            commonToolCalls,
            resolvedAgentId,
          );

          if (mcpResults.length > 0) {
            // Convert MCP results to Gemini format
            const toolResultParts = mcpResults.map((result) => ({
              functionResponse: {
                name:
                  commonToolCalls.find((tc) => tc.id === result.id)?.name ||
                  "unknown",
                response: result.isError
                  ? ({
                      error: result.error || "Tool execution failed",
                    } as Record<string, unknown>)
                  : (result.content as Record<string, unknown>),
              },
            }));

            // Make another call with the tool results
            const updatedContents = [
              ...filteredContents,
              {
                role: "model" as const,
                parts: response.candidates?.[0]?.content?.parts || [],
              },
              {
                role: "user" as const,
                parts: toolResultParts,
              },
            ];

            // Make final call with tool results
            const finalParams = {
              ...processedBody,
              contents: updatedContents,
            } as GenerateContentParameters;
            const finalResponse =
              await genAI.models.generateContent(finalParams);

            // Store the interaction with final response
            await InteractionModel.create({
              agentId: resolvedAgentId,
              type: "gemini:generateContent",
              request: body,
              // biome-ignore lint/suspicious/noExplicitAny: Gemini still WIP
              response: finalResponse as any,
            });

            return reply.send(finalResponse);
          }
        }

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

      const errorPayload = {
        error: {
          message:
            error instanceof Error
              ? error.message
              : "An unexpected error occurred",
          type: "api_error",
        },
      };
      if (stream) {
        reply.raw.write(`data: ${JSON.stringify(errorPayload) + "\n\n"}`);
        reply.raw.end();
        return;
      }

      return reply.status(statusCode).send(errorPayload);
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
        tags: ["llm-proxy"],
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
        tags: ["llm-proxy"],
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
        tags: ["llm-proxy"],
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
        tags: ["llm-proxy"],
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
