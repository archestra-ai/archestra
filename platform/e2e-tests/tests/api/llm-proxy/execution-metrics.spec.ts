import { randomUUID } from "node:crypto";
import type { SupportedProvider } from "@shared";
import { expect, test } from "../fixtures";

// =============================================================================
// Test Configuration Interface
// =============================================================================

interface ExecutionMetricsTestConfig {
  providerName: string;
  endpoint: (agentId: string) => string;
  headers: (wiremockStub: string) => Record<string, string>;
  buildRequest: (content: string) => object;
}

// =============================================================================
// Test Configurations
// =============================================================================

const openaiConfig: ExecutionMetricsTestConfig = {
  providerName: "OpenAI",

  endpoint: (agentId) => `/v1/openai/${agentId}/chat/completions`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content) => ({
    model: "gpt-4",
    messages: [{ role: "user", content }],
  }),
};

const anthropicConfig: ExecutionMetricsTestConfig = {
  providerName: "Anthropic",

  endpoint: (agentId) => `/v1/anthropic/${agentId}/v1/messages`,

  headers: (wiremockStub) => ({
    "x-api-key": wiremockStub,
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  }),

  buildRequest: (content) => ({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 1024,
    messages: [{ role: "user", content }],
  }),
};

const geminiConfig: ExecutionMetricsTestConfig = {
  providerName: "Gemini",

  endpoint: (agentId) =>
    `/v1/gemini/${agentId}/v1beta/models/gemini-2.5-pro:generateContent`,

  headers: (wiremockStub) => ({
    "x-goog-api-key": wiremockStub,
    "Content-Type": "application/json",
  }),

  buildRequest: (content) => ({
    contents: [
      {
        role: "user",
        parts: [{ text: content }],
      },
    ],
  }),
};

const cohereConfig: ExecutionMetricsTestConfig = {
  providerName: "Cohere",

  endpoint: (agentId) => `/v1/cohere/${agentId}/chat`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content) => ({
    model: "command-r-plus-08-2024",
    messages: [{ role: "user", content: [{ type: "text", text: content }] }],
  }),
};

const cerebrasConfig: ExecutionMetricsTestConfig = {
  providerName: "Cerebras",

  endpoint: (agentId) => `/v1/cerebras/${agentId}/chat/completions`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content) => ({
    model: "llama-4-scout-17b-16e-instruct",
    messages: [{ role: "user", content }],
  }),
};

const mistralConfig: ExecutionMetricsTestConfig = {
  providerName: "Mistral",

  endpoint: (agentId) => `/v1/mistral/${agentId}/chat/completions`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content) => ({
    model: "mistral-large-latest",
    messages: [{ role: "user", content }],
  }),
};

const vllmConfig: ExecutionMetricsTestConfig = {
  providerName: "vLLM",

  endpoint: (agentId) => `/v1/vllm/${agentId}/chat/completions`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content) => ({
    model: "meta-llama/Llama-3.1-8B-Instruct",
    messages: [{ role: "user", content }],
  }),
};

const ollamaConfig: ExecutionMetricsTestConfig = {
  providerName: "Ollama",

  endpoint: (agentId) => `/v1/ollama/${agentId}/chat/completions`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content) => ({
    model: "qwen2:0.5b",
    messages: [{ role: "user", content }],
  }),
};

const zhipuaiConfig: ExecutionMetricsTestConfig = {
  providerName: "Zhipuai",

  endpoint: (agentId) => `/v1/zhipuai/${agentId}/chat/completions`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content) => ({
    model: "glm-4.5-flash",
    messages: [{ role: "user", content }],
  }),
};

const deepseekConfig: ExecutionMetricsTestConfig = {
  providerName: "DeepSeek",

  endpoint: (agentId) => `/v1/deepseek/${agentId}/chat/completions`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content) => ({
    model: "deepseek-chat",
    messages: [{ role: "user", content }],
  }),
};

const bedrockConfig: ExecutionMetricsTestConfig = {
  providerName: "Bedrock",

  endpoint: (agentId) => `/v1/bedrock/${agentId}/converse`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content) => ({
    modelId: "anthropic.claude-3-sonnet-20240229-v1:0",
    messages: [{ role: "user", content: [{ text: content }] }],
  }),
};

// =============================================================================
// Test Suite
// =============================================================================

// Ensures every SupportedProvider has a test config (compile error when new provider added without config)
const testConfigsMap = {
  openai: openaiConfig,
  anthropic: anthropicConfig,
  gemini: geminiConfig,
  cohere: cohereConfig,
  cerebras: cerebrasConfig,
  mistral: mistralConfig,
  vllm: vllmConfig,
  ollama: ollamaConfig,
  zhipuai: zhipuaiConfig,
  deepseek: deepseekConfig,
  bedrock: bedrockConfig,
  perplexity: null, // Perplexity has no tool calling - execution metrics require tool call flows
} satisfies Record<SupportedProvider, ExecutionMetricsTestConfig | null>;

const testConfigs = Object.values(testConfigsMap).filter(
  (c): c is ExecutionMetricsTestConfig => c !== null,
);

for (const config of testConfigs) {
  test.describe(`LLMProxy-ExecutionMetrics-${config.providerName}`, () => {
    let agentId: string;

    test.afterEach(async ({ request, deleteAgent }) => {
      if (agentId) {
        await deleteAgent(request, agentId);
        agentId = "";
      }
    });

    test("stores execution id on interaction", async ({
      request,
      createLlmProxy,
      makeApiRequest,
      getInteractions,
    }) => {
      const wiremockStub = `${config.providerName.toLowerCase()}-execution-metrics`;

      // 1. Create an LLM Proxy
      const createResponse = await createLlmProxy(
        request,
        `Execution Metrics Test - ${config.providerName}`,
      );
      const agent = await createResponse.json();
      agentId = agent.id;

      // 2. Send an LLM proxy request with a unique execution ID
      const executionId = randomUUID();
      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: config.endpoint(agentId),
        headers: {
          ...config.headers(wiremockStub),
          "X-Archestra-Execution-Id": executionId,
        },
        data: config.buildRequest("Hello"),
      });
      expect(response.ok()).toBeTruthy();

      // 3. Verify the interaction was stored with the execution ID
      await expect
        .poll(
          async () => {
            const interactionsResponse = await getInteractions(request, {
              profileId: agentId,
            });
            const data = await interactionsResponse.json();
            return data.data;
          },
          { timeout: 10000, intervals: [500, 1000, 2000] },
        )
        .toEqual(
          expect.arrayContaining([expect.objectContaining({ executionId })]),
        );
    });

    test("stores same execution id on both interactions when sent twice", async ({
      request,
      createLlmProxy,
      makeApiRequest,
      getInteractions,
    }) => {
      const wiremockStub = `${config.providerName.toLowerCase()}-execution-metrics`;

      // 1. Create an LLM Proxy
      const createResponse = await createLlmProxy(
        request,
        `Execution Dedup Test - ${config.providerName}`,
      );
      const agent = await createResponse.json();
      agentId = agent.id;

      // 2. Send two requests with the same execution ID
      const executionId = randomUUID();
      const sendRequest = () =>
        makeApiRequest({
          request,
          method: "post",
          urlSuffix: config.endpoint(agentId),
          headers: {
            ...config.headers(wiremockStub),
            "X-Archestra-Execution-Id": executionId,
          },
          data: config.buildRequest("Hello"),
        });

      const response1 = await sendRequest();
      expect(response1.ok()).toBeTruthy();

      const response2 = await sendRequest();
      expect(response2.ok()).toBeTruthy();

      // 3. Verify both interactions share the same execution ID
      await expect
        .poll(
          async () => {
            const interactionsResponse = await getInteractions(request, {
              profileId: agentId,
            });
            const data = await interactionsResponse.json();
            return data.data.filter(
              (i: { executionId: string | null }) =>
                i.executionId === executionId,
            );
          },
          { timeout: 10000, intervals: [500, 1000, 2000] },
        )
        .toHaveLength(2);
    });

    test("stores different execution ids separately", async ({
      request,
      createLlmProxy,
      makeApiRequest,
      getInteractions,
    }) => {
      const wiremockStub = `${config.providerName.toLowerCase()}-execution-metrics`;

      // 1. Create an LLM Proxy
      const createResponse = await createLlmProxy(
        request,
        `Execution Separate Count Test - ${config.providerName}`,
      );
      const agent = await createResponse.json();
      agentId = agent.id;

      // 2. Send two requests with different execution IDs
      const executionId1 = randomUUID();
      const executionId2 = randomUUID();

      const sendRequest = (execId: string) =>
        makeApiRequest({
          request,
          method: "post",
          urlSuffix: config.endpoint(agentId),
          headers: {
            ...config.headers(wiremockStub),
            "X-Archestra-Execution-Id": execId,
          },
          data: config.buildRequest("Hello"),
        });

      const response1 = await sendRequest(executionId1);
      expect(response1.ok()).toBeTruthy();

      const response2 = await sendRequest(executionId2);
      expect(response2.ok()).toBeTruthy();

      // 3. Verify two interactions with distinct execution IDs
      await expect
        .poll(
          async () => {
            const interactionsResponse = await getInteractions(request, {
              profileId: agentId,
            });
            const data = await interactionsResponse.json();
            const executionIds = new Set(
              data.data
                .map((i: { executionId: string | null }) => i.executionId)
                .filter(Boolean),
            );
            return executionIds.size;
          },
          { timeout: 10000, intervals: [500, 1000, 2000] },
        )
        .toBeGreaterThanOrEqual(2);
    });
  });
}
