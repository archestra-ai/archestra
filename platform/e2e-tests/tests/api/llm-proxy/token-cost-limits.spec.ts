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
  tokenPrice: {
    provider: "openai" | "anthropic" | "gemini";
    model: string;
    pricePerMillionInput: string;
    pricePerMillionOutput: string;
  };
}

// =============================================================================
// Test Configurations
// =============================================================================

const openaiConfig: TokenCostLimitTestConfig = {
  providerName: "OpenAI",

  endpoint: (profileId) => `/v1/openai/${profileId}/chat/completions`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content) => ({
    model: "gpt-4",
    messages: [{ role: "user", content }],
  }),

  modelName: "gpt-4",

  // WireMock returns: prompt_tokens: 100, completion_tokens: 20
  // Cost = (100 * 30 + 20 * 60) / 1,000,000 = $0.0042
  tokenPrice: {
    provider: "openai",
    model: "gpt-4",
    pricePerMillionInput: "30.00",
    pricePerMillionOutput: "60.00",
  },
};

const anthropicConfig: TokenCostLimitTestConfig = {
  providerName: "Anthropic",

  endpoint: (profileId) => `/v1/anthropic/${profileId}/v1/messages`,

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

  modelName: "claude-3-5-sonnet-20241022",

  // WireMock returns: input_tokens: 100, output_tokens: 20
  // Cost = (100 * 3 + 20 * 15) / 1,000,000 = $0.0006
  tokenPrice: {
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
    pricePerMillionInput: "3.00",
    pricePerMillionOutput: "15.00",
  },
};

const geminiConfig: TokenCostLimitTestConfig = {
  providerName: "Gemini",

  endpoint: (profileId) =>
    `/v1/gemini/${profileId}/v1beta/models/gemini-2.5-pro:generateContent`,

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

  modelName: "gemini-2.5-pro",

  // WireMock returns: promptTokenCount: 100, candidatesTokenCount: 20
  // Cost = (100 * 1.25 + 20 * 5) / 1,000,000 = $0.000225
  tokenPrice: {
    provider: "gemini",
    model: "gemini-2.5-pro",
    pricePerMillionInput: "1.25",
    pricePerMillionOutput: "5.00",
  },
};

// =============================================================================
// Test Suite
// =============================================================================

const testConfigs: TokenCostLimitTestConfig[] = [
  openaiConfig,
  anthropicConfig,
  geminiConfig,
];

for (const config of testConfigs) {
  test.describe(`LLMProxy-TokenCostLimits-${config.providerName}`, () => {
    let profileId: string;
    let limitId: string;
    let tokenPriceId: string;

    const wiremockStub = `${config.providerName.toLowerCase()}-token-cost-limit-test`;

    test("blocks request when profile token cost limit is exceeded", async ({
      request,
      createAgent,
      createLimit,
      createTokenPrice,
      makeApiRequest,
    }) => {
      // 0. Create token price for the model
      const tokenPriceResponse = await createTokenPrice(
        request,
        config.tokenPrice,
      );
      if (tokenPriceResponse.ok()) {
        const tokenPrice = await tokenPriceResponse.json();
        tokenPriceId = tokenPrice.id;
      }

      // 1. Create a test profile
      const createResponse = await createAgent(
        request,
        `${config.providerName} Token Limit Test Profile`,
      );
      const profile = await createResponse.json();
      profileId = profile.id;

      // 2. Create profile-level limit with very low value (effectively $0)
      const limitResponse = await createLimit(request, {
        entityType: "agent",
        entityId: profileId,
        limitType: "token_cost",
        limitValue: 0.0000001,
        model: [config.modelName],
      });
      const limit = await limitResponse.json();
      limitId = limit.id;

      // 3. Make first request to set up usage
      const initialResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: config.endpoint(profileId),
        headers: config.headers(wiremockStub),
        data: config.buildRequest("Hello"),
      });

      if (!initialResponse.ok()) {
        const errorText = await initialResponse.text();
        throw new Error(
          `Initial ${config.providerName} request failed: ${initialResponse.status()} ${errorText}`,
        );
      }

      // 4. Second request should be blocked (limit exceeded)
      const blockedResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: config.endpoint(profileId),
        headers: config.headers(wiremockStub),
        data: config.buildRequest("This should be blocked"),
        ignoreStatusCheck: true,
      });

      // 5. Verify 429 response with token_cost_limit_exceeded code
      expect(blockedResponse.status()).toBe(429);
      const errorBody = await blockedResponse.json();
      expect(errorBody.error.code).toBe("token_cost_limit_exceeded");
      expect(errorBody.error.type).toBe("rate_limit_exceeded");
    });

    test("allows request when under limit", async ({
      request,
      createAgent,
      createLimit,
      createTokenPrice,
      makeApiRequest,
    }) => {
      // 0. Create token price for the model
      const tokenPriceResponse = await createTokenPrice(
        request,
        config.tokenPrice,
      );
      if (tokenPriceResponse.ok()) {
        const tokenPrice = await tokenPriceResponse.json();
        tokenPriceId = tokenPrice.id;
      }

      // 1. Create a test profile
      const createResponse = await createAgent(
        request,
        `${config.providerName} Token Limit OK Test Profile`,
      );
      const profile = await createResponse.json();
      profileId = profile.id;

      // 2. Create profile-level limit with high value
      const limitResponse = await createLimit(request, {
        entityType: "agent",
        entityId: profileId,
        limitType: "token_cost",
        limitValue: 1000,
        model: [config.modelName],
      });
      const limit = await limitResponse.json();
      limitId = limit.id;

      // 3. First request should succeed
      const response1 = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: config.endpoint(profileId),
        headers: config.headers(wiremockStub),
        data: config.buildRequest("Hello"),
      });
      expect(response1.ok()).toBeTruthy();

      // 4. Second request should also succeed (still under limit)
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
      async ({ request, deleteLimit, deleteAgent, deleteTokenPrice }) => {
        if (limitId) {
          await deleteLimit(request, limitId).catch(() => {});
          limitId = "";
        }
        if (profileId) {
          await deleteAgent(request, profileId).catch(() => {});
          profileId = "";
        }
        if (tokenPriceId) {
          await deleteTokenPrice(request, tokenPriceId).catch(() => {});
          tokenPriceId = "";
        }
      },
    );
  });
}
