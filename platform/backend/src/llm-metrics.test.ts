import type { GoogleGenAI } from "@google/genai";
import { AgentModel } from "@/models";
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
} from "./llm-metrics";

describe("getObservableFetch", () => {
  let testAgent: Agent;

  beforeEach(async () => {
    vi.clearAllMocks();
    testAgent = await AgentModel.create({
      name: "Test Agent",
      teams: [],
    });
    // Initialize metrics so the observable fetch can record metrics
    initializeMetrics([]);
  });

  it("records duration and tokens on successful request", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      clone: () => ({
        json: async () => ({
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
      }),
    } as Response;

    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const observableFetch = getObservableFetch("openai", testAgent);

    await observableFetch("https://api.openai.com/v1/chat", {
      method: "POST",
    });

    expect(histogramObserve).toHaveBeenCalledWith(
      {
        provider: "openai",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        status_code: "200",
      },
      expect.any(Number),
    );

    expect(counterInc).toHaveBeenCalledWith(
      {
        provider: "openai",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        type: "input",
      },
      100,
    );

    expect(counterInc).toHaveBeenCalledWith(
      {
        provider: "openai",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        type: "output",
      },
      50,
    );
  });

  it("records duration with 4xx status code", async () => {
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
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        status_code: "400",
      },
      expect.any(Number),
    );
  });

  it("records duration with 5xx status code", async () => {
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
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        status_code: "503",
      },
      expect.any(Number),
    );
  });

  it("records duration with status_code 0 on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const observableFetch = getObservableFetch("openai", testAgent);

    await expect(
      observableFetch("https://api.openai.com/v1/chat", { method: "POST" }),
    ).rejects.toThrow("Network error");

    expect(histogramObserve).toHaveBeenCalledWith(
      {
        provider: "openai",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        status_code: "0",
      },
      expect.any(Number),
    );
  });

  it("records tokens for Anthropic response format", async () => {
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
      {
        provider: "anthropic",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        type: "input",
      },
      200,
    );

    expect(counterInc).toHaveBeenCalledWith(
      {
        provider: "anthropic",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        type: "output",
      },
      75,
    );
  });

  it("calls original fetch with correct arguments and returns response", async () => {
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

  it("propagates errors from original fetch", async () => {
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

  beforeEach(async () => {
    vi.clearAllMocks();
    testAgent = await AgentModel.create({
      name: "Test Agent",
      teams: [],
    });
    // Initialize metrics so the observable GenAI can record metrics
    initializeMetrics([]);
  });

  it("records duration and tokens on successful Gemini request", async () => {
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
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        status_code: "200",
      },
      expect.any(Number),
    );

    expect(counterInc).toHaveBeenCalledWith(
      {
        provider: "gemini",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        type: "input",
      },
      150,
    );

    expect(counterInc).toHaveBeenCalledWith(
      {
        provider: "gemini",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        type: "output",
      },
      80,
    );
  });

  it("records duration with HTTP status on Gemini error", async () => {
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
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        status_code: "400",
      },
      expect.any(Number),
    );
  });

  it("records duration with status_code 0 on Gemini network error", async () => {
    const mockGenAI = getGenAIMock(new Error("Network timeout"));

    const instrumentedGenAI = getObservableGenAI(mockGenAI, testAgent);

    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: Mock parameter for testing
      instrumentedGenAI.models.generateContent({} as any),
    ).rejects.toThrow("Network timeout");

    expect(histogramObserve).toHaveBeenCalledWith(
      {
        provider: "gemini",
        agent_id: testAgent.id,
        agent_name: testAgent.name,
        status_code: "0",
      },
      expect.any(Number),
    );
  });

  it("calls original generateContent with correct arguments and returns result", async () => {
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

  it("propagates errors from original generateContent", async () => {
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

  it("skips reinitialization when label keys haven't changed", () => {
    initializeMetrics(["environment", "team", "region"]);
    registerRemoveSingleMetric.mockClear();

    initializeMetrics(["environment", "team", "region"]);

    expect(registerRemoveSingleMetric).not.toHaveBeenCalled();
  });

  it("reinitializes metrics when label keys are added", () => {
    initializeMetrics(["environment", "team"]);
    registerRemoveSingleMetric.mockClear();

    initializeMetrics(["environment", "team", "region"]);

    expect(registerRemoveSingleMetric).toHaveBeenCalledWith(
      "llm_request_duration_seconds",
    );
    expect(registerRemoveSingleMetric).toHaveBeenCalledWith("llm_tokens_total");
  });

  it("reinitializes metrics when label keys are removed", () => {
    initializeMetrics(["environment", "team", "region"]);
    registerRemoveSingleMetric.mockClear();

    initializeMetrics(["environment", "team"]);

    expect(registerRemoveSingleMetric).toHaveBeenCalledWith(
      "llm_request_duration_seconds",
    );
    expect(registerRemoveSingleMetric).toHaveBeenCalledWith("llm_tokens_total");
  });

  it("reinitializes metrics when label keys are changed", () => {
    initializeMetrics(["environment", "team"]);
    registerRemoveSingleMetric.mockClear();

    initializeMetrics(["environment", "region"]);

    expect(registerRemoveSingleMetric).toHaveBeenCalledWith(
      "llm_request_duration_seconds",
    );
    expect(registerRemoveSingleMetric).toHaveBeenCalledWith("llm_tokens_total");
  });

  it("doesn't reinit if keys with special characters didn't change", () => {
    initializeMetrics(["env-name", "team.id", "region@aws"]);
    registerRemoveSingleMetric.mockClear();

    initializeMetrics(["env-name", "team.id", "region@aws"]);

    expect(registerRemoveSingleMetric).not.toHaveBeenCalled();
  });

  it("doesn't reinit if keys are the same but in different order", () => {
    initializeMetrics(["team", "environment", "region"]);
    registerRemoveSingleMetric.mockClear();

    initializeMetrics(["region", "team", "environment"]);

    expect(registerRemoveSingleMetric).not.toHaveBeenCalled();
  });
});
