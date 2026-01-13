import type {
  GenerateContentParameters,
  GenerateContentResponse,
  GoogleGenAI,
} from "@google/genai";
import { encode as toonEncode } from "@toon-format/toon";
import { get } from "lodash-es";
import config from "@/config";
import { getObservableGenAI } from "@/llm-metrics";
import logger from "@/logging";
import { TokenPriceModel } from "@/models";
import { getTokenizer } from "@/tokenizers";
import type {
  ChunkProcessingResult,
  CommonMcpToolDefinition,
  CommonMessage,
  CommonToolCall,
  CommonToolResult,
  CreateClientOptions,
  Gemini,
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
  StreamAccumulatorState,
  ToonCompressionResult,
  UsageView,
} from "@/types";
import { MockGeminiClient } from "../mock-gemini-client";
import * as geminiUtils from "../utils/adapters/gemini";
import { createGoogleGenAIClient } from "../utils/gemini-client";
import {
  hasImageContent,
  isImageTooLarge,
  isMcpImageBlock,
} from "../utils/mcp-image";
import type { CompressionStats } from "../utils/toon-conversion";
import { unwrapToolContent } from "../utils/unwrap-tool-content";

// =============================================================================
// TYPE ALIASES
// =============================================================================

type GeminiRequest = Gemini.Types.GenerateContentRequest;
type GeminiResponse = Gemini.Types.GenerateContentResponse;
type GeminiContents = Gemini.Types.GenerateContentRequest["contents"];
type GeminiHeaders = Gemini.Types.GenerateContentHeaders;
type GeminiStreamChunk = GenerateContentResponse;
type GeminiFunctionResponse = Record<string, unknown> & {
  name: string;
  response: Record<string, unknown>;
};

// Extended request type that includes model (set from URL path parameter)
export interface GeminiRequestWithModel extends GeminiRequest {
  _model?: string;
  _isStreaming?: boolean;
}

// =============================================================================
// REQUEST ADAPTER
// =============================================================================

class GeminiRequestAdapter
  implements LLMRequestAdapter<GeminiRequestWithModel, GeminiContents>
{
  readonly provider = "gemini" as const;
  private request: GeminiRequestWithModel;
  private modifiedModel: string | null = null;
  private toolResultUpdates: Record<string, string> = {};

  constructor(request: GeminiRequestWithModel) {
    this.request = request;
  }

  // ---------------------------------------------------------------------------
  // Read Access
  // ---------------------------------------------------------------------------

  getModel(): string {
    return this.modifiedModel ?? this.request._model ?? "gemini-2.5-pro";
  }

  isStreaming(): boolean {
    // Gemini determines streaming by route, not body
    return this.request._isStreaming === true;
  }

  getMessages(): CommonMessage[] {
    return geminiUtils.toCommonFormat(this.request.contents || []);
  }

  getToolResults(): CommonToolResult[] {
    const results: CommonToolResult[] = [];

    for (const content of this.request.contents || []) {
      if (content.parts) {
        for (const part of content.parts) {
          if (
            "functionResponse" in part &&
            part.functionResponse &&
            typeof part.functionResponse === "object" &&
            "name" in part.functionResponse &&
            "response" in part.functionResponse
          ) {
            const { functionResponse } = part;
            const id =
              "id" in functionResponse &&
              typeof functionResponse.id === "string"
                ? functionResponse.id
                : geminiUtils.generateToolCallId(
                    functionResponse.name as string,
                  );

            results.push({
              id,
              name: functionResponse.name as string,
              content: functionResponse.response,
              isError: false,
            });
          }
        }
      }
    }

    return results;
  }

  getTools(): CommonMcpToolDefinition[] {
    const tools = this.request.tools;
    if (!tools) return [];

    const toolArray = Array.isArray(tools) ? tools : [tools];
    const result: CommonMcpToolDefinition[] = [];

    for (const tool of toolArray) {
      if (tool.functionDeclarations) {
        for (const fd of tool.functionDeclarations) {
          result.push({
            name: fd.name,
            description: fd.description,
            inputSchema: fd.parameters as Record<string, unknown>,
          });
        }
      }
    }

    return result;
  }

  hasTools(): boolean {
    const tools = this.request.tools;
    if (!tools) return false;
    const toolArray = Array.isArray(tools) ? tools : [tools];
    return toolArray.some(
      (t) => t.functionDeclarations && t.functionDeclarations.length > 0,
    );
  }

  getProviderMessages(): GeminiContents {
    return this.request.contents || [];
  }

  getOriginalRequest(): GeminiRequestWithModel {
    return this.request;
  }

  // ---------------------------------------------------------------------------
  // Modify Access
  // ---------------------------------------------------------------------------

  setModel(model: string): void {
    this.modifiedModel = model;
  }

  updateToolResult(toolCallId: string, newContent: string): void {
    this.toolResultUpdates[toolCallId] = newContent;
  }

  applyToolResultUpdates(updates: Record<string, string>): void {
    Object.assign(this.toolResultUpdates, updates);
  }

  async applyToonCompression(model: string): Promise<ToonCompressionResult> {
    const { contents: compressedContents, stats } =
      await convertToolResultsToToon(this.request.contents || [], model);
    this.request = {
      ...this.request,
      contents: compressedContents,
    };
    return {
      tokensBefore: stats.toonTokensBefore,
      tokensAfter: stats.toonTokensAfter,
      costSavings: stats.toonCostSavings,
    };
  }

  convertToolResultContent(contents: GeminiContents): GeminiContents {
    return contents.map((content) => {
      if (content.role !== "user" || !content.parts) {
        return content;
      }

      const updatedParts = content.parts.map((part) => {
        if (isGeminiFunctionResponsePart(part)) {
          const convertedResponse = convertMcpImageBlocksToGeminiResponse(
            part.functionResponse.response,
          );

          if (!convertedResponse) {
            return part;
          }

          return {
            ...part,
            functionResponse: {
              ...part.functionResponse,
              response: convertedResponse,
            },
          };
        }

        return part;
      });

      return {
        ...content,
        parts: updatedParts,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Build Modified Request
  // ---------------------------------------------------------------------------

  toProviderRequest(): GeminiRequestWithModel {
    let contents = this.request.contents || [];

    if (Object.keys(this.toolResultUpdates).length > 0) {
      contents = geminiUtils.applyUpdates(contents, this.toolResultUpdates);
    }

    if (config.features.browserStreamingEnabled) {
      contents = this.convertToolResultContent(contents);
    }

    return {
      ...this.request,
      contents,
      _model: this.getModel(),
    };
  }
}

function isGeminiFunctionResponsePart(
  part: Gemini.Types.MessagePart,
): part is Gemini.Types.MessagePart & {
  functionResponse: GeminiFunctionResponse;
} {
  if (!("functionResponse" in part) || !part.functionResponse) {
    return false;
  }

  if (typeof part.functionResponse !== "object") {
    return false;
  }

  const candidate = part.functionResponse as Record<string, unknown>;
  return typeof candidate.name === "string" && "response" in candidate;
}

function convertMcpImageBlocksToGeminiResponse(
  content: unknown,
): Record<string, unknown> | null {
  if (!Array.isArray(content)) {
    return null;
  }

  if (!hasImageContent(content)) {
    return null;
  }

  const textParts: string[] = [];
  const imageParts: Array<{ mimeType: string; data: string }> = [];
  const imageTooLargePlaceholder = "[Image omitted due to size]";

  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;

    if (isMcpImageBlock(item)) {
      if (isImageTooLarge(item)) {
        textParts.push(imageTooLargePlaceholder);
        continue;
      }
      const mimeType = item.mimeType ?? "image/png";
      imageParts.push({
        mimeType,
        data: item.data,
      });
    } else if (candidate.type === "text" && "text" in candidate) {
      textParts.push(
        typeof candidate.text === "string"
          ? candidate.text
          : JSON.stringify(candidate),
      );
    }
  }

  if (imageParts.length === 0 && textParts.length === 0) {
    return null;
  }

  const response: Record<string, unknown> = {
    text: textParts.join("\n"),
  };

  if (imageParts.length > 0) {
    response.images = imageParts.map((img) => ({
      inlineData: {
        mimeType: img.mimeType,
        data: img.data,
      },
    }));
  }

  return response;
}

// =============================================================================
// RESPONSE ADAPTER
// =============================================================================

class GeminiResponseAdapter implements LLMResponseAdapter<GeminiResponse> {
  readonly provider = "gemini" as const;
  private response: GeminiResponse;

  constructor(response: GeminiResponse) {
    this.response = response;
  }

  getId(): string {
    return this.response.responseId ?? `gemini-${Date.now()}`;
  }

  getModel(): string {
    return this.response.modelVersion ?? "gemini-2.5-pro";
  }

  getText(): string {
    const candidate = this.response.candidates?.[0];
    if (!candidate?.content?.parts) return "";

    const textParts = candidate.content.parts
      .filter((part) => "text" in part && part.text)
      .map((part) => ("text" in part ? part.text : ""));

    return textParts.join("");
  }

  getToolCalls(): CommonToolCall[] {
    const candidate = this.response.candidates?.[0];
    if (!candidate?.content?.parts) return [];

    return candidate.content.parts
      .filter((part) => "functionCall" in part && part.functionCall)
      .map((part) => {
        const functionCall = (
          part as {
            functionCall: {
              name: string;
              id?: string;
              args?: Record<string, unknown>;
            };
          }
        ).functionCall;
        return {
          id:
            functionCall.id ?? `gemini-call-${functionCall.name}-${Date.now()}`,
          name: functionCall.name,
          arguments: functionCall.args ?? {},
        };
      });
  }

  hasToolCalls(): boolean {
    const candidate = this.response.candidates?.[0];
    if (!candidate?.content?.parts) return false;

    return candidate.content.parts.some(
      (part) => "functionCall" in part && part.functionCall,
    );
  }

  getUsage(): UsageView {
    const usage = this.response.usageMetadata;
    return {
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
    };
  }

  getOriginalResponse(): GeminiResponse {
    return this.response;
  }

  toRefusalResponse(
    _refusalMessage: string,
    contentMessage: string,
  ): GeminiResponse {
    return {
      ...this.response,
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
    };
  }
}

// =============================================================================
// STREAM ADAPTER
// =============================================================================

class GeminiStreamAdapter
  implements LLMStreamAdapter<GeminiStreamChunk, GeminiResponse>
{
  readonly provider = "gemini" as const;
  readonly state: StreamAccumulatorState;
  private model: string = "";

  constructor() {
    this.state = {
      responseId: "",
      model: "",
      text: "",
      toolCalls: [],
      rawToolCallEvents: [],
      usage: null,
      stopReason: null,
      timing: {
        startTime: Date.now(),
        firstChunkTime: null,
      },
    };
  }

  processChunk(chunk: GeminiStreamChunk): ChunkProcessingResult {
    if (this.state.timing.firstChunkTime === null) {
      this.state.timing.firstChunkTime = Date.now();
    }

    let sseData: string | null = null;
    let isToolCallChunk = false;
    let isFinal = false;

    // Update state from chunk
    if (chunk.modelVersion) {
      this.state.model = chunk.modelVersion;
      this.model = chunk.modelVersion;
    }

    if (chunk.responseId) {
      this.state.responseId = chunk.responseId;
    }

    // Handle usage metadata
    if (chunk.usageMetadata) {
      this.state.usage = {
        inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
        outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
      };
    }

    const candidate = chunk.candidates?.[0];
    if (!candidate?.content?.parts) {
      return { sseData: null, isToolCallChunk: false, isFinal: false };
    }

    // Process parts
    for (const part of candidate.content.parts) {
      // Handle text content
      if (part.text) {
        this.state.text += part.text;
        // Convert SDK chunk to REST format for streaming
        const restChunk = geminiUtils.sdkResponseToRestResponse(
          chunk,
          this.model,
        );
        sseData = `data: ${JSON.stringify(restChunk)}\n\n`;
      }

      // Handle function calls
      if (part.functionCall) {
        const functionCall = part.functionCall;
        this.state.toolCalls.push({
          id:
            functionCall.id ?? `gemini-call-${functionCall.name}-${Date.now()}`,
          name: functionCall.name ?? "",
          arguments: JSON.stringify(functionCall.args ?? {}),
        });
        this.state.rawToolCallEvents.push(chunk);
        isToolCallChunk = true;
      }
    }

    // Check finish reason
    if (
      candidate.finishReason &&
      candidate.finishReason !== "FINISH_REASON_UNSPECIFIED"
    ) {
      this.state.stopReason = candidate.finishReason;
      isFinal = true;
    }

    return { sseData, isToolCallChunk, isFinal };
  }

  getSSEHeaders(): Record<string, string> {
    return {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
  }

  formatTextDeltaSSE(text: string): string {
    const chunk: GeminiResponse = {
      candidates: [
        {
          content: {
            parts: [{ text }],
            role: "model",
          },
          finishReason: undefined,
          index: 0,
        },
      ],
      modelVersion: this.state.model,
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  getRawToolCallEvents(): string[] {
    return this.state.rawToolCallEvents.map((event) => {
      const restChunk = geminiUtils.sdkResponseToRestResponse(
        event as GenerateContentResponse,
        this.model,
      );
      return `data: ${JSON.stringify(restChunk)}\n\n`;
    });
  }

  formatCompleteTextSSE(text: string): string[] {
    const chunk: GeminiResponse = {
      candidates: [
        {
          content: {
            parts: [{ text }],
            role: "model",
          },
          finishReason: "STOP",
          index: 0,
        },
      ],
      modelVersion: this.state.model || "gemini-2.5-pro",
      responseId: this.state.responseId || `gemini-${Date.now()}`,
    };
    return [`data: ${JSON.stringify(chunk)}\n\n`];
  }

  formatEndSSE(): string {
    return "data: [DONE]\n\n";
  }

  toProviderResponse(): GeminiResponse {
    const parts: Gemini.Types.MessagePart[] = [];

    // Add text if present
    if (this.state.text) {
      parts.push({ text: this.state.text });
    }

    // Add function calls
    for (const toolCall of this.state.toolCalls) {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(toolCall.arguments);
      } catch {
        // Keep empty object if parse fails
      }

      parts.push({
        functionCall: {
          id: toolCall.id,
          name: toolCall.name,
          args: parsedArgs,
        },
      });
    }

    return {
      candidates: [
        {
          content: {
            parts,
            role: "model",
          },
          finishReason:
            (this.state.stopReason as Gemini.Types.FinishReason) ?? "STOP",
          index: 0,
        },
      ],
      usageMetadata: this.state.usage
        ? {
            promptTokenCount: this.state.usage.inputTokens,
            candidatesTokenCount: this.state.usage.outputTokens,
            totalTokenCount:
              this.state.usage.inputTokens + this.state.usage.outputTokens,
          }
        : undefined,
      modelVersion: this.state.model,
      responseId: this.state.responseId || `gemini-${Date.now()}`,
    };
  }
}

// =============================================================================
// TOON COMPRESSION
// =============================================================================

async function convertToolResultsToToon(
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
              const unwrapped = unwrapToolContent(noncompressed);
              const parsed = JSON.parse(unwrapped);
              const compressed = toonEncode(parsed);

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

              // Return updated part with compressed response
              return {
                functionResponse: {
                  ...functionResponse,
                  // Gemini expects response as Record<string, unknown>, but we know have a TOON string
                  // We wrap it in a {"tool_result": "<TOON string>"} object to match the expected format
                  response: { tool_result: compressed } as Record<
                    string,
                    unknown
                  >,
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

// =============================================================================
// ADAPTER FACTORY
// =============================================================================

export const geminiAdapterFactory: LLMProvider<
  GeminiRequestWithModel,
  GeminiResponse,
  GeminiContents,
  GeminiStreamChunk,
  GeminiHeaders
> = {
  provider: "gemini",
  interactionType: "gemini:generateContent",

  createRequestAdapter(
    request: GeminiRequestWithModel,
  ): LLMRequestAdapter<GeminiRequestWithModel, GeminiContents> {
    return new GeminiRequestAdapter(request);
  },

  createResponseAdapter(
    response: GeminiResponse,
  ): LLMResponseAdapter<GeminiResponse> {
    return new GeminiResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<GeminiStreamChunk, GeminiResponse> {
    return new GeminiStreamAdapter();
  },

  extractApiKey(headers: GeminiHeaders): string | undefined {
    return headers["x-goog-api-key"];
  },

  getBaseUrl(): string | undefined {
    return config.llm.gemini.baseUrl;
  },

  getSpanName(_streaming?: boolean): string {
    return "gemini.generateContent";
  },

  createClient(
    apiKey: string | undefined,
    options?: CreateClientOptions,
  ): GoogleGenAI {
    if (options?.mockMode) {
      return new MockGeminiClient() as unknown as GoogleGenAI;
    }
    const client = createGoogleGenAIClient(apiKey, "[GeminiProxyV2]");

    // Wrap with observability for request duration metrics
    if (options?.agent) {
      return getObservableGenAI(client, options.agent, options.externalAgentId);
    }
    return client;
  },

  async execute(
    client: unknown,
    request: GeminiRequestWithModel,
  ): Promise<GeminiResponse> {
    const genAI = client as GoogleGenAI;
    const model = request._model ?? "gemini-2.5-pro";

    // Normalize tools to array
    const tools = request.tools
      ? Array.isArray(request.tools)
        ? request.tools
        : [request.tools]
      : undefined;

    // Convert REST body to SDK params
    const sdkParams = geminiUtils.restToSdkGenerateContentParams(
      { ...request, contents: request.contents || [] },
      model,
      tools,
    );

    const response = await genAI.models.generateContent(
      sdkParams as GenerateContentParameters,
    );

    // Convert SDK response to REST format
    return geminiUtils.sdkResponseToRestResponse(response, model);
  },

  async executeStream(
    client: unknown,
    request: GeminiRequestWithModel,
  ): Promise<AsyncIterable<GeminiStreamChunk>> {
    const genAI = client as GoogleGenAI;
    const model = request._model ?? "gemini-2.5-pro";

    // Normalize tools to array
    const tools = request.tools
      ? Array.isArray(request.tools)
        ? request.tools
        : [request.tools]
      : undefined;

    // Convert REST body to SDK params
    const sdkParams = geminiUtils.restToSdkGenerateContentParams(
      { ...request, contents: request.contents || [] },
      model,
      tools,
    );

    const streamingResponse = await genAI.models.generateContentStream(
      sdkParams as GenerateContentParameters,
    );

    // Return async iterable that yields stream chunks
    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of streamingResponse) {
          yield chunk;
        }
      },
    };
  },

  extractErrorMessage(error: unknown): string {
    // Gemini SDK error structure
    const geminiMessage = get(error, "message");
    if (typeof geminiMessage === "string") {
      return geminiMessage;
    }

    const nestedMessage = get(error, "error.message");
    if (typeof nestedMessage === "string") {
      return nestedMessage;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "Internal server error";
  },
};
