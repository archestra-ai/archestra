import type { SupportedProvider } from "@shared";
import { expect, test } from "../fixtures";

// =============================================================================
// Test Configuration Interface
// =============================================================================

interface TokenCostLimitTestConfig {
  providerName: string;
  endpoint: (profileId: string) => string;
  headers: (wiremockStub: string) => Record<string, string>;
  buildRequest: (content: string) => object;
  modelName: string;
  customPricing: {
    provider: SupportedProvider;
    model: string;
    pricePerMillionInput: string;
    pricePerMillionOutput: string;
  };
}

// =============================================================================
// OpenAI-Compatible Config Factory
// =============================================================================

/**
 * Factory for providers that use the OpenAI-compatible chat/completions format.
 * Only providerName, modelName, and provider enum differ between them.
 * All use Bearer auth, /chat/completions endpoint, and messages-format requests.
 */
function makeOpenAiCompatibleCostConfig(params: {
  providerName: string;
  modelName: string;
  provider: SupportedProvider;
}): TokenCostLimitTestConfig {
  return {
    providerName: params.providerName,

    endpoint: (profileId) =>
      `/v1/${params.provider}/${profileId}/chat/completions`,

    headers: (wiremockStub) => ({
      Authorization: `Bearer ${wiremockStub}`,
      "Content-Type": "application/json",
    }),

    buildRequest: (content) => ({
      model: params.modelName,
      messages: [{ role: "user", content }],
    }),

    modelName: params.modelName,

    // WireMock returns: prompt_tokens: 100, completion_tokens: 20
    // Cost = (100 * 20000 + 20 * 30000) / 1,000,000 = $2.60
    customPricing: {
      provider: params.provider,
      model: params.modelName,
      pricePerMillionInput: "20000.00",
      pricePerMillionOutput: "30000.00",
    },
  };
}

// =============================================================================
// Test Configurations
// =============================================================================

const openaiConfig = makeOpenAiCompatibleCostConfig({
  providerName: "OpenAI",
  modelName: "test-gpt-4-cost-limit",
  provider: "openai",
});

const anthropicConfig: TokenCostLimitTestConfig = {
  providerName: "Anthropic",

  endpoint: (profileId) => `/v1/anthropic/${profileId}/v1/messages`,

  headers: (wiremockStub) => ({
    "x-api-key": wiremockStub,
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  }),

  buildRequest: (content) => ({
    model: "test-claude-cost-limit",
    max_tokens: 1024,
    messages: [{ role: "user", content }],
  }),

  modelName: "test-claude-cost-limit",

  // WireMock returns: input_tokens: 100, output_tokens: 20
  // Cost = (100 * 20000 + 20 * 30000) / 1,000,000 = $2.60
  customPricing: {
    provider: "anthropic",
    model: "test-claude-cost-limit",
    pricePerMillionInput: "20000.00",
    pricePerMillionOutput: "30000.00",
  },
};

const geminiConfig: TokenCostLimitTestConfig = {
  providerName: "Gemini",

  endpoint: (profileId) =>
    `/v1/gemini/${profileId}/v1beta/models/test-gemini-cost-limit:generateContent`,

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

  modelName: "test-gemini-cost-limit",

  // WireMock returns: promptTokenCount: 100, candidatesTokenCount: 20
  // Cost = (100 * 20000 + 20 * 30000) / 1,000,000 = $2.60
  customPricing: {
    provider: "gemini",
    model: "test-gemini-cost-limit",
    pricePerMillionInput: "20000.00",
    pricePerMillionOutput: "30000.00",
  },
};

const cerebrasConfig = makeOpenAiCompatibleCostConfig({
  providerName: "Cerebras",
  modelName: "test-cerebras-cost-limit",
  provider: "cerebras",
});

const mistralConfig = makeOpenAiCompatibleCostConfig({
  providerName: "Mistral",
  modelName: "test-mistral-cost-limit",
  provider: "mistral",
});

const perplexityConfig = makeOpenAiCompatibleCostConfig({
  providerName: "Perplexity",
  modelName: "test-perplexity-cost-limit",
  provider: "perplexity",
});

const vllmConfig = makeOpenAiCompatibleCostConfig({
  providerName: "vLLM",
  modelName: "test-vllm-cost-limit",
  provider: "vllm",
});

const ollamaConfig = makeOpenAiCompatibleCostConfig({
  providerName: "Ollama",
  modelName: "test-ollama-cost-limit",
  provider: "ollama",
});

const zhipuaiConfig = makeOpenAiCompatibleCostConfig({
  providerName: "Zhipuai",
  modelName: "test-zhipuai-cost-limit",
  provider: "zhipuai",
});

const cohereConfig: TokenCostLimitTestConfig = {
  providerName: "Cohere",

  endpoint: (profileId) => `/v1/cohere/${profileId}/chat`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content) => ({
    model: "test-cohere-cost-limit",
    messages: [{ role: "user", content: [{ type: "text", text: content }] }],
  }),

  modelName: "test-cohere-cost-limit",

  // WireMock returns: input_tokens: 100, output_tokens: 20
  // Cost = (100 * 20000 + 20 * 30000) / 1,000,000 = $2.60
  customPricing: {
    provider: "cohere",
    model: "test-cohere-cost-limit",
    pricePerMillionInput: "20000.00",
    pricePerMillionOutput: "30000.00",
  },
};

const bedrockConfig: TokenCostLimitTestConfig = {
  providerName: "Bedrock",

  endpoint: (profileId) => `/v1/bedrock/${profileId}/converse`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content) => ({
    modelId: "test-bedrock-cost-limit",
    messages: [{ role: "user", content: [{ text: content }] }],
  }),

  modelName: "test-bedrock-cost-limit",

  // WireMock returns: inputTokens: 100, outputTokens: 20
  // Cost = (100 * 20000 + 20 * 30000) / 1,000,000 = $2.60
  customPricing: {
    provider: "bedrock",
    model: "test-bedrock-cost-limit",
    pricePerMillionInput: "20000.00",
    pricePerMillionOutput: "30000.00",
  },
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
  perplexity: perplexityConfig,
  vllm: vllmConfig,
  ollama: ollamaConfig,
  zhipuai: zhipuaiConfig,
  bedrock: bedrockConfig,
} satisfies Record<SupportedProvider, TokenCostLimitTestConfig>;

const testConfigs = Object.values(testConfigsMap);

for (const config of testConfigs) {
  test.describe(
    `LLMProxy-TokenCostLimits-${config.providerName}`,
    { tag: ["@flaky"] },
    () => {
      // Retry to handle async usage tracking race conditions in CI
      test.describe.configure({ retries: 2 });
      let profileId: string;
      let limitId: string;
      let modelUuid: string;

      const wiremockStub = `${config.providerName.toLowerCase()}-token-cost-limit-test`;

      test("blocks request when profile token cost limit is exceeded", async ({
        request,
        createAgent,
        createLimit,
        getModels,
        updateModelPricing,
        makeApiRequest,
      }) => {
        // 1. Create a test profile
        const createResponse = await createAgent(
          request,
          `${config.providerName} Token Limit Test Profile`,
        );
        const profile = await createResponse.json();
        profileId = profile.id;

        // 2. Make a setup request to trigger model creation via ensureModelExists.
        //    This also exercises the proxy path so the model entry is created in the DB.
        //    Cost is tracked at default pricing (~$0.006), well below the $2 limit.
        const setupResponse = await makeApiRequest({
          request,
          method: "post",
          urlSuffix: config.endpoint(profileId),
          headers: config.headers(wiremockStub),
          data: config.buildRequest("Setup request to create model entry"),
        });

        if (!setupResponse.ok()) {
          const errorText = await setupResponse.text();
          throw new Error(
            `Setup ${config.providerName} request failed: ${setupResponse.status()} ${errorText}`,
          );
        }

        // 3. Find the model by modelId via GET /api/models and set custom pricing
        const modelsResponse = await getModels(request);
        const allModels = await modelsResponse.json();
        const targetModel = allModels.find(
          (m: { modelId: string }) => m.modelId === config.modelName,
        );

        if (!targetModel) {
          throw new Error(
            `Model '${config.modelName}' not found after setup request`,
          );
        }
        modelUuid = targetModel.id;

        // Reset any existing custom pricing first, then set our test values
        await updateModelPricing(request, modelUuid, {
          customPricePerMillionInput:
            config.customPricing.pricePerMillionInput,
          customPricePerMillionOutput:
            config.customPricing.pricePerMillionOutput,
        });

        // 4. Create profile-level limit with $2 value (each request costs $2.60, so usage exceeds limit after next request)
        const limitResponse = await createLimit(request, {
          entityType: "agent",
          entityId: profileId,
          limitType: "token_cost",
          limitValue: 2,
          model: [config.modelName],
        });
        const limit = await limitResponse.json();
        limitId = limit.id;

        // 5. Make first tracked request with custom pricing (with long content to bypass optimization rules)
        const longContent =
          "This is a very long message to bypass optimization rules that typically only apply to short content under 1000 tokens. ".repeat(
            100,
          );

        const initialResponse = await makeApiRequest({
          request,
          method: "post",
          urlSuffix: config.endpoint(profileId),
          headers: config.headers(wiremockStub),
          data: config.buildRequest(longContent),
        });

        if (!initialResponse.ok()) {
          const errorText = await initialResponse.text();
          throw new Error(
            `Initial ${config.providerName} request failed: ${initialResponse.status()} ${errorText}`,
          );
        }

        // Poll for async usage tracking to complete
        // Usage tracking happens asynchronously after the response is sent
        // We need to wait until the usage is actually recorded before the next request
        // The limits endpoint returns modelUsage array with { model, tokensIn, tokensOut, cost }
        // Use generous timeouts - in CI, async tracking can be very slow due to resource contention
        // across parallel test suites and multiple providers running concurrently
        const maxPollingAttempts = 90;
        const pollingIntervalMs = 1000;
        let usageTracked = false;

        for (let attempt = 0; attempt < maxPollingAttempts; attempt++) {
          const limitsResponse = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: `/api/limits?entityType=agent&entityId=${profileId}`,
            ignoreStatusCheck: true,
          });

          if (limitsResponse.ok()) {
            const limits = await limitsResponse.json();
            const targetLimit = limits.find(
              (l: {
                id: string;
                modelUsage?: Array<{ model: string; cost: number }>;
              }) => l.id === limitId,
            );
            // Check if usage cost has reached the limit value.
            // Polling for cost > 0 is insufficient because the usage may be partially
            // tracked (e.g. only input tokens recorded) before the full cost is computed.
            // We need to wait until the tracked cost actually exceeds the limit ($2)
            // so the next request will be blocked with 429.
            const totalCost =
              targetLimit?.modelUsage?.reduce(
                (sum: number, m: { cost: number }) => sum + m.cost,
                0,
              ) ?? 0;
            if (totalCost >= 2) {
              usageTracked = true;
              break;
            }
          }

          await new Promise((resolve) =>
            setTimeout(resolve, pollingIntervalMs),
          );
        }

        if (!usageTracked) {
          throw new Error(
            `Usage was not tracked after ${maxPollingAttempts * pollingIntervalMs}ms`,
          );
        }

        // 6. Next request should be blocked (limit exceeded)
        const blockedResponse = await makeApiRequest({
          request,
          method: "post",
          urlSuffix: config.endpoint(profileId),
          headers: config.headers(wiremockStub),
          data: config.buildRequest(
            "This should be blocked because we exceeded the limit",
          ),
          ignoreStatusCheck: true,
        });

        // 7. Verify 429 response with token_cost_limit_exceeded code
        expect(blockedResponse.status()).toBe(429);
        const errorBody = await blockedResponse.json();
        expect(errorBody.error.code).toBe("token_cost_limit_exceeded");
        expect(errorBody.error.type).toBe("rate_limit_exceeded");
      });

      test("allows request when under limit", async ({
        request,
        createAgent,
        createLimit,
        getModels,
        updateModelPricing,
        makeApiRequest,
      }) => {
        // 1. Create a test profile
        const createResponse = await createAgent(
          request,
          `${config.providerName} Token Limit OK Test Profile`,
        );
        const profile = await createResponse.json();
        profileId = profile.id;

        // 2. Make a setup request to trigger model creation
        const setupResponse = await makeApiRequest({
          request,
          method: "post",
          urlSuffix: config.endpoint(profileId),
          headers: config.headers(wiremockStub),
          data: config.buildRequest("Setup request to create model entry"),
        });

        if (!setupResponse.ok()) {
          const errorText = await setupResponse.text();
          throw new Error(
            `Setup ${config.providerName} request failed: ${setupResponse.status()} ${errorText}`,
          );
        }

        // 3. Find the model and set custom pricing
        const modelsResponse = await getModels(request);
        const allModels = await modelsResponse.json();
        const targetModel = allModels.find(
          (m: { modelId: string }) => m.modelId === config.modelName,
        );

        if (targetModel) {
          modelUuid = targetModel.id;
          await updateModelPricing(request, modelUuid, {
            customPricePerMillionInput:
              config.customPricing.pricePerMillionInput,
            customPricePerMillionOutput:
              config.customPricing.pricePerMillionOutput,
          });
        }

        // 4. Create profile-level limit with high value
        const limitResponse = await createLimit(request, {
          entityType: "agent",
          entityId: profileId,
          limitType: "token_cost",
          limitValue: 1000,
          model: [config.modelName],
        });
        const limit = await limitResponse.json();
        limitId = limit.id;

        // 5. First request should succeed
        const response1 = await makeApiRequest({
          request,
          method: "post",
          urlSuffix: config.endpoint(profileId),
          headers: config.headers(wiremockStub),
          data: config.buildRequest("Hello"),
        });
        expect(response1.ok()).toBeTruthy();

        // 6. Second request should also succeed (still under limit)
        const response2 = await makeApiRequest({
          request,
          method: "post",
          urlSuffix: config.endpoint(profileId),
          headers: config.headers(wiremockStub),
          data: config.buildRequest("Hello again"),
        });
        expect(response2.ok()).toBeTruthy();
      });

      test.afterEach(
        async ({ request, deleteLimit, deleteAgent, updateModelPricing }) => {
          if (limitId) {
            await deleteLimit(request, limitId).catch(() => {});
            limitId = "";
          }
          if (profileId) {
            await deleteAgent(request, profileId).catch(() => {});
            profileId = "";
          }
          // Reset custom pricing back to null so other tests use default pricing
          if (modelUuid) {
            await updateModelPricing(request, modelUuid, {
              customPricePerMillionInput: null,
              customPricePerMillionOutput: null,
            }).catch(() => {});
            modelUuid = "";
          }
        },
      );
    },
  );
}
