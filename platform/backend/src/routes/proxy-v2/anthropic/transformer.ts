import { randomUUID } from "node:crypto";
import type AnthropicProvider from "@anthropic-ai/sdk";
import type { FastifyReply } from "fastify";
import type { z } from "zod";
import type { Anthropic, OpenAi } from "@/types/llm-providers";
import {
  BaseProviderTransformer,
  type OpenAIRequest,
  type OpenAIResponse,
  type OpenAIStreamChunk,
  type StreamTransformer,
} from "../base-transformer";

// Anthropic API types from our schema
type AnthropicRequest = Anthropic.Types.MessagesRequest;
type AnthropicResponse = Anthropic.Types.MessagesResponse;
type AnthropicStreamEvent = AnthropicProvider.Messages.MessageStreamEvent;

// Message and content types
type AnthropicMessage = z.infer<typeof Anthropic.Messages.MessageParamSchema>;
type AnthropicTool = Anthropic.Types.CustomTool;

// OpenAI types from schema
type OpenAIToolChoice = OpenAi.Types.ToolChoice;
type OpenAIToolCall = OpenAi.Types.FunctionToolCall;
type OpenAIFunctionTool = OpenAi.Types.FunctionTool;

/**
 * Bidirectional stream transformer for Anthropic.
 *
 * Handles both directions:
 * - decode: Anthropic stream events → OpenAI chunks (inbound from SDK)
 * - encode: OpenAI chunks → Anthropic SSE events (outbound to client)
 *
 * Stateful - tracks tool indices and content block lifecycle across the stream.
 */
class AnthropicStreamTransformer
  implements StreamTransformer<AnthropicStreamEvent>
{
  // === Decoder state (from SDK) ===
  /** Index of current tool call (increments for each tool_use block) */
  private decodeToolIndex = -1;

  /** Response ID (generated once per stream for consistency) */
  private responseId =
    `chatcmpl-${randomUUID().replace(/-/g, "").substring(0, 29)}`;

  /** Model name from message_start */
  private model = "";

  // === Encoder state (to client) ===
  /** Current content block index for SSE output */
  private encodeContentBlockIndex = -1;

  /** Set of tool indices we've already started blocks for */
  private seenToolIndices = new Set<number>();

  /** Whether we've started a text content block */
  private hasStartedTextBlock = false;

  decode(event: AnthropicStreamEvent): OpenAIStreamChunk | null {
    // Handle "ping" event which exists at runtime but not in TypeScript types
    const eventType = event.type as string;
    if (eventType === "ping") {
      return null;
    }

    switch (event.type) {
      case "message_start":
        return this.handleMessageStart(event);

      case "content_block_start":
        return this.handleContentBlockStart(event);

      case "content_block_delta":
        return this.handleContentBlockDelta(event);

      case "content_block_stop":
        // No chunk needed for block stop events
        return null;

      case "message_delta":
        return this.handleMessageDelta(event);

      case "message_stop":
        // No chunk needed for these events
        return null;

      default:
        return null;
    }
  }

  isToolChunk(chunk: OpenAIStreamChunk): boolean {
    const delta = chunk.choices?.[0]?.delta;
    return delta !== undefined && "tool_calls" in delta;
  }

  encode(reply: FastifyReply, chunk: OpenAIStreamChunk): void {
    const choice = chunk.choices?.[0];
    if (!choice) return;

    const delta = choice.delta;
    if (!delta) return;

    // Handle text content
    if ("content" in delta && delta.content) {
      // Emit content_block_start for first text content if not already done
      if (!this.hasStartedTextBlock) {
        this.encodeContentBlockIndex++;
        this.hasStartedTextBlock = true;

        const startEvent = {
          type: "content_block_start",
          index: this.encodeContentBlockIndex,
          content_block: { type: "text", text: "" },
        };
        reply.raw.write(
          `event: content_block_start\ndata: ${JSON.stringify(startEvent)}\n\n`,
        );
      }

      // Emit text delta
      const deltaEvent = {
        type: "content_block_delta",
        index: this.encodeContentBlockIndex,
        delta: { type: "text_delta", text: delta.content },
      };
      reply.raw.write(
        `event: content_block_delta\ndata: ${JSON.stringify(deltaEvent)}\n\n`,
      );
    }

    // Handle tool calls
    if ("tool_calls" in delta && delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const toolIndex = tc.index ?? 0;

        // New tool - emit content_block_start
        if (!this.seenToolIndices.has(toolIndex)) {
          this.seenToolIndices.add(toolIndex);

          // Close text block if one was open
          if (this.hasStartedTextBlock) {
            const stopEvent = {
              type: "content_block_stop",
              index: this.encodeContentBlockIndex,
            };
            reply.raw.write(
              `event: content_block_stop\ndata: ${JSON.stringify(stopEvent)}\n\n`,
            );
            this.hasStartedTextBlock = false;
          }

          this.encodeContentBlockIndex++;

          const startEvent = {
            type: "content_block_start",
            index: this.encodeContentBlockIndex,
            content_block: {
              type: "tool_use",
              id: tc.id ?? `tool_${toolIndex}`,
              name: tc.function?.name ?? "",
              input: {},
            },
          };
          reply.raw.write(
            `event: content_block_start\ndata: ${JSON.stringify(startEvent)}\n\n`,
          );
        }

        // Emit tool input delta if arguments present
        if (tc.function?.arguments) {
          const deltaEvent = {
            type: "content_block_delta",
            index: this.encodeContentBlockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: tc.function.arguments,
            },
          };
          reply.raw.write(
            `event: content_block_delta\ndata: ${JSON.stringify(deltaEvent)}\n\n`,
          );
        }
      }
    }

    // Handle finish_reason - close any open content blocks and emit terminal events
    if (choice.finish_reason) {
      // Close any open content block
      if (this.hasStartedTextBlock || this.seenToolIndices.size > 0) {
        const stopEvent = {
          type: "content_block_stop",
          index: this.encodeContentBlockIndex,
        };
        reply.raw.write(
          `event: content_block_stop\ndata: ${JSON.stringify(stopEvent)}\n\n`,
        );
      }

      // Map OpenAI finish_reason to Anthropic stop_reason
      const stopReason = this.mapFinishReasonToStopReason(choice.finish_reason);

      // Emit message_delta with stop_reason
      const messageDeltaEvent = {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 0 },
      };
      reply.raw.write(
        `event: message_delta\ndata: ${JSON.stringify(messageDeltaEvent)}\n\n`,
      );

      // Emit message_stop
      const messageStopEvent = { type: "message_stop" };
      reply.raw.write(
        `event: message_stop\ndata: ${JSON.stringify(messageStopEvent)}\n\n`,
      );
    }
  }

  private mapFinishReasonToStopReason(
    finishReason: string,
  ): "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" {
    switch (finishReason) {
      case "tool_calls":
        return "tool_use";
      case "length":
        return "max_tokens";
      default:
        return "end_turn";
    }
  }

  private handleMessageStart(
    event: AnthropicProvider.Messages.MessageStartEvent,
  ): OpenAIStreamChunk {
    this.model = event.message.model;

    return {
      id: this.responseId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: null,
        },
      ],
      usage: {
        prompt_tokens: event.message.usage.input_tokens,
        completion_tokens: event.message.usage.output_tokens,
        total_tokens:
          event.message.usage.input_tokens + event.message.usage.output_tokens,
      },
    };
  }

  private handleContentBlockStart(
    event: AnthropicProvider.Messages.ContentBlockStartEvent,
  ): OpenAIStreamChunk | null {
    const contentBlock = event.content_block;

    if (contentBlock.type === "tool_use") {
      this.decodeToolIndex++;
      return {
        id: this.responseId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: this.model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: this.decodeToolIndex,
                  id: contentBlock.id,
                  type: "function",
                  function: {
                    name: contentBlock.name,
                    arguments: "",
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
    }

    if (contentBlock.type === "text") {
      // Initial text block - emit empty content to signal start
      return {
        id: this.responseId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: this.model,
        choices: [
          {
            index: 0,
            delta: { content: contentBlock.text },
            finish_reason: null,
          },
        ],
      };
    }

    // Skip thinking blocks and other types for now
    return null;
  }

  private handleContentBlockDelta(
    event: AnthropicProvider.Messages.ContentBlockDeltaEvent,
  ): OpenAIStreamChunk | null {
    const delta = event.delta;

    if (delta.type === "text_delta") {
      return {
        id: this.responseId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: this.model,
        choices: [
          {
            index: 0,
            delta: { content: delta.text },
            finish_reason: null,
          },
        ],
      };
    }

    if (delta.type === "input_json_delta") {
      return {
        id: this.responseId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: this.model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: this.decodeToolIndex,
                  function: {
                    arguments: delta.partial_json,
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
    }

    // Skip thinking_delta and other types for now
    return null;
  }

  private handleMessageDelta(
    event: AnthropicProvider.Messages.MessageDeltaEvent,
  ): OpenAIStreamChunk {
    const finishReason = this.mapStopReason(event.delta.stop_reason);

    return {
      id: this.responseId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: event.usage.output_tokens,
        total_tokens: event.usage.output_tokens,
      },
    };
  }

  private mapStopReason(
    stopReason: AnthropicProvider.Messages.MessageDeltaEvent["delta"]["stop_reason"],
  ): "stop" | "tool_calls" | "length" | null {
    switch (stopReason) {
      case "end_turn":
        return "stop";
      case "tool_use":
        return "tool_calls";
      case "max_tokens":
        return "length";
      default:
        return null;
    }
  }
}

export class AnthropicTransformer extends BaseProviderTransformer<
  AnthropicRequest,
  AnthropicResponse,
  AnthropicStreamEvent
> {
  readonly provider = "anthropic";

  convertRequestToOpenAI(anthropicReq: AnthropicRequest): OpenAIRequest {
    const messages: OpenAIRequest["messages"] = [];

    // 1. Convert system param to system message
    const systemContent = this.normalizeSystemContent(anthropicReq.system);
    if (systemContent) {
      messages.push({
        role: "system",
        content: systemContent,
      });
    }

    // 2. Convert Anthropic messages to OpenAI format
    for (const msg of anthropicReq.messages) {
      this.normalizeMessage(msg, messages);
    }

    // 3. Convert tools
    const tools = anthropicReq.tools
      ?.filter(
        (t): t is AnthropicTool =>
          t.type === "custom" || t.type === undefined || t.type === null,
      )
      .map((t) => this.normalizeTool(t));

    return {
      model: anthropicReq.model,
      messages,
      tools,
      tool_choice: this.normalizeToolChoice(anthropicReq.tool_choice),
      max_tokens: anthropicReq.max_tokens,
      temperature: anthropicReq.temperature ?? undefined,
      top_p: anthropicReq.top_p ?? undefined,
      stream: anthropicReq.stream ?? undefined,
    };
  }

  convertRequestFromOpenAI(openaiReq: OpenAIRequest): AnthropicRequest {
    // 1. Extract system messages
    const systemContent = this.extractSystemMessages(openaiReq.messages);

    // 2. Convert remaining messages (tool messages → tool_result blocks)
    const messages = this.transformMessages(
      openaiReq.messages.filter((m) => m.role !== "system"),
    );

    // 3. Convert tools
    const tools = openaiReq.tools
      ?.filter((t): t is OpenAIFunctionTool => t.type === "function")
      .map((t) => this.transformTool(t));

    return {
      model: openaiReq.model,
      messages,
      system: systemContent,
      tools,
      max_tokens: openaiReq.max_tokens ?? 4096,
      temperature: openaiReq.temperature ?? undefined,
      top_p: openaiReq.top_p ?? undefined,
      stop_sequences: openaiReq.stop
        ? Array.isArray(openaiReq.stop)
          ? openaiReq.stop
          : [openaiReq.stop]
        : undefined,
      tool_choice: this.transformToolChoice(openaiReq.tool_choice),
      stream: openaiReq.stream ?? undefined,
    };
  }

  convertResponseToOpenAI(response: AnthropicResponse): OpenAIResponse {
    const { textContent, toolCalls } = this.extractResponseContent(
      response.content,
    );

    return {
      id: response.id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: response.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: textContent || null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          },
          // TODO: ikonstantinov - mapStopReason can return null, cast to satisfy type checker
          finish_reason: this.mapStopReason(
            response.stop_reason,
          ) as NonNullable<ReturnType<typeof this.mapStopReason>>,
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens:
          response.usage.input_tokens + response.usage.output_tokens,
      },
    };
  }

  convertResponseFromOpenAI(openaiResp: OpenAIResponse): AnthropicResponse {
    const choice = openaiResp.choices[0];
    const content: AnthropicResponse["content"] = [];

    // Convert text content
    if (choice?.message.content) {
      content.push({
        type: "text",
        text: choice.message.content,
        citations: null,
      });
    }

    // Convert tool_calls to tool_use blocks
    if (choice?.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        if (tc.type === "function") {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          });
        }
      }
    }

    return {
      id: openaiResp.id,
      type: "message",
      role: "assistant",
      content,
      model: openaiResp.model,
      stop_reason: this.denormalizeStopReason(choice?.finish_reason ?? null),
      stop_sequence: null,
      usage: {
        input_tokens: openaiResp.usage?.prompt_tokens ?? 0,
        output_tokens: openaiResp.usage?.completion_tokens ?? 0,
      },
    };
  }

  // ========== STREAMING ==========

  createStreamTransformer(): StreamTransformer<AnthropicStreamEvent> {
    return new AnthropicStreamTransformer();
  }

  /**
   * Normalize Anthropic system param to string content
   */
  private normalizeSystemContent(
    system: AnthropicRequest["system"],
  ): string | undefined {
    if (!system) return undefined;

    if (typeof system === "string") {
      return system;
    }

    if (Array.isArray(system)) {
      return system.map((block) => block.text).join("\n");
    }

    // Single text block object
    return system.text;
  }

  /**
   * Normalize a single Anthropic message to OpenAI format
   * May produce multiple OpenAI messages (e.g., tool results become separate tool messages)
   */
  private normalizeMessage(
    msg: AnthropicMessage,
    messages: OpenAIRequest["messages"],
  ): void {
    if (msg.role === "user") {
      // Check for tool_result blocks → convert to tool messages
      if (Array.isArray(msg.content)) {
        const toolResults: Array<{
          tool_use_id: string;
          content?: string | unknown[];
          is_error?: boolean;
        }> = [];
        const otherContent: Array<{ type: "text"; text: string }> = [];

        for (const block of msg.content) {
          if (block.type === "tool_result") {
            toolResults.push(block);
          } else if (block.type === "text") {
            otherContent.push(block);
          }
        }

        // Add tool messages first
        for (const result of toolResults) {
          messages.push({
            role: "tool",
            tool_call_id: result.tool_use_id,
            content: this.normalizeToolResultContent(result.content),
          });
        }

        // Add user message if there's other content
        if (otherContent.length > 0) {
          const textContent = otherContent.map((b) => b.text).join("\n");
          messages.push({ role: "user", content: textContent });
        }
      } else {
        // Simple string content
        messages.push({ role: "user", content: msg.content });
      }
    } else if (msg.role === "assistant") {
      messages.push(this.normalizeAssistantMessage(msg));
    }
  }

  /**
   * Normalize tool result content to string
   */
  private normalizeToolResultContent(
    content: string | unknown[] | undefined,
  ): string {
    if (!content) return "";

    if (typeof content === "string") {
      return content;
    }

    // Array of content blocks - extract text
    const textParts: string[] = [];
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "text" &&
        "text" in block
      ) {
        textParts.push(block.text as string);
      }
    }
    return textParts.join("\n");
  }

  /**
   * Normalize Anthropic assistant message to OpenAI format
   */
  private normalizeAssistantMessage(
    msg: AnthropicMessage,
  ): OpenAIRequest["messages"][number] {
    const toolCalls: OpenAIToolCall[] = [];
    let textContent = "";

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          textContent += block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        }
      }
    } else if (typeof msg.content === "string") {
      textContent = msg.content;
    }

    return {
      role: "assistant",
      content: textContent || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  /**
   * Normalize Anthropic tool to OpenAI function tool format
   */
  private normalizeTool(tool: AnthropicTool): OpenAIFunctionTool {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    };
  }

  /**
   * Normalize Anthropic tool_choice to OpenAI format
   */
  private normalizeToolChoice(
    toolChoice: AnthropicRequest["tool_choice"],
  ): OpenAIToolChoice | undefined {
    if (!toolChoice) return undefined;

    switch (toolChoice.type) {
      case "auto":
        return "auto";
      case "any":
        return "required";
      case "tool":
        return { type: "function", function: { name: toolChoice.name } };
      case "none":
        return "none";
      default:
        return "auto";
    }
  }

  /**
   * Extract system messages from OpenAI messages and combine to Anthropic system param
   */
  private extractSystemMessages(
    messages: OpenAIRequest["messages"],
  ): string | undefined {
    const systemMessages = messages.filter((m) => m.role === "system");
    if (systemMessages.length === 0) return undefined;

    return systemMessages
      .map((m) => {
        if (typeof m.content === "string") return m.content;
        if (Array.isArray(m.content)) {
          return m.content
            .filter(
              (p): p is { type: "text"; text: string } => p.type === "text",
            )
            .map((p) => p.text)
            .join("\n");
        }
        return "";
      })
      .join("\n\n");
  }

  /**
   * Transform OpenAI messages to Anthropic format
   * Groups tool messages into tool_result blocks within user messages
   */
  private transformMessages(
    messages: OpenAIRequest["messages"],
  ): AnthropicRequest["messages"] {
    const result: AnthropicRequest["messages"] = [];
    let pendingToolResults: Array<{
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }> = [];

    for (const msg of messages) {
      if (msg.role === "tool") {
        // Accumulate tool results to be grouped into next user message
        pendingToolResults.push({
          type: "tool_result",
          tool_use_id: msg.tool_call_id ?? "",
          content:
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content),
        });
      } else if (msg.role === "user") {
        // Flush any pending tool results first
        if (pendingToolResults.length > 0) {
          const content: AnthropicMessage["content"] = [...pendingToolResults];
          // Add user content if present
          if (msg.content) {
            if (typeof msg.content === "string") {
              content.push({ type: "text", text: msg.content });
            } else if (Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if (part.type === "text") {
                  content.push({ type: "text", text: part.text });
                }
              }
            }
          }
          result.push({ role: "user", content });
          pendingToolResults = [];
        } else {
          // Regular user message
          result.push({
            role: "user",
            content:
              typeof msg.content === "string"
                ? msg.content
                : Array.isArray(msg.content)
                  ? msg.content
                      .filter(
                        (p): p is { type: "text"; text: string } =>
                          p.type === "text",
                      )
                      .map((p) => ({ type: "text" as const, text: p.text }))
                  : "",
          });
        }
      } else if (msg.role === "assistant") {
        // Flush any pending tool results as a user message first
        if (pendingToolResults.length > 0) {
          result.push({ role: "user", content: pendingToolResults });
          pendingToolResults = [];
        }

        // Transform assistant message
        const content: AnthropicMessage["content"] = [];
        if (msg.content) {
          if (typeof msg.content === "string") {
            content.push({ type: "text", text: msg.content });
          } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === "text") {
                content.push({ type: "text", text: part.text });
              }
            }
          }
        }

        // Convert tool_calls to tool_use blocks
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            if (tc.type === "function") {
              content.push({
                type: "tool_use",
                id: tc.id,
                name: tc.function.name,
                input: JSON.parse(tc.function.arguments),
              });
            }
          }
        }

        if (content.length > 0) {
          result.push({ role: "assistant", content });
        }
      }
    }

    // Flush any remaining tool results
    if (pendingToolResults.length > 0) {
      result.push({ role: "user", content: pendingToolResults });
    }

    return result;
  }

  /**
   * Transform OpenAI function tool to Anthropic custom tool format
   */
  private transformTool(tool: OpenAIFunctionTool): AnthropicTool {
    return {
      name: tool.function.name,
      description: tool.function.description,
      input_schema: (tool.function.parameters ?? {}) as Record<string, unknown>,
    };
  }

  /**
   * Transform OpenAI tool_choice to Anthropic format
   */
  private transformToolChoice(
    toolChoice: OpenAIToolChoice | undefined,
  ): AnthropicRequest["tool_choice"] {
    if (!toolChoice) return undefined;

    if (typeof toolChoice === "string") {
      switch (toolChoice) {
        case "auto":
          return { type: "auto" };
        case "required":
          return { type: "any" };
        case "none":
          return { type: "none" };
        default:
          return { type: "auto" };
      }
    }

    // Handle object-style tool choice
    if ("type" in toolChoice) {
      if (toolChoice.type === "function" && "function" in toolChoice) {
        return { type: "tool", name: toolChoice.function.name };
      }
      // For custom, allowed_tools, etc. - default to auto
      return { type: "auto" };
    }

    return { type: "auto" };
  }

  /**
   * Extract text content and tool calls from Anthropic response content
   */
  private extractResponseContent(content: AnthropicResponse["content"]): {
    textContent: string;
    toolCalls: OpenAIToolCall[];
  } {
    let textContent = "";
    const toolCalls: OpenAIToolCall[] = [];

    for (const block of content) {
      if (block.type === "text") {
        textContent += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    return { textContent, toolCalls };
  }

  /**
   * Map Anthropic stop_reason to OpenAI finish_reason
   */
  // TODO: ikonstantinov - OpenAI SDK types don't allow null for finish_reason in non-streaming responses,
  // but our schema (FinishReasonSchema) is nullable. The SDK ChatCompletionChunk type uses a different
  // finish_reason type than our inferred schema type. Need to align these types properly.
  private mapStopReason(
    stopReason: AnthropicResponse["stop_reason"],
  ): OpenAIResponse["choices"][0]["finish_reason"] | null {
    switch (stopReason) {
      case "end_turn":
        return "stop";
      case "tool_use":
        return "tool_calls";
      case "max_tokens":
        return "length";
      default:
        return null;
    }
  }

  /**
   * Denormalize OpenAI finish_reason to Anthropic stop_reason
   */
  private denormalizeStopReason(
    finishReason: OpenAIResponse["choices"][0]["finish_reason"],
  ): AnthropicResponse["stop_reason"] {
    switch (finishReason) {
      case "stop":
        return "end_turn";
      case "tool_calls":
        return "tool_use";
      case "length":
        return "max_tokens";
      default:
        return null;
    }
  }
}
