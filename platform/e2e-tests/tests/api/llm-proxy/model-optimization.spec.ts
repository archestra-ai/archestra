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
      model: "gpt-4",
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

  baselineModel: "gpt-4",
  optimizedModel: "gpt-4o-mini",

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
      model: "claude-3-5-sonnet-20241022",
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

  baselineModel: "claude-3-5-sonnet-20241022",
  optimizedModel: "claude-3-5-haiku-20241022",

  getModelFromResponse: (response) => response.model,
};

const geminiConfig: ModelOptimizationTestConfig = {
  providerName: "Gemini",
  provider: "gemini",

  endpoint: (agentId) =>
    `/v1/gemini/${agentId}/v1beta/models/gemini-2.0-flash:generateContent`,

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

  baselineModel: "gemini-2.0-flash",
  optimizedModel: "gemini-2.0-flash-lite",

  getModelFromResponse: (response) => response.modelVersion,
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Generate a long message that exceeds typical maxLength thresholds.
 * We need enough content to exceed token limits (e.g., 1000 tokens).
 * Average English word is ~1.3 tokens, so ~800 words should exceed 1000 tokens.
 */
function generateLongMessage(): string {
  const baseText =
    "This is a test message to verify that model optimization rules do not apply when the message length exceeds the configured threshold. ";
  // Repeat to create a message with many tokens
  return baseText.repeat(100);
}

/**
 * Generate a short message that stays under typical maxLength thresholds.
 */
function generateShortMessage(): string {
  return "Hello, this is a short test message.";
}

// =============================================================================
// Test Suite
// =============================================================================

const testConfigs: ModelOptimizationTestConfig[] = [
  openaiConfig,
  anthropicConfig,
  geminiConfig,
];

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
        conditions: [{ maxLength: 1000 }], // Short messages (< 1000 tokens) should be optimized
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
        conditions: [{ maxLength: 1000 }], // Only short messages should be optimized
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
        conditions: [{ maxLength: 1000 }], // Would match, but rule is disabled
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
