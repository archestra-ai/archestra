/**
 * LLM Proxy Handler Tests
 *
 * Tests that verify:
 * 1. Prometheus metrics are correctly incremented for all LLM providers
 * 2. recordBlockedToolSpans is called when tool invocation policies block tool calls
 */

import {
  CHAT_API_KEY_ID_HEADER,
  PROVIDER_BASE_URL_HEADER,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import db, { schema } from "@/database";
import type { PolicyBlockResult } from "@/guardrails/tool-invocation";
import {
  InteractionModel,
  LlmProviderApiKeyModel,
  ModelModel,
  ModelTeamModel,
  VirtualApiKeyModel,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  type AnthropicStubOptions,
  createAnthropicTestClient,
  createGeminiTestClient,
  createOpenAiTestClient,
  type OpenAiStubOptions,
} from "@/test/llm-provider-stubs";
import type { Agent } from "@/types";
import { ApiError } from "@/types";

// Mock prom-client at module level (like llm-metrics.test.ts)
const counterInc = vi.fn();
const histogramObserve = vi.fn();

vi.mock("prom-client", () => ({
  default: {
    Counter: class {
      inc(...args: unknown[]) {
        counterInc(...args);
      }
    },
    Histogram: class {
      observe(...args: unknown[]) {
        histogramObserve(...args);
      }
    },
    register: {
      removeSingleMetric: vi.fn(),
    },
  },
}));

// Mock tool-invocation to control policy evaluation results.
// Default: evaluatePolicies → null (allow), matching the real behavior when no
// policies exist in the DB.
// Args are forwarded so tests can assert what the handler computed and passed
// in (notably the availability set), not just that evaluation happened.
const mockEvaluatePolicies =
  vi.fn<(...args: unknown[]) => Promise<PolicyBlockResult | null>>();

vi.mock("@/guardrails/tool-invocation", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/guardrails/tool-invocation")>();
  return {
    ...original,
    evaluatePolicies: (...args: unknown[]) => mockEvaluatePolicies(...args),
  };
});

// Spy on recordBlockedToolSpans to verify it's called with the right args
const mockRecordBlockedToolSpans = vi.fn();
vi.mock("@/observability/tracing", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/observability/tracing")>();
  return {
    ...original,
    recordBlockedToolSpans: (...args: unknown[]) =>
      mockRecordBlockedToolSpans(...args),
  };
});

vi.mock("@/clients/azure-openai-credentials", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/clients/azure-openai-credentials")>();
  return {
    ...original,
    isAzureOpenAiEntraIdEnabled: () => true,
  };
});

// Import after mocks to ensure mocks are applied
import { metrics } from "@/observability";
import {
  anthropicAdapterFactory,
  azureAdapterFactory,
  bedrockAdapterFactory,
  geminiAdapterFactory,
  openaiAdapterFactory,
} from "./adapters";
import { virtualKeyRateLimiter } from "./llm-proxy-auth";
import anthropicProxyRoutes from "./routes/anthropic";
import azureProxyRoutes from "./routes/azure";
import bedrockProxyRoutes from "./routes/bedrock";
import geminiProxyRoutes from "./routes/gemini";
import githubCopilotProxyRoutes from "./routes/github-copilot";
import openAiProxyRoutes from "./routes/openai";

describe("LLM Proxy Handler Prometheus Metrics", () => {
  let app: FastifyInstance;
  let testAgent: Agent;
  let openAiStubOptions: OpenAiStubOptions;
  let anthropicStubOptions: {
    includeToolUse?: boolean;
    interruptAtChunk?: number;
  };
  let geminiStubOptions: { interruptAtChunk?: number };

  beforeEach(async ({ makeAgent }) => {
    vi.clearAllMocks();

    // Create Fastify app
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    openAiStubOptions = {};
    anthropicStubOptions = {};
    geminiStubOptions = {};

    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiTestClient(openAiStubOptions) as never,
    );
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
      () => createAnthropicTestClient(anthropicStubOptions) as never,
    );
    vi.spyOn(geminiAdapterFactory, "createClient").mockImplementation(
      () => createGeminiTestClient(geminiStubOptions) as never,
    );

    // Create test agent
    testAgent = await makeAgent({ name: "Test Metrics Agent" });

    // Initialize metrics
    metrics.llm.initializeMetrics([]);

    // Default: policies allow everything (matches real behavior when no policies exist)
    mockEvaluatePolicies.mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  describe("OpenAI", () => {
    beforeEach(async () => {
      await app.register(openAiProxyRoutes);

      // Create token pricing for mock model
      await ModelModel.upsert({
        externalId: "openai/gpt-4o",
        provider: "openai",
        modelId: "gpt-4o",
        inputModalities: null,
        outputModalities: null,
        customPricePerMillionInput: "2.50",
        customPricePerMillionOutput: "10.00",
        lastSyncedAt: new Date(),
      });
    });

    test("streaming request increments token and cost metrics", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${testAgent.id}/chat/completions`,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-key",
          "user-agent": "test-client",
        },
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hello!" }],
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify token metrics (input: 12, output: 10 from the streaming test stub)
      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.objectContaining({
            provider: "openai",
            type: "input",
            model: "gpt-4o",
            agent_id: testAgent.id,
            agent_name: testAgent.name,
          }),
          value: 12,
        }),
      );

      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.objectContaining({
            provider: "openai",
            type: "output",
            model: "gpt-4o",
            agent_id: testAgent.id,
            agent_name: testAgent.name,
          }),
          value: 10,
        }),
      );

      // Verify cost metric was called with provider and model
      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.objectContaining({
            provider: "openai",
            model: "gpt-4o",
            agent_id: testAgent.id,
            agent_name: testAgent.name,
          }),
          value: expect.any(Number),
        }),
      );

      // TTFT and tokens/sec histograms may be skipped because the test stub
      // returns data immediately (TTFT = 0, which is invalid).
    });

    test("non-streaming request increments cost metrics", async () => {
      // Token metrics are NOT reported for these non-streaming stubbed requests
      // because the test clients don't use getObservableFetch(). In production,
      // tokens are reported by getObservableFetch() in the HTTP layer.
      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${testAgent.id}/chat/completions`,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-key",
          "user-agent": "test-client",
        },
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hello!" }],
          stream: false,
        },
      });

      expect(response.statusCode).toBe(200);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify cost metric was called
      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.objectContaining({
            provider: "openai",
            model: "gpt-4o",
            agent_id: testAgent.id,
            agent_name: testAgent.name,
          }),
          value: expect.any(Number),
        }),
      );
    });

    test("passthrough virtual key attributes the interaction to its owner", async ({
      makeUser,
    }) => {
      const owner = await makeUser();
      const { value: passthroughToken, virtualKey } =
        await VirtualApiKeyModel.create({
          organizationId: testAgent.organizationId,
          name: "pt-attribution",
          keyType: "passthrough",
          scope: "personal",
          authorId: owner.id,
        });

      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${testAgent.id}/chat/completions`,
        headers: {
          "content-type": "application/json",
          // Raw provider key forwarded upstream; passthrough key attributes the user.
          authorization: "Bearer test-key",
          "x-archestra-virtual-key": passthroughToken,
        },
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hello!" }],
          stream: false,
        },
      });

      expect(response.statusCode).toBe(200);

      const [interaction] = await db
        .select()
        .from(schema.interactionsTable)
        .where(eq(schema.interactionsTable.profileId, testAgent.id));

      expect(interaction.userId).toBe(owner.id);
      expect(interaction.passthroughVirtualKeyId).toBe(virtualKey.id);
      expect(interaction.virtualKeyId).toBeNull();
      expect(interaction.authMethod).toBe("passthrough_virtual_key");
    });

    test("personal standard virtual key attributes the interaction to its owner", async ({
      makeUser,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      // Virtual-key connection mode: the connect flow mints a personal virtual
      // key whose author is the acting user (Codex ChatGPT subscription, Claude
      // Code virtual key). The key is the sole identity signal, so its owner
      // must attribute the request even though no X-Archestra-User-Id header or
      // passthrough key is present.
      const owner = await makeUser();
      const secret = await makeSecret({ secret: { apiKey: "sk-owned-key" } });
      const providerKey = await makeLlmProviderApiKey(
        testAgent.organizationId,
        secret.id,
        { provider: "openai" },
      );
      const { value: virtualKey, virtualKey: virtualKeyRow } =
        await VirtualApiKeyModel.create({
          organizationId: testAgent.organizationId,
          name: "vk-attribution",
          scope: "personal",
          authorId: owner.id,
          providerApiKeys: [
            { provider: "openai", providerApiKeyId: providerKey.id },
          ],
        });

      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${testAgent.id}/chat/completions`,
        // Non-loopback: attribution comes from the virtual key, not a localhost bypass.
        remoteAddress: "203.0.113.5",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${virtualKey}`,
        },
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hello!" }],
          stream: false,
        },
      });

      expect(response.statusCode, response.body).toBe(200);

      const [interaction] = await db
        .select()
        .from(schema.interactionsTable)
        .where(eq(schema.interactionsTable.profileId, testAgent.id));

      expect(interaction.userId).toBe(owner.id);
      expect(interaction.virtualKeyId).toBe(virtualKeyRow.id);
      expect(interaction.authMethod).toBe("virtual_key");
    });

    test.skip("non-streaming request increments token metrics", async () => {
      // SKIPPED: Mock clients don't use getObservableFetch(), so token metrics
      // are not reported in mock mode. To properly test this, we need to either:
      // 1. Mock globalThis.fetch so getObservableFetch wraps it and reports tokens
      // 2. Modify mock clients to accept and call an observable fetch
      // See TODO in llm-proxy-handler.ts handleNonStreaming()
      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${testAgent.id}/chat/completions`,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-key",
          "user-agent": "test-client",
        },
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hello!" }],
          stream: false,
        },
      });

      expect(response.statusCode).toBe(200);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify token metrics (input: 82, output: 17 from the non-streaming test stub)
      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.objectContaining({
            provider: "openai",
            type: "input",
            model: "gpt-4o",
            agent_id: testAgent.id,
            agent_name: testAgent.name,
          }),
          value: 82,
        }),
      );

      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.objectContaining({
            provider: "openai",
            type: "output",
            model: "gpt-4o",
            agent_id: testAgent.id,
            agent_name: testAgent.name,
          }),
          value: 17,
        }),
      );
    });

    test("streaming failure before any usage persists an error interaction", async () => {
      // A provider 400 (e.g. context length exceeded) rejects the stream before
      // any chunk — the failure must still land in the interactions log so it
      // shows up in LLM logs / session history.
      openAiStubOptions.failStreamWithError =
        "This endpoint's maximum context length is 262144 tokens. However, you requested about 285869 tokens";

      await app.inject({
        method: "POST",
        url: `/v1/openai/${testAgent.id}/chat/completions`,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-key",
          "user-agent": "test-client",
        },
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hello!" }],
          stream: true,
        },
      });

      const rows = await db
        .select()
        .from(schema.interactionsTable)
        .where(eq(schema.interactionsTable.profileId, testAgent.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].response).toMatchObject({
        error: expect.stringContaining("maximum context length"),
      });
      expect(rows[0].inputTokens).toBe(0);
      expect(rows[0].outputTokens).toBe(0);
    });

    test("streaming failure after SSE headers and content persists an error interaction", async () => {
      // The provider fails mid-stream: SSE headers and content chunks are already
      // on the wire, but the usage-bearing final chunk never arrives. The
      // finally-block persist is gated on usage, so this must be covered by the
      // catch path or the failure leaves no trace in LLM logs / session history.
      openAiStubOptions.throwAtChunk = 2;

      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${testAgent.id}/chat/completions`,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-key",
          "user-agent": "test-client",
        },
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hello!" }],
          stream: true,
        },
      });

      // Headers were already committed, so the failure surfaces as an SSE error
      // event on a 200 response rather than an HTTP error status.
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("event: error");

      const rows = await db
        .select()
        .from(schema.interactionsTable)
        .where(eq(schema.interactionsTable.profileId, testAgent.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].response).toMatchObject({
        error: expect.stringContaining("Simulated OpenAI stream failure"),
      });
      expect(rows[0].inputTokens).toBe(0);
      expect(rows[0].outputTokens).toBe(0);
    });

    test("stream ending early without usage persists a partial interaction", async () => {
      // The provider closes the stream cleanly mid-way (no throw) before the
      // usage chunk. Nothing raises, so the catch path never runs and the
      // finally-block persist is gated on usage — the call must still be
      // recorded rather than vanishing from interaction history.
      openAiStubOptions.interruptAtChunk = 2;

      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${testAgent.id}/chat/completions`,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-key",
          "user-agent": "test-client",
        },
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hello!" }],
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);

      const rows = await db
        .select()
        .from(schema.interactionsTable)
        .where(eq(schema.interactionsTable.profileId, testAgent.id));
      expect(rows).toHaveLength(1);
    });
  });

  describe("Anthropic", () => {
    beforeEach(async () => {
      await app.register(anthropicProxyRoutes);

      // Create token pricing for mock model
      await ModelModel.upsert({
        externalId: "anthropic/claude-3-5-sonnet-20241022",
        provider: "anthropic",
        modelId: "claude-3-5-sonnet-20241022",
        inputModalities: null,
        outputModalities: null,
        customPricePerMillionInput: "3.00",
        customPricePerMillionOutput: "15.00",
        lastSyncedAt: new Date(),
      });
    });

    test("streaming request increments token and cost metrics", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/v1/anthropic/${testAgent.id}/v1/messages`,
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01",
        },
        payload: {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user", content: "Hello!" }],
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify token metrics (input: 12, output: 10 from the Anthropic test stub)
      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.objectContaining({
            provider: "anthropic",
            type: "input",
            model: "claude-3-5-sonnet-20241022",
            agent_id: testAgent.id,
            agent_name: testAgent.name,
          }),
          value: 12,
        }),
      );

      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.objectContaining({
            provider: "anthropic",
            type: "output",
            model: "claude-3-5-sonnet-20241022",
            agent_id: testAgent.id,
            agent_name: testAgent.name,
          }),
          value: 10,
        }),
      );

      // Verify cost metric was called with provider and model
      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.objectContaining({
            provider: "anthropic",
            model: "claude-3-5-sonnet-20241022",
            agent_id: testAgent.id,
            agent_name: testAgent.name,
          }),
          value: expect.any(Number),
        }),
      );

      // TTFT and tokens/sec histograms may be skipped because the test stub
      // returns data immediately (TTFT = 0, which is invalid).
    });

    test("non-streaming request increments cost metrics", async () => {
      // Token metrics are NOT reported for these non-streaming stubbed requests
      // because the test clients don't use getObservableFetch(). In production,
      // tokens are reported by getObservableFetch() in the HTTP layer.
      const response = await app.inject({
        method: "POST",
        url: `/v1/anthropic/${testAgent.id}/v1/messages`,
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01",
        },
        payload: {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user", content: "Hello!" }],
          stream: false,
        },
      });

      expect(response.statusCode).toBe(200);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify cost metric was called
      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.objectContaining({
            provider: "anthropic",
            model: "claude-3-5-sonnet-20241022",
            agent_id: testAgent.id,
            agent_name: testAgent.name,
          }),
          value: expect.any(Number),
        }),
      );
    });

    test("records a context-variant id as the model it names, and forwards it unchanged", async () => {
      const forwarded: string[] = [];
      vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
        () =>
          ({
            messages: {
              create: async (...args: unknown[]) => {
                const [params] = args as [{ model: string }];
                forwarded.push(params.model);
                return (
                  createAnthropicTestClient(anthropicStubOptions).messages
                    .create as (...a: unknown[]) => unknown
                )(...args);
              },
            },
          }) as never,
      );

      const response = await app.inject({
        method: "POST",
        url: `/v1/anthropic/${testAgent.id}/v1/messages`,
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01",
        },
        payload: {
          // A client asking for the long-context variant of a model that is
          // already priced under its plain id.
          model: "claude-3-5-sonnet-20241022[1m]",
          max_tokens: 1024,
          messages: [{ role: "user", content: "Hello!" }],
        },
      });

      expect(response.statusCode).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The marker names the same model, so usage is attributed to the priced
      // record rather than to a second one no catalog can describe.
      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.objectContaining({
            provider: "anthropic",
            model: "claude-3-5-sonnet-20241022",
          }),
        }),
      );
      await expect(
        ModelModel.findByProviderAndModelId(
          "anthropic",
          "claude-3-5-sonnet-20241022[1m]",
        ),
      ).resolves.toBeNull();

      // The provider still receives the id the client asked for.
      expect(forwarded).toEqual(["claude-3-5-sonnet-20241022[1m]"]);
    });
  });

  describe("Gemini", () => {
    beforeEach(async () => {
      await app.register(geminiProxyRoutes);

      // Create token pricing for mock model
      await ModelModel.upsert({
        externalId: "gemini/gemini-2.5-pro",
        provider: "gemini",
        modelId: "gemini-2.5-pro",
        inputModalities: null,
        outputModalities: null,
        customPricePerMillionInput: "1.25",
        customPricePerMillionOutput: "5.00",
        lastSyncedAt: new Date(),
      });
    });

    test("streaming request increments token and cost metrics", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/v1/gemini/${testAgent.id}/v1beta/models/gemini-2.5-pro:streamGenerateContent`,
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": "test-key",
        },
        payload: {
          contents: [
            {
              role: "user",
              parts: [{ text: "Hello!" }],
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify token metrics (input: 12, output: 10 from the Gemini streaming test stub)
      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.objectContaining({
            provider: "gemini",
            type: "input",
            model: "gemini-2.5-pro",
            agent_id: testAgent.id,
            agent_name: testAgent.name,
          }),
          value: 12,
        }),
      );

      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.objectContaining({
            provider: "gemini",
            type: "output",
            model: "gemini-2.5-pro",
            agent_id: testAgent.id,
            agent_name: testAgent.name,
          }),
          value: 10,
        }),
      );

      // Verify cost metric was called with provider and model
      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.objectContaining({
            provider: "gemini",
            model: "gemini-2.5-pro",
            agent_id: testAgent.id,
            agent_name: testAgent.name,
          }),
          value: expect.any(Number),
        }),
      );

      // TTFT and tokens/sec histograms may be skipped because the test stub
      // returns data immediately (TTFT = 0, which is invalid).
    });

    test("non-streaming request increments cost metrics", async () => {
      // Token metrics are NOT reported for these non-streaming stubbed requests
      // because the test clients don't use getObservableFetch(). In production,
      // tokens are reported by getObservableFetch() in the HTTP layer.
      const response = await app.inject({
        method: "POST",
        url: `/v1/gemini/${testAgent.id}/v1beta/models/gemini-2.5-pro:generateContent`,
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": "test-key",
        },
        payload: {
          contents: [
            {
              role: "user",
              parts: [{ text: "Hello!" }],
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify cost metric was called
      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.objectContaining({
            provider: "gemini",
            model: "gemini-2.5-pro",
            agent_id: testAgent.id,
            agent_name: testAgent.name,
          }),
          value: expect.any(Number),
        }),
      );
    });
  });

  // Bedrock uses a custom SigV4 client instead of getObservableFetch, so unlike
  // fetch-based providers it can't self-instrument llm_request_duration_seconds.
  // The handler records it on Bedrock's behalf; these tests pin that behavior.
  // The duration histogram is the only LLM metric carrying a `status_code`
  // label, which is what distinguishes it from TTFT/tokens-per-second here.
  describe("Bedrock", () => {
    const BEDROCK_MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";

    beforeEach(async () => {
      await app.register(bedrockProxyRoutes);

      vi.spyOn(bedrockAdapterFactory, "createClient").mockReturnValue({
        converse: async () => ({
          $metadata: { requestId: "req_bedrock_test" },
          output: {
            message: { role: "assistant", content: [{ text: "Hi there" }] },
          },
          stopReason: "end_turn",
          usage: { inputTokens: 12, outputTokens: 10 },
        }),
        converseStream: async () =>
          (async function* () {
            yield { messageStart: { role: "assistant" } };
            yield {
              contentBlockDelta: {
                contentBlockIndex: 0,
                delta: { text: "Hi there" },
              },
            };
            yield { contentBlockStop: { contentBlockIndex: 0 } };
            yield { messageStop: { stopReason: "end_turn" } };
            yield {
              metadata: { usage: { inputTokens: 12, outputTokens: 10 } },
            };
          })(),
      } as never);

      await ModelModel.upsert({
        externalId: `bedrock/${BEDROCK_MODEL}`,
        provider: "bedrock",
        modelId: BEDROCK_MODEL,
        inputModalities: null,
        outputModalities: null,
        customPricePerMillionInput: "3.00",
        customPricePerMillionOutput: "15.00",
        lastSyncedAt: new Date(),
      });
    });

    test("streaming request records the request-duration metric", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/v1/bedrock/${testAgent.id}/converse-stream`,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-key",
        },
        payload: {
          modelId: BEDROCK_MODEL,
          messages: [{ role: "user", content: [{ text: "Hello!" }] }],
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(histogramObserve).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.objectContaining({
            provider: "bedrock",
            model: BEDROCK_MODEL,
            agent_id: testAgent.id,
            status_code: "200",
          }),
          value: expect.any(Number),
        }),
      );
    });

    test("non-streaming request records the request-duration metric", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/v1/bedrock/${testAgent.id}/converse`,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-key",
        },
        payload: {
          modelId: BEDROCK_MODEL,
          messages: [{ role: "user", content: [{ text: "Hello!" }] }],
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(histogramObserve).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.objectContaining({
            provider: "bedrock",
            model: BEDROCK_MODEL,
            agent_id: testAgent.id,
            status_code: "200",
          }),
          value: expect.any(Number),
        }),
      );
    });
  });
});

describe("LLM Proxy Handler — recordBlockedToolSpans", () => {
  let app: FastifyInstance;
  let testAgent: Agent;
  let openAiStubOptions: OpenAiStubOptions;
  let anthropicStubOptions: AnthropicStubOptions;

  beforeEach(async ({ makeAgent }) => {
    vi.clearAllMocks();

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    openAiStubOptions = {};
    anthropicStubOptions = {};

    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiTestClient(openAiStubOptions) as never,
    );
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
      () => createAnthropicTestClient(anthropicStubOptions) as never,
    );

    testAgent = await makeAgent({ name: "Blocked Tools Agent" });

    metrics.llm.initializeMetrics([]);

    // Default: policies allow everything
    mockEvaluatePolicies.mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  describe("non-streaming (OpenAI)", () => {
    // The test stub returns a "list_files" tool call for non-streaming requests.
    beforeEach(async () => {
      await app.register(openAiProxyRoutes);

      await ModelModel.upsert({
        externalId: "openai/gpt-4o",
        provider: "openai",
        modelId: "gpt-4o",
        inputModalities: null,
        outputModalities: null,
        customPricePerMillionInput: "2.50",
        customPricePerMillionOutput: "10.00",
        lastSyncedAt: new Date(),
      });
    });

    // Same refusal condition as the Anthropic streaming case, on the other axis
    // of the matrix: OpenAI forces `stop` through the same replaced-response
    // path, so the turn reads as finished while a tool_call is on the wire.
    test("a refusal after streamed tool calls closes the turn as stop", async () => {
      openAiStubOptions.includeToolCalls = true;

      mockEvaluatePolicies.mockResolvedValue({
        refusalMessage: "Tool get_weather is not enabled here",
        contentMessage: "Tool get_weather is not enabled here",
        reason: "Tool invocation blocked: disabled for conversation",
        blockedToolName: "get_weather",
        toolInput: {},
        allToolCallNames: ["get_weather"],
      } satisfies PolicyBlockResult);

      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${testAgent.id}/chat/completions`,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-key",
        },
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "What's the weather?" }],
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("call_test_weather");
      expect(response.body).toContain("Tool get_weather is not enabled here");
      // Upstream closed as tool_calls; the refusal overrides it.
      expect(response.body).toContain('"finish_reason":"stop"');
      expect(response.body).not.toContain('"finish_reason":"tool_calls"');
    });

    // Buffered turns can still be edited when the refusal lands, and the whole
    // message is replaced: the model's text and every tool call go with it.
    test("a refusal replaces the entire buffered message", async () => {
      mockEvaluatePolicies.mockResolvedValue({
        refusalMessage: "Tool list_files is not enabled here",
        contentMessage: "Tool list_files is not enabled here",
        reason: "Tool invocation blocked: disabled for conversation",
        blockedToolName: "list_files",
        toolInput: {},
        allToolCallNames: ["list_files"],
      } satisfies PolicyBlockResult);

      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${testAgent.id}/chat/completions`,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-key",
        },
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "List the files" }],
        },
      });

      expect(response.statusCode).toBe(200);
      const choice = response.json().choices[0];
      expect(choice.message.content).toBe(
        "Tool list_files is not enabled here",
      );
      expect(choice.message.tool_calls).toBeUndefined();
      expect(choice.finish_reason).toBe("stop");
    });

    test("calls recordBlockedToolSpans when policy blocks tool calls", async () => {
      const blockResult: PolicyBlockResult = {
        refusalMessage: "Tool blocked by policy",
        contentMessage: "Tool list_files was blocked",
        reason: "Tool invocation blocked: policy is configured to always block",
        blockedToolName: "list_files",
        toolInput: {},
        allToolCallNames: ["list_files"],
      };
      mockEvaluatePolicies.mockResolvedValue(blockResult);

      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${testAgent.id}/chat/completions`,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-key",
          "user-agent": "test-client",
        },
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "List files" }],
          stream: false,
        },
      });

      expect(response.statusCode).toBe(200);

      expect(mockRecordBlockedToolSpans).toHaveBeenCalledOnce();
      expect(mockRecordBlockedToolSpans).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCallNames: ["list_files"],
          blockedReason:
            "Tool invocation blocked: policy is configured to always block",
          agent: expect.objectContaining({
            id: testAgent.id,
            name: testAgent.name,
          }),
        }),
      );
    });

    test("does not call recordBlockedToolSpans when policy allows tool calls", async () => {
      mockEvaluatePolicies.mockResolvedValue(null);

      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${testAgent.id}/chat/completions`,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-key",
          "user-agent": "test-client",
        },
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "List files" }],
          stream: false,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockRecordBlockedToolSpans).not.toHaveBeenCalled();
    });

    test("passes agentType to recordBlockedToolSpans", async () => {
      const blockResult: PolicyBlockResult = {
        refusalMessage: "Tool blocked",
        contentMessage: "Tool list_files was blocked",
        reason: "blocked by policy",
        blockedToolName: "list_files",
        toolInput: {},
        allToolCallNames: ["list_files"],
      };
      mockEvaluatePolicies.mockResolvedValue(blockResult);

      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${testAgent.id}/chat/completions`,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-key",
          "user-agent": "test-client",
        },
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "List files" }],
          stream: false,
        },
      });

      expect(response.statusCode).toBe(200);

      expect(mockRecordBlockedToolSpans).toHaveBeenCalledOnce();
      const callArg = mockRecordBlockedToolSpans.mock.calls[0][0];
      expect(callArg.agentType).toBeDefined();
    });
  });

  describe("streaming (Anthropic)", () => {
    // The test stub can emit a "get_weather" tool_use block when enabled.
    beforeEach(async () => {
      await app.register(anthropicProxyRoutes);

      await ModelModel.upsert({
        externalId: "anthropic/claude-3-5-sonnet-20241022",
        provider: "anthropic",
        modelId: "claude-3-5-sonnet-20241022",
        inputModalities: null,
        outputModalities: null,
        customPricePerMillionInput: "3.00",
        customPricePerMillionOutput: "15.00",
        lastSyncedAt: new Date(),
      });
    });

    // Billed spend is derived by filtering on billing_mode, so the value the
    // handler stamps on the interaction decides whether a call is charged.
    // It is classified from the credential format alone.
    test.for([
      ["sk-ant-oat-token", "subscription"],
      ["sk-ant-api-token", "metered"],
    ])("a %s credential persists billing_mode %s", async ([key, expected]) => {
      mockEvaluatePolicies.mockResolvedValue(null);

      await app.inject({
        method: "POST",
        url: `/v1/anthropic/${testAgent.id}/v1/messages`,
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        payload: {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user", content: "Hello" }],
        },
      });

      const interactions = await InteractionModel.getAllInteractionsForProfile(
        testAgent.id,
      );
      expect(interactions).toHaveLength(1);
      expect(interactions[0].billingMode).toBe(expected);
    });

    // The buffered counterpart on the incident's own provider: the assistant
    // message is discarded down to the refusal text, taking the model's prose
    // and the tool call with it.
    test("a refusal replaces the entire buffered message", async () => {
      anthropicStubOptions.includeToolUseNonStreaming = true;

      mockEvaluatePolicies.mockResolvedValue({
        refusalMessage: "Tool get_weather is not enabled here",
        contentMessage: "Tool get_weather is not enabled here",
        reason: "Tool invocation blocked: disabled for conversation",
        blockedToolName: "get_weather",
        toolInput: {},
        allToolCallNames: ["get_weather"],
      } satisfies PolicyBlockResult);

      const response = await app.inject({
        method: "POST",
        url: `/v1/anthropic/${testAgent.id}/v1/messages`,
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01",
        },
        payload: {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user", content: "What's the weather?" }],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.content).toEqual([
        {
          type: "text",
          text: "Tool get_weather is not enabled here",
          citations: null,
        },
      ]);
      expect(body.stop_reason).toBe("end_turn");
    });

    // The set the handler hands to evaluatePolicies decides which model tool
    // calls count as available. It is built from getTools(), which drops
    // provider built-ins, so a caller that declares `bash` alongside a custom
    // tool has `bash` judged unavailable.
    test("the availability set passed to evaluatePolicies omits declared built-ins", async () => {
      anthropicStubOptions.includeToolUse = true;
      mockEvaluatePolicies.mockResolvedValue(null);

      await app.inject({
        method: "POST",
        url: `/v1/anthropic/${testAgent.id}/v1/messages`,
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01",
        },
        payload: {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user", content: "What's the weather?" }],
          stream: true,
          tools: [
            {
              name: "get_weather",
              description: "weather",
              input_schema: { type: "object", properties: {} },
            },
            { type: "bash_20250124", name: "bash" },
          ],
        },
      });

      expect(mockEvaluatePolicies).toHaveBeenCalled();
      const enabledToolNames = mockEvaluatePolicies.mock
        .calls[0][4] as Set<string>;
      expect([...enabledToolNames]).toEqual(["get_weather"]);
    });

    // The shape the client actually receives when a refusal lands after tool
    // calls have already been written to the wire. Every assertion here is the
    // current behavior, including the parts that make the turn unanswerable:
    // the tool_use survives with no way to resolve it, and the turn is closed
    // as finished even though a tool_result is still owed.
    test("a refusal after streamed tool calls leaves the tool_use on the wire and closes the turn", async () => {
      anthropicStubOptions.includeToolUse = true;
      anthropicStubOptions.streamStopReason = "tool_use";

      mockEvaluatePolicies.mockResolvedValue({
        refusalMessage: "Tool get_weather is not enabled here",
        contentMessage: "Tool get_weather is not enabled here",
        reason: "Tool invocation blocked: disabled for conversation",
        blockedToolName: "get_weather",
        toolInput: {},
        allToolCallNames: ["get_weather"],
      } satisfies PolicyBlockResult);

      const response = await app.inject({
        method: "POST",
        url: `/v1/anthropic/${testAgent.id}/v1/messages`,
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01",
        },
        payload: {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user", content: "What's the weather?" }],
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("toolu_test_weather");
      expect(response.body).toContain("Tool get_weather is not enabled here");
      // Upstream said tool_use; the refusal overrides it.
      expect(response.body).toContain('"stop_reason":"end_turn"');
      expect(response.body).not.toContain('"stop_reason":"tool_use"');
    });

    test("calls recordBlockedToolSpans when streaming response contains blocked tool calls", async () => {
      anthropicStubOptions.includeToolUse = true;

      const blockResult: PolicyBlockResult = {
        refusalMessage: "Tool blocked by policy",
        contentMessage: "Tool get_weather was blocked",
        reason: "Tool invocation blocked: always block",
        blockedToolName: "get_weather",
        toolInput: {},
        allToolCallNames: ["get_weather"],
      };
      mockEvaluatePolicies.mockResolvedValue(blockResult);

      const response = await app.inject({
        method: "POST",
        url: `/v1/anthropic/${testAgent.id}/v1/messages`,
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01",
        },
        payload: {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user", content: "What's the weather?" }],
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockRecordBlockedToolSpans).toHaveBeenCalledOnce();
      expect(mockRecordBlockedToolSpans).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCallNames: ["get_weather"],
          blockedReason: "Tool invocation blocked: always block",
          agent: expect.objectContaining({
            id: testAgent.id,
            name: testAgent.name,
          }),
        }),
      );
    });

    test("does not call recordBlockedToolSpans when streaming has no tool calls", async () => {
      anthropicStubOptions.includeToolUse = false;
      mockEvaluatePolicies.mockResolvedValue(null);

      const response = await app.inject({
        method: "POST",
        url: `/v1/anthropic/${testAgent.id}/v1/messages`,
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01",
        },
        payload: {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user", content: "Hello!" }],
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockRecordBlockedToolSpans).not.toHaveBeenCalled();
    });

    test("does not call recordBlockedToolSpans when streaming tool calls are allowed", async () => {
      anthropicStubOptions.includeToolUse = true;
      mockEvaluatePolicies.mockResolvedValue(null);

      const response = await app.inject({
        method: "POST",
        url: `/v1/anthropic/${testAgent.id}/v1/messages`,
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01",
        },
        payload: {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user", content: "What's the weather?" }],
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockRecordBlockedToolSpans).not.toHaveBeenCalled();
    });
  });
});

describe("LLM Proxy Handler — CHAT_API_KEY_ID_HEADER fallback", () => {
  let app: FastifyInstance;
  let testAgent: Agent;
  const createClientSpy = vi.fn();

  beforeEach(async ({ makeAgent }) => {
    vi.clearAllMocks();
    createClientSpy.mockReset();

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ApiError) {
        return reply
          .status(error.statusCode)
          .send({ error: { message: error.message, type: error.type } });
      }
      return reply.status(500).send({
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "api_internal_server_error",
        },
      });
    });

    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      (apiKey, options) => {
        createClientSpy(apiKey, options);
        return createOpenAiTestClient({}) as never;
      },
    );
    // The cache-backed rate limiter isn't started under PGLite tests; stub it
    // so the virtual-key validation path exercises auth, not cache I/O.
    vi.spyOn(virtualKeyRateLimiter, "check").mockResolvedValue(undefined);
    vi.spyOn(virtualKeyRateLimiter, "recordFailure").mockResolvedValue(
      undefined,
    );

    testAgent = await makeAgent({ name: "Test Extra Headers Agent" });
    metrics.llm.initializeMetrics([]);
    mockEvaluatePolicies.mockResolvedValue(null);

    await app.register(openAiProxyRoutes);
    await ModelModel.upsert({
      externalId: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "2.50",
      customPricePerMillionOutput: "10.00",
      lastSyncedAt: new Date(),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("loopback request with header forwards per-key extraHeaders to upstream", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const apiKey = await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: null,
      name: "Test key with extra headers",
      provider: "openai",
      scope: "org",
      userId: null,
      teamId: null,
      extraHeaders: { "X-Custom-Auth": "abc" },
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${testAgent.id}/chat/completions`,
      remoteAddress: "127.0.0.1",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        [CHAT_API_KEY_ID_HEADER]: apiKey.id,
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(createClientSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        defaultHeaders: expect.objectContaining({ "X-Custom-Auth": "abc" }),
      }),
    );
  });

  test("non-loopback request ignores header (extraHeaders not applied)", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const apiKey = await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: null,
      name: "Test key with extra headers",
      provider: "openai",
      scope: "org",
      userId: null,
      teamId: null,
      extraHeaders: { "X-Custom-Auth": "abc" },
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${testAgent.id}/chat/completions`,
      remoteAddress: "203.0.113.5",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        [CHAT_API_KEY_ID_HEADER]: apiKey.id,
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(createClientSpy).toHaveBeenCalled();
    const [, options] = createClientSpy.mock.calls[0];
    expect(options.defaultHeaders).toBeUndefined();
  });

  test("loopback request with keyless Azure provider key ignores extracted auth and uses inference URL", async ({
    makeOrganization,
  }) => {
    vi.spyOn(azureAdapterFactory, "createClient").mockImplementation(
      (apiKey, options) => {
        createClientSpy(apiKey, options);
        return {
          apiKey,
          baseUrl: options.baseUrl,
          openai: createOpenAiTestClient({}),
        } as never;
      },
    );

    await app.register(azureProxyRoutes);

    await ModelModel.upsert({
      externalId: "azure/gpt-4o",
      provider: "azure",
      modelId: "gpt-4o",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "2.50",
      customPricePerMillionOutput: "10.00",
      lastSyncedAt: new Date(),
    });

    const org = await makeOrganization();
    const apiKey = await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: null,
      name: "Keyless Azure split endpoint",
      provider: "azure",
      scope: "org",
      userId: null,
      teamId: null,
      baseUrl: "https://discovery.example.com/openai",
      inferenceBaseUrl: "https://runtime.example.com/openai/v1",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/azure/${testAgent.id}/chat/completions`,
      remoteAddress: "127.0.0.1",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer synthetic-internal-key",
        [CHAT_API_KEY_ID_HEADER]: apiKey.id,
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(createClientSpy).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        baseUrl: "https://runtime.example.com/openai/v1",
      }),
    );
  });

  test("loopback chat forward of a non-local arch_ secret forwards it to the provider base URL", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const apiKey = await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: null,
      name: "Downstream Archestra proxy key",
      provider: "openai",
      scope: "org",
      userId: null,
      teamId: null,
    });
    const foreignVirtualKey = `arch_${"f".repeat(64)}`;

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${testAgent.id}/chat/completions`,
      remoteAddress: "127.0.0.1",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${foreignVirtualKey}`,
        [CHAT_API_KEY_ID_HEADER]: apiKey.id,
        [PROVIDER_BASE_URL_HEADER]: "https://downstream.example.com/v1/openai",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(createClientSpy).toHaveBeenCalledWith(
      foreignVirtualKey,
      expect.objectContaining({
        baseUrl: "https://downstream.example.com/v1/openai",
      }),
    );
  });

  test("non-loopback request with a non-local arch_ secret is still rejected with 401", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const apiKey = await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: null,
      name: "Downstream Archestra proxy key",
      provider: "openai",
      scope: "org",
      userId: null,
      teamId: null,
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${testAgent.id}/chat/completions`,
      remoteAddress: "203.0.113.5",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer arch_${"f".repeat(64)}`,
        [CHAT_API_KEY_ID_HEADER]: apiKey.id,
        [PROVIDER_BASE_URL_HEADER]: "https://downstream.example.com/v1/openai",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(createClientSpy).not.toHaveBeenCalled();
  });

  test("loopback chat forward of a non-local arch_ secret WITHOUT a provider base URL is still rejected with 401", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const apiKey = await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: null,
      name: "Downstream Archestra proxy key",
      provider: "openai",
      scope: "org",
      userId: null,
      teamId: null,
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${testAgent.id}/chat/completions`,
      remoteAddress: "127.0.0.1",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer arch_${"f".repeat(64)}`,
        [CHAT_API_KEY_ID_HEADER]: apiKey.id,
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(createClientSpy).not.toHaveBeenCalled();
  });

  test("loopback chat forward of a VALID local virtual key still resolves it locally", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-resolved-real" } });
    const providerKey = await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: secret.id,
      name: "Local OpenAI key behind a virtual key",
      provider: "openai",
      scope: "org",
      userId: null,
      teamId: null,
    });
    const { value: localVirtualKey } = await VirtualApiKeyModel.create({
      name: "local-vk",
      providerApiKeys: [
        { provider: "openai", providerApiKeyId: providerKey.id },
      ],
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${testAgent.id}/chat/completions`,
      remoteAddress: "127.0.0.1",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${localVirtualKey}`,
        [CHAT_API_KEY_ID_HEADER]: providerKey.id,
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    // Resolved to the real provider secret, NOT forwarded as the arch_ token.
    expect(createClientSpy).toHaveBeenCalledWith(
      "sk-resolved-real",
      expect.any(Object),
    );
  });
});

describe("LLM Proxy Handler — per-user provider connect required", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ApiError) {
        return reply
          .status(error.statusCode)
          .send({ error: { message: error.message, type: error.type } });
      }
      return reply.status(500).send({
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "api_internal_server_error",
        },
      });
    });

    vi.spyOn(virtualKeyRateLimiter, "check").mockResolvedValue(undefined);
    vi.spyOn(virtualKeyRateLimiter, "recordFailure").mockResolvedValue(
      undefined,
    );
    metrics.llm.initializeMetrics([]);
    mockEvaluatePolicies.mockResolvedValue(null);

    await app.register(githubCopilotProxyRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("returns an actionable provider_auth_required 401 when the acting user's Copilot credential is missing", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({
      name: "Copilot Proxy Agent",
      organizationId: org.id,
    });

    // Personal Copilot key whose secret is gone (revoked / orphaned): the
    // virtual key authenticates but resolves no usable upstream token.
    const copilotKey = await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: null,
      name: "Copilot (orphaned secret)",
      provider: "github-copilot",
      scope: "personal",
      userId: user.id,
      teamId: null,
    });

    const { value: virtualKey } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "my-copilot-vk",
      scope: "personal",
      authorId: user.id,
      providerApiKeys: [
        { provider: "github-copilot", providerApiKeyId: copilotKey.id },
      ],
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/github-copilot/${agent.id}/chat/completions`,
      remoteAddress: "203.0.113.5",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${virtualKey}`,
      },
      payload: {
        model: "gpt-4",
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      },
    });

    expect(response.statusCode, response.body).toBe(401);
    const body = response.json();
    expect(body.error.type).toBe("api_authentication_error");
    expect(body.error.internal_code).toBe("provider_auth_required");
    expect(body.error.message).toContain("GitHub Copilot");
    expect(body.error.message).toContain("/settings");
  });
});

describe("LLM Proxy Handler — team-restricted models", () => {
  let app: FastifyInstance;
  let testAgent: Agent;

  beforeEach(async ({ makeAgent }) => {
    vi.clearAllMocks();

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiTestClient({}) as never,
    );
    vi.spyOn(virtualKeyRateLimiter, "check").mockResolvedValue(undefined);
    vi.spyOn(virtualKeyRateLimiter, "recordFailure").mockResolvedValue(
      undefined,
    );

    testAgent = await makeAgent({ name: "Test Restricted Models Agent" });
    metrics.llm.initializeMetrics([]);
    mockEvaluatePolicies.mockResolvedValue(null);

    await app.register(openAiProxyRoutes);
    await ModelModel.upsert({
      externalId: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "2.50",
      customPricePerMillionOutput: "10.00",
      lastSyncedAt: new Date(),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  async function injectChatCompletionAs(passthroughToken: string) {
    return await app.inject({
      method: "POST",
      url: `/v1/openai/${testAgent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "x-archestra-virtual-key": passthroughToken,
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      },
    });
  }

  test("blocks a restricted model for users outside its teams and allows team members", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const model = await ModelModel.findByProviderAndModelId("openai", "gpt-4o");
    if (!model) throw new Error("expected gpt-4o model row");

    const insider = await makeUser();
    await makeMember(insider.id, testAgent.organizationId);
    const outsider = await makeUser();
    await makeMember(outsider.id, testAgent.organizationId);

    const devTeam = await makeTeam(testAgent.organizationId, insider.id);
    await makeTeamMember(devTeam.id, insider.id);
    await ModelTeamModel.syncModelTeams(model.id, [devTeam.id]);

    const { value: outsiderToken } = await VirtualApiKeyModel.create({
      organizationId: testAgent.organizationId,
      name: "outsider-pt",
      keyType: "passthrough",
      scope: "personal",
      authorId: outsider.id,
    });
    const blocked = await injectChatCompletionAs(outsiderToken);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toMatchObject({
      type: "api_authorization_error",
      internal_code: "model_restricted_to_teams",
    });

    const { value: insiderToken } = await VirtualApiKeyModel.create({
      organizationId: testAgent.organizationId,
      name: "insider-pt",
      keyType: "passthrough",
      scope: "personal",
      authorId: insider.id,
    });
    const allowed = await injectChatCompletionAs(insiderToken);
    expect(allowed.statusCode).toBe(200);
  });
});
