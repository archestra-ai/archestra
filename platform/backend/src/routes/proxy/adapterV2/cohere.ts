import { encode as toonEncode } from "@toon-format/toon";
import { get } from "lodash-es";
import config from "@/config";
import { getObservableFetch } from "@/llm-metrics";
import logger from "@/logging";
import { TokenPriceModel } from "@/models";
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
  ToonCompressionResult,
  UsageView,
} from "@/types";
import type { CompressionStats } from "../utils/toon-conversion";
import { unwrapToolContent } from "../utils/unwrap-tool-content";

// =============================================================================
// TYPE ALIASES
// =============================================================================

type CohereRequest = Cohere.Types.ChatRequest;
type CohereResponse = Cohere.Types.ChatResponse;
type CohereMessages = Cohere.Types.ChatRequest["messages"];
type CohereHeaders = Cohere.Types.ChatHeaders;
type CohereStreamChunk = Cohere.Types.ChatStreamEvent;

// =============================================================================
// COHERE CLIENT
// =============================================================================

class CohereClient {
  private apiKey: string | undefined;
  private baseURL: string;
  private customFetch?: typeof fetch;

  constructor(
    apiKey: string | undefined,
    baseURL?: string,
    customFetch?: typeof fetch,
  ) {
    this.apiKey = apiKey;
    this.baseURL =
      baseURL || config.llm.cohere.baseUrl || "https://api.cohere.ai";
    this.customFetch = customFetch;
  }

  async chat(request: CohereRequest): Promise<CohereResponse> {
    const url = `${this.baseURL}/v2/chat`;
    const response = await (this.customFetch || fetch)(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "Cohere-Version": "2024-11-19",
      },
      body: JSON.stringify({
        ...request,
        stream: false,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Cohere API error: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    return response.json() as Promise<CohereResponse>;
  }

  async *chatStream(request: CohereRequest): AsyncIterable<CohereStreamChunk> {
    const url = `${this.baseURL}/v2/chat`;
    logger.debug(
      { url, model: request.model, hasMessages: !!request.messages },
      "Cohere chatStream request",
    );

    const response = await (this.customFetch || fetch)(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "Cohere-Version": "2024-11-19",
      },
      body: JSON.stringify({
        ...request,
        stream: true,
      }),
    });

    logger.debug(
      {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      },
      "Cohere API response received",
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(
        { status: response.status, statusText: response.statusText, errorText },
        "Cohere API error",
      );
      throw new Error(
        `Cohere API error: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    if (!response.body) {
      logger.error("Cohere response body is null");
      throw new Error("Response body is null");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      let eventCount = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          logger.debug(
            { eventCount, remainingBuffer: buffer.length },
            "Cohere stream reader done",
          );
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue; // Skip empty lines

          if (trimmed.startsWith("data: ")) {
            const data = trimmed.slice(6);
            if (data === "[DONE]") {
              logger.debug("Cohere stream received [DONE] marker");
              continue;
            }
            try {
              const event = JSON.parse(data) as CohereStreamChunk;
              eventCount++;
              logger.debug(
                { eventCount, eventType: event.event_type },
                "Cohere stream event received",
              );
              yield event;
            } catch (e) {
              logger.warn(
                { error: e, data, line: trimmed },
                "Failed to parse Cohere SSE event",
              );
            }
          } else if (trimmed) {
            // Log non-empty lines that don't start with "data: "
            logger.debug(
              { line: trimmed },
              "Cohere stream unexpected line format",
            );
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        const lines = buffer.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith("data: ")) {
            const data = trimmed.slice(6);
            if (data === "[DONE]") continue;
            try {
              const event = JSON.parse(data) as CohereStreamChunk;
              eventCount++;
              logger.debug(
                { eventCount, eventType: event.event_type },
                "Cohere stream final event from buffer",
              );
              yield event;
            } catch (e) {
              logger.warn(
                { error: e, data, line: trimmed },
                "Failed to parse final Cohere SSE event",
              );
            }
          }
        }
      }

      logger.debug(
        { totalEvents: eventCount },
        "Cohere stream parsing completed",
      );
    } finally {
      reader.releaseLock();
    }
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
    const model = this.modifiedModel ?? this.request.model;
    // Strip :free suffix if present (Cohere API doesn't accept it)
    // The :free suffix is used in the UI to indicate free tier, but API needs base model name
    return model.replace(/:free$/, "");
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
      // Check tool_results array
      if (message.tool_results) {
        for (const toolResult of message.tool_results) {
          let content: unknown;
          if (typeof toolResult.result === "string") {
            try {
              content = JSON.parse(toolResult.result);
            } catch {
              content = toolResult.result;
            }
          } else {
            content = toolResult.result;
          }

          // Find tool name from tool_calls or content blocks
          const toolName = this.findToolName(toolResult.tool_call_id);

          results.push({
            id: toolResult.tool_call_id,
            name: toolName ?? "unknown",
            content,
            isError: toolResult.is_error ?? false,
          });
        }
      }

      // Also check content blocks for tool_result
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === "tool_result") {
            let content: unknown;
            if (typeof block.result === "string") {
              try {
                content = JSON.parse(block.result);
              } catch {
                content = block.result;
              }
            } else {
              content = block.result;
            }

            const toolName = this.findToolName(block.tool_call_id);

            results.push({
              id: block.tool_call_id,
              name: toolName ?? "unknown",
              content,
              isError: block.is_error ?? false,
            });
          }
        }
      }
    }

    return results;
  }

  getTools(): CommonMcpToolDefinition[] {
    if (!this.request.tools) return [];

    const result: CommonMcpToolDefinition[] = [];
    for (const tool of this.request.tools) {
      result.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameter_definitions as Record<string, unknown>,
      });
    }
    return result;
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

  setTools(tools: CommonMcpToolDefinition[]): void {
    this.request = {
      ...this.request,
      tools: tools.map((tool) => {
        // Convert inputSchema to Cohere's parameter_definitions format
        const parameterDefinitions: Record<
          string,
          {
            type: "string" | "number" | "boolean" | "object" | "array";
            description?: string;
            enum?: (string | number)[];
            properties?: Record<string, unknown>;
            required?: string[];
            items?: unknown;
          }
        > = {};

        for (const [key, value] of Object.entries(tool.inputSchema)) {
          if (typeof value === "object" && value !== null) {
            const param = value as Record<string, unknown>;
            parameterDefinitions[key] = {
              type:
                (param.type as
                  | "string"
                  | "number"
                  | "boolean"
                  | "object"
                  | "array") || "string",
              description: param.description as string | undefined,
              enum: param.enum as (string | number)[] | undefined,
              properties: param.properties as
                | Record<string, unknown>
                | undefined,
              required: param.required as string[] | undefined,
              items: param.items,
            };
          }
        }

        return {
          name: tool.name,
          description: tool.description,
          parameter_definitions: parameterDefinitions,
        };
      }),
    };
  }

  updateToolResult(toolCallId: string, newContent: string): void {
    this.toolResultUpdates[toolCallId] = newContent;
  }

  applyToolResultUpdates(updates: Record<string, string>): void {
    Object.assign(this.toolResultUpdates, updates);
  }

  async applyToonCompression(model: string): Promise<ToonCompressionResult> {
    const { messages: compressedMessages, stats } =
      await convertToolResultsToToon(this.request.messages, model);
    this.request = {
      ...this.request,
      messages: compressedMessages,
    };
    return {
      tokensBefore: stats.toonTokensBefore,
      tokensAfter: stats.toonTokensAfter,
      costSavings: stats.toonCostSavings,
    };
  }

  convertToolResultContent(messages: CohereMessages): CohereMessages {
    // Cohere doesn't have special image block conversion like Anthropic
    // Just return messages as-is
    return messages;
  }

  // ---------------------------------------------------------------------------
  // Build Modified Request
  // ---------------------------------------------------------------------------

  toProviderRequest(): CohereRequest {
    let messages = this.request.messages;

    // Apply tool result updates if any
    if (Object.keys(this.toolResultUpdates).length > 0) {
      messages = this.applyUpdates(messages, this.toolResultUpdates);
    }

    // Build request with only Cohere-supported fields
    // Filter out unsupported fields like stream_options from OpenAI-compatible requests
    const cohereRequest: CohereRequest = {
      model: this.getModel(),
      messages,
    };

    // Only include optional fields that are supported by Cohere API
    if (this.request.tools !== undefined) {
      cohereRequest.tools = this.request.tools;
    }
    if (this.request.tool_choice !== undefined) {
      cohereRequest.tool_choice = this.request.tool_choice;
    }
    if (this.request.temperature !== undefined) {
      cohereRequest.temperature = this.request.temperature;
    }
    if (this.request.max_tokens !== undefined) {
      cohereRequest.max_tokens = this.request.max_tokens;
    }
    if (this.request.stream !== undefined) {
      cohereRequest.stream = this.request.stream;
    }
    if (this.request.preamble !== undefined) {
      cohereRequest.preamble = this.request.preamble;
    }
    if (this.request.prompt_truncation !== undefined) {
      cohereRequest.prompt_truncation = this.request.prompt_truncation;
    }
    if (this.request.connectors !== undefined) {
      cohereRequest.connectors = this.request.connectors;
    }
    if (this.request.search_queries_only !== undefined) {
      cohereRequest.search_queries_only = this.request.search_queries_only;
    }
    if (this.request.documents !== undefined) {
      cohereRequest.documents = this.request.documents;
    }
    if (this.request.citation_quality !== undefined) {
      cohereRequest.citation_quality = this.request.citation_quality;
    }

    return cohereRequest;
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  private findToolName(toolCallId: string): string | null {
    for (let i = this.request.messages.length - 1; i >= 0; i--) {
      const message = this.request.messages[i];

      // Check tool_calls array
      if (message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          if (toolCall.id === toolCallId) {
            return toolCall.name;
          }
        }
      }

      // Check content blocks
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === "tool_call" && block.id === toolCallId) {
            return block.name;
          }
        }
      }
    }
    return null;
  }

  /**
   * Convert Cohere messages to common format for policy evaluation
   */
  private toCommonFormat(messages: CohereMessages): CommonMessage[] {
    const commonMessages: CommonMessage[] = [];

    for (const message of messages) {
      const commonMessage: CommonMessage = {
        role: message.role === "chatbot" ? "assistant" : message.role,
      };

      // Extract text content
      let _textContent = "";
      if (typeof message.content === "string") {
        _textContent = message.content;
      } else if (Array.isArray(message.content)) {
        _textContent = message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
      }

      // CommonMessage doesn't have content property, it's role-based
      // Text content is extracted but not stored in CommonMessage structure

      // Extract tool calls
      const toolCalls: CommonToolCall[] = [];

      // From tool_calls array
      if (message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          toolCalls.push({
            id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.parameters as Record<string, unknown>,
          });
        }
      }

      // From content blocks
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === "tool_call") {
            toolCalls.push({
              id: block.id,
              name: block.name,
              arguments: block.parameters as Record<string, unknown>,
            });
          }
        }
      }

      // Note: CommonMessage doesn't have toolCalls property directly
      // Tool calls are extracted but stored separately for policy evaluation

      commonMessages.push(commonMessage);
    }

    return commonMessages;
  }

  /**
   * Apply tool result updates back to Cohere messages
   */
  private applyUpdates(
    messages: CohereMessages,
    updates: Record<string, string>,
  ): CohereMessages {
    if (Object.keys(updates).length === 0) {
      return messages;
    }

    return messages.map((message) => {
      // Update tool_results array
      if (message.tool_results) {
        const updatedToolResults = message.tool_results.map((toolResult) => {
          if (updates[toolResult.tool_call_id]) {
            return {
              ...toolResult,
              result: updates[toolResult.tool_call_id],
            };
          }
          return toolResult;
        });

        return {
          ...message,
          tool_results: updatedToolResults,
        };
      }

      // Update content blocks
      if (Array.isArray(message.content)) {
        const updatedContent = message.content.map((block) => {
          if (block.type === "tool_result" && updates[block.tool_call_id]) {
            return {
              ...block,
              result: updates[block.tool_call_id],
            };
          }
          return block;
        });

        return {
          ...message,
          content: updatedContent,
        };
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
    return this.response.id;
  }

  getModel(): string {
    return this.response.model ?? this.response.response.id;
  }

  getText(): string {
    return this.response.response.text ?? "";
  }

  getToolCalls(): CommonToolCall[] {
    if (!this.response.response.tool_calls) return [];

    return this.response.response.tool_calls.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.parameters as Record<string, unknown>,
    }));
  }

  hasToolCalls(): boolean {
    return (this.response.response.tool_calls?.length ?? 0) > 0;
  }

  getUsage(): UsageView {
    const tokens = this.response.response.meta?.tokens;
    const billedUnits = this.response.response.meta?.billed_units;

    return {
      inputTokens: tokens?.input_tokens ?? billedUnits?.input_tokens ?? 0,
      outputTokens: tokens?.output_tokens ?? billedUnits?.output_tokens ?? 0,
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
      response: {
        ...this.response.response,
        text: contentMessage,
        finish_reason: "COMPLETE",
      },
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
  private rawToolCallEvents: unknown[] = [];
  private modelFromRequest: string = "";

  constructor(model?: string) {
    this.state = {
      responseId: "",
      model: model || "",
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
    this.modelFromRequest = model || "";
  }

  processChunk(chunk: CohereStreamChunk): ChunkProcessingResult {
    // Track first chunk time
    if (this.state.timing.firstChunkTime === null) {
      this.state.timing.firstChunkTime = Date.now();
    }

    let sseData: string | null = null;
    let isToolCallChunk = false;
    let isFinal = false;

    // Handle new Cohere format with "type" field (OpenAI-compatible format)
    // Type assertion needed because Cohere can return OpenAI-compatible chunks with "type" field
    const chunkWithType = chunk as CohereStreamChunk & {
      type?: string;
      index?: number;
      message?: { id?: string };
      delta?: {
        message?: { content?: { text?: string } };
        usage?: {
          tokens?: { input_tokens?: number; output_tokens?: number };
          billed_units?: { input_tokens?: number; output_tokens?: number };
        };
        finish_reason?: string;
      };
      text?: string;
    };

    // Handle message-start to get response ID
    if (chunkWithType.type === "message-start" && chunkWithType.message?.id) {
      this.state.responseId = chunkWithType.message.id;
      logger.info(
        { responseId: this.state.responseId },
        "Cohere message-start chunk processed",
      );
      return { sseData: null, isToolCallChunk, isFinal };
    }

    // Generate responseId if we don't have one yet
    if (!this.state.responseId) {
      this.state.responseId = `cohere-${Date.now()}`;
    }

    if (
      chunkWithType.type === "content-delta" &&
      chunkWithType.delta?.message?.content?.text
    ) {
      const text = chunkWithType.delta.message.content.text;
      this.state.text += text;
      const textModel = this.state.model || this.modelFromRequest || "cohere";
      const openAiChunk = {
        id: this.state.responseId || `cohere-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: textModel,
        choices: [
          {
            index: chunkWithType.index ?? 0,
            delta: {
              content: text,
            },
            finish_reason: null,
          },
        ],
      };
      sseData = `data: ${JSON.stringify(openAiChunk)}\n\n`;
      logger.info(
        {
          textLength: text.length,
          totalTextLength: this.state.text.length,
          chunkText: text.substring(0, 50),
        },
        "Cohere content-delta chunk processed",
      );
      return { sseData, isToolCallChunk, isFinal };
    }

    // Handle message-end with usage
    if (
      chunkWithType.type === "message-end" &&
      chunkWithType.delta?.finish_reason
    ) {
      if (chunkWithType.delta.usage) {
        this.state.usage = {
          inputTokens:
            chunkWithType.delta.usage.tokens?.input_tokens ??
            chunkWithType.delta.usage.billed_units?.input_tokens ??
            0,
          outputTokens:
            chunkWithType.delta.usage.tokens?.output_tokens ??
            chunkWithType.delta.usage.billed_units?.output_tokens ??
            0,
        };
      }
      this.state.stopReason = chunkWithType.delta.finish_reason ?? null;
      isFinal = true;
      const finishReason = this.mapCohereFinishReasonToOpenAI(
        this.state.stopReason ?? "COMPLETE",
      );
      const endModel = this.state.model || this.modelFromRequest || "cohere";
      const finalChunk = {
        id: this.state.responseId || `cohere-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: endModel,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: finishReason,
          },
        ],
        ...(this.state.usage && {
          usage: {
            prompt_tokens: this.state.usage.inputTokens,
            completion_tokens: this.state.usage.outputTokens,
            total_tokens:
              this.state.usage.inputTokens + this.state.usage.outputTokens,
          },
        }),
      };
      sseData = `data: ${JSON.stringify(finalChunk)}\n\ndata: [DONE]\n\n`;
      logger.info("Cohere message-end chunk processed");
      return { sseData, isToolCallChunk, isFinal };
    }

    // Handle content-end (no-op, just marks end of content)
    if (chunkWithType.type === "content-end") {
      return { sseData: null, isToolCallChunk, isFinal };
    }

    logger.info(
      {
        eventType: chunk.event_type,
        chunkType: chunkWithType.type,
        hasText: !!chunkWithType.text,
      },
      "Cohere processChunk",
    );

    // Handle old Cohere v2 format with event_type
    switch (chunk.event_type) {
      case "stream-start":
        this.state.responseId = chunk.generation_id;
        // OpenAI format doesn't use stream-start events, skip sending
        sseData = null;
        break;

      case "text-generation": {
        if (!chunk.text) {
          logger.warn({ chunk }, "Cohere text-generation chunk has no text");
          sseData = null;
          break;
        }
        this.state.text += chunk.text;
        // Format in OpenAI-compatible format for /chat/completions endpoint
        const textModel = this.state.model || this.modelFromRequest || "cohere";
        const openAiChunk = {
          id: this.state.responseId || `cohere-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: textModel,
          choices: [
            {
              index: 0,
              delta: {
                content: chunk.text,
              },
              finish_reason: null,
            },
          ],
        };
        sseData = `data: ${JSON.stringify(openAiChunk)}\n\n`;
        logger.info(
          {
            textLength: chunk.text.length,
            totalTextLength: this.state.text.length,
            chunkText: chunk.text.substring(0, 50),
          },
          "Cohere text-generation chunk processed",
        );
        break;
      }

      case "tool-calls-generation":
        // Add tool calls to state
        for (const toolCall of chunk.tool_calls) {
          this.state.toolCalls.push({
            id: toolCall.id,
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.parameters),
          });
        }
        // Store raw event for replay after policy approval
        this.rawToolCallEvents.push(chunk);
        this.state.rawToolCallEvents.push(chunk);
        isToolCallChunk = true;
        // Don't send SSE data yet - will be sent after policy approval
        sseData = null;
        break;

      case "stream-end": {
        if (chunk.finish_reason) {
          this.state.stopReason = chunk.finish_reason;
        }
        if (chunk.usage) {
          this.state.usage = {
            inputTokens: chunk.usage.input_tokens,
            outputTokens: chunk.usage.output_tokens,
          };
        }
        isFinal = true;
        // Format in OpenAI-compatible format for /chat/completions endpoint
        const finishReason = this.mapCohereFinishReasonToOpenAI(
          this.state.stopReason ?? "COMPLETE",
        );
        const endModel = this.state.model || this.modelFromRequest || "cohere";
        const finalChunk = {
          id: this.state.responseId || `cohere-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: endModel,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: finishReason,
            },
          ],
          ...(this.state.usage && {
            usage: {
              prompt_tokens: this.state.usage.inputTokens,
              completion_tokens: this.state.usage.outputTokens,
              total_tokens:
                this.state.usage.inputTokens + this.state.usage.outputTokens,
            },
          }),
        };
        sseData = `data: ${JSON.stringify(finalChunk)}\n\ndata: [DONE]\n\n`;
        break;
      }
    }

    return { sseData, isToolCallChunk, isFinal };
  }

  getSSEHeaders(): Record<string, string> {
    return {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
  }

  formatTextDeltaSSE(text: string): string {
    // Format in OpenAI-compatible format for /chat/completions endpoint
    const deltaModel = this.state.model || this.modelFromRequest || "cohere";
    const chunk = {
      id: this.state.responseId || `cohere-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: deltaModel,
      choices: [
        {
          index: 0,
          delta: {
            content: text,
          },
          finish_reason: null,
        },
      ],
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  formatCompleteTextSSE(text: string): string[] {
    // Format in OpenAI-compatible format for /chat/completions endpoint
    const completeModel = this.state.model || this.modelFromRequest || "cohere";
    const chunk = {
      id: this.state.responseId || `cohere-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: completeModel,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: text,
          },
          finish_reason: null,
        },
      ],
    };
    return [`data: ${JSON.stringify(chunk)}\n\n`];
  }

  formatEndSSE(): string {
    // Format in OpenAI-compatible format for /chat/completions endpoint
    const finishReason = this.mapCohereFinishReasonToOpenAI(
      this.state.stopReason ?? "COMPLETE",
    );
    const endSSEModel = this.state.model || this.modelFromRequest || "cohere";
    const finalChunk = {
      id: this.state.responseId || `cohere-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: endSSEModel,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: finishReason,
        },
      ],
      ...(this.state.usage && {
        usage: {
          prompt_tokens: this.state.usage.inputTokens,
          completion_tokens: this.state.usage.outputTokens,
          total_tokens:
            this.state.usage.inputTokens + this.state.usage.outputTokens,
        },
      }),
    };
    return `data: ${JSON.stringify(finalChunk)}\n\ndata: [DONE]\n\n`;
  }

  /**
   * Map Cohere finish reasons to OpenAI finish reasons
   */
  private mapCohereFinishReasonToOpenAI(
    cohereReason: string,
  ): "stop" | "length" | "tool_calls" | null {
    switch (cohereReason) {
      case "COMPLETE":
        return "stop";
      case "MAX_TOKENS":
        return "length";
      case "TOOL_CALLS":
        return "tool_calls";
      case "STOP_SEQUENCE":
        return "stop";
      case "ERROR":
      case "ERROR_TOXIC":
        return "stop";
      default:
        return "stop";
    }
  }

  getRawToolCallEvents(): string[] {
    return this.rawToolCallEvents.map(
      (event) =>
        `event: tool-calls-generation\ndata: ${JSON.stringify(event)}\n\n`,
    );
  }

  toProviderResponse(): CohereResponse {
    return {
      id: this.state.responseId,
      model: this.state.model,
      response: {
        id: this.state.responseId,
        text: this.state.text,
        finish_reason:
          (this.state.stopReason as
            | "COMPLETE"
            | "MAX_TOKENS"
            | "STOP_SEQUENCE"
            | "TOOL_CALLS"
            | "ERROR"
            | "ERROR_TOXIC") ?? "COMPLETE",
        tool_calls:
          this.state.toolCalls.length > 0
            ? this.state.toolCalls.map((tc) => {
                let parameters: Record<string, unknown> = {};
                try {
                  parameters = JSON.parse(tc.arguments);
                } catch {
                  // If parsing fails, use empty object
                }
                return {
                  id: tc.id,
                  name: tc.name,
                  parameters,
                };
              })
            : undefined,
        meta: this.state.usage
          ? {
              tokens: {
                input_tokens: this.state.usage.inputTokens,
                output_tokens: this.state.usage.outputTokens,
              },
            }
          : undefined,
      },
    };
  }
}

// =============================================================================
// TOON COMPRESSION
// =============================================================================

/**
 * Convert tool results in messages to TOON format
 */
export async function convertToolResultsToToon(
  messages: CohereMessages,
  model: string,
): Promise<{
  messages: CohereMessages;
  stats: CompressionStats;
}> {
  const tokenizer = getTokenizer("cohere");
  let toolResultCount = 0;
  let totalTokensBefore = 0;
  let totalTokensAfter = 0;

  const result = messages.map((message) => {
    // Process tool_results array
    if (message.tool_results) {
      const updatedToolResults = message.tool_results.map((toolResult) => {
        if (toolResult.is_error) {
          return toolResult;
        }

        toolResultCount++;
        let _content: unknown;
        const originalResult = toolResult.result;

        if (typeof originalResult === "string") {
          try {
            const unwrapped = unwrapToolContent(originalResult);
            const parsed = JSON.parse(unwrapped);
            const compressed = toonEncode(parsed);

            const tokensBefore = tokenizer.countTokens([
              { role: "user", content: unwrapped },
            ]);
            const tokensAfter = tokenizer.countTokens([
              { role: "user", content: compressed },
            ]);

            totalTokensBefore += tokensBefore;
            totalTokensAfter += tokensAfter;

            return {
              ...toolResult,
              result: compressed,
            };
          } catch {
            return toolResult;
          }
        } else if (
          typeof originalResult === "object" &&
          originalResult !== null
        ) {
          try {
            const compressed = toonEncode(originalResult);
            const originalStr = JSON.stringify(originalResult);

            const tokensBefore = tokenizer.countTokens([
              { role: "user", content: originalStr },
            ]);
            const tokensAfter = tokenizer.countTokens([
              { role: "user", content: compressed },
            ]);

            totalTokensBefore += tokensBefore;
            totalTokensAfter += tokensAfter;

            return {
              ...toolResult,
              result: compressed,
            };
          } catch {
            return toolResult;
          }
        }

        return toolResult;
      });

      return {
        ...message,
        tool_results: updatedToolResults,
      };
    }

    // Process content blocks with tool_result
    if (Array.isArray(message.content)) {
      const updatedContent = message.content.map((block) => {
        if (block.type === "tool_result" && !block.is_error) {
          toolResultCount++;
          const content: unknown = block.result;

          if (typeof content === "string") {
            try {
              const unwrapped = unwrapToolContent(content);
              const parsed = JSON.parse(unwrapped);
              const compressed = toonEncode(parsed);

              const tokensBefore = tokenizer.countTokens([
                { role: "user", content: unwrapped },
              ]);
              const tokensAfter = tokenizer.countTokens([
                { role: "user", content: compressed },
              ]);

              totalTokensBefore += tokensBefore;
              totalTokensAfter += tokensAfter;

              return {
                ...block,
                result: compressed,
              };
            } catch {
              return block;
            }
          } else if (typeof content === "object" && content !== null) {
            try {
              const compressed = toonEncode(content);
              const originalStr = JSON.stringify(content);

              const tokensBefore = tokenizer.countTokens([
                { role: "user", content: originalStr },
              ]);
              const tokensAfter = tokenizer.countTokens([
                { role: "user", content: compressed },
              ]);

              totalTokensBefore += tokensBefore;
              totalTokensAfter += tokensAfter;

              return {
                ...block,
                result: compressed,
              };
            } catch {
              return block;
            }
          }
        }
        return block;
      });

      return {
        ...message,
        content: updatedContent,
      };
    }

    return message;
  });

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
    messages: result,
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

export const cohereAdapterFactory: LLMProvider<
  CohereRequest,
  CohereResponse,
  CohereMessages,
  CohereStreamChunk,
  CohereHeaders
> = {
  provider: "cohere",
  interactionType: "cohere:chat",

  createRequestAdapter(
    request: CohereRequest,
  ): LLMRequestAdapter<CohereRequest, CohereMessages> {
    return new CohereRequestAdapter(request);
  },

  createResponseAdapter(
    response: CohereResponse,
  ): LLMResponseAdapter<CohereResponse> {
    return new CohereResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<CohereStreamChunk, CohereResponse> {
    return new CohereStreamAdapter();
  },

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

  createClient(
    apiKey: string | undefined,
    options?: CreateClientOptions,
  ): CohereClient {
    const customFetch = options?.agent
      ? getObservableFetch("cohere", options.agent, options.externalAgentId)
      : undefined;

    return new CohereClient(apiKey, options?.baseUrl, customFetch);
  },

  async execute(
    client: unknown,
    request: CohereRequest,
  ): Promise<CohereResponse> {
    const cohereClient = client as CohereClient;
    return cohereClient.chat(request);
  },

  async executeStream(
    client: unknown,
    request: CohereRequest,
  ): Promise<AsyncIterable<CohereStreamChunk>> {
    const cohereClient = client as CohereClient;
    return cohereClient.chatStream(request);
  },

  extractErrorMessage(error: unknown): string {
    const errorMessage = get(error, "error.message") || get(error, "message");
    if (typeof errorMessage === "string") {
      return errorMessage;
    }
    return String(error);
  },
};
