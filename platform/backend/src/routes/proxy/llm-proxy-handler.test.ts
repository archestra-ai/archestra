/**
 * LLM Proxy Handler Tests
 *
 * Tests that verify:
 * 1. Prometheus metrics are correctly incremented for all LLM providers
 * 2. recordBlockedToolSpans is called when tool invocation policies block tool calls
 */

import { CHAT_API_KEY_ID_HEADER } from "@shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import type { PolicyBlockResult } from "@/guardrails/tool-invocation";
import { LlmProviderApiKeyModel, ModelModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  createAnthropicTestClient,
  createGeminiTestClient,
  createOpenAiTestClient,
} from "@/test/llm-provider-stubs";
import type { Agent } from "@/types";

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
// Defaults: evaluatePolicies → null (allow), getGlobalToolPolicy → "permissive".
// These defaults match the real behavior when no policies exist in the DB.
const mockEvaluatePolicies = vi.fn<() => Promise<PolicyBlockResult | null>>();
const mockGetGlobalToolPolicy = vi.fn<() => Promise<string>>();

vi.mock("@/guardrails/tool-invocation", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/guardrails/tool-invocation")>();
  return {
    ...original,
    evaluatePolicies: (..._args: unknown[]) => mockEvaluatePolicies(),
    getGlobalToolPolicy: (..._args: unknown[]) => mockGetGlobalToolPolicy(),
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

// Import after mocks to ensure mocks are applied
import { metrics } from "@/observability";
import {
  anthropicAdapterFactory,
  geminiAdapterFactory,
  openaiAdapterFactory,
} from "./adapters";
import anthropicProxyRoutes from "./routes/anthropic";
import geminiProxyRoutes from "./routes/gemini";
import openAiProxyRoutes from "./routes/openai";

describe("LLM Proxy Handler Prometheus Metrics", () => {
  let app: FastifyInstance;
  let testAgent: Agent;
  let openAiStubOptions: { interruptAtChunk?: number };
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
    mockGetGlobalToolPolicy.mockResolvedValue("permissive");
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
});

describe("LLM Proxy Handler — recordBlockedToolSpans", () => {
  let app: FastifyInstance;
  let testAgent: Agent;
  let openAiStubOptions: { interruptAtChunk?: number };
  let anthropicStubOptions: {
    includeToolUse?: boolean;
    interruptAtChunk?: number;
  };

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
    mockGetGlobalToolPolicy.mockResolvedValue("permissive");
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

    test("calls recordBlockedToolSpans when policy blocks tool calls", async () => {
      const blockResult: PolicyBlockResult = {
        refusalMessage: "Tool blocked by policy",
        contentMessage: "Tool list_files was blocked",
        reason: "Tool invocation blocked: policy is configured to always block",
        blockedToolName: "list_files",
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

    test("calls recordBlockedToolSpans when streaming response contains blocked tool calls", async () => {
      anthropicStubOptions.includeToolUse = true;

      const blockResult: PolicyBlockResult = {
        refusalMessage: "Tool blocked by policy",
        contentMessage: "Tool get_weather was blocked",
        reason: "Tool invocation blocked: always block",
        blockedToolName: "get_weather",
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

    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      (apiKey, options) => {
        createClientSpy(apiKey, options);
        return createOpenAiTestClient({}) as never;
      },
    );

    testAgent = await makeAgent({ name: "Test Extra Headers Agent" });
    metrics.llm.initializeMetrics([]);
    mockEvaluatePolicies.mockResolvedValue(null);
    mockGetGlobalToolPolicy.mockResolvedValue("permissive");

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

    expect(response.statusCode).toBe(200);
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

    expect(response.statusCode).toBe(200);
    expect(createClientSpy).toHaveBeenCalled();
    const [, options] = createClientSpy.mock.calls[0];
    expect(options.defaultHeaders).toBeUndefined();
  });
});
