import logger from "@/logging";
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
  StreamAccumulatorState,
  ToolCompressionStats,
  UsageView,
} from "@/types";
import {
  anthropicAdapterFactory,
  bedrockAdapterFactory,
  cohereAdapterFactory,
  geminiAdapterFactory,
  openaiAdapterFactory,
  perplexityAdapterFactory,
  mistralAdapterFactory,
  groqAdapterFactory,
  deepseekAdapterFactory,
} from "./index";
import { 
  openaiToAnthropic, 
  anthropicResponseToOpenai, 
  createAnthropicToOpenaiSseEncoder 
} from "./anthropic-openai-translator";
import { 
  openaiToGemini, 
  geminiResponseToOpenai, 
  createGeminiToOpenaiSseEncoder 
} from "./gemini-openai-translator";
import {
  openaiToConverse,
  converseResponseToOpenai,
  createConverseToOpenaiSseEncoder
} from "./bedrock-openai-translator";

/**
 * Resolves the underlying provider factory based on the model name.
 */
function getProviderInfo(model: string): { factory: LLMProvider<any, any, any, any, any>, translator?: any } {
  const m = model.toLowerCase();

  if (m.startsWith("gpt-") || m.startsWith("o1-") || m.startsWith("text-embedding-3")) {
    return { factory: openaiAdapterFactory };
  }

  if (m.startsWith("claude-")) {
    return { factory: anthropicAdapterFactory, translator: { 
      toNative: openaiToAnthropic, 
      fromNative: anthropicResponseToOpenai,
      createEncoder: createAnthropicToOpenaiSseEncoder 
    } };
  }

  if (m.startsWith("gemini-")) {
    return { factory: geminiAdapterFactory, translator: { 
      toNative: openaiToGemini, 
      fromNative: geminiResponseToOpenai,
      createEncoder: createGeminiToOpenaiSseEncoder 
    } };
  }

  if (m.startsWith("mistral-") || m.startsWith("mixtral-") || m.startsWith("pixtral-")) {
    return { factory: mistralAdapterFactory };
  }

  if (m.startsWith("sonar-")) {
    return { factory: perplexityAdapterFactory };
  }

  if (m.includes("groq") || m.startsWith("llama3-") || m.startsWith("mixtral-8x7b")) {
    return { factory: groqAdapterFactory };
  }

  if (m.startsWith("deepseek-")) {
    return { factory: deepseekAdapterFactory };
  }

  if (m.includes("anthropic.claude") || m.includes("meta.llama") || m.includes("amazon.titan")) {
    return { factory: bedrockAdapterFactory, translator: {
      toNative: openaiToConverse,
      fromNative: converseResponseToOpenai,
      createEncoder: createConverseToOpenaiSseEncoder
    } };
  }

  return { factory: openaiAdapterFactory };
}

class TranslatedRequestAdapter implements LLMRequestAdapter<any, any> {
  constructor(
    private inner: LLMRequestAdapter<any, any>,
    private ctx: any
  ) {}

  readonly provider = "unified" as any;
  getModel(): string { return this.ctx.requestedModel; }
  isStreaming(): boolean { return this.inner.isStreaming(); }
  getMessages(): CommonMessage[] { return this.inner.getMessages(); }
  getToolResults(): CommonToolResult[] { return this.inner.getToolResults(); }
  getTools(): CommonMcpToolDefinition[] { return this.inner.getTools(); }
  hasTools(): boolean { return this.inner.hasTools(); }
  getProviderMessages(): any { return this.inner.getProviderMessages(); }
  getOriginalRequest(): any { return this.inner.getOriginalRequest(); }
  setModel(model: string): void { 
    this.ctx.requestedModel = model;
    this.inner.setModel(model); 
  }
  updateToolResult(id: string, content: string): void { this.inner.updateToolResult(id, content); }
  applyToolResultUpdates(updates: Record<string, string>): void { this.inner.applyToolResultUpdates(updates); }
  async applyToonCompression(model: string): Promise<ToolCompressionStats> {
    return this.inner.applyToonCompression(model);
  }
  toProviderRequest(): any { 
    const req = this.inner.toProviderRequest();
    if (req && typeof req === "object") {
       (req as any)._openaiContext = this.ctx;
    }
    return req;
  }
}

class TranslatedResponseAdapter implements LLMResponseAdapter<any> {
  constructor(
    private inner: LLMResponseAdapter<any>,
    private translator: any,
    private ctx: any
  ) {}

  readonly provider = "unified" as any;
  getId(): string { return this.inner.getId(); }
  getModel(): string { return this.ctx.requestedModel; }
  getText(): string { return this.inner.getText(); }
  getToolCalls(): CommonToolCall[] { return this.inner.getToolCalls(); }
  hasToolCalls(): boolean { return this.inner.hasToolCalls(); }
  getUsage(): UsageView { return this.inner.getUsage(); }
  getFinishReasons(): string[] { return this.inner.getFinishReasons(); }
  
  getOriginalResponse(): any {
    const native = this.inner.getOriginalResponse();
    return this.translator.fromNative(native, this.ctx);
  }

  toRefusalResponse(refusal: string, content: string): any {
    const usage = this.getUsage();
    return {
      id: this.ctx.chatcmplId,
      object: "chat.completion",
      created: this.ctx.createdUnix,
      model: this.ctx.requestedModel,
      choices: [{
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop"
      }],
      usage: {
        prompt_tokens: usage.inputTokens ?? 0,
        completion_tokens: usage.outputTokens ?? 0,
        total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
      }
    };
  }
}

class TranslatedStreamAdapter implements LLMStreamAdapter<any, any> {
  private encoder: any;
  constructor(
    private inner: LLMStreamAdapter<any, any>,
    private translator: any,
    private ctx: any
  ) {
    this.encoder = translator.createEncoder(ctx);
  }

  readonly provider = "unified" as any;
  get state(): StreamAccumulatorState { return this.inner.state; }

  processChunk(chunk: any): ChunkProcessingResult {
    const innerResult = this.inner.processChunk(chunk);
    const sseData = this.encoder.encodeNativeEvent(chunk);
    
    return {
      ...innerResult,
      sseData: sseData ? (sseData instanceof Uint8Array ? Buffer.from(sseData).toString() : sseData) : null
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
    const data = this.encoder.formatTextDelta ? this.encoder.formatTextDelta(text) : null;
    return data ? Buffer.from(data).toString() : "";
  }

  getRawToolCallEvents(): any[] { return this.inner.getRawToolCallEvents(); }
  
  formatCompleteTextSSE(text: string): string[] {
    const data = this.encoder.formatCompleteText ? this.encoder.formatCompleteText(text) : [];
    return data.map((d: any) => Buffer.from(d).toString());
  }

  formatEndSSE(): string {
    const data = this.encoder.formatEnd ? this.encoder.formatEnd() : "";
    return data ? Buffer.from(data).toString() : "";
  }

  toProviderResponse(): any { return this.inner.toProviderResponse(); }
}

export const unifiedAdapterFactory: LLMProvider<any, any, any, any, any> = {
  provider: "unified" as any,
  interactionType: "chat",
  spanName: "llm.unified_proxy",

  createRequestAdapter(body: any) {
    logger.debug({ model: body.model }, "[UnifiedAdapter] Creating request adapter");
    const { factory, translator } = getProviderInfo(body.model || "");
    if (!translator) {
      logger.debug({ provider: factory.provider }, "[UnifiedAdapter] No translator needed, using factory directly");
      return factory.createRequestAdapter(body);
    }
    
    logger.debug({ provider: factory.provider }, "[UnifiedAdapter] Using translator for provider");
    const { anthropicBody, geminiBody, converseBody, openaiContext } = translator.toNative(body);
    const nativeBody = anthropicBody || geminiBody || converseBody;
    (body as any)._openaiContext = openaiContext; 
    const inner = factory.createRequestAdapter(nativeBody);
    return new TranslatedRequestAdapter(inner, openaiContext);
  },

  createResponseAdapter(response: any) {
    const ctx = (response as any)._openaiContext;
    if (!ctx) return openaiAdapterFactory.createResponseAdapter(response);
    
    const { factory, translator } = getProviderInfo(ctx.requestedModel);
    const inner = factory.createResponseAdapter(response);
    if (translator) return new TranslatedResponseAdapter(inner, translator, ctx);
    return inner;
  },

  createStreamAdapter(body: any) {
    const { factory, translator } = getProviderInfo(body.model || "");
    const inner = factory.createStreamAdapter(body);
    const ctx = (body as any)._openaiContext;
    if (!translator || !ctx) return inner;
    return new TranslatedStreamAdapter(inner, translator, ctx);
  },

  createClient(apiKey: string | undefined, options: CreateClientOptions) {
    const { factory } = getProviderInfo(options.agent.baselineModel || "");
    return factory.createClient(apiKey, options);
  },

  async execute(client: any, request: any) {
    const ctx = (request as any)._openaiContext;
    const model = ctx?.requestedModel || (request as any).model || "";
    const { factory } = getProviderInfo(model);
    logger.debug({ provider: factory.provider, model }, "[UnifiedAdapter] Executing request");
    const response = await factory.execute(client, request);
    if (ctx && response && typeof response === "object") {
      (response as any)._openaiContext = ctx;
    }
    return response;
  },

  async executeStream(client: any, request: any) {
    const ctx = (request as any)._openaiContext;
    const model = ctx?.requestedModel || (request as any).model || "";
    const { factory } = getProviderInfo(model);
    return factory.executeStream(client, request);
  },

  extractApiKey(headers: any) {
    return openaiAdapterFactory.extractApiKey(headers);
  },

  extractErrorMessage(error: any) {
    return openaiAdapterFactory.extractErrorMessage(error);
  },

  getBaseUrl() {
    return "";
  }
};
