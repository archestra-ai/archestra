import type { SupportedProvider } from "@shared";
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
  provider: SupportedProvider;

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

const cerebrasConfig: ModelOptimizationTestConfig = {
  providerName: "Cerebras",
  provider: "cerebras",

  endpoint: (agentId) => `/v1/cerebras/${agentId}/chat/completions`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content, tools) => {
    const request: Record<string, unknown> = {
      model: "e2e-test-cerebras-baseline",
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

  baselineModel: "e2e-test-cerebras-baseline",
  optimizedModel: "e2e-test-cerebras-optimized",

  getModelFromResponse: (response) => response.model,
};

const vllmConfig: ModelOptimizationTestConfig = {
  providerName: "vLLM",
  provider: "vllm",

  endpoint: (agentId) => `/v1/vllm/${agentId}/chat/completions`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content, tools) => {
    const request: Record<string, unknown> = {
      model: "e2e-test-vllm-baseline",
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

  baselineModel: "e2e-test-vllm-baseline",
  optimizedModel: "e2e-test-vllm-optimized",

  getModelFromResponse: (response) => response.model,
};

const ollamaConfig: ModelOptimizationTestConfig = {
  providerName: "Ollama",
  provider: "ollama",

  endpoint: (agentId) => `/v1/ollama/${agentId}/chat/completions`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content, tools) => {
    const request: Record<string, unknown> = {
      model: "e2e-test-ollama-baseline",
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

  baselineModel: "e2e-test-ollama-baseline",
  optimizedModel: "e2e-test-ollama-optimized",

  getModelFromResponse: (response) => response.model,
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Generate a message with ~1200 tokens (between 1000 and 1500).
 * This should trigger the optimization rule with maxLength: 1500.
 */
function generateShortMessage(): string {
  return "test ".repeat(1200);
}

/**
 * Generate a long message with ~1600 tokens (> 1500).
 * This should NOT trigger the optimization rule with maxLength: 1500.
 */
function generateLongMessage(): string {
  return "test ".repeat(1600);
}

// =============================================================================
// Test Suite
// =============================================================================

const testConfigs: ModelOptimizationTestConfig[] = [
  openaiConfig,
  anthropicConfig,
  geminiConfig,
  cerebrasConfig,
  vllmConfig,
  ollamaConfig,
];

test.describe("LLMProxy-ModelOptimization", () => {
  for (const config of testConfigs) {
    // Each provider's tests run serially within the provider
    test.describe(config.providerName, () => {
      test.describe.configure({ mode: "serial" });

      let agentId: string;
      let optimizationRuleId: string;

      test.afterEach(
        async ({ request, deleteOptimizationRule, deleteAgent }) => {
          if (optimizationRuleId) {
            await deleteOptimizationRule(request, optimizationRuleId);
            optimizationRuleId = "";
          }
          if (agentId) {
            await deleteAgent(request, agentId);
            agentId = "";
          }
        },
      );

      test("swaps model when length is between 1000 and 1500", async ({
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
          `${config.providerName} Model Optimization Short Test`,
        );
        const agent = await createResponse.json();
        agentId = agent.id;

        // 2. Create optimization rule: swap model when < 1500 tokens
        const organizationId = await getActiveOrganizationId(request);
        const ruleResponse = await createOptimizationRule(request, {
          entityType: "organization",
          entityId: organizationId,
          provider: config.provider,
          conditions: [{ maxLength: 1500 }],
          targetModel: config.optimizedModel,
          enabled: true,
        });
        const rule = await ruleResponse.json();
        optimizationRuleId = rule.id;

        // 3. Send a ~1200 token message (should trigger optimization)
        // WireMock stub expects the optimized model in request body - returns 404 if wrong model
        const response = await makeApiRequest({
          request,
          method: "post",
          urlSuffix: config.endpoint(agentId),
          headers: config.headers(wiremockStub),
          data: config.buildRequest(generateShortMessage()),
        });

        // WireMock body matcher verifies the model was swapped to optimized
        expect(response.ok()).toBeTruthy();
      });

      test("does NOT swap model when length > 1500", async ({
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
          `${config.providerName} Model Optimization Long Test`,
        );
        const agent = await createResponse.json();
        agentId = agent.id;

        // 2. Create optimization rule: swap model when < 1500 tokens
        const organizationId = await getActiveOrganizationId(request);
        const ruleResponse = await createOptimizationRule(request, {
          entityType: "organization",
          entityId: organizationId,
          provider: config.provider,
          conditions: [{ maxLength: 1500 }],
          targetModel: config.optimizedModel,
          enabled: true,
        });
        const rule = await ruleResponse.json();
        optimizationRuleId = rule.id;

        // 3. Send a ~1600 token message (should NOT trigger optimization)
        // WireMock stub expects the baseline model in request body - returns 404 if wrong model
        const response = await makeApiRequest({
          request,
          method: "post",
          urlSuffix: config.endpoint(agentId),
          headers: config.headers(wiremockStub),
          data: config.buildRequest(generateLongMessage()),
        });

        // WireMock body matcher verifies the model was NOT swapped (stays baseline)
        expect(response.ok()).toBeTruthy();
      });

      test("swaps model when tools are present", async ({
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
          `${config.providerName} Model Optimization WithTools Test`,
        );
        const agent = await createResponse.json();
        agentId = agent.id;

        // 2. Create optimization rule: swap model when request HAS tools
        const organizationId = await getActiveOrganizationId(request);
        const ruleResponse = await createOptimizationRule(request, {
          entityType: "organization",
          entityId: organizationId,
          provider: config.provider,
          conditions: [{ hasTools: true }],
          targetModel: config.optimizedModel,
          enabled: true,
        });
        const rule = await ruleResponse.json();
        optimizationRuleId = rule.id;

        // 3. Send a request WITH tools (should trigger optimization)
        // WireMock stub expects the optimized model in request body - returns 404 if wrong model
        const response = await makeApiRequest({
          request,
          method: "post",
          urlSuffix: config.endpoint(agentId),
          headers: config.headers(wiremockStub),
          data: config.buildRequest(generateShortMessage(), [READ_FILE_TOOL]),
        });

        // WireMock body matcher verifies the model was swapped to optimized
        expect(response.ok()).toBeTruthy();
      });

      test("does NOT swap model when tools are absent", async ({
        request,
        createAgent,
        createOptimizationRule,
        getActiveOrganizationId,
        makeApiRequest,
      }) => {
        const wiremockStub = `${config.providerName.toLowerCase()}-model-optimization-no-tools`;

        // 1. Create a test agent
        const createResponse = await createAgent(
          request,
          `${config.providerName} Model Optimization NoTools Test`,
        );
        const agent = await createResponse.json();
        agentId = agent.id;

        // 2. Create optimization rule: swap model when request HAS tools
        const organizationId = await getActiveOrganizationId(request);
        const ruleResponse = await createOptimizationRule(request, {
          entityType: "organization",
          entityId: organizationId,
          provider: config.provider,
          conditions: [{ hasTools: true }],
          targetModel: config.optimizedModel,
          enabled: true,
        });
        const rule = await ruleResponse.json();
        optimizationRuleId = rule.id;

        // 3. Send a request WITHOUT tools (should NOT trigger optimization)
        // WireMock stub expects the baseline model in request body - returns 404 if wrong model
        const response = await makeApiRequest({
          request,
          method: "post",
          urlSuffix: config.endpoint(agentId),
          headers: config.headers(wiremockStub),
          data: config.buildRequest(generateShortMessage()),
        });

        // WireMock body matcher verifies the model was NOT swapped (stays baseline)
        expect(response.ok()).toBeTruthy();
      });
    });
  }
});
