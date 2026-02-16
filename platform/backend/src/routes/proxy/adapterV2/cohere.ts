import { randomUUID } from "node:crypto";
import { encode as toonEncode } from "@toon-format/toon";
import { get } from "lodash-es";
import config from "@/config";
import logger from "@/logging";
import { TokenPriceModel } from "@/models";
import { metrics } from "@/observability";
import { getTokenizer } from "@/tokenizers";
import type {
  ChunkProcessingResult,
  Cohere,
  CommonMcpToolDefinition,
  CommonMessage,
  CommonToolCall,
  CommonToolResult,
  CreateClientOptions,
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
  StreamAccumulatorState,
  ToolCompressionStats,
  UsageView,
} from "@/types";
import type { ToolCompressionStats as CompressionStats } from "../utils/toon-conversion";
import { unwrapToolContent } from "../utils/unwrap-tool-content";

// =============================================================================
// TYPE ALIASES
// =============================================================================

type CohereRequest = Cohere.Types.ChatRequest;
type CohereResponse = Cohere.Types.ChatResponse;
type CohereMessages = Cohere.Types.ChatRequest["messages"];
type CohereHeaders = Cohere.Types.ChatHeaders;
// Cohere stream events are SSE with different event types
type CohereStreamChunk = {
  type: string;
  [key: string]: unknown;
};

// Small helper to safely parse JSON without throwing. Returns ok=false on parse error.
function safeJsonParse(
  input: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch {
    return { ok: false };
  }
}
// =============================================================================
// REQUEST ADAPTER
// =============================================================================

class CohereRequestAdapter
  implements LLMRequestAdapter<CohereRequest, CohereMessages>
{
  readonly provider = "cohere" as const;
  private request: CohereRequest;
  private modifiedModel: string | null = null;
  private toolResultUpdates: Record<string, string> = {};

  constructor(request: CohereRequest) {
    this.request = request;
  }

  // ---------------------------------------------------------------------------
  // Read Access
  // ---------------------------------------------------------------------------

  getModel(): string {
    return this.modifiedModel ?? this.request.model;
  }

  isStreaming(): boolean {
    return this.request.stream === true;
  }

  getMessages(): CommonMessage[] {
    return this.toCommonFormat(this.request.messages);
  }

  getToolResults(): CommonToolResult[] {
    const results: CommonToolResult[] = [];

    for (const message of this.request.messages) {
      // Cohere uses "tool" role for tool results (similar to OpenAI)
      if (message.role === "tool") {
        const toolMsg = message as Cohere.Types.ToolMessage;
        const toolName = this.findToolName(toolMsg.tool_call_id);

        const parsed = safeJsonParse(toolMsg.content);
        const content = parsed.ok ? parsed.value : toolMsg.content;

        results.push({
          id: toolMsg.tool_call_id,
          name: toolName ?? "unknown",
          content,
          isError: false,
        });
      }
    }

    return results;
  }

  getTools(): CommonMcpToolDefinition[] {
    if (!this.request.tools) return [];

    return this.request.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      inputSchema: tool.function.parameters as Record<string, unknown>,
    }));
  }

  hasTools(): boolean {
    return (this.request.tools?.length ?? 0) > 0;
  }

  getProviderMessages(): CohereMessages {
    return this.request.messages;
  }

  getOriginalRequest(): CohereRequest {
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

  async applyToonCompression(model: string): Promise<ToolCompressionStats> {
    const { messages: compressedMessages, stats } =
      await convertToolResultsToToon(this.request.messages, model);
    this.request = {
      ...this.request,
      messages: compressedMessages,
    };
    return stats;
  }

  convertToolResultContent(messages: CohereMessages): CohereMessages {
    return messages;
  }

  // ---------------------------------------------------------------------------
  // Build Modified Request
  // ---------------------------------------------------------------------------

  toProviderRequest(): CohereRequest {
    let messages = this.request.messages;

    if (Object.keys(this.toolResultUpdates).length > 0) {
      messages = this.applyUpdates(messages, this.toolResultUpdates);
    }

    return {
      ...this.request,
      model: this.getModel(),
      messages: messages.filter((msg) => {
        // Filter out empty assistant messages that have no tool calls
        if (msg.role === "assistant") {
          const assistantMsg = msg as Cohere.Types.AssistantMessage;
          const hasContent =
            (typeof assistantMsg.content === "string" &&
              assistantMsg.content.length > 0) ||
            (Array.isArray(assistantMsg.content) &&
              assistantMsg.content.length > 0);
          const hasToolCalls =
            assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0;

          return hasContent || hasToolCalls;
        }
        return true;
      }),
    };
  }
  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  private findToolName(toolCallId: string): string | null {
    for (let i = this.request.messages.length - 1; i >= 0; i--) {
      const message = this.request.messages[i];
      if (message.role === "assistant") {
        const assistantMsg = message as Cohere.Types.AssistantMessage;
        if (assistantMsg.tool_calls) {
          for (const toolCall of assistantMsg.tool_calls) {
            if (toolCall.id === toolCallId) {
              return toolCall.function.name;
            }
          }
        }
      }
    }
    return null;
  }

  private toCommonFormat(messages: CohereMessages): CommonMessage[] {
    const commonMessages: CommonMessage[] = [];

    for (const message of messages) {
      const commonMessage: CommonMessage = {
        role: message.role as CommonMessage["role"],
      };

      // Handle tool messages
      if (message.role === "tool") {
        const toolMsg = message as Cohere.Types.ToolMessage;
        const toolName = this.findToolName(toolMsg.tool_call_id);

        if (toolName) {
          const parsed = safeJsonParse(toolMsg.content);
          const toolResult = parsed.ok ? parsed.value : toolMsg.content;

          commonMessage.toolCalls = [
            {
              id: toolMsg.tool_call_id,
              name: toolName,
              content: toolResult,
              isError: false,
            },
          ];
        }
      }

      commonMessages.push(commonMessage);
    }

    return commonMessages;
  }

  private applyUpdates(
    messages: CohereMessages,
    updates: Record<string, string>,
  ): CohereMessages {
    if (Object.keys(updates).length === 0) {
      return messages;
    }

    return messages.map((message) => {
      if (message.role === "tool") {
        const toolMsg = message as Cohere.Types.ToolMessage;
        if (updates[toolMsg.tool_call_id]) {
          return {
            ...toolMsg,
            content: updates[toolMsg.tool_call_id],
          };
        }
      }
      return message;
    });
  }
}

// =============================================================================
// RESPONSE ADAPTER
// =============================================================================

class CohereResponseAdapter implements LLMResponseAdapter<CohereResponse> {
  readonly provider = "cohere" as const;
  private response: CohereResponse;

  constructor(response: CohereResponse) {
    this.response = response;
  }

  getId(): string {
    return this.response?.id ?? "";
  }

  getModel(): string {
    // Cohere response doesn't include model in response, return empty string
    // The actual model is tracked from the request
    return "";
  }

  getText(): string {
    const content = this.response?.message?.content;
    if (!content) return "";

    return content
      .filter((block) => block.type === "text")
      .map((block) => (block as { type: "text"; text: string }).text)
      .join("");
  }

  getToolCalls(): CommonToolCall[] {
    const toolCalls = this.response?.message?.tool_calls;
    if (!toolCalls) return [];

    return toolCalls.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: JSON.parse(toolCall.function.arguments),
    }));
  }

  hasToolCalls(): boolean {
    return (this.response?.message?.tool_calls?.length ?? 0) > 0;
  }

  getUsage(): UsageView {
    const usage = this.response.usage;
    return {
      inputTokens:
        usage?.tokens?.input_tokens ?? usage?.billed_units?.input_tokens ?? 0,
      outputTokens:
        usage?.tokens?.output_tokens ?? usage?.billed_units?.output_tokens ?? 0,
    };
  }

  getOriginalResponse(): CohereResponse {
    return this.response;
  }

  toRefusalResponse(
    _refusalMessage: string,
    contentMessage: string,
  ): CohereResponse {
    return {
      ...this.response,
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: contentMessage,
          },
        ],
      },
      finish_reason: "COMPLETE",
    };
  }
}

// =============================================================================
// STREAM ADAPTER
// =============================================================================

class CohereStreamAdapter
  implements LLMStreamAdapter<CohereStreamChunk, CohereResponse>
{
  readonly provider = "cohere" as const;
  readonly state: StreamAccumulatorState;
  private currentToolCallIndex = -1;

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

  processChunk(chunk: CohereStreamChunk): ChunkProcessingResult {
    if (this.state.timing.firstChunkTime === null) {
      this.state.timing.firstChunkTime = Date.now();
    }

    logger.trace({ chunk }, "CohereStreamAdapter processing chunk");

    let sseData: string | null = null;
    let isToolCallChunk = false;
    let isFinal = false;

    // Helper to format SSE events reliably
    const formatSSE = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;

    // Process chunk based on type
    switch (chunk.type) {
      case "message-start": {
        const id = get(chunk, "message.id", "") as string;
        this.state.responseId = id;
        sseData = formatSSE(chunk);
        break;
      }

      case "content-start": {
        // Pass through raw Cohere chunk - @ai-sdk/cohere expects native format
        // The SDK schema expects: { type, index, delta: { message: { content: {...} } } }
        // Cohere API sends this structure natively - do not modify
        sseData = formatSSE(chunk);
        break;
      }

      case "content-delta": {
        // Pass through raw Cohere chunk - @ai-sdk/cohere expects native format
        // The SDK schema expects: { type, index, delta: { message: { content: {...} } } }
        // Extract text for internal accumulation but don't modify the chunk
        const delta = get(chunk, "delta.message.content", {}) as Record<
          string,
          unknown
        >;
        const text = (delta.text as string) || "";
        if (text) {
          this.state.text += text;
        }
        sseData = formatSSE(chunk);
        break;
      }

      case "content-end": {
        // Pass through raw Cohere chunk
        sseData = formatSSE(chunk);
        break;
      }

      case "tool-call-start": {
        this.currentToolCallIndex = this.state.toolCalls.length;
        // SDK expects: delta.message.tool_calls structure
        const toolCallData = get(
          chunk,
          "delta.message.tool_calls",
          {},
        ) as Record<string, unknown>;

        // Fallback to old structure if new structure not present
        const toolCall =
          Object.keys(toolCallData).length > 0
            ? toolCallData
            : (get(chunk, "tool_call", {}) as Record<string, unknown>);

        // Critically: Generate ID if missing. Cohere V2 sometimes omits it.
        const fixedId = (toolCall.id as string) || randomUUID();
        const funcData = get(toolCall, "function", {}) as Record<
          string,
          unknown
        >;

        this.state.toolCalls.push({
          id: fixedId,
          name: (funcData.name as string) || "",
          arguments: (funcData.arguments as string) || "",
        });

        // Build event in SDK-expected format
        const modifiedChunk = {
          type: "tool-call-start",
          delta: {
            message: {
              tool_calls: {
                id: fixedId,
                type: "function",
                function: {
                  name: funcData.name || "",
                  arguments: funcData.arguments || "",
                },
              },
            },
          },
        };
        this.state.rawToolCallEvents.push(modifiedChunk);
        isToolCallChunk = true;
        break;
      }

      case "tool-call-delta": {
        // SDK expects: delta.message.tool_calls.function.arguments
        const deltaData = get(
          chunk,
          "delta.message.tool_calls.function",
          {},
        ) as Record<string, unknown>;
        const args =
          (deltaData.arguments as string) ||
          (get(chunk, "delta.function.arguments", "") as string);

        if (this.currentToolCallIndex >= 0 && args) {
          this.state.toolCalls[this.currentToolCallIndex].arguments += args;
        }

        // Build event in SDK-expected format
        const modifiedChunk = {
          type: "tool-call-delta",
          delta: {
            message: {
              tool_calls: {
                function: {
                  arguments: args,
                },
              },
            },
          },
        };
        this.state.rawToolCallEvents.push(modifiedChunk);
        isToolCallChunk = true;
        break;
      }

      case "tool-call-end": {
        // Pass through - SDK expects { type: "tool-call-end" }
        this.state.rawToolCallEvents.push({ type: "tool-call-end" });
        isToolCallChunk = true;
        break;
      }

      case "message-end": {
        const finishReason = get(
          chunk,
          "delta.finish_reason",
          "COMPLETE",
        ) as string;
        this.state.stopReason = finishReason;
        const usage = get(chunk, "delta.usage", {}) as Record<string, unknown>;
        this.state.usage = {
          inputTokens:
            (get(usage, "tokens.input_tokens", 0) as number) ||
            (get(usage, "billed_units.input_tokens", 0) as number),
          outputTokens:
            (get(usage, "tokens.output_tokens", 0) as number) ||
            (get(usage, "billed_units.output_tokens", 0) as number),
        };
        isFinal = true;
        // Do NOT send message-end yet if you want to inspect or modify final state
        // But for Cohere we generally pass it through unless we need policy check refutation
        // The Proxy Handler handles policy checks on completion.
        sseData = formatSSE(chunk);
        break;
      }

      default: {
        // Log unknown chunks but don't break
        // logger.debug({ type: chunk.type }, "Ignored unknown Cohere chunk type");
        break;
      }
    }

    if (sseData) {
      logger.debug(
        {
          sseDataLength: sseData.length,
          sseDeltaSnippet: sseData.substring(0, 50),
        },
        "CohereStreamAdapter emitting SSE data",
      );
    }
    return { sseData, isToolCallChunk, isFinal };
  }

  getSSEHeaders(): Record<string, string> {
    return {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    };
  }

  formatTextDeltaSSE(text: string): string {
    // Format must match Cohere API stream format for @ai-sdk/cohere
    const event = {
      type: "content-delta",
      index: 0,
      delta: {
        message: {
          content: {
            text,
          },
        },
      },
    };
    return `data: ${JSON.stringify(event)}\n\n`;
  }

  getRawToolCallEvents(): string[] {
    return this.state.rawToolCallEvents.map(
      (event) => `data: ${JSON.stringify(event)}\n\n`,
    );
  }

  formatCompleteTextSSE(text: string): string[] {
    // Format must match Cohere API stream format for @ai-sdk/cohere
    return [
      `data: ${JSON.stringify({
        type: "content-start",
        index: 0,
        delta: {
          message: {
            content: {
              type: "text",
              text: "",
            },
          },
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "content-delta",
        index: 0,
        delta: {
          message: {
            content: {
              text,
            },
          },
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "content-end",
        index: 0,
      })}\n\n`,
    ];
  }

  formatEndSSE(): string {
    const event = {
      type: "message-end",
      delta: {
        finish_reason: this.state.stopReason ?? "COMPLETE",
        usage: {
          tokens: {
            input_tokens: this.state.usage?.inputTokens ?? 0,
            output_tokens: this.state.usage?.outputTokens ?? 0,
          },
        },
      },
    };
    return `data: ${JSON.stringify(event)}\n\n`;
  }

  toProviderResponse(): CohereResponse {
    const content: CohereResponse["message"]["content"] = [];

    if (this.state.text) {
      content.push({
        type: "text",
        text: this.state.text,
      });
    }

    const toolCalls: CohereResponse["message"]["tool_calls"] = [];
    for (const toolCall of this.state.toolCalls) {
      toolCalls.push({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments,
        },
      });
    }

    return {
      id: this.state.responseId,
      message: {
        role: "assistant",
        content: content.length > 0 ? content : undefined,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      finish_reason:
        (this.state.stopReason as CohereResponse["finish_reason"]) ??
        "COMPLETE",
      usage: {
        tokens: {
          input_tokens: this.state.usage?.inputTokens ?? 0,
          output_tokens: this.state.usage?.outputTokens ?? 0,
        },
      },
    };
  }
}

// =============================================================================
// TOON COMPRESSION
// =============================================================================

export async function convertToolResultsToToon(
  messages: CohereMessages,
  model: string,
): Promise<{
  messages: CohereMessages;
  stats: CompressionStats;
}> {
  const tokenizer = getTokenizer("cohere");

  let totalTokensBefore = 0;
  let totalTokensAfter = 0;

  const result = messages.map((message) => {
    if (message.role === "tool") {
      const toolMsg = message as Cohere.Types.ToolMessage;

      try {
        const unwrapped = unwrapToolContent(toolMsg.content);
        const parsedRes = safeJsonParse(unwrapped);
        if (!parsedRes.ok) {
          logger.info(
            {
              toolCallId: toolMsg.tool_call_id,
              contentPreview: toolMsg.content.substring(0, 100),
            },
            "convertToolResultsToToon: skipping - content is not JSON",
          );
          return message;
        }

        const parsed = parsedRes.value as unknown;
        const noncompressed = unwrapped;
        const compressed = toonEncode(parsed);

        const tokensBefore = tokenizer.countTokens([
          { role: "user", content: noncompressed },
        ]);
        const tokensAfter = tokenizer.countTokens([
          { role: "user", content: compressed },
        ]);

        // Only use TOON compression if it actually saves tokens
        if (tokensAfter < tokensBefore) {
          totalTokensBefore += tokensBefore;
          totalTokensAfter += tokensAfter;

          logger.info(
            {
              toolCallId: toolMsg.tool_call_id,
              beforeLength: noncompressed.length,
              afterLength: compressed.length,
              tokensBefore,
              tokensAfter,
              tokensSaved: tokensBefore - tokensAfter,
              provider: "cohere",
            },
            "convertToolResultsToToon: compressed",
          );

          return {
            ...toolMsg,
            content: compressed,
          };
        } else {
          logger.info(
            {
              toolCallId: toolMsg.tool_call_id,
              beforeLength: noncompressed.length,
              afterLength: compressed.length,
              tokensBefore,
              tokensAfter,
              tokensDiff: tokensAfter - tokensBefore,
              provider: "cohere",
            },
            "convertToolResultsToToon: skipping - compression increases tokens",
          );
          return message;
        }
      } catch {
        logger.info(
          {
            toolCallId: toolMsg.tool_call_id,
            contentPreview: toolMsg.content.substring(0, 100),
          },
          "convertToolResultsToToon: skipping - content is not JSON",
        );
        return message;
      }
    }
    return message;
  });

  // Calculate cost savings
  let costSavings = 0;
  if (totalTokensBefore > 0) {
    const tokenPrice = await TokenPriceModel.findByModel(model);
    if (tokenPrice) {
      const savedTokens = totalTokensBefore - totalTokensAfter;
      const inputPricePerToken =
        parseFloat(tokenPrice.pricePerMillionInput) / 1_000_000;
      costSavings =
        savedTokens *
        (Number.isFinite(inputPricePerToken) ? inputPricePerToken : 0);
    }
  }

  return {
    messages: result,
    stats: {
      tokensBefore: totalTokensBefore,
      tokensAfter: totalTokensAfter,
      costSavings: costSavings,
      wasEffective: totalTokensAfter < totalTokensBefore,
      hadToolResults: totalTokensBefore > 0,
    },
  };
}

// =============================================================================
// COHERE CLIENT
// =============================================================================

interface CohereClient {
  chat: {
    create: (request: CohereRequest) => Promise<CohereResponse>;
    stream: (request: CohereRequest) => AsyncIterable<CohereStreamChunk>;
  };
}

function createCohereClient(
  apiKey: string,
  options: CreateClientOptions,
): CohereClient {
  const baseUrl = options.baseUrl || config.llm.cohere.baseUrl;
  // Only wrap fetch with metrics when agent context is available
  const observableFetch = options.agent
    ? metrics.llm.getObservableFetch(
        "cohere",
        options.agent,
        options.externalAgentId,
      )
    : fetch;

  return {
    chat: {
      create: async (request: CohereRequest): Promise<CohereResponse> => {
        const response = await observableFetch(`${baseUrl}/v2/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            ...options.defaultHeaders,
          },
          body: JSON.stringify({ ...request, stream: false }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `Cohere API error: ${response.status} - ${errorText}`,
          );
        }

        return response.json();
      },
      stream: async function* (
        request: CohereRequest,
      ): AsyncIterable<CohereStreamChunk> {
        const response = await observableFetch(`${baseUrl}/v2/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            ...options.defaultHeaders,
          },
          body: JSON.stringify({ ...request, stream: true }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `Error from Cohere API : ${response.status} - ${errorText}`,
          );
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("No response body");
        }

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:")) continue;

            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") continue;

            try {
              yield JSON.parse(data);
            } catch {
              logger.warn({ data }, "Failed to parse Cohere's stream data");
            }
          }
        }
      },
    },
  };
}

// =============================================================================
// ADAPTER FACTORY
// =============================================================================

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  const message = get(error, "error.message") || get(error, "message");
  if (typeof message === "string") {
    return message;
  }
  return String(error);
}

export function getUsageTokens(usage: Cohere.Types.Usage) {
  return {
    input:
      usage?.tokens?.input_tokens ?? usage?.billed_units?.input_tokens ?? 0,
    output:
      usage?.tokens?.output_tokens ?? usage?.billed_units?.output_tokens ?? 0,
  };
}

export const cohereAdapterFactory: LLMProvider<
  CohereRequest,
  CohereResponse,
  CohereMessages,
  CohereStreamChunk,
  CohereHeaders
> = {
  provider: "cohere",
  interactionType: "cohere:chat",

  createClient(apiKey: string, options: CreateClientOptions) {
    if (options.mockMode) {
      throw new Error("Mock mode not yet implemented for Cohere");
    }
    return createCohereClient(apiKey, options);
  },

  createRequestAdapter(request: CohereRequest) {
    return new CohereRequestAdapter(request);
  },

  createResponseAdapter(response: CohereResponse) {
    if (!response) {
      throw new Error("Cannot create response adapter: response is undefined");
    }
    return new CohereResponseAdapter(response);
  },

  createStreamAdapter() {
    return new CohereStreamAdapter();
  },

  async execute(client: CohereClient, request: CohereRequest) {
    const response = await client.chat.create(request);
    logger.debug({ response }, "Cohere raw response");
    if (!response) {
      throw new Error("'Cohere's API has returned an undefined response.");
    }
    return response;
  },

  async executeStream(client: CohereClient, request: CohereRequest) {
    return client.chat.stream(request);
  },

  extractErrorMessage,

  extractApiKey(headers: CohereHeaders): string | undefined {
    const authHeader = headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      return authHeader.slice(7);
    }
    return undefined;
  },

  getBaseUrl(): string | undefined {
    return config.llm.cohere.baseUrl;
  },

  getSpanName(): string {
    return "cohere.chat";
  },
};
