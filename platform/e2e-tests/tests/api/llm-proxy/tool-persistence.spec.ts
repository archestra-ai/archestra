import { expect, test } from "../fixtures";

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

interface ToolPersistenceTestConfig {
  providerName: string;
  endpoint: (agentId: string) => string;
  headers: (wiremockStub: string) => Record<string, string>;
  buildRequest: (content: string, tools: ToolDefinition[]) => object;
}

// =============================================================================
// Test Tools (unique names to avoid collisions)
// =============================================================================

const E2E_PERSIST_TOOL_ALPHA: ToolDefinition = {
  name: "e2e_persist_test_tool_alpha",
  description: "Test tool alpha for persistence verification",
  parameters: {
    type: "object",
    properties: {
      input: { type: "string", description: "Input string" },
    },
    required: ["input"],
  },
};

const E2E_PERSIST_TOOL_BETA: ToolDefinition = {
  name: "e2e_persist_test_tool_beta",
  description: "Test tool beta for persistence verification",
  parameters: {
    type: "object",
    properties: {
      value: { type: "number", description: "Numeric value" },
    },
    required: ["value"],
  },
};

// =============================================================================
// Provider Configurations
// =============================================================================

const openaiConfig: ToolPersistenceTestConfig = {
  providerName: "OpenAI",

  endpoint: (agentId) => `/v1/openai/${agentId}/chat/completions`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content, tools) => ({
    model: "gpt-4",
    messages: [{ role: "user", content }],
    tools: tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    })),
  }),
};

const anthropicConfig: ToolPersistenceTestConfig = {
  providerName: "Anthropic",

  endpoint: (agentId) => `/v1/anthropic/${agentId}/v1/messages`,

  headers: (wiremockStub) => ({
    "x-api-key": wiremockStub,
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  }),

  buildRequest: (content, tools) => ({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 1024,
    messages: [{ role: "user", content }],
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    })),
  }),
};

const geminiConfig: ToolPersistenceTestConfig = {
  providerName: "Gemini",

  endpoint: (agentId) =>
    `/v1/gemini/${agentId}/v1beta/models/gemini-2.5-pro:generateContent`,

  headers: (wiremockStub) => ({
    "x-goog-api-key": wiremockStub,
    "Content-Type": "application/json",
  }),

  buildRequest: (content, tools) => ({
    contents: [
      {
        role: "user",
        parts: [{ text: content }],
      },
    ],
    tools: [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ],
  }),
};

// =============================================================================
// Test Suite
// =============================================================================

const testConfigs: ToolPersistenceTestConfig[] = [
  openaiConfig,
  anthropicConfig,
  geminiConfig,
];

for (const config of testConfigs) {
  test.describe(`LLMProxy-ToolPersistence-${config.providerName}`, () => {
    let agentId: string;

    test("persists tools from LLM proxy request", async ({
      request,
      createAgent,
      makeApiRequest,
      waitForAgentTool,
    }) => {
      const wiremockStub = `${config.providerName.toLowerCase()}-tool-persistence`;

      // 1. Create test profile with unique name
      const createResponse = await createAgent(
        request,
        `Tool Persistence Test - ${config.providerName}`,
      );
      const agent = await createResponse.json();
      agentId = agent.id;

      // 2. Send LLM proxy request with test tools
      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: config.endpoint(agentId),
        headers: config.headers(wiremockStub),
        data: config.buildRequest("Test message", [
          E2E_PERSIST_TOOL_ALPHA,
          E2E_PERSIST_TOOL_BETA,
        ]),
      });
      expect(response.ok()).toBeTruthy();

      // 3. Verify tools are persisted using waitForAgentTool
      const toolAlpha = await waitForAgentTool(
        request,
        agentId,
        "e2e_persist_test_tool_alpha",
      );
      expect(toolAlpha).toBeDefined();
      expect(toolAlpha.agent.id).toBe(agentId);
      expect(toolAlpha.tool.name).toBe("e2e_persist_test_tool_alpha");

      const toolBeta = await waitForAgentTool(
        request,
        agentId,
        "e2e_persist_test_tool_beta",
      );
      expect(toolBeta).toBeDefined();
      expect(toolBeta.agent.id).toBe(agentId);
      expect(toolBeta.tool.name).toBe("e2e_persist_test_tool_beta");
    });

    test("does not create duplicate tools when same request is sent twice", async ({
      request,
      createAgent,
      makeApiRequest,
      waitForAgentTool,
    }) => {
      const wiremockStub = `${config.providerName.toLowerCase()}-tool-persistence-idempotency`;

      // 1. Create test profile
      const createResponse = await createAgent(
        request,
        `Tool Persistence Idempotency Test - ${config.providerName}`,
      );
      const agent = await createResponse.json();
      agentId = agent.id;

      // 2. Send first request with test tool
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: config.endpoint(agentId),
        headers: config.headers(wiremockStub),
        data: config.buildRequest("First request", [E2E_PERSIST_TOOL_ALPHA]),
      });

      // 3. Wait for tool to be persisted
      await waitForAgentTool(request, agentId, "e2e_persist_test_tool_alpha");

      // 4. Send second request with same tool
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: config.endpoint(agentId),
        headers: config.headers(wiremockStub),
        data: config.buildRequest("Second request", [E2E_PERSIST_TOOL_ALPHA]),
      });

      // 5. Small delay for any async processing
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // 6. Query all agent-tools and verify no duplicates
      const agentToolsResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/agent-tools?agentId=${agentId}&limit=100`,
      });
      const agentTools = await agentToolsResponse.json();

      // Filter to only our test tool
      const alphaTools = agentTools.data.filter(
        (at: { tool: { name: string } }) =>
          at.tool.name === "e2e_persist_test_tool_alpha",
      );

      // Should have exactly 1 instance, not 2
      expect(alphaTools.length).toBe(1);
    });

    test.afterEach(async ({ request, deleteAgent }) => {
      if (agentId) {
        await deleteAgent(request, agentId);
        agentId = "";
      }
    });
  });
}
