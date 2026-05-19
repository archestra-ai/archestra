import {
  CHAT_API_KEY_ID_HEADER,
  EXTERNAL_AGENT_ID_HEADER,
  PROVIDER_BASE_URL_HEADER,
  SESSION_ID_HEADER,
  SOURCE_HEADER,
  UNTRUSTED_CONTEXT_HEADER,
  USER_ID_HEADER,
} from "@shared";
import { streamText } from "ai";
import { vi } from "vitest";
import { ConversationModel, LlmProviderApiKeyModel } from "@/models";
import { describe, expect, it, test } from "@/test";

// Mock the gemini-client module before importing llm-client
const mockIsVertexAiEnabled = vi.hoisted(() => vi.fn(() => false));
const mockIsAzureOpenAiEntraIdEnabled = vi.hoisted(() => vi.fn(() => false));
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
vi.mock("@/clients/azure-openai-credentials", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/clients/azure-openai-credentials")>();
  return {
    ...actual,
    isAzureOpenAiEntraIdEnabled: mockIsAzureOpenAiEntraIdEnabled,
  };
});
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: mockCreateAnthropic,
}));

// Capture the fetch option passed to createOpenAI for azure fetchWithVersion tests
const capturedCreateOpenAIOptions = vi.hoisted(() => ({
  fetch: undefined as typeof globalThis.fetch | undefined,
  headers: undefined as Record<string, string> | undefined,
  apiKey: undefined as string | undefined,
}));
vi.mock("@ai-sdk/openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-sdk/openai")>();
  return {
    ...actual,
    createOpenAI: (options: Parameters<typeof actual.createOpenAI>[0]) => {
      capturedCreateOpenAIOptions.fetch = (
        options as { fetch?: typeof globalThis.fetch }
      ).fetch;
      capturedCreateOpenAIOptions.headers = (
        options as { headers?: Record<string, string> }
      ).headers;
      capturedCreateOpenAIOptions.apiKey = (
        options as { apiKey?: string }
      ).apiKey;
      return actual.createOpenAI(options);
    },
  };
});

import {
  createDirectLLMModel,
  createLLMModel,
  createLLMModelForAgent,
} from "./llm-client";

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

  it("creates a model for azure provider", () => {
    const model = createDirectLLMModel({
      provider: "azure",
      apiKey: "test-key",
      modelName: "gpt-4o",
      baseUrl: "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
    });
    expect(model).toBeDefined();
    expect(capturedCreateOpenAIOptions.headers).toEqual(
      expect.objectContaining({
        "api-key": "test-key",
      }),
    );
    expect(capturedCreateOpenAIOptions.apiKey).toBe("test-key");
  });

  it("strips a Bearer prefix before setting the azure api-key header", () => {
    createDirectLLMModel({
      provider: "azure",
      apiKey: "Bearer test-key",
      modelName: "gpt-4o",
      baseUrl: "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
    });

    expect(capturedCreateOpenAIOptions.headers).toEqual(
      expect.objectContaining({
        "api-key": "test-key",
      }),
    );
    expect(capturedCreateOpenAIOptions.apiKey).toBe("test-key");
  });

  // createDirectLLMModel doesn't expose a `fetch` parameter — the azure createModel
  // closure always uses `providedFetch ?? globalThis.fetch`. We stub globalThis.fetch
  // to observe the URL that fetchWithVersion passes through.
  describe("azure fetchWithVersion", () => {
    it("appends api-version to string URL", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("{}"));
      vi.stubGlobal("fetch", mockFetch);

      createDirectLLMModel({
        provider: "azure",
        apiKey: "test-key",
        modelName: "gpt-4o",
        baseUrl:
          "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
      });

      const fetchWithVersion = capturedCreateOpenAIOptions.fetch;
      expect(fetchWithVersion).toBeDefined();
      if (!fetchWithVersion) {
        throw new Error("Expected Azure fetchWithVersion to be configured");
      }

      await fetchWithVersion(
        "https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions",
        {},
      );

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("api-version="),
        expect.anything(),
      );

      vi.unstubAllGlobals();
    });

    it("appends api-version when input is a URL object", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("{}"));
      vi.stubGlobal("fetch", mockFetch);

      createDirectLLMModel({
        provider: "azure",
        apiKey: "test-key",
        modelName: "gpt-4o",
        baseUrl:
          "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
      });

      const fetchWithVersion = capturedCreateOpenAIOptions.fetch;
      expect(fetchWithVersion).toBeDefined();
      if (!fetchWithVersion) {
        throw new Error("Expected Azure fetchWithVersion to be configured");
      }

      const urlObj = new URL(
        "https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions",
      );
      await fetchWithVersion(urlObj, {});

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("api-version="),
        expect.anything(),
      );

      vi.unstubAllGlobals();
    });

    it("appends api-version when input is a Request object", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("{}"));
      vi.stubGlobal("fetch", mockFetch);

      createDirectLLMModel({
        provider: "azure",
        apiKey: "test-key",
        modelName: "gpt-4o",
        baseUrl:
          "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
      });

      const fetchWithVersion = capturedCreateOpenAIOptions.fetch;
      expect(fetchWithVersion).toBeDefined();
      if (!fetchWithVersion) {
        throw new Error("Expected Azure fetchWithVersion to be configured");
      }

      const request = new Request(
        "https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions",
      );
      await fetchWithVersion(request, {});

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("api-version="),
        expect.anything(),
      );

      vi.unstubAllGlobals();
    });

    it("uses globalThis.fetch when no provider fetch is configured", async () => {
      const globalMockFetch = vi.fn().mockResolvedValue(new Response("{}"));
      vi.stubGlobal("fetch", globalMockFetch);

      createDirectLLMModel({
        provider: "azure",
        apiKey: "test-key",
        modelName: "gpt-4o",
        baseUrl:
          "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
      });

      const fetchWithVersion = capturedCreateOpenAIOptions.fetch;
      expect(fetchWithVersion).toBeDefined();
      if (!fetchWithVersion) {
        throw new Error("Expected Azure fetchWithVersion to be configured");
      }

      await fetchWithVersion(
        "https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions",
        {},
      );

      expect(globalMockFetch).toHaveBeenCalledWith(
        expect.stringContaining("api-version="),
        expect.anything(),
      );

      vi.unstubAllGlobals();
    });
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
  test("uses an explicit keyless Azure conversation key and forwards its inference URL to the proxy", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeAgent,
  }) => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(true);

    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ name: "Azure Chat Agent", teams: [] });
    const fallbackSecret = await makeSecret({
      secret: { apiKey: "sk-fallback" },
    });

    const fallbackKey = await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: fallbackSecret.id,
      name: "Fallback Azure Key",
      provider: "azure",
      scope: "org",
      baseUrl: "https://fallback.example.com/openai",
      inferenceBaseUrl: "https://fallback-runtime.example.com/openai",
    });
    const selectedKey = await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: null,
      name: "Selected Keyless Azure Key",
      provider: "azure",
      scope: "org",
      baseUrl: "https://discovery.example.com/openai",
      inferenceBaseUrl: "https://runtime.example.com/openai",
    });
    const conversation = await ConversationModel.create({
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
      title: "Azure Chat Conversation",
      chatApiKeyId: selectedKey.id,
    });

    const result = await createLLMModelForAgent({
      organizationId: org.id,
      userId: user.id,
      agentId: agent.id,
      model: "gpt-4o",
      provider: "azure",
      conversationId: conversation.id,
      source: "chat",
    });

    expect(result.apiKeySource).toBe("org");
    expect(capturedCreateOpenAIOptions.apiKey).toBe("EMPTY");
    expect(capturedCreateOpenAIOptions.headers).toEqual(
      expect.objectContaining({
        [CHAT_API_KEY_ID_HEADER]: selectedKey.id,
        [PROVIDER_BASE_URL_HEADER]: "https://runtime.example.com/openai",
      }),
    );
    expect(capturedCreateOpenAIOptions.headers).not.toEqual(
      expect.objectContaining({
        [CHAT_API_KEY_ID_HEADER]: fallbackKey.id,
        [PROVIDER_BASE_URL_HEADER]:
          "https://fallback-runtime.example.com/openai",
      }),
    );

    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => {
      return new Response(
        [
          'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      const streamResult = streamText({
        model: result.model,
        prompt: "hello",
      });

      await expect(streamResult.text).resolves.toBe("ok");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalled();
    const firstFetchCall = fetchMock.mock.calls[0] as unknown as Parameters<
      typeof globalThis.fetch
    >;
    const [, fetchInit] = firstFetchCall;
    expect(new Headers(fetchInit?.headers).get("authorization")).toBe(
      "Bearer EMPTY",
    );
  });

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
