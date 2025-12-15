import {
  Behavior,
  type Candidate,
  type Content,
  type FunctionResponse,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type GenerateContentResponseUsageMetadata,
  type HarmCategory,
  type HarmProbability,
  type Part,
} from "@google/genai";
import { encode as toonEncode } from "@toon-format/toon";
import logger from "@/logging";
import { TokenPriceModel } from "@/models";
import { getTokenizer } from "@/tokenizers";
import type { CommonToolCall, CommonToolResult, Gemini } from "@/types";
import type { CommonMessage, ToolResultUpdates } from "@/types/llm-proxy";
import type { CompressionStats } from "../toon-conversion";

type GeminiContents = Gemini.Types.GenerateContentRequest["contents"];

/**
 * Convert Gemini contents to common format for trusted data evaluation
 */
export function toCommonFormat(contents: GeminiContents): CommonMessage[] {
  logger.debug(
    { contentsCount: contents?.length || 0 },
    "[adapters/gemini] toCommonFormat: starting conversion",
  );
  const commonMessages: CommonMessage[] = [];

  for (const content of contents) {
    const commonMessage: CommonMessage = {
      role: content.role as CommonMessage["role"],
    };

    // Process parts looking for function responses
    if (content.parts) {
      const toolCalls: CommonToolResult[] = [];

      for (const part of content.parts) {
        // Check if this part has the functionResponse property
        if (
          "functionResponse" in part &&
          part.functionResponse &&
          typeof part.functionResponse === "object" &&
          "name" in part.functionResponse &&
          "response" in part.functionResponse
        ) {
          const { functionResponse } = part;
          const id =
            "id" in functionResponse && typeof functionResponse.id === "string"
              ? functionResponse.id
              : generateToolCallId(functionResponse.name as string);

          toolCalls.push({
            id,
            name: functionResponse.name as string,
            content: functionResponse.response,
            isError: false,
          });
        }
      }

      if (toolCalls.length > 0) {
        commonMessage.toolCalls = toolCalls;
      }
    }

    commonMessages.push(commonMessage);
  }

  logger.debug(
    { commonMessageCount: commonMessages.length },
    "[adapters/gemini] toCommonFormat: conversion complete",
  );
  return commonMessages;
}

/**
 * Apply tool result updates back to Gemini contents
 * Returns an array of Content objects, not ContentListUnion
 */
export function applyUpdates(
  contents: GeminiContents,
  updates: ToolResultUpdates,
): GeminiContents {
  const updateCount = Object.keys(updates).length;
  logger.debug(
    { contentsCount: contents?.length || 0, updateCount },
    "[adapters/gemini] applyUpdates: starting",
  );

  if (updateCount === 0) {
    logger.debug("[adapters/gemini] applyUpdates: no updates to apply");
    return contents;
  }

  return contents.map((content) => {
    // Only process user messages with parts
    if (content.role === "user" && content.parts) {
      const updatedParts = content.parts.map((part) => {
        // Check if this part is a function response
        if (
          "functionResponse" in part &&
          part.functionResponse &&
          typeof part.functionResponse === "object" &&
          "name" in part.functionResponse
        ) {
          const { functionResponse } = part;
          const id =
            "id" in functionResponse && typeof functionResponse.id === "string"
              ? functionResponse.id
              : generateToolCallId(functionResponse.name as string);

          if (updates[id]) {
            // Update the function response with sanitized content
            return {
              functionResponse: {
                ...functionResponse,
                response: { sanitizedContent: updates[id] } as Record<
                  string,
                  unknown
                >,
              },
            };
          }
        }
        return part;
      });

      return {
        ...content,
        parts: updatedParts,
      };
    }

    return content;
  });
}

/**
 * Generate a consistent tool call ID for function responses that don't have one
 * This is needed because Gemini's function responses may not always have an ID
 */
export function generateToolCallId(functionName: string): string {
  // Use a simple deterministic approach for now
  // In practice, this might need to be more sophisticated
  return `gemini-tool-${functionName}-${Date.now()}`;
}

/**
 * Extract the user's original request from Gemini contents
 */
export function extractUserRequest(contents: GeminiContents): string {
  // Find the last user content with text
  for (let i = contents.length - 1; i >= 0; i--) {
    const content = contents[i];
    if (content.role === "user" && content.parts) {
      for (const part of content.parts) {
        if ("text" in part && part.text && typeof part.text === "string") {
          return part.text;
        }
      }
    }
  }
  return "process this data";
}

/**
 * Convert a Gemini REST-style GenerateContentRequest body into the SDK's
 * GenerateContentParameters shape. The SDK and REST shapes differ significantly:
 * - SDK expects contents as an array of Content objects
 * - SDK expects tools, systemInstruction, and generationConfig at top level
 * - SDK doesn't use a nested "config" object for these parameters
 *
 * Note: Gemini SDK and REST API have different schemas. See:
 * https://ai.google.dev/api/generate-content
 */
export function restToSdkGenerateContentParams(
  body: Partial<Gemini.Types.GenerateContentRequest>,
  model: string,
  mergedTools?: Gemini.Types.Tool[] | undefined,
): GenerateContentParameters {
  // Build a partial params object and cast at the end. Use Partial<> to keep
  // strong typing while allowing incremental population.
  const params: Partial<GenerateContentParameters> = {
    model,
    contents: [],
    config: {} as GenerateContentConfig,
  };

  if (Array.isArray(body.contents)) {
    params.contents = body.contents as GenerateContentParameters["contents"];
  } else {
    params.contents = [] as GenerateContentParameters["contents"];
  }

  if (body.generationConfig) {
    params.config =
      body.generationConfig as GenerateContentParameters["config"];
  } else {
    const generationConfig: Record<string, unknown> = {};
    const configKeys = [
      "temperature",
      "maxOutputTokens",
      "candidateCount",
      "topP",
      "topK",
      "stopSequences",
    ];
    for (const k of configKeys) {
      const val = (body as Record<string, unknown>)[k];
      if (val !== undefined) generationConfig[k] = val;
    }
    if (Object.keys(generationConfig).length > 0) {
      params.config = generationConfig as GenerateContentParameters["config"];
    }
  }
  if (params.config === undefined) {
    params.config = {} as GenerateContentConfig;
  }
  if (mergedTools && mergedTools.length > 0) {
    const sdkTools = mergedTools.map((t) => {
      const functionDeclarations = t.functionDeclarations?.map((fd) => {
        const mappedBehavior = fd.behavior
          ? (Behavior as Record<string, Behavior>)[fd.behavior]
          : undefined;
        return {
          name: fd.name,
          description: fd.description,
          behavior: mappedBehavior,
          parameters: fd.parameters,
          parametersJsonSchema: fd.parametersJsonSchema,
          response: fd.response,
          responseJsonSchema: fd.responseJsonSchema,
        };
      });

      return {
        ...t,
        functionDeclarations,
      } as unknown as Record<string, unknown>;
    });

    params.config.tools = sdkTools;
  }

  if (body.systemInstruction) {
    params.config.systemInstruction = { ...body.systemInstruction };
  }

  return params as GenerateContentParameters;
}

type GeminiUsage = Pick<
  Gemini.Types.UsageMetadata,
  "promptTokenCount" | "candidatesTokenCount"
>;
/** Returns Gemini input and output usage tokens */
export function getUsageTokens(usage: GeminiUsage) {
  return {
    input: usage.promptTokenCount,
    output: usage.candidatesTokenCount,
  };
}
export function sdkPartToRestPart(sdkPart: Part): Gemini.Types.MessagePart {
  // Text part
  if (sdkPart.text !== undefined) {
    return {
      text: sdkPart.text,
      thought: sdkPart.thought,
      thoughtSignature: sdkPart.thoughtSignature,
      metadata: sdkPart.videoMetadata,
    };
  }

  // Function call part
  if (sdkPart.functionCall !== undefined) {
    return {
      functionCall: {
        name: sdkPart.functionCall.name ?? "unknown_function",
        id: sdkPart.functionCall.id,
        args: sdkPart.functionCall.args,
      },
      thought: sdkPart.thought,
      thoughtSignature: sdkPart.thoughtSignature,
      metadata: sdkPart.videoMetadata,
    };
  }

  // Function response part
  if (sdkPart.functionResponse !== undefined) {
    return {
      functionResponse: {
        name: sdkPart.functionResponse.name ?? "unknown_function",
        id: sdkPart.functionResponse.id,
        response: sdkPart.functionResponse.response || {},
        willContinue: sdkPart.functionResponse.willContinue,
        scheduling: sdkPart.functionResponse.scheduling,
      },
      thought: sdkPart.thought,
      thoughtSignature: sdkPart.thoughtSignature,
      metadata: sdkPart.videoMetadata,
    };
  }

  // Inline data part
  if (sdkPart.inlineData !== undefined) {
    return {
      inlineData: {
        mimeType: sdkPart.inlineData.mimeType,
        data: sdkPart.inlineData.data ?? "unknown_data",
      },
      thought: sdkPart.thought,
      thoughtSignature: sdkPart.thoughtSignature,
      metadata: sdkPart.videoMetadata,
    };
  }

  // File data part
  if (sdkPart.fileData !== undefined) {
    return {
      fileData: {
        mimeType: sdkPart.fileData.mimeType ?? "",
        fileUri: sdkPart.fileData.fileUri ?? "",
      },
      thought: sdkPart.thought,
      thoughtSignature: sdkPart.thoughtSignature,
      metadata: sdkPart.videoMetadata,
    };
  }

  // Executable code part
  if (sdkPart.executableCode !== undefined) {
    return {
      language:
        sdkPart.executableCode.language || ("LANGUAGE_UNSPECIFIED" as const),
      executableCode: {
        code: sdkPart.executableCode.code ?? "",
      },
      thought: sdkPart.thought,
      thoughtSignature: sdkPart.thoughtSignature,
      metadata: sdkPart.videoMetadata,
    };
  }

  // Code execution result part
  if (sdkPart.codeExecutionResult !== undefined) {
    return {
      codeExecutionResult: {
        outcome:
          sdkPart.codeExecutionResult.outcome ||
          ("OUTCOME_UNSPECIFIED" as const),
        output: sdkPart.codeExecutionResult.output,
      },
      thought: sdkPart.thought,
      thoughtSignature: sdkPart.thoughtSignature,
      metadata: sdkPart.videoMetadata,
    };
  }

  // Fallback - return text part with empty text
  return {
    text: "",
  };
}

/**
 * Convert SDK Candidate format to REST API Candidate format
 */
export function sdkCandidateToRestCandidate(
  sdkCandidate: Candidate,
): Gemini.Types.Candidate {
  return {
    content: {
      role: sdkCandidate.content?.role || "model",
      parts: sdkCandidate.content?.parts?.map(sdkPartToRestPart) || [],
    },
    finishReason: sdkCandidate.finishReason,
    safetyRatings: sdkCandidate.safetyRatings
      ?.filter(
        (
          rating,
        ): rating is {
          category: HarmCategory;
          probability: HarmProbability;
          blocked?: boolean;
        } => rating.category !== undefined && rating.probability !== undefined,
      )
      .map((rating) => ({
        category: rating.category,
        probability: rating.probability,
        blocked: rating.blocked,
      })) as Gemini.Types.Candidate["safetyRatings"],
    citationMetadata: sdkCandidate.citationMetadata?.citations
      ? ({
          citationSources: sdkCandidate.citationMetadata.citations.map(
            (source) => ({
              startIndex: source.startIndex,
              endIndex: source.endIndex,
              uri: source.uri,
              license: source.license,
            }),
          ),
        } as Gemini.Types.Candidate["citationMetadata"])
      : undefined,
    tokenCount: sdkCandidate.tokenCount,
    groundingMetadata: sdkCandidate.groundingMetadata,
    avgLogprobs: sdkCandidate.avgLogprobs,
    logprobsResult: sdkCandidate.logprobsResult,
    index: sdkCandidate.index ?? 0,
    finishMessage: sdkCandidate.finishMessage,
  } as Gemini.Types.Candidate;
}

/**
 * Convert SDK GenerateContentResponse to REST API GenerateContentResponse
 */
export function sdkResponseToRestResponse(
  sdkResponse: GenerateContentResponse,
  modelName: string,
): Gemini.Types.GenerateContentResponse {
  return {
    candidates: sdkResponse.candidates?.map(sdkCandidateToRestCandidate) || [],
    promptFeedback: sdkResponse.promptFeedback
      ? {
          blockReason: sdkResponse.promptFeedback.blockReason,
          safetyRatings:
            sdkResponse.promptFeedback.safetyRatings
              ?.filter(
                (
                  rating,
                ): rating is {
                  category: HarmCategory;
                  probability: HarmProbability;
                  blocked?: boolean;
                } =>
                  rating.category !== undefined &&
                  rating.probability !== undefined,
              )
              .map((rating) => ({
                category: rating.category,
                probability: rating.probability,
                blocked: rating.blocked,
              })) || [],
        }
      : undefined,
    usageMetadata: sdkResponse.usageMetadata,
    modelVersion: sdkResponse.modelVersion || modelName,
    responseId: sdkResponse.responseId || "unknown",
  } as Gemini.Types.GenerateContentResponse;
}

/**
 * Convert SDK Content format to REST API Content format
 */
export function sdkContentToRestContent(
  sdkContents: Content,
): Gemini.Types.MessageContent {
  return {
    role: sdkContents.role ?? "model",
    parts: sdkContents.parts?.map(sdkPartToRestPart) ?? [],
  };
}

/**
 * Convert SDK GenerateContentResponseUsageMetadata into REST usageMetadata shape.
 * Returns undefined if sdkUsage is falsy.
 */
export function sdkUsageToRestUsageMetadata(
  sdkUsage?: GenerateContentResponseUsageMetadata | null,
): Gemini.Types.UsageMetadata | undefined {
  if (!sdkUsage) return undefined;

  return {
    ...sdkUsage,
  } as Gemini.Types.UsageMetadata;
}

/**
 * Convert common tool results to Gemini function response format.
 * Unlike other adapters that use JSON.stringify for content,
 * Gemini expects structured response objects.
 */
export function toolResultsToMessages(
  results: CommonToolResult[],
  commonToolCalls: CommonToolCall[],
): FunctionResponse[] {
  if (results.length === 0) {
    return [];
  }

  return results.map((result) => ({
    name: commonToolCalls.find((tc) => tc.id === result.id)?.name || "unknown",
    response: result.isError
      ? { error: result.error || "Tool execution failed" }
      : typeof result.content === "string"
        ? { result: result.content }
        : (result.content as Record<string, unknown>),
    is_error: result.isError,
  }));
}

/**
 * Convert tool results (functionResponse parts) to TOON format for token efficiency.
 * Processes Gemini contents and compresses JSON-like functionResponse data.
 */
export async function convertToolResultsToToon(
  contents: GeminiContents,
  model: string,
): Promise<{
  contents: GeminiContents;
  stats: CompressionStats;
}> {
  const tokenizer = getTokenizer("gemini");
  let toolResultCount = 0;
  let totalTokensBefore = 0;
  let totalTokensAfter = 0;

  const result = contents.map((content) => {
    // Only process user messages with parts containing functionResponse
    if (content.role === "user" && content.parts) {
      const updatedParts = content.parts.map((part) => {
        // Check if this part has a functionResponse
        if (
          "functionResponse" in part &&
          part.functionResponse &&
          typeof part.functionResponse === "object" &&
          "response" in part.functionResponse
        ) {
          const { functionResponse } = part;
          toolResultCount++;

          logger.info(
            {
              functionName:
                "name" in functionResponse ? functionResponse.name : "unknown",
              responseType: typeof functionResponse.response,
            },
            "Processing functionResponse for TOON conversion",
          );

          // Handle response object - try to compress it
          const response = functionResponse.response;
          if (response && typeof response === "object") {
            try {
              const noncompressed = JSON.stringify(response);
              const compressed = toonEncode(response);

              // Count tokens for before and after
              const tokensBefore = tokenizer.countTokens([
                { role: "user", content: noncompressed },
              ]);
              const tokensAfter = tokenizer.countTokens([
                { role: "user", content: compressed },
              ]);
              totalTokensBefore += tokensBefore;
              totalTokensAfter += tokensAfter;

              logger.info(
                {
                  functionName:
                    "name" in functionResponse
                      ? functionResponse.name
                      : "unknown",
                  beforeLength: noncompressed.length,
                  afterLength: compressed.length,
                  tokensBefore,
                  tokensAfter,
                  toonPreview: compressed.substring(0, 150),
                  provider: "gemini",
                },
                "convertToolResultsToToon: compressed",
              );
              logger.debug(
                {
                  functionName:
                    "name" in functionResponse
                      ? functionResponse.name
                      : "unknown",
                  before: noncompressed,
                  after: compressed,
                  provider: "gemini",
                },
                "convertToolResultsToToon: before/after",
              );

              // Return updated part with compressed response as a text-like object
              // Gemini expects response as Record<string, unknown>, so we wrap the TOON string
              return {
                functionResponse: {
                  ...functionResponse,
                  response: { toon: compressed } as Record<string, unknown>,
                },
              };
            } catch {
              logger.info(
                {
                  functionName:
                    "name" in functionResponse
                      ? functionResponse.name
                      : "unknown",
                },
                "convertToolResultsToToon: skipping - response cannot be compressed",
              );
              return part;
            }
          }
        }
        return part;
      });

      return {
        ...content,
        parts: updatedParts,
      };
    }

    return content;
  });

  logger.info(
    { contentsCount: contents.length, toolResultCount },
    "convertToolResultsToToon completed",
  );

  // Calculate cost savings
  let toonCostSavings: number | null = null;
  if (toolResultCount > 0) {
    const tokensSaved = totalTokensBefore - totalTokensAfter;
    if (tokensSaved > 0) {
      const tokenPrice = await TokenPriceModel.findByModel(model);
      if (tokenPrice) {
        const inputPricePerToken =
          Number(tokenPrice.pricePerMillionInput) / 1000000;
        toonCostSavings = tokensSaved * inputPricePerToken;
      }
    }
  }

  return {
    contents: result,
    stats: {
      toonTokensBefore: toolResultCount > 0 ? totalTokensBefore : null,
      toonTokensAfter: toolResultCount > 0 ? totalTokensAfter : null,
      toonCostSavings,
    },
  };
}
