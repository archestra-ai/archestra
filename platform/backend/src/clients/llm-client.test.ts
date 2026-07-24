import {
  CHAT_API_KEY_ID_HEADER,
  CHATGPT_SUBSCRIPTION_LABEL,
  EXTERNAL_AGENT_ID_HEADER,
  PROVIDER_BASE_URL_HEADER,
  SESSION_ID_HEADER,
  SOURCE_HEADER,
  UNTRUSTED_CONTEXT_HEADER,
  USER_ID_HEADER,
} from "@archestra/shared";
import { generateText, streamText } from "ai";
import { vi } from "vitest";
import { ConversationModel, LlmProviderApiKeyModel } from "@/models";
import { encodeOpenAiCodexCredential } from "@/services/openai-codex-credentials";
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

// Capture the options passed to createOpenAICompatible for the azure
// open-model (reasoning_content) branch tests.
const capturedCreateOpenAICompatibleOptions = vi.hoisted(() => ({
  headers: undefined as Record<string, string> | undefined,
  apiKey: undefined as string | undefined,
  includeUsage: undefined as boolean | undefined,
}));
vi.mock("@ai-sdk/openai-compatible", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@ai-sdk/openai-compatible")>();
  return {
    ...actual,
    createOpenAICompatible: (
      options: Parameters<typeof actual.createOpenAICompatible>[0],
    ) => {
      capturedCreateOpenAICompatibleOptions.headers = (
        options as { headers?: Record<string, string> }
      ).headers;
      capturedCreateOpenAICompatibleOptions.apiKey = (
        options as { apiKey?: string }
      ).apiKey;
      capturedCreateOpenAICompatibleOptions.includeUsage = (
        options as { includeUsage?: boolean }
      ).includeUsage;
      return actual.createOpenAICompatible(options);
    },
  };
});

// Capture the fetch option passed to createOllama, so the native `think`
// reconciliation can be asserted against the body that actually goes out.
const capturedCreateOllamaOptions = vi.hoisted(() => ({
  fetch: undefined as typeof globalThis.fetch | undefined,
}));
vi.mock("ollama-ai-provider-v2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ollama-ai-provider-v2")>();
  return {
    ...actual,
    createOllama: (options: Parameters<typeof actual.createOllama>[0]) => {
      capturedCreateOllamaOptions.fetch = (
        options as { fetch?: typeof globalThis.fetch }
      ).fetch;
      return actual.createOllama(options);
    },
  };
});

import { buildOllamaNativeProviderOptions } from "@/routes/chat/ollama-native-params";
import type { ConfiguredParameters } from "@/types/model";
import {
  createDirectLLMModel,
  createLLMModel,
  createLLMModelForAgent,
  OLLAMA_THINK_EXPLICIT_HEADER,
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

  it("keeps azure OpenAI first-party deployments on the strict openai chat model", () => {
    const model = createDirectLLMModel({
      provider: "azure",
      apiKey: "test-key",
      modelName: "gpt-5.5",
      baseUrl: "https://my-resource.services.ai.azure.com/openai/v1",
    });

    expect((model as { provider: string }).provider).toBe("openai.chat");
  });

  it("uses the openai-compatible chat model for azure open-model deployments so reasoning_content surfaces", () => {
    const model = createDirectLLMModel({
      provider: "azure",
      apiKey: "Bearer test-key",
      modelName: "DeepSeek-R1",
      baseUrl: "https://my-resource.services.ai.azure.com/openai/v1",
    });

    expect((model as { provider: string }).provider).toBe("azure.chat");
    expect((model as { modelId: string }).modelId).toBe("DeepSeek-R1");
    // The azure specifics must survive the SDK switch: api-key header
    // (Bearer-stripped) and the usage chunk the strict SDK sends by default.
    expect(capturedCreateOpenAICompatibleOptions.headers).toEqual(
      expect.objectContaining({
        "api-key": "test-key",
      }),
    );
    expect(capturedCreateOpenAICompatibleOptions.apiKey).toBe("test-key");
    expect(capturedCreateOpenAICompatibleOptions.includeUsage).toBe(true);
  });

  it("throws when azure has no base URL instead of falling back to api.openai.com", () => {
    // Covers the strict-SDK branch too: createOpenAI would otherwise default
    // to api.openai.com and send the Azure api-key there.
    expect(() =>
      createDirectLLMModel({
        provider: "azure",
        apiKey: "test-key",
        modelName: "gpt-5.5",
        baseUrl: null,
      }),
    ).toThrow("Azure AI Foundry base URL is required.");
  });

  it("routes azure gpt-oss deployments through the openai-compatible chat model", () => {
    const model = createDirectLLMModel({
      provider: "azure",
      apiKey: "test-key",
      modelName: "gpt-oss-120b",
      baseUrl: "https://my-resource.services.ai.azure.com/openai/v1",
    });

    expect((model as { provider: string }).provider).toBe("azure.chat");
  });

  // Boundary test: drive the REAL @ai-sdk/openai-compatible model against a
  // stubbed Azure upstream. Pins the reason for the azure SDK gate: DeepSeek-R1
  // style deployments stream their thinking in `reasoning_content` delta
  // fields, which the strict @ai-sdk/openai chat parser silently drops — the
  // thinking must instead surface as reasoning stream parts.
  it("surfaces azure reasoning_content deltas as reasoning stream parts", async () => {
    const chunk = (payload: object) =>
      `data: ${JSON.stringify({
        id: "cmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "DeepSeek-R1",
        ...payload,
      })}`;
    const sseBody = [
      chunk({
        choices: [
          {
            index: 0,
            delta: { role: "assistant", reasoning_content: "Let me think." },
            finish_reason: null,
          },
        ],
      }),
      chunk({
        choices: [{ index: 0, delta: { content: "42" }, finish_reason: null }],
      }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      chunk({
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 5 },
      }),
      "data: [DONE]",
    ].join("\n\n");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(`${sseBody}\n\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );

    const model = createDirectLLMModel({
      provider: "azure",
      apiKey: "test-key",
      modelName: "DeepSeek-R1",
      baseUrl: "https://my-resource.services.ai.azure.com/openai/v1",
    });

    const result = streamText({
      model,
      prompt: "What is 6 * 7?",
      maxRetries: 0,
    });
    let reasoningText = "";
    let answerText = "";
    const errors: unknown[] = [];
    for await (const part of result.fullStream) {
      if (part.type === "reasoning-delta") reasoningText += part.text;
      if (part.type === "text-delta") answerText += part.text;
      if (part.type === "error") errors.push(part.error);
    }

    expect(errors).toEqual([]);
    expect(reasoningText).toBe("Let me think.");
    expect(answerText).toBe("42");
  });

  // createDirectLLMModel doesn't expose a `fetch` parameter — the azure createModel
  // closure always uses `providedFetch ?? globalThis.fetch`. We stub globalThis.fetch
  // to observe the URL that fetchWithVersion passes through.
  // ollama-ai-provider-v2 emits `think: ollamaOptions?.think ?? false`, turning
  // "the caller said nothing" into an explicit `think: false` on the wire. That
  // disables thinking, and a qwen3-class model then returns its chain of thought
  // as message `content` closed by a bare `</think>` — which renders as the
  // answer. These pin the reconciliation against the real request body, since
  // asserting on the provider-options bag alone passed while the wire was wrong.
  describe("ollama-native think reconciliation", () => {
    // Boundary test: drive the REAL ollama-ai-provider-v2 and assert on the body
    // it actually builds. The previous version of these tests hand-wrote the
    // request body, so it could not see that the package strips unknown keys
    // from `providerOptions.ollama.options` — the explicit-thinking marker used
    // to ride there, never survived the parse, and `think` was dropped on every
    // setting. The marker is a header now precisely because headers bypass that
    // Zod parse; a hand-written body would once again prove nothing.
    const wireBodyFor = async (
      configured: ConfiguredParameters | null,
    ): Promise<Record<string, unknown>> => {
      let sent: Record<string, unknown> | undefined;
      const mockFetch = vi.fn(
        async (_input: unknown, init: RequestInit | undefined) => {
          sent = JSON.parse(init?.body as string);
          return new Response("upstream stub", { status: 500 });
        },
      );
      // Must be stubbed BEFORE the model is built: createOllamaNativeFetch
      // captures `globalThis.fetch` at construction time.
      vi.stubGlobal("fetch", mockFetch);

      const turn = buildOllamaNativeProviderOptions({ configured });
      const model = createDirectLLMModel({
        provider: "ollama-native",
        apiKey: undefined,
        modelName: "qwen3:4b",
        baseUrl: "http://localhost:11434",
      });

      // The stubbed upstream fails the call; the request body is captured
      // before that, which is all these assertions need.
      await generateText({
        model,
        prompt: "hi",
        maxRetries: 0,
        ...(turn ? { providerOptions: turn.providerOptions } : {}),
        ...(turn?.headers ? { headers: turn.headers } : {}),
      }).catch(() => {});

      if (!sent) {
        throw new Error("Expected a request to reach the fetch wrapper");
      }
      return sent;
    };

    it("omits think entirely when no thinking choice was configured", async () => {
      // The package defaults `think` to false, which actively DISABLES thinking
      // rather than deferring to the model — a qwen3-class model then returns
      // its chain of thought as message `content` closed by a bare `</think>`.
      const body = await wireBodyFor({ num_ctx: 4096 });
      expect(body).not.toHaveProperty("think");
    });

    it("sends think:false when an admin explicitly turned thinking off", async () => {
      const body = await wireBodyFor({ reasoning_effort: "none" });
      expect(body.think).toBe(false);
    });

    it("sends think:true when an admin explicitly turned thinking on", async () => {
      const body = await wireBodyFor({ reasoning_effort: "medium" });
      expect(body.think).toBe(true);
    });

    it("never leaks the internal marker header upstream", async () => {
      let sentHeaders: Record<string, string> | undefined;
      const mockFetch = vi.fn(
        async (_input: unknown, init: RequestInit | undefined) => {
          sentHeaders = init?.headers as Record<string, string>;
          return new Response("upstream stub", { status: 500 });
        },
      );
      vi.stubGlobal("fetch", mockFetch);

      const turn = buildOllamaNativeProviderOptions({
        configured: { reasoning_effort: "none" },
      });
      const model = createDirectLLMModel({
        provider: "ollama-native",
        apiKey: undefined,
        modelName: "qwen3:4b",
        baseUrl: "http://localhost:11434",
      });
      await generateText({
        model,
        prompt: "hi",
        maxRetries: 0,
        providerOptions: turn?.providerOptions,
        headers: turn?.headers,
      }).catch(() => {});

      const keys = Object.keys(sentHeaders ?? {}).map((k) => k.toLowerCase());
      expect(keys).not.toContain(OLLAMA_THINK_EXPLICIT_HEADER);
    });

    it("keeps the configured sampling options on the wire", async () => {
      const body = await wireBodyFor({ num_ctx: 4096, top_k: 40 });
      expect(body.options).toMatchObject({ num_ctx: 4096, top_k: 40 });
    });

    it("passes a non-JSON body through untouched", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("{}"));
      vi.stubGlobal("fetch", mockFetch);

      createDirectLLMModel({
        provider: "ollama-native",
        apiKey: undefined,
        modelName: "qwen3:4b",
        baseUrl: "http://localhost:11434",
      });
      const wrapped = capturedCreateOllamaOptions.fetch;
      if (!wrapped) {
        throw new Error(
          "Expected ollama-native fetch wrapper to be configured",
        );
      }

      await wrapped("http://localhost:11434/api/chat", {
        method: "POST",
        body: "not json",
      });

      expect(mockFetch.mock.calls[0][1].body).toBe("not json");
    });
  });

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

  test("throws the typed connect prompt when the agent's key is another user's ChatGPT subscription", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const otherUser = await makeUser();
    const agent = await makeAgent({ name: "Codex Agent", teams: [] });
    const secret = await makeSecret({
      secret: {
        apiKey: encodeOpenAiCodexCredential({
          refreshToken: "refresh-token",
          accountId: "account-id",
        }),
      },
    });
    const ownerKey = await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: secret.id,
      name: CHATGPT_SUBSCRIPTION_LABEL,
      provider: "openai",
      scope: "personal",
      userId: owner.id,
    });

    await expect(
      createLLMModelForAgent({
        organizationId: org.id,
        userId: otherUser.id,
        agentId: agent.id,
        model: "gpt-5-codex",
        provider: "openai",
        agentLlmApiKeyId: ownerKey.id,
        source: "chat",
      }),
    ).rejects.toMatchObject({
      name: "LlmProviderAuthRequiredError",
      provider: "openai",
      providerLabel: CHATGPT_SUBSCRIPTION_LABEL,
    });
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

  for (const provider of ["ollama", "ollama-native", "vllm"] as const) {
    test(`${provider} resolves a chat model with no API key configured anywhere`, async ({
      makeOrganization,
      makeUser,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const agent = await makeAgent({ name: `${provider} agent`, teams: [] });

      // The whole point of the self-hosted providers: no key exists, and
      // `resolveProviderApiKey` deliberately returns `apiKey: undefined` for
      // them. A hardcoded provider list in the guard drifts from that set —
      // which is how keyless `ollama-native` 400'd on every turn, the exact
      // setup the docs tell users to create.
      const result = await createLLMModelForAgent({
        organizationId: org.id,
        userId: user.id,
        agentId: agent.id,
        model: "llama3.2",
        provider,
        source: "chat",
      });

      expect(result.model).toBeDefined();
    });
  }
});
