import { expect, test } from "../fixtures";

// biome-ignore lint/suspicious/noExplicitAny: test file uses dynamic response structures
type AnyResponse = any;

// =============================================================================
// Test Configuration Interface
// =============================================================================

interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

interface ModelOptimizationTestConfig {
  providerName: string;
  provider: "openai" | "anthropic" | "gemini";

  // Request building
  endpoint: (agentId: string) => string;
  headers: (wiremockStub: string) => Record<string, string>;
  buildRequest: (content: string, tools?: ToolDefinition[]) => object;

  // Models
  baselineModel: string;
  optimizedModel: string;

  // Response extraction
  getModelFromResponse: (response: AnyResponse) => string;
}

// =============================================================================
// Shared Tool Definition (for hasTools tests)
// =============================================================================

const READ_FILE_TOOL: ToolDefinition = {
  name: "read_file",
  description: "Read a file from the filesystem",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The path to the file to read",
      },
    },
    required: ["file_path"],
  },
};

// =============================================================================
// Test Configurations
// =============================================================================

const openaiConfig: ModelOptimizationTestConfig = {
  providerName: "OpenAI",
  provider: "openai",

  endpoint: (agentId) => `/v1/openai/${agentId}/chat/completions`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content, tools) => {
    const request: Record<string, unknown> = {
      model: "e2e-test-openai-baseline",
      messages: [{ role: "user", content }],
    };
    if (tools && tools.length > 0) {
      request.tools = tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }
    return request;
  },

  baselineModel: "e2e-test-openai-baseline",
  optimizedModel: "e2e-test-openai-optimized",

  getModelFromResponse: (response) => response.model,
};

const anthropicConfig: ModelOptimizationTestConfig = {
  providerName: "Anthropic",
  provider: "anthropic",

  endpoint: (agentId) => `/v1/anthropic/${agentId}/v1/messages`,

  headers: (wiremockStub) => ({
    "x-api-key": wiremockStub,
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  }),

  buildRequest: (content, tools) => {
    const request: Record<string, unknown> = {
      model: "e2e-test-anthropic-baseline",
      max_tokens: 1024,
      messages: [{ role: "user", content }],
    };
    if (tools && tools.length > 0) {
      request.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }
    return request;
  },

  baselineModel: "e2e-test-anthropic-baseline",
  optimizedModel: "e2e-test-anthropic-optimized",

  getModelFromResponse: (response) => response.model,
};

const geminiConfig: ModelOptimizationTestConfig = {
  providerName: "Gemini",
  provider: "gemini",

  endpoint: (agentId) =>
    `/v1/gemini/${agentId}/v1beta/models/e2e-test-gemini-baseline:generateContent`,

  headers: (wiremockStub) => ({
    "x-goog-api-key": wiremockStub,
    "Content-Type": "application/json",
  }),

  buildRequest: (content, tools) => {
    const request: Record<string, unknown> = {
      contents: [
        {
          role: "user",
          parts: [{ text: content }],
        },
      ],
    };
    if (tools && tools.length > 0) {
      request.tools = [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }
    return request;
  },

  baselineModel: "e2e-test-gemini-baseline",
  optimizedModel: "e2e-test-gemini-optimized",

  getModelFromResponse: (response) => response.modelVersion,
};

// =============================================================================
// Helper Functions
// =============================================================================

// Token thresholds for test isolation:
// - Default org-level rules use maxLength: 1000
// - Our test rules use maxLength: 2000
// - "test " is ~1 token, so repeat count ≈ token count

/**
 * Generate a "short" message with ~1500 tokens (> 1000 AND < 2000).
 * This exceeds the default org-level rule threshold (1000) but stays under
 * our test rule threshold (2000), ensuring only test rules match.
 */
function generateShortMessage(): string {
  return "test ".repeat(1500); // ~1501 tokens
}

/**
 * Generate a long message with ~2100 tokens (> 2000).
 * This exceeds ALL maxLength thresholds, so no optimization rules match.
 */
function generateLongMessage(): string {
  return "test ".repeat(2100); // ~2101 tokens
}

// =============================================================================
// Test Suite
// =============================================================================
//
// HOW THESE TESTS WORK:
//
// These tests verify that the LLM Proxy correctly swaps models based on
// optimization rules (maxLength and hasTools conditions).
//
// Test Flow:
// 1. Test creates an optimization rule (e.g., swap to "optimized" model when
//    message length < 2000 tokens)
// 2. Test sends a request through LLM Proxy with the "baseline" model
// 3. LLM Proxy evaluates the optimization rules and either:
//    - Swaps the model to "optimized" (if conditions match)
//    - Keeps the "baseline" model (if conditions don't match)
// 4. LLM Proxy forwards the request to WireMock (mocked LLM provider)
//
// WireMock Request Validation:
// The WireMock stubs are configured to match BOTH the API key AND the model
// in the request:
// - OpenAI/Anthropic: `bodyPatterns` checks the model in the request body
// - Gemini: `urlPathPattern` checks the model in the URL path
//
// This ensures the test actually validates the optimization logic:
// - If the proxy sends the WRONG model → WireMock won't match → HTTP 404 → test fails
// - If the proxy sends the CORRECT model → WireMock matches → returns mock response
//
// Token Threshold Strategy:
// Default optimization rules use maxLength=1000. Our test rules use maxLength=2000.
// - "Short" messages: 1001-1999 tokens (exceeds default threshold, matches test threshold)
// - "Long" messages: 2001+ tokens (exceeds both thresholds, no rule matches)
// This isolation prevents default rules from interfering with our tests.
//
// =============================================================================

const testConfigs: ModelOptimizationTestConfig[] = [
  openaiConfig,
  anthropicConfig,
  geminiConfig,
];

// All optimization tests must run serially because they create org-level rules that can interfere
test.describe.configure({ mode: "serial" });

for (const config of testConfigs) {
  test.describe(`LLMProxy-ModelOptimization-${config.providerName}`, () => {
    let agentId: string;
    let optimizationRuleId: string;

    test("swaps model when maxLength condition matches (short message)", async ({
      request,
      createAgent,
      createOptimizationRule,
      getActiveOrganizationId,
      makeApiRequest,
    }) => {
      const wiremockStub = `${config.providerName.toLowerCase()}-model-optimization-short`;

      // 1. Create a test agent
      const createResponse = await createAgent(
        request,
        `${config.providerName} Model Optimization Test Agent`,
      );
      const agent = await createResponse.json();
      agentId = agent.id;

      // 2. Get organization ID and create optimization rule
      const organizationId = await getActiveOrganizationId(request);
      const ruleResponse = await createOptimizationRule(request, {
        entityType: "organization",
        entityId: organizationId,
        provider: config.provider,
        conditions: [{ maxLength: 2000 }], // Messages < 2000 tokens should be optimized (above default 1000 threshold)
        targetModel: config.optimizedModel,
        enabled: true,
      });
      const rule = await ruleResponse.json();
      optimizationRuleId = rule.id;

      // 3. Send a short message that should trigger model optimization
      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: config.endpoint(agentId),
        headers: config.headers(wiremockStub),
        data: config.buildRequest(generateShortMessage()),
      });

      expect(response.ok()).toBeTruthy();

      // 4. Verify the interaction was recorded with the optimized model
      const interactionsResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/interactions?agentId=${agentId}`,
      });
      expect(interactionsResponse.ok()).toBeTruthy();
      const interactionsData = await interactionsResponse.json();
      expect(interactionsData.data.length).toBeGreaterThan(0);

      // The most recent interaction should use the optimized model
      const interaction = interactionsData.data[0];
      expect(interaction.model).toBe(config.optimizedModel);
    });

    test("does NOT swap model when maxLength condition does NOT match (long message)", async ({
      request,
      createAgent,
      createOptimizationRule,
      getActiveOrganizationId,
      makeApiRequest,
    }) => {
      const wiremockStub = `${config.providerName.toLowerCase()}-model-optimization-long`;

      // 1. Create a test agent
      const createResponse = await createAgent(
        request,
        `${config.providerName} Model Optimization Long Test Agent`,
      );
      const agent = await createResponse.json();
      agentId = agent.id;

      // 2. Get organization ID and create optimization rule
      const organizationId = await getActiveOrganizationId(request);
      const ruleResponse = await createOptimizationRule(request, {
        entityType: "organization",
        entityId: organizationId,
        provider: config.provider,
        conditions: [{ maxLength: 2000 }], // Messages < 2000 tokens should be optimized (above default 1000 threshold)
        targetModel: config.optimizedModel,
        enabled: true,
      });
      const rule = await ruleResponse.json();
      optimizationRuleId = rule.id;

      // 3. Send a long message that should NOT trigger model optimization
      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: config.endpoint(agentId),
        headers: config.headers(wiremockStub),
        data: config.buildRequest(generateLongMessage()),
      });

      expect(response.ok()).toBeTruthy();

      // 4. Verify the interaction was recorded with the baseline model (not optimized)
      const interactionsResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/interactions?agentId=${agentId}`,
      });
      expect(interactionsResponse.ok()).toBeTruthy();
      const interactionsData = await interactionsResponse.json();
      expect(interactionsData.data.length).toBeGreaterThan(0);

      // The interaction should use the baseline model (optimization did not apply)
      const interaction = interactionsData.data[0];
      expect(interaction.model).toBe(config.baselineModel);
    });

    test("swaps model when hasTools condition matches (request without tools)", async ({
      request,
      createAgent,
      createOptimizationRule,
      getActiveOrganizationId,
      makeApiRequest,
    }) => {
      const wiremockStub = `${config.providerName.toLowerCase()}-model-optimization-short`;

      // 1. Create a test agent
      const createResponse = await createAgent(
        request,
        `${config.providerName} Model Optimization NoTools Test Agent`,
      );
      const agent = await createResponse.json();
      agentId = agent.id;

      // 2. Get organization ID and create optimization rule that matches when NO tools
      const organizationId = await getActiveOrganizationId(request);
      const ruleResponse = await createOptimizationRule(request, {
        entityType: "organization",
        entityId: organizationId,
        provider: config.provider,
        conditions: [{ hasTools: false }], // Requests without tools should be optimized
        targetModel: config.optimizedModel,
        enabled: true,
      });
      const rule = await ruleResponse.json();
      optimizationRuleId = rule.id;

      // 3. Send a request WITHOUT tools - should trigger optimization
      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: config.endpoint(agentId),
        headers: config.headers(wiremockStub),
        data: config.buildRequest(generateShortMessage()), // No tools passed
      });

      expect(response.ok()).toBeTruthy();

      // 4. Verify the interaction was recorded with the optimized model
      const interactionsResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/interactions?agentId=${agentId}`,
      });
      expect(interactionsResponse.ok()).toBeTruthy();
      const interactionsData = await interactionsResponse.json();
      expect(interactionsData.data.length).toBeGreaterThan(0);

      const interaction = interactionsData.data[0];
      expect(interaction.model).toBe(config.optimizedModel);
    });

    test("does NOT swap model when hasTools condition does NOT match (request with tools)", async ({
      request,
      createAgent,
      createOptimizationRule,
      getActiveOrganizationId,
      makeApiRequest,
    }) => {
      const wiremockStub = `${config.providerName.toLowerCase()}-model-optimization-with-tools`;

      // 1. Create a test agent
      const createResponse = await createAgent(
        request,
        `${config.providerName} Model Optimization WithTools Test Agent`,
      );
      const agent = await createResponse.json();
      agentId = agent.id;

      // 2. Get organization ID and create optimization rule that matches when NO tools
      const organizationId = await getActiveOrganizationId(request);
      const ruleResponse = await createOptimizationRule(request, {
        entityType: "organization",
        entityId: organizationId,
        provider: config.provider,
        conditions: [{ hasTools: false }], // Only requests WITHOUT tools should be optimized
        targetModel: config.optimizedModel,
        enabled: true,
      });
      const rule = await ruleResponse.json();
      optimizationRuleId = rule.id;

      // 3. Send a request WITH tools - should NOT trigger optimization
      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: config.endpoint(agentId),
        headers: config.headers(wiremockStub),
        data: config.buildRequest(generateShortMessage(), [READ_FILE_TOOL]),
      });

      expect(response.ok()).toBeTruthy();

      // 4. Verify the interaction was recorded with the baseline model (not optimized)
      const interactionsResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/interactions?agentId=${agentId}`,
      });
      expect(interactionsResponse.ok()).toBeTruthy();
      const interactionsData = await interactionsResponse.json();
      expect(interactionsData.data.length).toBeGreaterThan(0);

      const interaction = interactionsData.data[0];
      expect(interaction.model).toBe(config.baselineModel);
    });

    test("does NOT swap model when optimization rule is disabled", async ({
      request,
      createAgent,
      createOptimizationRule,
      getActiveOrganizationId,
      makeApiRequest,
    }) => {
      const wiremockStub = `${config.providerName.toLowerCase()}-model-optimization-disabled`;

      // 1. Create a test agent
      const createResponse = await createAgent(
        request,
        `${config.providerName} Model Optimization Disabled Test Agent`,
      );
      const agent = await createResponse.json();
      agentId = agent.id;

      // 2. Get organization ID and create a DISABLED optimization rule
      const organizationId = await getActiveOrganizationId(request);
      const ruleResponse = await createOptimizationRule(request, {
        entityType: "organization",
        entityId: organizationId,
        provider: config.provider,
        conditions: [{ maxLength: 2000 }], // Would match, but rule is disabled
        targetModel: config.optimizedModel,
        enabled: false, // Rule is disabled
      });
      const rule = await ruleResponse.json();
      optimizationRuleId = rule.id;

      // 3. Send a short message that would match the condition if rule was enabled
      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: config.endpoint(agentId),
        headers: config.headers(wiremockStub),
        data: config.buildRequest(generateShortMessage()),
      });

      expect(response.ok()).toBeTruthy();

      // 4. Verify the interaction was recorded with the baseline model (rule was disabled)
      const interactionsResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/interactions?agentId=${agentId}`,
      });
      expect(interactionsResponse.ok()).toBeTruthy();
      const interactionsData = await interactionsResponse.json();
      expect(interactionsData.data.length).toBeGreaterThan(0);

      const interaction = interactionsData.data[0];
      expect(interaction.model).toBe(config.baselineModel);
    });

    test.afterEach(async ({ request, deleteOptimizationRule, deleteAgent }) => {
      if (optimizationRuleId) {
        await deleteOptimizationRule(request, optimizationRuleId);
        optimizationRuleId = "";
      }
      if (agentId) {
        await deleteAgent(request, agentId);
        agentId = "";
      }
    });
  });
}
