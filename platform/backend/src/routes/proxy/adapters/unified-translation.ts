/**
 * Unified LLM Gateway — Translation Adapters
 *
 * Wraps non-OpenAI-compatible providers (Anthropic, Gemini, Cohere, Bedrock)
 * so they can receive OpenAI-format requests and return OpenAI-format responses.
 * Each translation follows the same two-step pattern:
 *   1. oaiTo<Provider>() converts the incoming OAI request to native format.
 *   2. The native response is normalised back to OAI format via UnifiedResponseAdapter.
 */
import { randomUUID } from "node:crypto";
import type {
  ChunkProcessingResult,
  CommonMcpToolDefinition,
  CommonMessage,
  CommonToolCall,
  CommonToolResult,
  CreateClientOptions,
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
  OpenAi,
  StreamAccumulatorState,
  ToolCompressionStats,
  UsageView,
} from "@/types";
import type { GeminiRequestWithModel } from "./gemini";
import { convertToolResultsToToon } from "./openai";

// =============================================================================
// TYPE ALIASES
// =============================================================================

type OAIRequest = OpenAi.Types.ChatCompletionsRequest;
type OAIResponse = OpenAi.Types.ChatCompletionsResponse;
type OAIHeaders = OpenAi.Types.ChatCompletionsHeaders;
type OAIMessage = OpenAi.Types.Message;

// =============================================================================
// HELPERS
// =============================================================================

function getContentText(content: OAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if ("text" in part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  if (content == null) return "";
  return "";
}

// =============================================================================
// REQUEST TRANSLATION
// =============================================================================

type AnthropicTextBlock = { type: "text"; text: string };
type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};
type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolResultBlock
  | AnthropicToolUseBlock;

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

type AnthropicTool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};

type AnthropicRequest = {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string;
  temperature?: number;
  tools?: AnthropicTool[];
  stream?: boolean;
};

function oaiToAnthropic(req: OAIRequest): AnthropicRequest {
  const anthropicMessages: AnthropicMessage[] = [];
  let systemPrompt: string | undefined;

  for (const msg of req.messages) {
    if (msg.role === "system" || msg.role === "developer") {
      systemPrompt = getContentText(msg.content);
      continue;
    }

    if (msg.role === "tool") {
      const toolResultBlock: AnthropicToolResultBlock = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: getContentText(msg.content),
      };
      const last = anthropicMessages[anthropicMessages.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(toolResultBlock);
      } else {
        anthropicMessages.push({ role: "user", content: [toolResultBlock] });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const contentBlocks: AnthropicContentBlock[] = [];
      const text = getContentText(msg.content);
      if (text) contentBlocks.push({ type: "text", text });

      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.type !== "function") continue;
          const f = tc.function;
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(f.arguments) as Record<string, unknown>;
          } catch {
            input = {};
          }
          contentBlocks.push({
            type: "tool_use",
            id: tc.id,
            name: f.name,
            input,
          });
        }
      }

      const finalContent: AnthropicMessage["content"] =
        contentBlocks.length === 1 && contentBlocks[0].type === "text"
          ? (contentBlocks[0] as AnthropicTextBlock).text
          : contentBlocks;

      anthropicMessages.push({ role: "assistant", content: finalContent });
      continue;
    }

    if (msg.role === "function") {
      const block: AnthropicToolResultBlock = {
        type: "tool_result",
        tool_use_id: msg.name,
        content: msg.content ?? "",
      };
      const last = anthropicMessages[anthropicMessages.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        anthropicMessages.push({ role: "user", content: [block] });
      }
      continue;
    }

    anthropicMessages.push({
      role: "user",
      content: getContentText(msg.content),
    });
  }

  const tools: AnthropicTool[] | undefined = req.tools
    ?.filter(
      (t): t is Extract<typeof t, { type: "function" }> =>
        t.type === "function",
    )
    .map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: (t.function.parameters ?? {}) as Record<string, unknown>,
    }));

  return {
    model: req.model,
    messages: anthropicMessages,
    max_tokens: req.max_tokens ?? 4096,
    system: systemPrompt,
    temperature: req.temperature ?? undefined,
    tools: tools && tools.length > 0 ? tools : undefined,
    stream: req.stream ?? false,
  };
}

type GeminiPart = {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
};

type GeminiContent = {
  role: string;
  parts: GeminiPart[];
};

function oaiToGemini(req: OAIRequest): GeminiRequestWithModel {
  const contents: GeminiContent[] = [];
  let systemInstruction: string | undefined;

  for (const msg of req.messages) {
    if (msg.role === "system" || msg.role === "developer") {
      systemInstruction = getContentText(msg.content);
      continue;
    }

    if (msg.role === "tool") {
      const funcResp: GeminiPart = {
        functionResponse: {
          name: msg.tool_call_id,
          response: { result: getContentText(msg.content) },
        },
      };
      const last = contents[contents.length - 1];
      if (last && last.role === "user") {
        last.parts.push(funcResp);
      } else {
        contents.push({ role: "user", parts: [funcResp] });
      }
      continue;
    }

    if (msg.role === "function") {
      const funcResp: GeminiPart = {
        functionResponse: {
          name: msg.name,
          response: { result: msg.content ?? "" },
        },
      };
      const last = contents[contents.length - 1];
      if (last && last.role === "user") {
        last.parts.push(funcResp);
      } else {
        contents.push({ role: "user", parts: [funcResp] });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const parts: GeminiPart[] = [];
      const text = getContentText(msg.content);
      if (text) parts.push({ text });

      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.type !== "function") continue;
          const f = tc.function;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(f.arguments) as Record<string, unknown>;
          } catch {
            args = {};
          }
          parts.push({ functionCall: { name: f.name, args } });
        }
      }
      contents.push({ role: "model", parts });
      continue;
    }

    // user
    contents.push({
      role: "user",
      parts: [{ text: getContentText(msg.content) }],
    });
  }

  const tools = req.tools?.filter(
    (t): t is Extract<typeof t, { type: "function" }> => t.type === "function",
  ).length
    ? [
        {
          functionDeclarations: req.tools
            .filter(
              (t): t is Extract<typeof t, { type: "function" }> =>
                t.type === "function",
            )
            .map((t) => ({
              name: t.function.name,
              description: t.function.description ?? "",
              parameters: t.function.parameters as Record<string, unknown>,
            })),
        },
      ]
    : undefined;

  const geminiConfig: Record<string, unknown> = {};
  if (req.temperature != null) geminiConfig.temperature = req.temperature;
  if (req.max_tokens != null) geminiConfig.maxOutputTokens = req.max_tokens;

  return {
    contents: contents as GeminiRequestWithModel["contents"],
    tools: tools as GeminiRequestWithModel["tools"],
    config:
      Object.keys(geminiConfig).length > 0
        ? (geminiConfig as GeminiRequestWithModel["config"])
        : undefined,
    systemInstruction: systemInstruction
      ? {
          parts: [{ text: systemInstruction }],
        }
      : undefined,
    _model: req.model,
    _isStreaming: req.stream === true,
  };
}

type CohereMessage = { role: string; content: string };

type CohereRequest = {
  model: string;
  messages: CohereMessage[];
  tools?: OAIRequest["tools"];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
};

function oaiToCohere(req: OAIRequest): CohereRequest {
  const messages: CohereMessage[] = req.messages.map((msg) => ({
    role: msg.role,
    content: getContentText(msg.content),
  }));

  return {
    model: req.model,
    messages,
    tools: req.tools,
    temperature: req.temperature ?? undefined,
    max_tokens: req.max_tokens ?? undefined,
    stream: req.stream ?? false,
  };
}

type BedrockTextContent = { text: string };
type BedrockToolUseContent = {
  toolUse: { toolUseId: string; name: string; input: Record<string, unknown> };
};
type BedrockToolResultContent = {
  toolResult: { toolUseId: string; content: Array<{ text: string }> };
};
type BedrockMessageContent =
  | BedrockTextContent
  | BedrockToolUseContent
  | BedrockToolResultContent;

type BedrockMessage = {
  role: "user" | "assistant";
  content: BedrockMessageContent[];
};

type BedrockToolSpec = {
  toolSpec: {
    name: string;
    description?: string;
    inputSchema: { json: Record<string, unknown> };
  };
};

type BedrockRequest = {
  modelId: string;
  messages: BedrockMessage[];
  system?: Array<{ text: string }>;
  inferenceConfig?: { maxTokens?: number; temperature?: number };
  toolConfig?: { tools: BedrockToolSpec[] };
  _isStreaming?: boolean;
};

function oaiToBedrock(req: OAIRequest): BedrockRequest {
  const bedrockMessages: BedrockMessage[] = [];
  const systemBlocks: Array<{ text: string }> = [];

  for (const msg of req.messages) {
    if (msg.role === "system" || msg.role === "developer") {
      systemBlocks.push({ text: getContentText(msg.content) });
      continue;
    }

    if (msg.role === "tool") {
      const toolResult: BedrockToolResultContent = {
        toolResult: {
          toolUseId: msg.tool_call_id,
          content: [{ text: getContentText(msg.content) }],
        },
      };
      const last = bedrockMessages[bedrockMessages.length - 1];
      if (last && last.role === "user") {
        last.content.push(toolResult);
      } else {
        bedrockMessages.push({ role: "user", content: [toolResult] });
      }
      continue;
    }

    if (msg.role === "function") {
      const toolResult: BedrockToolResultContent = {
        toolResult: {
          toolUseId: msg.name,
          content: [{ text: msg.content ?? "" }],
        },
      };
      const last = bedrockMessages[bedrockMessages.length - 1];
      if (last && last.role === "user") {
        last.content.push(toolResult);
      } else {
        bedrockMessages.push({ role: "user", content: [toolResult] });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const content: BedrockMessageContent[] = [];
      const text = getContentText(msg.content);
      if (text) content.push({ text });

      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.type !== "function") continue;
          const f = tc.function;
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(f.arguments) as Record<string, unknown>;
          } catch {
            input = {};
          }
          content.push({ toolUse: { toolUseId: tc.id, name: f.name, input } });
        }
      }
      bedrockMessages.push({ role: "assistant", content });
      continue;
    }

    // user
    bedrockMessages.push({
      role: "user",
      content: [{ text: getContentText(msg.content) }],
    });
  }

  const toolConfig: BedrockRequest["toolConfig"] = req.tools?.filter(
    (t): t is Extract<typeof t, { type: "function" }> => t.type === "function",
  ).length
    ? {
        tools: req.tools
          .filter(
            (t): t is Extract<typeof t, { type: "function" }> =>
              t.type === "function",
          )
          .map((t) => ({
            toolSpec: {
              name: t.function.name,
              description: t.function.description,
              inputSchema: {
                json: (t.function.parameters ?? {}) as Record<string, unknown>,
              },
            },
          })),
      }
    : undefined;

  return {
    modelId: req.model,
    messages: bedrockMessages,
    system: systemBlocks.length > 0 ? systemBlocks : undefined,
    inferenceConfig: {
      maxTokens: req.max_tokens ?? undefined,
      temperature: req.temperature ?? undefined,
    },
    toolConfig,
    _isStreaming: req.stream === true,
  };
}

// =============================================================================
// RESPONSE HELPERS
// =============================================================================

function makeOAIResponse(
  id: string,
  model: string,
  text: string,
  toolCalls: CommonToolCall[],
  usage: UsageView,
): OAIResponse {
  const hasToolCalls = toolCalls.length > 0;
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        finish_reason: hasToolCalls ? "tool_calls" : "stop",
        logprobs: null,
        message: {
          role: "assistant",
          content: text || null,
          refusal: null,
          tool_calls: hasToolCalls
            ? toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: {
                  name: tc.name,
                  arguments:
                    typeof tc.arguments === "string"
                      ? tc.arguments
                      : JSON.stringify(tc.arguments),
                },
              }))
            : undefined,
        },
      },
    ],
    usage: {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
    },
  };
}

// =============================================================================
// RESPONSE ADAPTER
// =============================================================================

class UnifiedResponseAdapter implements LLMResponseAdapter<OAIResponse> {
  readonly provider: LLMResponseAdapter<OAIResponse>["provider"];
  private oaiResponse: OAIResponse;

  constructor(
    provider: LLMResponseAdapter<OAIResponse>["provider"],
    oaiResponse: OAIResponse,
  ) {
    this.provider = provider;
    this.oaiResponse = oaiResponse;
  }

  static fromParts(
    provider: LLMResponseAdapter<OAIResponse>["provider"],
    id: string,
    model: string,
    text: string,
    toolCalls: CommonToolCall[],
    usage: UsageView,
  ): UnifiedResponseAdapter {
    return new UnifiedResponseAdapter(
      provider,
      makeOAIResponse(id, model, text, toolCalls, usage),
    );
  }

  getId(): string {
    return this.oaiResponse.id;
  }

  getModel(): string {
    return this.oaiResponse.model;
  }

  getText(): string {
    return this.oaiResponse.choices[0]?.message.content ?? "";
  }

  getToolCalls(): CommonToolCall[] {
    const calls = this.oaiResponse.choices[0]?.message.tool_calls;
    if (!calls) return [];
    return calls
      .filter((tc) => tc.type === "function")
      .map((tc) => {
        const f = (
          tc as {
            type: "function";
            function: { name: string; arguments: string };
          }
        ).function;
        return {
          id: tc.id,
          name: f.name,
          arguments: f.arguments as unknown as Record<string, unknown>,
        };
      });
  }

  hasToolCalls(): boolean {
    return (this.oaiResponse.choices[0]?.message.tool_calls?.length ?? 0) > 0;
  }

  getUsage(): UsageView {
    return {
      inputTokens: this.oaiResponse.usage?.prompt_tokens ?? 0,
      outputTokens: this.oaiResponse.usage?.completion_tokens ?? 0,
    };
  }

  getOriginalResponse(): OAIResponse {
    return this.oaiResponse;
  }

  getFinishReasons(): string[] {
    return this.oaiResponse.choices.map((c) => c.finish_reason ?? "stop");
  }

  toRefusalResponse(
    _refusalMessage: string,
    contentMessage: string,
  ): OAIResponse {
    return makeOAIResponse(
      this.oaiResponse.id,
      this.oaiResponse.model,
      contentMessage,
      [],
      {
        inputTokens: this.oaiResponse.usage?.prompt_tokens ?? 0,
        outputTokens: this.oaiResponse.usage?.completion_tokens ?? 0,
      },
    );
  }
}

// =============================================================================
// STREAM ADAPTER
// =============================================================================

class NativeWrapperStreamAdapter
  implements LLMStreamAdapter<unknown, OAIResponse>
{
  readonly provider: LLMStreamAdapter<unknown, OAIResponse>["provider"];
  private native: LLMStreamAdapter<unknown, unknown>;
  private responseId: string;
  private resolvedModel: string;
  private lastEmittedTextLength = 0;

  constructor(
    provider: LLMStreamAdapter<unknown, OAIResponse>["provider"],
    model: string,
    native: LLMStreamAdapter<unknown, unknown>,
  ) {
    this.provider = provider;
    this.responseId = `chatcmpl-unified-${randomUUID()}`;
    this.resolvedModel = model;
    this.native = native;
  }

  get state(): StreamAccumulatorState {
    return this.native.state;
  }

  processChunk(chunk: unknown): ChunkProcessingResult {
    const result = this.native.processChunk(chunk);

    if (result.isFinal) {
      return { sseData: null, isToolCallChunk: false, isFinal: true };
    }

    if (result.isToolCallChunk) {
      return { sseData: null, isToolCallChunk: true, isFinal: false };
    }

    const currentText = this.native.state.text;
    const newText = currentText.slice(this.lastEmittedTextLength);
    this.lastEmittedTextLength = currentText.length;

    if (!newText) {
      return { sseData: null, isToolCallChunk: false, isFinal: false };
    }

    if (this.native.state.timing.firstChunkTime === null) {
      this.native.state.timing.firstChunkTime = Date.now();
    }

    const oaiChunk = {
      id: this.responseId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.resolvedModel,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: newText },
          finish_reason: null,
          logprobs: null,
        },
      ],
    };
    return {
      sseData: `data: ${JSON.stringify(oaiChunk)}\n\n`,
      isToolCallChunk: false,
      isFinal: false,
    };
  }

  getSSEHeaders(): Record<string, string> {
    return {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
  }

  formatTextDeltaSSE(text: string): string {
    this.native.state.text += text;
    const chunk = {
      id: this.responseId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.resolvedModel,
      choices: [
        {
          index: 0,
          delta: { content: text },
          finish_reason: null,
          logprobs: null,
        },
      ],
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  getRawToolCallEvents(): string[] {
    const toolCalls = this.native.state.toolCalls;
    return toolCalls.map((tc, idx) => {
      const toolChunk = {
        id: this.responseId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: this.resolvedModel,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  index: idx,
                  id: tc.id,
                  type: "function",
                  function: {
                    name: tc.name,
                    arguments:
                      typeof tc.arguments === "string"
                        ? tc.arguments
                        : JSON.stringify(tc.arguments),
                  },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      };
      return `data: ${JSON.stringify(toolChunk)}\n\n`;
    });
  }

  formatCompleteTextSSE(text: string): string[] {
    return [this.formatTextDeltaSSE(text)];
  }

  formatEndSSE(): string {
    const usage = this.native.state.usage;
    const stopChunk = {
      id: this.responseId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.resolvedModel,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason:
            (this.native.state.toolCalls.length > 0
              ? "tool_calls"
              : this.native.state.stopReason) ?? "stop",
          logprobs: null,
        },
      ],
      usage: usage
        ? {
            prompt_tokens: usage.inputTokens,
            completion_tokens: usage.outputTokens,
            total_tokens: usage.inputTokens + usage.outputTokens,
          }
        : undefined,
    };
    return `data: ${JSON.stringify(stopChunk)}\n\ndata: [DONE]\n\n`;
  }

  toProviderResponse(): OAIResponse {
    const usage = this.native.state.usage;
    return makeOAIResponse(
      this.responseId,
      this.native.state.model || this.resolvedModel,
      this.native.state.text,
      this.native.state.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments as unknown as Record<string, unknown>,
      })),
      usage ?? { inputTokens: 0, outputTokens: 0 },
    );
  }
}

// =============================================================================
// REQUEST ADAPTER
// =============================================================================

class UnifiedRequestAdapter
  implements LLMRequestAdapter<OAIRequest, unknown[]>
{
  readonly provider: LLMRequestAdapter<OAIRequest, unknown[]>["provider"];
  private inner: LLMRequestAdapter<unknown, unknown>;
  private oaiRequest: OAIRequest;
  private modifiedModel: string | null = null;

  constructor(
    provider: LLMRequestAdapter<OAIRequest, unknown[]>["provider"],
    oaiRequest: OAIRequest,
    inner: LLMRequestAdapter<unknown, unknown>,
  ) {
    this.provider = provider;
    this.oaiRequest = oaiRequest;
    this.inner = inner;
  }

  getModel(): string {
    return this.modifiedModel ?? this.oaiRequest.model;
  }

  isStreaming(): boolean {
    return this.oaiRequest.stream === true;
  }

  getMessages(): CommonMessage[] {
    return this.inner.getMessages();
  }

  getToolResults(): CommonToolResult[] {
    return this.inner.getToolResults();
  }

  getTools(): CommonMcpToolDefinition[] {
    return this.inner.getTools();
  }

  hasTools(): boolean {
    return this.inner.hasTools();
  }

  getProviderMessages(): unknown[] {
    return this.inner.getProviderMessages() as unknown[];
  }

  getOriginalRequest(): OAIRequest {
    return this.oaiRequest;
  }

  setModel(model: string): void {
    this.modifiedModel = model;
  }

  updateToolResult(toolCallId: string, newContent: string): void {
    this.applyToolResultUpdates({ [toolCallId]: newContent });
  }

  applyToolResultUpdates(updates: Record<string, string>): void {
    if (Object.keys(updates).length === 0) return;
    this.oaiRequest = {
      ...this.oaiRequest,
      messages: this.oaiRequest.messages.map((msg) => {
        if (msg.role === "tool" && updates[msg.tool_call_id]) {
          return { ...msg, content: updates[msg.tool_call_id] };
        }
        return msg;
      }),
    };
  }

  async applyToonCompression(model: string): Promise<ToolCompressionStats> {
    const { messages: compressed, stats } = await convertToolResultsToToon(
      this.oaiRequest.messages as Parameters<
        typeof convertToolResultsToToon
      >[0],
      model,
    );
    this.oaiRequest = {
      ...this.oaiRequest,
      messages: compressed as OAIRequest["messages"],
    };
    return stats;
  }

  convertToolResultContent(messages: unknown[]): unknown[] {
    return this.inner.convertToolResultContent(messages as never) as unknown[];
  }

  toProviderRequest(): OAIRequest {
    if (this.modifiedModel) {
      return { ...this.oaiRequest, model: this.modifiedModel };
    }
    return this.oaiRequest;
  }
}

// =============================================================================
// ADAPTER FACTORY
// =============================================================================

type NativeProvider = LLMProvider<unknown, unknown, unknown, unknown, unknown>;

function buildUnifiedProvider(
  nativeProvider: NativeProvider,
  translateRequest: (req: OAIRequest) => unknown,
): LLMProvider<OAIRequest, OAIResponse, unknown[], unknown, OAIHeaders> {
  const providerName = nativeProvider.provider;

  return {
    provider: providerName,
    interactionType: nativeProvider.interactionType,
    spanName: nativeProvider.spanName,

    createRequestAdapter(req: OAIRequest) {
      const nativeReq = translateRequest(req);
      const nativeAdapter = nativeProvider.createRequestAdapter(nativeReq);
      return new UnifiedRequestAdapter(providerName, req, nativeAdapter);
    },

    createResponseAdapter(
      response: OAIResponse,
    ): LLMResponseAdapter<OAIResponse> {
      return new UnifiedResponseAdapter(providerName, response);
    },

    createStreamAdapter(req?: OAIRequest) {
      const model = req?.model ?? "";
      const nativeReq = req ? translateRequest(req) : undefined;
      const nativeStreamAdapter = nativeProvider.createStreamAdapter(
        nativeReq as unknown as Parameters<
          typeof nativeProvider.createStreamAdapter
        >[0],
      );
      return new NativeWrapperStreamAdapter(
        providerName,
        model,
        nativeStreamAdapter,
      );
    },

    extractApiKey(headers: OAIHeaders): string | undefined {
      const auth = headers.authorization;
      if (!auth) return undefined;
      return auth.startsWith("Bearer ") ? auth.slice(7) : auth;
    },

    getBaseUrl(): string | undefined {
      return nativeProvider.getBaseUrl();
    },

    createClient(
      apiKey: string | undefined,
      options: CreateClientOptions,
    ): unknown {
      return nativeProvider.createClient(apiKey, options);
    },

    async execute(client: unknown, req: OAIRequest): Promise<OAIResponse> {
      const nativeReq = translateRequest(req);
      const nativeResp = await nativeProvider.execute(client, nativeReq);
      const nativeAdapter = nativeProvider.createResponseAdapter(nativeResp);
      return UnifiedResponseAdapter.fromParts(
        providerName,
        nativeAdapter.getId(),
        nativeAdapter.getModel() || req.model,
        nativeAdapter.getText(),
        nativeAdapter.getToolCalls(),
        nativeAdapter.getUsage(),
      ).getOriginalResponse();
    },

    async executeStream(
      client: unknown,
      req: OAIRequest,
    ): Promise<AsyncIterable<unknown>> {
      const nativeReq = translateRequest(req);
      return nativeProvider.executeStream(client, nativeReq);
    },

    extractErrorMessage(error: unknown): string {
      return nativeProvider.extractErrorMessage(error);
    },
  };
}

// =============================================================================
// PUBLIC API
// =============================================================================

export function buildUnifiedAnthropicProvider(
  anthropicFactory: NativeProvider,
): LLMProvider<OAIRequest, OAIResponse, unknown[], unknown, OAIHeaders> {
  return buildUnifiedProvider(anthropicFactory, oaiToAnthropic);
}

export function buildUnifiedGeminiProvider(
  geminiFactory: NativeProvider,
): LLMProvider<OAIRequest, OAIResponse, unknown[], unknown, OAIHeaders> {
  return buildUnifiedProvider(geminiFactory, oaiToGemini);
}

export function buildUnifiedCohereProvider(
  cohereFactory: NativeProvider,
): LLMProvider<OAIRequest, OAIResponse, unknown[], unknown, OAIHeaders> {
  return buildUnifiedProvider(cohereFactory, oaiToCohere);
}

export function buildUnifiedBedrockProvider(
  bedrockFactory: NativeProvider,
): LLMProvider<OAIRequest, OAIResponse, unknown[], unknown, OAIHeaders> {
  return buildUnifiedProvider(bedrockFactory, oaiToBedrock);
}
