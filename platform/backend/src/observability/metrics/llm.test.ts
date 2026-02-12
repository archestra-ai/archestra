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
  reportLLMCost,
  reportLLMTokens,
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

    const observableFetch = getObservableFetch("openai", testAgent);

    await observableFetch("https://api.openai.com/v1/chat", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4" }),
    });

    expect(histogramObserve).toHaveBeenCalledWith(
      {
        provider: "openai",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "gpt-4",
        status_code: "200",
      },
      expect.any(Number),
    );

    expect(counterInc).toHaveBeenCalledWith(
      {
        provider: "openai",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "gpt-4",
        type: "input",
      },
      100,
    );

    expect(counterInc).toHaveBeenCalledWith(
      {
        provider: "openai",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "gpt-4",
        type: "output",
      },
      50,
    );
  });

  test("records duration with 4xx status code", async () => {
    const mockResponse = {
      ok: false,
      status: 400,
      headers: new Headers(),
    } as Response;

    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const observableFetch = getObservableFetch("anthropic", testAgent);

    await observableFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
    });

    expect(histogramObserve).toHaveBeenCalledWith(
      {
        provider: "anthropic",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "unknown",
        status_code: "400",
      },
      expect.any(Number),
    );
  });

  test("records duration with 5xx status code", async () => {
    const mockResponse = {
      ok: false,
      status: 503,
      headers: new Headers(),
    } as Response;

    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const observableFetch = getObservableFetch("openai", testAgent);

    await observableFetch("https://api.openai.com/v1/chat", {
      method: "POST",
    });

    expect(histogramObserve).toHaveBeenCalledWith(
      {
        provider: "openai",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "unknown",
        status_code: "503",
      },
      expect.any(Number),
    );
  });

  test("records duration with status_code 0 on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const observableFetch = getObservableFetch("openai", testAgent);

    await expect(
      observableFetch("https://api.openai.com/v1/chat", { method: "POST" }),
    ).rejects.toThrow("Network error");

    expect(histogramObserve).toHaveBeenCalledWith(
      {
        provider: "openai",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "unknown",
        status_code: "0",
      },
      expect.any(Number),
    );
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

    const observableFetch = getObservableFetch("anthropic", testAgent);

    await observableFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
    });

    expect(counterInc).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "unknown",
        type: "input",
      }),
      200,
    );

    expect(counterInc).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "unknown",
        type: "output",
      }),
      75,
    );
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

    const observableFetch = getObservableFetch("openai", testAgent);
    const url = "https://mock.openai.com/v1/chat";
    const init = { method: "POST", body: '{"model":"gpt-4"}' };

    const result = await observableFetch(url, init);

    expect(mockFetch).toHaveBeenCalledWith(url, init);
    expect(result).toBe(mockResponse);
  });

  test("propagates errors from original fetch", async () => {
    const testError = new Error("Fetch failed");
    globalThis.fetch = vi.fn().mockRejectedValue(testError);

    const observableFetch = getObservableFetch("anthropic", testAgent);

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
    return {
      models: {
        generateContent: mockGenerateContent,
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

    const instrumentedGenAI = getObservableGenAI(mockGenAI, testAgent);

    // biome-ignore lint/suspicious/noExplicitAny: Mock parameter for testing
    await instrumentedGenAI.models.generateContent({} as any);

    expect(histogramObserve).toHaveBeenCalledWith(
      {
        provider: "gemini",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "unknown",
        status_code: "200",
      },
      expect.any(Number),
    );

    expect(counterInc).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "gemini",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "unknown",
        type: "input",
      }),
      150,
    );

    expect(counterInc).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "gemini",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "unknown",
        type: "output",
      }),
      80,
    );
  });

  test("records duration with HTTP status on Gemini error", async () => {
    const errorWithStatus = new Error("Bad request");
    Object.assign(errorWithStatus, { status: 400 });

    const mockGenAI = getGenAIMock(errorWithStatus);
    const instrumentedGenAI = getObservableGenAI(mockGenAI, testAgent);

    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: Mock parameter for testing
      instrumentedGenAI.models.generateContent({} as any),
    ).rejects.toThrow("Bad request");

    expect(histogramObserve).toHaveBeenCalledWith(
      {
        provider: "gemini",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "unknown",
        status_code: "400",
      },
      expect.any(Number),
    );
  });

  test("records duration with status_code 0 on Gemini network error", async () => {
    const mockGenAI = getGenAIMock(new Error("Network timeout"));

    const instrumentedGenAI = getObservableGenAI(mockGenAI, testAgent);

    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: Mock parameter for testing
      instrumentedGenAI.models.generateContent({} as any),
    ).rejects.toThrow("Network timeout");

    expect(histogramObserve).toHaveBeenCalledWith(
      {
        provider: "gemini",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "unknown",
        status_code: "0",
      },
      expect.any(Number),
    );
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
      },
    } as unknown as GoogleGenAI;

    const instrumentedGenAI = getObservableGenAI(mockGenAI, testAgent);

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
      },
    } as unknown as GoogleGenAI;

    const instrumentedGenAI = getObservableGenAI(mockGenAI, testAgent);

    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: Mock parameter for testing
      instrumentedGenAI.models.generateContent({} as any),
    ).rejects.toThrow("Gemini API failed");

    expect(mockGenerateContent).toHaveBeenCalled();
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
    reportLLMCost("openai", testAgent, "gpt-4", 0.05);

    expect(counterInc).toHaveBeenCalledWith(
      {
        provider: "openai",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "gpt-4",
      },
      0.05,
    );
  });

  test("records cost without model", () => {
    reportLLMCost("anthropic", testAgent, "unknown", 0.02);

    expect(counterInc).toHaveBeenCalledWith(
      {
        provider: "anthropic",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "unknown",
      },
      0.02,
    );
  });

  test("records cost with external agent id", () => {
    reportLLMCost("openai", testAgent, "gpt-4", 0.05, "external-123");

    expect(counterInc).toHaveBeenCalledWith(
      {
        provider: "openai",
        agent_id: "external-123",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "gpt-4",
      },
      0.05,
    );
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
    reportLLMTokens("openai", testAgent, { input: 100, output: 50 }, "gpt-4");

    expect(counterInc).toHaveBeenCalledWith(
      {
        provider: "openai",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "gpt-4",
        type: "input",
      },
      100,
    );

    expect(counterInc).toHaveBeenCalledWith(
      {
        provider: "openai",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "gpt-4",
        type: "output",
      },
      50,
    );
  });

  test("records tokens with external agent id", () => {
    reportLLMTokens(
      "openai",
      testAgent,
      { input: 100, output: 50 },
      "gpt-4",
      "external-456",
    );

    expect(counterInc).toHaveBeenCalledWith(
      {
        provider: "openai",
        agent_id: "external-456",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "gpt-4",
        type: "input",
      },
      100,
    );

    expect(counterInc).toHaveBeenCalledWith(
      {
        provider: "openai",
        agent_id: "external-456",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "gpt-4",
        type: "output",
      },
      50,
    );
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
    reportBlockedTools("openai", testAgent, 3, "gpt-4");

    expect(counterInc).toHaveBeenCalledWith(
      {
        provider: "openai",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "gpt-4",
      },
      3,
    );
  });

  test("records blocked tools with external agent id", () => {
    reportBlockedTools("openai", testAgent, 3, "gpt-4", "external-789");

    expect(counterInc).toHaveBeenCalledWith(
      {
        provider: "openai",
        agent_id: "external-789",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "gpt-4",
      },
      3,
    );
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
    reportTimeToFirstToken("openai", testAgent, "gpt-4", 0.5);

    expect(histogramObserve).toHaveBeenCalledWith(
      {
        provider: "openai",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "gpt-4",
      },
      0.5,
    );
  });

  test("records time to first token without model", () => {
    reportTimeToFirstToken("anthropic", testAgent, undefined, 0.25);

    expect(histogramObserve).toHaveBeenCalledWith(
      {
        provider: "anthropic",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "unknown",
      },
      0.25,
    );
  });

  test("skips reporting for invalid TTFT value", () => {
    reportTimeToFirstToken("openai", testAgent, "gpt-4", 0);
    reportTimeToFirstToken("openai", testAgent, "gpt-4", -1);

    expect(histogramObserve).not.toHaveBeenCalled();
  });

  test("records TTFT for different providers", () => {
    reportTimeToFirstToken("gemini", testAgent, "gemini-pro", 0.3);

    expect(histogramObserve).toHaveBeenCalledWith(
      {
        provider: "gemini",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "gemini-pro",
      },
      0.3,
    );
  });

  test("records TTFT with external agent id", () => {
    reportTimeToFirstToken(
      "openai",
      testAgent,
      "gpt-4",
      0.5,
      "external-ttft-123",
    );

    expect(histogramObserve).toHaveBeenCalledWith(
      {
        provider: "openai",
        agent_id: "external-ttft-123",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "gpt-4",
      },
      0.5,
    );
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
    reportTokensPerSecond("openai", testAgent, "gpt-4", 100, 2);

    expect(histogramObserve).toHaveBeenCalledWith(
      {
        provider: "openai",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "gpt-4",
      },
      50,
    );
  });

  test("records tokens per second without model", () => {
    // 150 tokens in 3 seconds = 50 tokens/sec
    reportTokensPerSecond("anthropic", testAgent, undefined, 150, 3);

    expect(histogramObserve).toHaveBeenCalledWith(
      {
        provider: "anthropic",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "unknown",
      },
      50,
    );
  });

  test("skips reporting for zero output tokens", () => {
    reportTokensPerSecond("openai", testAgent, "gpt-4", 0, 2);

    expect(histogramObserve).not.toHaveBeenCalled();
  });

  test("skips reporting for zero duration", () => {
    reportTokensPerSecond("openai", testAgent, "gpt-4", 100, 0);

    expect(histogramObserve).not.toHaveBeenCalled();
  });

  test("skips reporting for negative duration", () => {
    reportTokensPerSecond("openai", testAgent, "gpt-4", 100, -1);

    expect(histogramObserve).not.toHaveBeenCalled();
  });

  test("calculates correct tokens/sec for fast response", () => {
    // 50 tokens in 0.5 seconds = 100 tokens/sec
    reportTokensPerSecond("gemini", testAgent, "gemini-pro", 50, 0.5);

    expect(histogramObserve).toHaveBeenCalledWith(
      {
        provider: "gemini",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "gemini-pro",
      },
      100,
    );
  });

  test("calculates correct tokens/sec for slow response", () => {
    // 200 tokens in 10 seconds = 20 tokens/sec
    reportTokensPerSecond("anthropic", testAgent, "claude-3", 200, 10);

    expect(histogramObserve).toHaveBeenCalledWith(
      {
        provider: "anthropic",
        agent_id: "",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "claude-3",
      },
      20,
    );
  });

  test("records tokens per second with external agent id", () => {
    // 100 tokens in 2 seconds = 50 tokens/sec
    reportTokensPerSecond(
      "openai",
      testAgent,
      "gpt-4",
      100,
      2,
      "external-tps-123",
    );

    expect(histogramObserve).toHaveBeenCalledWith(
      {
        provider: "openai",
        agent_id: "external-tps-123",
        profile_id: testAgent.id,
        profile_name: testAgent.name,
        model: "gpt-4",
      },
      50,
    );
  });
});
