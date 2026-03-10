import type { SupportedProvider } from "@shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getProviderChatInteractionType,
  withKbObservability,
} from "./kb-interaction";

// ===== Mocks =====

const mockSpan = {
  setAttribute: vi.fn(),
  setStatus: vi.fn(),
  addEvent: vi.fn(),
  end: vi.fn(),
};

vi.mock("@/observability/tracing/llm", () => ({
  startActiveLlmSpan: vi.fn(
    async (params: { callback: (span: typeof mockSpan) => Promise<unknown> }) =>
      params.callback(mockSpan),
  ),
}));

const mockCreate = vi.fn((_data: unknown) =>
  Promise.resolve({ id: "test-interaction-id" }),
);
const mockFindByProviderAndModelId = vi.fn(
  (_provider: unknown, _model: unknown) =>
    Promise.resolve({
      id: "model-1",
      modelId: "text-embedding-3-small",
      provider: "openai",
      customPricePerMillionInput: null,
      customPricePerMillionOutput: null,
      promptPricePerToken: null,
      completionPricePerToken: null,
    }),
);
const mockGetEffectivePricing = vi.fn(() => ({
  pricePerMillionInput: "0.02",
  pricePerMillionOutput: "0.02",
  source: "default",
}));
vi.mock("@/models", () => ({
  InteractionModel: {
    create: (data: unknown) => mockCreate(data),
  },
  ModelModel: {
    findByProviderAndModelId: (_provider: unknown, _model: unknown) =>
      mockFindByProviderAndModelId(_provider, _model),
    getEffectivePricing: (_model: unknown, _modelId?: unknown) =>
      mockGetEffectivePricing(),
  },
}));

const mockReportKbLlmCall = vi.fn();
vi.mock("@/observability", () => ({
  metrics: {
    llm: {
      reportKbLlmCall: (params: unknown) => mockReportKbLlmCall(params),
    },
  },
}));

vi.mock("@/logging", () => ({
  default: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/config", () => ({
  default: {
    observability: { otel: { captureContent: false, contentMaxLength: 10000 } },
  },
}));

// ===== Tests =====

describe("getProviderChatInteractionType", () => {
  it("maps standard chat providers to chatCompletions", () => {
    const chatProviders: SupportedProvider[] = [
      "openai",
      "cerebras",
      "mistral",
      "perplexity",
      "groq",
      "xai",
      "openrouter",
      "vllm",
      "ollama",
      "zhipuai",
      "deepseek",
      "minimax",
    ];
    for (const provider of chatProviders) {
      expect(getProviderChatInteractionType(provider)).toBe(
        `${provider}:chatCompletions`,
      );
    }
  });

  it("maps gemini to generateContent", () => {
    expect(getProviderChatInteractionType("gemini")).toBe(
      "gemini:generateContent",
    );
  });

  it("maps anthropic to messages", () => {
    expect(getProviderChatInteractionType("anthropic")).toBe(
      "anthropic:messages",
    );
  });

  it("maps bedrock to converse", () => {
    expect(getProviderChatInteractionType("bedrock")).toBe("bedrock:converse");
  });

  it("maps cohere to chat", () => {
    expect(getProviderChatInteractionType("cohere")).toBe("cohere:chat");
  });
});

describe("withKbObservability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseParams = {
    operationName: "embedding" as const,
    provider: "openai" as SupportedProvider,
    model: "text-embedding-3-small",
    source: "knowledge:embedding" as const,
    type: "openai:embeddings" as const,
  };

  it("executes the callback and returns its result", async () => {
    const expected = { data: [1, 2, 3] };

    const result = await withKbObservability({
      ...baseParams,
      callback: async () => expected,
      buildInteraction: () => ({
        request: {},
        response: {},
        model: "text-embedding-3-small",
        inputTokens: 10,
        outputTokens: 0,
      }),
    });

    expect(result).toBe(expected);
  });

  it("records an interaction with correct params", async () => {
    await withKbObservability({
      ...baseParams,
      callback: async () => "result",
      buildInteraction: () => ({
        request: { model: "text-embedding-3-small", input: ["hello"] },
        response: { object: "list", data: [], model: "text-embedding-3-small" },
        model: "text-embedding-3-small",
        inputTokens: 5,
        outputTokens: 0,
      }),
    });

    // Give the fire-and-forget promise time to execute
    await vi.waitFor(() => {
      expect(mockCreate).toHaveBeenCalledOnce();
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: null,
        source: "knowledge:embedding",
        type: "openai:embeddings",
        model: "text-embedding-3-small",
        inputTokens: 5,
        outputTokens: 0,
      }),
    );
  });

  it("sets span attributes for source and token usage", async () => {
    await withKbObservability({
      ...baseParams,
      callback: async () => "result",
      buildInteraction: () => ({
        request: {},
        response: {},
        model: "text-embedding-3-small",
        inputTokens: 42,
        outputTokens: 0,
      }),
    });

    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      "archestra.trigger.source",
      "knowledge:embedding",
    );
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      "gen_ai.response.model",
      "text-embedding-3-small",
    );
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      "gen_ai.usage.input_tokens",
      42,
    );
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      "gen_ai.usage.output_tokens",
      0,
    );
  });

  it("does not record interaction when callback throws", async () => {
    const error = new Error("API failed");

    await expect(
      withKbObservability({
        ...baseParams,
        callback: async () => {
          throw error;
        },
        buildInteraction: () => ({
          request: {},
          response: {},
          model: "test",
          inputTokens: 0,
          outputTokens: 0,
        }),
      }),
    ).rejects.toThrow("API failed");

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("still returns result when InteractionModel.create fails", async () => {
    mockCreate.mockRejectedValueOnce(new Error("DB error"));

    const result = await withKbObservability({
      ...baseParams,
      callback: async () => "success",
      buildInteraction: () => ({
        request: {},
        response: {},
        model: "test",
        inputTokens: 0,
        outputTokens: 0,
      }),
    });

    expect(result).toBe("success");
  });

  it("calculates cost from model pricing and stores it", async () => {
    mockGetEffectivePricing.mockReturnValueOnce({
      pricePerMillionInput: "3.00",
      pricePerMillionOutput: "15.00",
      source: "custom",
    });

    await withKbObservability({
      ...baseParams,
      callback: async () => "result",
      buildInteraction: () => ({
        request: {},
        response: {},
        model: "text-embedding-3-small",
        inputTokens: 1_000_000,
        outputTokens: 0,
      }),
    });

    await vi.waitFor(() => {
      expect(mockCreate).toHaveBeenCalledOnce();
    });

    // Cost = (1M / 1M) * 3.00 + (0 / 1M) * 15.00 = 3.00
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        cost: "3.0000000000",
      }),
    );

    expect(mockSpan.setAttribute).toHaveBeenCalledWith("archestra.cost", 3);
  });

  it("stores null cost when pricing lookup fails", async () => {
    mockFindByProviderAndModelId.mockRejectedValueOnce(new Error("DB down"));

    await withKbObservability({
      ...baseParams,
      callback: async () => "result",
      buildInteraction: () => ({
        request: {},
        response: {},
        model: "unknown-model",
        inputTokens: 100,
        outputTokens: 0,
      }),
    });

    await vi.waitFor(() => {
      expect(mockCreate).toHaveBeenCalledOnce();
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        cost: null,
      }),
    );
  });

  it("emits Prometheus metrics via reportKbLlmCall", async () => {
    mockGetEffectivePricing.mockReturnValueOnce({
      pricePerMillionInput: "2.00",
      pricePerMillionOutput: "10.00",
      source: "default",
    });

    await withKbObservability({
      ...baseParams,
      callback: async () => "result",
      buildInteraction: () => ({
        request: {},
        response: {},
        model: "text-embedding-3-small",
        inputTokens: 500,
        outputTokens: 0,
      }),
    });

    expect(mockReportKbLlmCall).toHaveBeenCalledOnce();
    expect(mockReportKbLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "text-embedding-3-small",
        inputTokens: 500,
        outputTokens: 0,
      }),
    );
    // Should include durationSeconds (number >= 0) and cost
    const call = mockReportKbLlmCall.mock.calls[0][0];
    expect(typeof call.durationSeconds).toBe("number");
    expect(call.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it("works with reranker source and chat operation", async () => {
    await withKbObservability({
      operationName: "chat",
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      source: "knowledge:reranker",
      type: "anthropic:messages",
      callback: async () => ({ scores: [{ index: 0, score: 8 }] }),
      buildInteraction: () => ({
        request: { model: "claude-haiku-4-5-20251001", messages: [] },
        response: { id: "r-1", model: "claude-haiku-4-5-20251001" },
        model: "claude-haiku-4-5-20251001",
        inputTokens: 100,
        outputTokens: 20,
      }),
    });

    await vi.waitFor(() => {
      expect(mockCreate).toHaveBeenCalledOnce();
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "knowledge:reranker",
        type: "anthropic:messages",
        model: "claude-haiku-4-5-20251001",
        inputTokens: 100,
        outputTokens: 20,
      }),
    );
  });
});
