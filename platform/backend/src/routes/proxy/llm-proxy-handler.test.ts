/**
 * LLM Proxy Handler V2 Prometheus Metrics Tests
 *
 * Tests that verify Prometheus metrics are correctly incremented
 * for all LLM providers (OpenAI, Anthropic, Gemini) in both
 * streaming and non-streaming modes.
 */

import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import config from "@/config";
import { TokenPriceModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
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

// Import after mock to ensure mock is applied
import { metrics } from "@/observability";
import anthropicProxyRoutesV2 from "./routesv2/anthropic";
import geminiProxyRoutesV2 from "./routesv2/gemini";
import openAiProxyRoutesV2 from "./routesv2/openai";

describe("LLM Proxy Handler V2 Prometheus Metrics", () => {
  let app: FastifyInstance;
  let testAgent: Agent;

  beforeEach(async ({ makeAgent }) => {
    vi.clearAllMocks();

    // Create Fastify app
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    // Enable mock mode
    config.benchmark.mockMode = true;

    // Create test agent
    testAgent = await makeAgent({ name: "Test Metrics Agent" });

    // Initialize metrics
    metrics.llm.initializeMetrics([]);
  });

  afterEach(async () => {
    config.benchmark.mockMode = false;
    await app.close();
  });

  describe("OpenAI", () => {
    beforeEach(async () => {
      await app.register(openAiProxyRoutesV2);

      // Create token pricing for mock model
      await TokenPriceModel.create({
        provider: "openai",
        model: "gpt-4o",
        pricePerMillionInput: "2.50",
        pricePerMillionOutput: "10.00",
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

      // Verify token metrics (input: 12, output: 10 from MockOpenAIClient)
      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "openai",
          type: "input",
          model: "gpt-4o",
          profile_id: testAgent.id,
          profile_name: testAgent.name,
        }),
        12,
      );

      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "openai",
          type: "output",
          model: "gpt-4o",
          profile_id: testAgent.id,
          profile_name: testAgent.name,
        }),
        10,
      );

      // Verify cost metric was called with provider and model
      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "openai",
          model: "gpt-4o",
          profile_id: testAgent.id,
          profile_name: testAgent.name,
        }),
        expect.any(Number),
      );

      // Note: TTFT and tokens/sec histograms may be skipped in mock mode
      // because the mock returns data instantly (TTFT = 0, which is invalid)
    });

    test("non-streaming request increments cost metrics", async () => {
      // Note: In mock mode, token metrics are NOT reported for non-streaming requests
      // because mock clients don't use getObservableFetch(). In production, tokens
      // are reported by getObservableFetch() in the HTTP layer.
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
          provider: "openai",
          model: "gpt-4o",
          profile_id: testAgent.id,
          profile_name: testAgent.name,
        }),
        expect.any(Number),
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

      // Verify token metrics (input: 82, output: 17 from MockOpenAIClient non-streaming)
      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "openai",
          type: "input",
          model: "gpt-4o",
          profile_id: testAgent.id,
          profile_name: testAgent.name,
        }),
        82,
      );

      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "openai",
          type: "output",
          model: "gpt-4o",
          profile_id: testAgent.id,
          profile_name: testAgent.name,
        }),
        17,
      );
    });
  });

  describe("Anthropic", () => {
    beforeEach(async () => {
      await app.register(anthropicProxyRoutesV2);

      // Create token pricing for mock model
      await TokenPriceModel.create({
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        pricePerMillionInput: "3.00",
        pricePerMillionOutput: "15.00",
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

      // Verify token metrics (input: 12, output: 10 from MockAnthropicClient)
      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "anthropic",
          type: "input",
          model: "claude-3-5-sonnet-20241022",
          profile_id: testAgent.id,
          profile_name: testAgent.name,
        }),
        12,
      );

      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "anthropic",
          type: "output",
          model: "claude-3-5-sonnet-20241022",
          profile_id: testAgent.id,
          profile_name: testAgent.name,
        }),
        10,
      );

      // Verify cost metric was called with provider and model
      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "anthropic",
          model: "claude-3-5-sonnet-20241022",
          profile_id: testAgent.id,
          profile_name: testAgent.name,
        }),
        expect.any(Number),
      );

      // Note: TTFT and tokens/sec histograms may be skipped in mock mode
      // because the mock returns data instantly (TTFT = 0, which is invalid)
    });

    test("non-streaming request increments cost metrics", async () => {
      // Note: In mock mode, token metrics are NOT reported for non-streaming requests
      // because mock clients don't use getObservableFetch(). In production, tokens
      // are reported by getObservableFetch() in the HTTP layer.
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
          provider: "anthropic",
          model: "claude-3-5-sonnet-20241022",
          profile_id: testAgent.id,
          profile_name: testAgent.name,
        }),
        expect.any(Number),
      );
    });
  });

  describe("Gemini", () => {
    beforeEach(async () => {
      await app.register(geminiProxyRoutesV2);

      // Create token pricing for mock model
      await TokenPriceModel.create({
        provider: "gemini",
        model: "gemini-2.5-pro",
        pricePerMillionInput: "1.25",
        pricePerMillionOutput: "5.00",
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

      // Verify token metrics (input: 12, output: 10 from MockGeminiClient streaming)
      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "gemini",
          type: "input",
          model: "gemini-2.5-pro",
          profile_id: testAgent.id,
          profile_name: testAgent.name,
        }),
        12,
      );

      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "gemini",
          type: "output",
          model: "gemini-2.5-pro",
          profile_id: testAgent.id,
          profile_name: testAgent.name,
        }),
        10,
      );

      // Verify cost metric was called with provider and model
      expect(counterInc).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "gemini",
          model: "gemini-2.5-pro",
          profile_id: testAgent.id,
          profile_name: testAgent.name,
        }),
        expect.any(Number),
      );

      // Note: TTFT and tokens/sec histograms may be skipped in mock mode
      // because the mock returns data instantly (TTFT = 0, which is invalid)
    });

    test("non-streaming request increments cost metrics", async () => {
      // Note: In mock mode, token metrics are NOT reported for non-streaming requests
      // because mock clients don't use getObservableFetch(). In production, tokens
      // are reported by getObservableFetch() in the HTTP layer.
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
          provider: "gemini",
          model: "gemini-2.5-pro",
          profile_id: testAgent.id,
          profile_name: testAgent.name,
        }),
        expect.any(Number),
      );
    });
  });
});
