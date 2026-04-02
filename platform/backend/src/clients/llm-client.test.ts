import {
  EXTERNAL_AGENT_ID_HEADER,
  SESSION_ID_HEADER,
  SOURCE_HEADER,
  UNTRUSTED_CONTEXT_HEADER,
  USER_ID_HEADER,
} from "@shared";
import { vi } from "vitest";
import { describe, expect, it, test } from "@/test";

// Mock the gemini-client module before importing llm-client
const mockIsVertexAiEnabled = vi.hoisted(() => vi.fn(() => false));
const mockCreateAnthropic = vi.hoisted(() =>
  vi.fn(({ headers }: { headers?: Record<string, string> }) =>
    vi.fn((modelName: string) => ({
      provider: "anthropic",
      modelName,
      headers,
    })),
  ),
);
vi.mock("@/clients/gemini-client", () => ({
  isVertexAiEnabled: mockIsVertexAiEnabled,
}));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: mockCreateAnthropic,
}));

import {
  createDirectLLMModel,
  createLLMModel,
  detectProviderFromModel,
} from "./llm-client";

describe("detectProviderFromModel", () => {
  describe("anthropic models", () => {
    it("detects claude models as anthropic", () => {
      expect(detectProviderFromModel("claude-3-haiku-20240307")).toBe(
        "anthropic",
      );
      expect(detectProviderFromModel("claude-3-opus-20240229")).toBe(
        "anthropic",
      );
      expect(detectProviderFromModel("claude-opus-4-1-20250805")).toBe(
        "anthropic",
      );
      expect(detectProviderFromModel("Claude-3-Sonnet")).toBe("anthropic");
    });
  });

  describe("gemini models", () => {
    it("detects gemini models as gemini", () => {
      expect(detectProviderFromModel("gemini-2.5-pro")).toBe("gemini");
      expect(detectProviderFromModel("gemini-1.5-flash")).toBe("gemini");
      expect(detectProviderFromModel("Gemini-Pro")).toBe("gemini");
    });

    it("detects google models as gemini", () => {
      expect(detectProviderFromModel("google-palm")).toBe("gemini");
    });
  });

  describe("openai models", () => {
    it("detects gpt models as openai", () => {
      expect(detectProviderFromModel("gpt-4o")).toBe("openai");
      expect(detectProviderFromModel("gpt-4-turbo")).toBe("openai");
      expect(detectProviderFromModel("GPT-4")).toBe("openai");
    });

    it("detects o1 models as openai", () => {
      expect(detectProviderFromModel("o1-preview")).toBe("openai");
      expect(detectProviderFromModel("o1-mini")).toBe("openai");
    });

    it("detects o3 models as openai", () => {
      expect(detectProviderFromModel("o3-mini")).toBe("openai");
    });
  });

  describe("unknown models", () => {
    it("defaults to anthropic for unknown models", () => {
      expect(detectProviderFromModel("some-unknown-model")).toBe("anthropic");
      expect(detectProviderFromModel("custom-model")).toBe("anthropic");
    });
  });
});

describe("createDirectLLMModel", () => {
  it("creates a model for anthropic provider", () => {
    const model = createDirectLLMModel({
      provider: "anthropic",
      apiKey: "test-key",
      modelName: "claude-3-5-haiku-20241022",
      baseUrl: null,
    });
    expect(model).toBeDefined();
  });

  it("creates a model for openai provider", () => {
    const model = createDirectLLMModel({
      provider: "openai",
      apiKey: "test-key",
      modelName: "gpt-4o-mini",
      baseUrl: null,
    });
    expect(model).toBeDefined();
  });

  it("creates a model for gemini provider", () => {
    const model = createDirectLLMModel({
      provider: "gemini",
      apiKey: "test-key",
      modelName: "gemini-1.5-flash",
      baseUrl: null,
    });
    expect(model).toBeDefined();
  });

  it("creates a model for cerebras provider", () => {
    const model = createDirectLLMModel({
      provider: "cerebras",
      apiKey: "test-key",
      modelName: "llama-3.3-70b",
      baseUrl: null,
    });
    expect(model).toBeDefined();
  });

  it("creates a model for cohere provider", () => {
    const model = createDirectLLMModel({
      provider: "cohere",
      apiKey: "test-key",
      modelName: "command-light",
      baseUrl: null,
    });
    expect(model).toBeDefined();
  });

  it("creates a model for vllm provider without API key", () => {
    const model = createDirectLLMModel({
      provider: "vllm",
      apiKey: undefined,
      modelName: "default",
      baseUrl: null,
    });
    expect(model).toBeDefined();
  });

  it("creates a model for ollama provider without API key", () => {
    const model = createDirectLLMModel({
      provider: "ollama",
      apiKey: undefined,
      modelName: "llama3.2",
      baseUrl: null,
    });
    expect(model).toBeDefined();
  });

  it("creates a model for zhipuai provider", () => {
    const model = createDirectLLMModel({
      provider: "zhipuai",
      apiKey: "test-key",
      modelName: "glm-4-flash",
      baseUrl: null,
    });
    expect(model).toBeDefined();
  });

  it("throws ApiError for unsupported provider", () => {
    expect(() =>
      createDirectLLMModel({
        provider: "unsupported" as never,
        apiKey: "test-key",
        modelName: "some-model",
        baseUrl: null,
      }),
    ).toThrow("Unsupported provider: unsupported");
  });

  it("throws descriptive error for gemini provider without API key and Vertex AI disabled", () => {
    expect(() =>
      createDirectLLMModel({
        provider: "gemini",
        apiKey: undefined,
        modelName: "gemini-1.5-flash",
        baseUrl: null,
      }),
    ).toThrow(
      "Gemini API key is required when Vertex AI is not enabled. Please configure GEMINI_API_KEY or enable Vertex AI.",
    );
  });

  it("throws descriptive error for anthropic provider without API key", () => {
    expect(() =>
      createDirectLLMModel({
        provider: "anthropic",
        apiKey: undefined,
        modelName: "claude-3-5-haiku-20241022",
        baseUrl: null,
      }),
    ).toThrow(
      "Anthropic API key is required. Please configure ANTHROPIC_API_KEY.",
    );
  });

  it("throws descriptive error for openai provider without API key", () => {
    expect(() =>
      createDirectLLMModel({
        provider: "openai",
        apiKey: undefined,
        modelName: "gpt-4o-mini",
        baseUrl: null,
      }),
    ).toThrow("OpenAI API key is required. Please configure OPENAI_API_KEY.");
  });

  it("throws descriptive error for cerebras provider without API key", () => {
    expect(() =>
      createDirectLLMModel({
        provider: "cerebras",
        apiKey: undefined,
        modelName: "llama-3.3-70b",
        baseUrl: null,
      }),
    ).toThrow(
      "Cerebras API key is required. Please configure CEREBRAS_API_KEY.",
    );
  });

  it("throws descriptive error for cohere provider without API key", () => {
    expect(() =>
      createDirectLLMModel({
        provider: "cohere",
        apiKey: undefined,
        modelName: "command-light",
        baseUrl: null,
      }),
    ).toThrow("Cohere API key is required. Please configure COHERE_API_KEY.");
  });

  it("throws descriptive error for zhipuai provider without API key", () => {
    expect(() =>
      createDirectLLMModel({
        provider: "zhipuai",
        apiKey: undefined,
        modelName: "glm-4-flash",
        baseUrl: null,
      }),
    ).toThrow(
      "Zhipu AI API key is required. Please configure ZHIPUAI_API_KEY.",
    );
  });
});

describe("createLLMModel", () => {
  test("sets the untrusted-context header only when contextIsTrusted is false", () => {
    createLLMModel({
      provider: "anthropic",
      apiKey: "test-key",
      agentId: "agent-1",
      modelName: "claude-3-5-haiku-20241022",
      userId: "user-1",
      externalAgentId: "external-agent-1",
      sessionId: "session-1",
      source: "chat",
      baseUrl: null,
      contextIsTrusted: false,
    });

    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          [EXTERNAL_AGENT_ID_HEADER]: "external-agent-1",
          [USER_ID_HEADER]: "user-1",
          [SESSION_ID_HEADER]: "session-1",
          [SOURCE_HEADER]: "chat",
          [UNTRUSTED_CONTEXT_HEADER]: "true",
        }),
      }),
    );

    mockCreateAnthropic.mockClear();

    createLLMModel({
      provider: "anthropic",
      apiKey: "test-key",
      agentId: "agent-1",
      modelName: "claude-3-5-haiku-20241022",
      userId: "user-1",
      externalAgentId: "external-agent-1",
      sessionId: "session-1",
      source: "chat",
      baseUrl: null,
      contextIsTrusted: undefined,
    });

    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.not.objectContaining({
          [UNTRUSTED_CONTEXT_HEADER]: "true",
        }),
      }),
    );
  });
});
