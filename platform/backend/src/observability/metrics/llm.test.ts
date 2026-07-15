import type { GoogleGenAI } from "@google/genai";
import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";

const histogramObserve = vi.fn();
const counterInc = vi.fn();
const registerRemoveSingleMetric = vi.fn();

vi.mock("prom-client", () => {
  return {
    default: {
      Histogram: class {
        observe(...args: unknown[]) {
          return histogramObserve(...args);
        }
      },
      Counter: class {
        inc(...args: unknown[]) {
          return counterInc(...args);
        }
      },
      register: {
        removeSingleMetric: (...args: unknown[]) =>
          registerRemoveSingleMetric(...args),
      },
    },
  };
});

import {
  getObservableFetch,
  getObservableGenAI,
  initializeMetrics,
  reportBlockedTools,
  reportLLMCacheCost,
  reportLLMCost,
  reportLLMTokens,
  reportRequestDuration,
  reportTimeToFirstToken,
  reportTokensPerSecond,
} from "./llm";

describe("getObservableFetch", () => {
  let testAgent: Agent;

  beforeEach(async ({ makeAgent }) => {
    vi.clearAllMocks();
    testAgent = await makeAgent();
    // Initialize metrics so the observable fetch can record metrics
    initializeMetrics([]);
  });

  test("records duration and tokens on successful request", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      clone: () => ({
        json: async () => ({
          usage: { prompt_tokens: 100, completion_tokens: 50 },
          model: "gpt-4",
        }),
      }),
    } as Response;

    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const observableFetch = getObservableFetch("openai", testAgent, "api");

    await observableFetch("https://api.openai.com/v1/chat", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4" }),
    });

    expect(histogramObserve).toHaveBeenCalledWith({
      labels: {
        provider: "openai",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "gpt-4",
        status_code: "200",
      },
      value: expect.any(Number),
      exemplarLabels: expect.any(Object),
    });

    expect(counterInc).toHaveBeenCalledWith({
      labels: {
        provider: "openai",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "gpt-4",
        type: "input",
      },
      value: 100,
      exemplarLabels: expect.any(Object),
    });

    expect(counterInc).toHaveBeenCalledWith({
      labels: {
        provider: "openai",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "gpt-4",
        type: "output",
      },
      value: 50,
      exemplarLabels: expect.any(Object),
    });
  });

  test("records cache tokens on a non-streaming response with cached prompt", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      clone: () => ({
        json: async () => ({
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            prompt_tokens_details: { cached_tokens: 30 },
          },
          model: "gpt-4",
        }),
      }),
    } as Response;

    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const observableFetch = getObservableFetch("openai", testAgent, "api");
    await observableFetch("https://api.openai.com/v1/chat", { method: "POST" });

    // cached_tokens (30) is a subset of prompt_tokens, so uncached input = 70
    // and the cache counter records the 30 reads with cache_type=read.
    expect(counterInc).toHaveBeenCalledWith({
      labels: {
        provider: "openai",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "gpt-4",
        type: "input",
      },
      value: 70,
      exemplarLabels: expect.any(Object),
    });
    expect(counterInc).toHaveBeenCalledWith({
      labels: {
        provider: "openai",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "gpt-4",
        cache_type: "read",
      },
      value: 30,
      exemplarLabels: expect.any(Object),
    });
  });

  test("records duration with 4xx status code", async () => {
    const mockResponse = {
      ok: false,
      status: 400,
      headers: new Headers(),
    } as Response;

    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const observableFetch = getObservableFetch("anthropic", testAgent, "api");

    await observableFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
    });

    expect(histogramObserve).toHaveBeenCalledWith({
      labels: {
        provider: "anthropic",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "unknown",
        status_code: "400",
      },
      value: expect.any(Number),
      exemplarLabels: expect.any(Object),
    });
  });

  test("records duration with 5xx status code", async () => {
    const mockResponse = {
      ok: false,
      status: 503,
      headers: new Headers(),
    } as Response;

    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const observableFetch = getObservableFetch("openai", testAgent, "api");

    await observableFetch("https://api.openai.com/v1/chat", {
      method: "POST",
    });

    expect(histogramObserve).toHaveBeenCalledWith({
      labels: {
        provider: "openai",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "unknown",
        status_code: "503",
      },
      value: expect.any(Number),
      exemplarLabels: expect.any(Object),
    });
  });

  test("records duration with status_code 0 on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const observableFetch = getObservableFetch("openai", testAgent, "api");

    await expect(
      observableFetch("https://api.openai.com/v1/chat", { method: "POST" }),
    ).rejects.toThrow("Network error");

    expect(histogramObserve).toHaveBeenCalledWith({
      labels: {
        provider: "openai",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "unknown",
        status_code: "0",
      },
      value: expect.any(Number),
      exemplarLabels: expect.any(Object),
    });
  });

  test("records tokens for Anthropic response format", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      clone: () => ({
        json: async () => ({
          usage: { input_tokens: 200, output_tokens: 75 },
        }),
      }),
    } as Response;

    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const observableFetch = getObservableFetch("anthropic", testAgent, "api");

    await observableFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
    });

    expect(counterInc).toHaveBeenCalledWith({
      labels: expect.objectContaining({
        provider: "anthropic",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "unknown",
        type: "input",
      }),
      value: 200,
      exemplarLabels: expect.any(Object),
    });

    expect(counterInc).toHaveBeenCalledWith({
      labels: expect.objectContaining({
        provider: "anthropic",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "unknown",
        type: "output",
      }),
      value: 75,
      exemplarLabels: expect.any(Object),
    });
  });

  test("calls original fetch with correct arguments and returns response", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      headers: new Headers(),
      data: "test-response",
    } as unknown as Response;

    const mockFetch = vi.fn().mockResolvedValue(mockResponse);
    globalThis.fetch = mockFetch;

    const observableFetch = getObservableFetch("openai", testAgent, "api");
    const url = "https://mock.openai.com/v1/chat";
    const init = { method: "POST", body: '{"model":"gpt-4"}' };

    const result = await observableFetch(url, init);

    expect(mockFetch).toHaveBeenCalledWith(url, init);
    expect(result).toBe(mockResponse);
  });

  test("propagates errors from original fetch", async () => {
    const testError = new Error("Fetch failed");
    globalThis.fetch = vi.fn().mockRejectedValue(testError);

    const observableFetch = getObservableFetch("anthropic", testAgent, "api");

    await expect(
      observableFetch("https://mock.anthropic.com/v1/messages", {
        method: "POST",
      }),
    ).rejects.toThrow("Fetch failed");

    expect(globalThis.fetch).toHaveBeenCalled();
  });
});

describe("getObservableGenAI", () => {
  function getGenAIMock(response: Error | unknown) {
    const mockGenerateContent =
      response instanceof Error
        ? vi.fn().mockRejectedValue(response)
        : vi.fn().mockResolvedValue(response);
    const mockGenerateContentStream =
      response instanceof Error
        ? vi.fn().mockRejectedValue(response)
        : vi.fn().mockResolvedValue(response);
    return {
      models: {
        generateContent: mockGenerateContent,
        generateContentStream: mockGenerateContentStream,
      },
    } as unknown as GoogleGenAI;
  }

  let testAgent: Agent;

  beforeEach(async ({ makeAgent }) => {
    vi.clearAllMocks();
    testAgent = await makeAgent();
    // Initialize metrics so the observable GenAI can record metrics
    initializeMetrics([]);
  });

  test("records duration and tokens on successful Gemini request", async () => {
    const mockGenAI = getGenAIMock({
      usageMetadata: {
        promptTokenCount: 150,
        candidatesTokenCount: 80,
      },
    });

    const instrumentedGenAI = getObservableGenAI(mockGenAI, testAgent, "api");

    // biome-ignore lint/suspicious/noExplicitAny: Mock parameter for testing
    await instrumentedGenAI.models.generateContent({} as any);

    expect(histogramObserve).toHaveBeenCalledWith({
      labels: {
        provider: "gemini",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "unknown",
        status_code: "200",
      },
      value: expect.any(Number),
      exemplarLabels: expect.any(Object),
    });

    expect(counterInc).toHaveBeenCalledWith({
      labels: expect.objectContaining({
        provider: "gemini",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "unknown",
        type: "input",
      }),
      value: 150,
      exemplarLabels: expect.any(Object),
    });

    expect(counterInc).toHaveBeenCalledWith({
      labels: expect.objectContaining({
        provider: "gemini",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "unknown",
        type: "output",
      }),
      value: 80,
      exemplarLabels: expect.any(Object),
    });
  });

  test("records duration with HTTP status on Gemini error", async () => {
    const errorWithStatus = new Error("Bad request");
    Object.assign(errorWithStatus, { status: 400 });

    const mockGenAI = getGenAIMock(errorWithStatus);
    const instrumentedGenAI = getObservableGenAI(mockGenAI, testAgent, "api");

    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: Mock parameter for testing
      instrumentedGenAI.models.generateContent({} as any),
    ).rejects.toThrow("Bad request");

    expect(histogramObserve).toHaveBeenCalledWith({
      labels: {
        provider: "gemini",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "unknown",
        status_code: "400",
      },
      value: expect.any(Number),
      exemplarLabels: expect.any(Object),
    });
  });

  test("records duration with status_code 0 on Gemini network error", async () => {
    const mockGenAI = getGenAIMock(new Error("Network timeout"));

    const instrumentedGenAI = getObservableGenAI(mockGenAI, testAgent, "api");

    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: Mock parameter for testing
      instrumentedGenAI.models.generateContent({} as any),
    ).rejects.toThrow("Network timeout");

    expect(histogramObserve).toHaveBeenCalledWith({
      labels: {
        provider: "gemini",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "unknown",
        status_code: "0",
      },
      value: expect.any(Number),
      exemplarLabels: expect.any(Object),
    });
  });

  test("calls original generateContent with correct arguments and returns result", async () => {
    const mockResult = {
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
      },
      text: "test-response",
    };

    const mockGenerateContent = vi.fn().mockResolvedValue(mockResult);

    const mockGenAI = {
      models: {
        generateContent: mockGenerateContent,
        generateContentStream: vi.fn(),
      },
    } as unknown as GoogleGenAI;

    const instrumentedGenAI = getObservableGenAI(mockGenAI, testAgent, "api");

    const params = { model: "gemini-pro", contents: [{ text: "test" }] };
    const result = await instrumentedGenAI.models.generateContent(
      // biome-ignore lint/suspicious/noExplicitAny: Mock parameter for testing
      params as any,
    );

    expect(mockGenerateContent).toHaveBeenCalledWith(params);
    expect(result).toBe(mockResult);
  });

  test("propagates errors from original generateContent", async () => {
    const testError = new Error("Gemini API failed");
    Object.assign(testError, { status: 500 });

    const mockGenerateContent = vi.fn().mockRejectedValue(testError);

    const mockGenAI = {
      models: {
        generateContent: mockGenerateContent,
        generateContentStream: vi.fn(),
      },
    } as unknown as GoogleGenAI;

    const instrumentedGenAI = getObservableGenAI(mockGenAI, testAgent, "api");

    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: Mock parameter for testing
      instrumentedGenAI.models.generateContent({} as any),
    ).rejects.toThrow("Gemini API failed");

    expect(mockGenerateContent).toHaveBeenCalled();
  });

  test("records duration on successful Gemini streaming request", async () => {
    const mockStream = async function* () {
      yield { text: "chunk1" };
      yield { text: "chunk2" };
    };

    const mockGenerateContentStream = vi.fn().mockResolvedValue(mockStream());

    const mockGenAI = {
      models: {
        generateContent: vi.fn(),
        generateContentStream: mockGenerateContentStream,
      },
    } as unknown as GoogleGenAI;

    const instrumentedGenAI = getObservableGenAI(mockGenAI, testAgent, "api");

    const params = {
      model: "gemini-2.5-pro",
      contents: [{ text: "test" }],
    };
    // biome-ignore lint/suspicious/noExplicitAny: Mock parameter for testing
    await instrumentedGenAI.models.generateContentStream(params as any);

    expect(histogramObserve).toHaveBeenCalledWith({
      labels: {
        provider: "gemini",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "gemini-2.5-pro",
        status_code: "200",
      },
      value: expect.any(Number),
      exemplarLabels: expect.any(Object),
    });
  });

  test("records duration with error status on Gemini streaming error", async () => {
    const errorWithStatus = new Error("Rate limited");
    Object.assign(errorWithStatus, { status: 429 });

    const mockGenAI = {
      models: {
        generateContent: vi.fn(),
        generateContentStream: vi.fn().mockRejectedValue(errorWithStatus),
      },
    } as unknown as GoogleGenAI;

    const instrumentedGenAI = getObservableGenAI(mockGenAI, testAgent, "api");

    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: Mock parameter for testing
      instrumentedGenAI.models.generateContentStream({} as any),
    ).rejects.toThrow("Rate limited");

    expect(histogramObserve).toHaveBeenCalledWith({
      labels: {
        provider: "gemini",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "unknown",
        status_code: "429",
      },
      value: expect.any(Number),
      exemplarLabels: expect.any(Object),
    });
  });

  test("returns original stream from generateContentStream", async () => {
    const chunks = [{ text: "a" }, { text: "b" }, { text: "c" }];
    async function* mockStream() {
      for (const chunk of chunks) {
        yield chunk;
      }
    }

    const mockGenerateContentStream = vi.fn().mockResolvedValue(mockStream());

    const mockGenAI = {
      models: {
        generateContent: vi.fn(),
        generateContentStream: mockGenerateContentStream,
      },
    } as unknown as GoogleGenAI;

    const instrumentedGenAI = getObservableGenAI(mockGenAI, testAgent, "api");

    const result = await instrumentedGenAI.models.generateContentStream(
      // biome-ignore lint/suspicious/noExplicitAny: Mock parameter for testing
      {} as any,
    );

    const received: unknown[] = [];
    for await (const chunk of result) {
      received.push(chunk);
    }

    expect(received).toEqual(chunks);
  });
});

describe("initializeMetrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("skips reinitialization when label keys haven't changed", () => {
    initializeMetrics(["environment", "team", "region"]);
    registerRemoveSingleMetric.mockClear();

    initializeMetrics(["environment", "team", "region"]);

    expect(registerRemoveSingleMetric).not.toHaveBeenCalled();
  });

  test("reinitializes metrics when label keys are added", () => {
    initializeMetrics(["environment", "team"]);
    registerRemoveSingleMetric.mockClear();

    initializeMetrics(["environment", "team", "region"]);

    expect(registerRemoveSingleMetric).toHaveBeenCalledWith(
      "llm_request_duration_seconds",
    );
    expect(registerRemoveSingleMetric).toHaveBeenCalledWith("llm_tokens_total");
  });

  test("reinitializes metrics when label keys are removed", () => {
    initializeMetrics(["environment", "team", "region"]);
    registerRemoveSingleMetric.mockClear();

    initializeMetrics(["environment", "team"]);

    expect(registerRemoveSingleMetric).toHaveBeenCalledWith(
      "llm_request_duration_seconds",
    );
    expect(registerRemoveSingleMetric).toHaveBeenCalledWith("llm_tokens_total");
  });

  test("reinitializes metrics when label keys are changed", () => {
    initializeMetrics(["environment", "team"]);
    registerRemoveSingleMetric.mockClear();

    initializeMetrics(["environment", "region"]);

    expect(registerRemoveSingleMetric).toHaveBeenCalledWith(
      "llm_request_duration_seconds",
    );
    expect(registerRemoveSingleMetric).toHaveBeenCalledWith("llm_tokens_total");
  });

  test("doesn't reinit if keys with special characters didn't change", () => {
    initializeMetrics(["env-name", "team.id", "region@aws"]);
    registerRemoveSingleMetric.mockClear();

    initializeMetrics(["env-name", "team.id", "region@aws"]);

    expect(registerRemoveSingleMetric).not.toHaveBeenCalled();
  });

  test("doesn't reinit if keys are the same but in different order", () => {
    initializeMetrics(["team", "environment", "region"]);
    registerRemoveSingleMetric.mockClear();

    initializeMetrics(["region", "team", "environment"]);

    expect(registerRemoveSingleMetric).not.toHaveBeenCalled();
  });
});

describe("reportLLMCost", () => {
  let testAgent: Agent;

  beforeEach(async ({ makeAgent }) => {
    vi.clearAllMocks();
    testAgent = await makeAgent();
    initializeMetrics([]);
  });

  test("records cost with model", () => {
    reportLLMCost("openai", testAgent, "gpt-4", 0.05, "api");

    expect(counterInc).toHaveBeenCalledWith({
      labels: {
        provider: "openai",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "gpt-4",
      },
      value: 0.05,
      exemplarLabels: expect.any(Object),
    });
  });

  test("records cost without model", () => {
    reportLLMCost("anthropic", testAgent, "unknown", 0.02, "api");

    expect(counterInc).toHaveBeenCalledWith({
      labels: {
        provider: "anthropic",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "unknown",
      },
      value: 0.02,
      exemplarLabels: expect.any(Object),
    });
  });
});

describe("reportLLMTokens with model", () => {
  let testAgent: Agent;

  beforeEach(async ({ makeAgent }) => {
    vi.clearAllMocks();
    testAgent = await makeAgent();
    initializeMetrics([]);
  });

  test("records tokens with model specified", () => {
    reportLLMTokens(
      "openai",
      testAgent,
      { input: 100, output: 50 },
      "gpt-4",
      "api",
    );

    expect(counterInc).toHaveBeenCalledWith({
      labels: {
        provider: "openai",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "gpt-4",
        type: "input",
      },
      value: 100,
      exemplarLabels: expect.any(Object),
    });

    expect(counterInc).toHaveBeenCalledWith({
      labels: {
        provider: "openai",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "gpt-4",
        type: "output",
      },
      value: 50,
      exemplarLabels: expect.any(Object),
    });
  });
});

describe("reportBlockedTools with model", () => {
  let testAgent: Agent;

  beforeEach(async ({ makeAgent }) => {
    vi.clearAllMocks();
    testAgent = await makeAgent();
    initializeMetrics([]);
  });

  test("records blocked tools with model", () => {
    reportBlockedTools("openai", testAgent, 3, "gpt-4", "api");

    expect(counterInc).toHaveBeenCalledWith({
      labels: {
        provider: "openai",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "gpt-4",
      },
      value: 3,
      exemplarLabels: expect.any(Object),
    });
  });
});

describe("reportTimeToFirstToken", () => {
  let testAgent: Agent;

  beforeEach(async ({ makeAgent }) => {
    vi.clearAllMocks();
    testAgent = await makeAgent();
    initializeMetrics([]);
  });

  test("records time to first token with model", () => {
    reportTimeToFirstToken("openai", testAgent, "gpt-4", 0.5, "api");

    expect(histogramObserve).toHaveBeenCalledWith({
      labels: {
        provider: "openai",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "gpt-4",
      },
      value: 0.5,
      exemplarLabels: expect.any(Object),
    });
  });

  test("records time to first token with unknown model", () => {
    reportTimeToFirstToken("anthropic", testAgent, "unknown", 0.25, "api");

    expect(histogramObserve).toHaveBeenCalledWith({
      labels: {
        provider: "anthropic",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "unknown",
      },
      value: 0.25,
      exemplarLabels: expect.any(Object),
    });
  });

  test("skips reporting for invalid TTFT value", () => {
    reportTimeToFirstToken("openai", testAgent, "gpt-4", 0, "api");
    reportTimeToFirstToken("openai", testAgent, "gpt-4", -1, "api");

    expect(histogramObserve).not.toHaveBeenCalled();
  });

  test("records TTFT for different providers", () => {
    reportTimeToFirstToken("gemini", testAgent, "gemini-pro", 0.3, "api");

    expect(histogramObserve).toHaveBeenCalledWith({
      labels: {
        provider: "gemini",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "gemini-pro",
      },
      value: 0.3,
      exemplarLabels: expect.any(Object),
    });
  });
});

describe("reportTokensPerSecond", () => {
  let testAgent: Agent;

  beforeEach(async ({ makeAgent }) => {
    vi.clearAllMocks();
    testAgent = await makeAgent();
    initializeMetrics([]);
  });

  test("records tokens per second with model", () => {
    // 100 tokens in 2 seconds = 50 tokens/sec
    reportTokensPerSecond("openai", testAgent, "gpt-4", 100, 2, "api");

    expect(histogramObserve).toHaveBeenCalledWith({
      labels: {
        provider: "openai",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "gpt-4",
      },
      value: 50,
      exemplarLabels: expect.any(Object),
    });
  });

  test("records tokens per second with unknown model", () => {
    // 150 tokens in 3 seconds = 50 tokens/sec
    reportTokensPerSecond("anthropic", testAgent, "unknown", 150, 3, "api");

    expect(histogramObserve).toHaveBeenCalledWith({
      labels: {
        provider: "anthropic",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "unknown",
      },
      value: 50,
      exemplarLabels: expect.any(Object),
    });
  });

  test("skips reporting for zero output tokens", () => {
    reportTokensPerSecond("openai", testAgent, "gpt-4", 0, 2, "api");

    expect(histogramObserve).not.toHaveBeenCalled();
  });

  test("skips reporting for zero duration", () => {
    reportTokensPerSecond("openai", testAgent, "gpt-4", 100, 0, "api");

    expect(histogramObserve).not.toHaveBeenCalled();
  });

  test("skips reporting for negative duration", () => {
    reportTokensPerSecond("openai", testAgent, "gpt-4", 100, -1, "api");

    expect(histogramObserve).not.toHaveBeenCalled();
  });

  test("calculates correct tokens/sec for fast response", () => {
    // 50 tokens in 0.5 seconds = 100 tokens/sec
    reportTokensPerSecond("gemini", testAgent, "gemini-pro", 50, 0.5, "api");

    expect(histogramObserve).toHaveBeenCalledWith({
      labels: {
        provider: "gemini",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "gemini-pro",
      },
      value: 100,
      exemplarLabels: expect.any(Object),
    });
  });

  test("calculates correct tokens/sec for slow response", () => {
    // 200 tokens in 10 seconds = 20 tokens/sec
    reportTokensPerSecond("anthropic", testAgent, "claude-3", 200, 10, "api");

    expect(histogramObserve).toHaveBeenCalledWith({
      labels: {
        provider: "anthropic",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "claude-3",
      },
      value: 20,
      exemplarLabels: expect.any(Object),
    });
  });
});

describe("reportRequestDuration", () => {
  let testAgent: Agent;

  beforeEach(async ({ makeAgent }) => {
    vi.clearAllMocks();
    testAgent = await makeAgent();
    initializeMetrics([]);
  });

  test("records duration with a success status code", () => {
    reportRequestDuration(
      "bedrock",
      testAgent,
      "claude-sonnet",
      1.5,
      "200",
      "api",
    );

    expect(histogramObserve).toHaveBeenCalledWith({
      labels: {
        provider: "bedrock",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "claude-sonnet",
        status_code: "200",
      },
      value: 1.5,
      exemplarLabels: expect.any(Object),
    });
  });

  test("records duration with an error status code", () => {
    reportRequestDuration(
      "bedrock",
      testAgent,
      "claude-sonnet",
      0.2,
      "400",
      "chat",
    );

    expect(histogramObserve).toHaveBeenCalledWith({
      labels: {
        provider: "bedrock",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "chat",
        model: "claude-sonnet",
        status_code: "400",
      },
      value: 0.2,
      exemplarLabels: expect.any(Object),
    });
  });

  test("falls back to unknown model label", () => {
    reportRequestDuration("bedrock", testAgent, "unknown", 3, "0", "api");

    expect(histogramObserve).toHaveBeenCalledWith({
      labels: expect.objectContaining({
        provider: "bedrock",
        model: "unknown",
        status_code: "0",
      }),
      value: 3,
      exemplarLabels: expect.any(Object),
    });
  });
});

describe("reportLLMTokens cache tokens", () => {
  let testAgent: Agent;

  beforeEach(async ({ makeAgent }) => {
    vi.clearAllMocks();
    testAgent = await makeAgent();
    initializeMetrics([]);
  });

  test("emits llm_cache_tokens_total with read and write cache_type", () => {
    reportLLMTokens(
      "anthropic",
      testAgent,
      { input: 5, output: 10, cacheRead: 1000, cacheWrite: 200 },
      "claude-sonnet",
      "api",
    );

    expect(counterInc).toHaveBeenCalledWith({
      labels: {
        provider: "anthropic",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "claude-sonnet",
        cache_type: "read",
      },
      value: 1000,
      exemplarLabels: expect.any(Object),
    });
    expect(counterInc).toHaveBeenCalledWith({
      labels: {
        provider: "anthropic",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        agent_type: testAgent.agentType,
        source: "api",
        model: "claude-sonnet",
        cache_type: "write",
      },
      value: 200,
      exemplarLabels: expect.any(Object),
    });
  });

  test("does not emit cache tokens when there is no cache usage", () => {
    reportLLMTokens(
      "anthropic",
      testAgent,
      { input: 5, output: 10, cacheRead: 0, cacheWrite: 0 },
      "claude-sonnet",
      "api",
    );

    expect(counterInc).not.toHaveBeenCalledWith(
      expect.objectContaining({
        labels: expect.objectContaining({ cache_type: expect.any(String) }),
      }),
    );
  });
});

describe("reportLLMCacheCost", () => {
  let testAgent: Agent;

  beforeEach(async ({ makeAgent }) => {
    vi.clearAllMocks();
    testAgent = await makeAgent();
    initializeMetrics([]);
  });

  test("emits cache cost and gross read savings", () => {
    reportLLMCacheCost(
      "anthropic",
      testAgent,
      "claude-sonnet",
      { cacheCost: 0.012, cacheReadSavings: 0.09 },
      "api",
    );

    const expectedLabels = {
      provider: "anthropic",
      agent_id: testAgent.id,
      agent_name: testAgent.name,
      agent_type: testAgent.agentType,
      source: "api",
      model: "claude-sonnet",
    };

    expect(counterInc).toHaveBeenCalledWith({
      labels: expectedLabels,
      value: 0.012,
      exemplarLabels: expect.any(Object),
    });
    expect(counterInc).toHaveBeenCalledWith({
      labels: expectedLabels,
      value: 0.09,
      exemplarLabels: expect.any(Object),
    });
  });

  test("does not emit when cost and savings are absent or non-positive", () => {
    reportLLMCacheCost(
      "openai",
      testAgent,
      "gpt-4",
      { cacheCost: 0, cacheReadSavings: undefined },
      "api",
    );

    expect(counterInc).not.toHaveBeenCalled();
  });

  test("emits only savings when there is no cache cost", () => {
    reportLLMCacheCost(
      "anthropic",
      testAgent,
      "claude-sonnet",
      { cacheCost: undefined, cacheReadSavings: 0.05 },
      "api",
    );

    expect(counterInc).toHaveBeenCalledTimes(1);
    expect(counterInc).toHaveBeenCalledWith({
      labels: expect.objectContaining({ provider: "anthropic" }),
      value: 0.05,
      exemplarLabels: expect.any(Object),
    });
  });
});
