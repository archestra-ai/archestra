import type { SupportedProvider } from "@shared";
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

const cerebrasConfig: ToolPersistenceTestConfig = {
  providerName: "Cerebras",

  endpoint: (agentId) => `/v1/cerebras/${agentId}/chat/completions`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content, tools) => ({
    model: "llama-4-scout-17b-16e-instruct",
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

const mistralConfig: ToolPersistenceTestConfig = {
  providerName: "Mistral",

  endpoint: (agentId) => `/v1/mistral/${agentId}/chat/completions`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content, tools) => ({
    model: "mistral-large-latest",
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

const vllmConfig: ToolPersistenceTestConfig = {
  providerName: "vLLM",

  endpoint: (agentId) => `/v1/vllm/${agentId}/chat/completions`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content, tools) => ({
    model: "meta-llama/Llama-3.1-8B-Instruct",
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

const ollamaConfig: ToolPersistenceTestConfig = {
  providerName: "Ollama",

  endpoint: (agentId) => `/v1/ollama/${agentId}/chat/completions`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content, tools) => ({
    model: "qwen2:0.5b",
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

const zhipuaiConfig: ToolPersistenceTestConfig = {
  providerName: "Zhipuai",

  endpoint: (agentId) => `/v1/zhipuai/${agentId}/chat/completions`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content, tools) => ({
    model: "glm-4.5-flash",
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

const cohereConfig: ToolPersistenceTestConfig = {
  providerName: "Cohere",

  endpoint: (agentId) => `/v1/cohere/${agentId}/chat`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content, tools) => ({
    model: "command-r-plus-08-2024",
    messages: [{ role: "user", content: [{ type: "text", text: content }] }],
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

const groqConfig: ToolPersistenceTestConfig = {
  providerName: "Groq",

  endpoint: (agentId) => `/v1/groq/${agentId}/chat/completions`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content, tools) => ({
    model: "llama-3.1-8b-instant",
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

const minimaxConfig: ToolPersistenceTestConfig = {
  providerName: "Minimax",

  endpoint: (agentId) => `/v1/minimax/${agentId}/chat/completions`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content, tools) => ({
    model: "MiniMax-M2.1",
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

const deepseekConfig: ToolPersistenceTestConfig = {
  providerName: "DeepSeek",

  endpoint: (agentId) => `/v1/deepseek/${agentId}/chat/completions`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content, tools) => ({
    model: "deepseek-chat",
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

const bedrockConfig: ToolPersistenceTestConfig = {
  providerName: "Bedrock",

  endpoint: (agentId) => `/v1/bedrock/${agentId}/converse`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content, tools) => ({
    modelId: "anthropic.claude-3-sonnet-20240229-v1:0",
    messages: [{ role: "user", content: [{ text: content }] }],
    toolConfig: {
      tools: tools.map((t) => ({
        toolSpec: {
          name: t.name,
          description: t.description,
          inputSchema: { json: t.parameters },
        },
      })),
    },
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
  groq: groqConfig,
  cerebras: cerebrasConfig,
  mistral: mistralConfig,
  vllm: vllmConfig,
  ollama: ollamaConfig,
  zhipuai: zhipuaiConfig,
  minimax: minimaxConfig,
  deepseek: deepseekConfig,
  bedrock: bedrockConfig,
  perplexity: null, // Perplexity does not support tool calling
} satisfies Record<SupportedProvider, ToolPersistenceTestConfig | null>;

const testConfigs = Object.values(testConfigsMap).filter(
  (c): c is ToolPersistenceTestConfig => c !== null,
);

for (const config of testConfigs) {
  test.describe(`LLMProxy-ToolPersistence-${config.providerName}`, () => {
    let agentId: string;

    test("persists tools from LLM proxy request", async ({
      request,
      createLlmProxy,
      makeApiRequest,
      waitForProxyTool,
    }) => {
      const provider = config.providerName.toLowerCase();
      const wiremockStub = `${provider}-tool-persistence`;
      const toolOneName = `e2e_persist_tool_1_${provider}`;
      const toolTwoName = `e2e_persist_tool_2_${provider}`;

      // 1. Create test LLM proxy (tool persistence only applies to llm_proxy agents)
      const createResponse = await createLlmProxy(
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
          {
            name: toolOneName,
            description: "Test tool for persistence",
            parameters: {
              type: "object",
              properties: { input: { type: "string", description: "Input" } },
              required: ["input"],
            },
          },
          {
            name: toolTwoName,
            description: "Test tool for persistence",
            parameters: {
              type: "object",
              properties: { value: { type: "number", description: "Value" } },
              required: ["value"],
            },
          },
        ]),
      });
      expect(response.ok()).toBeTruthy();

      // 3. Verify tools are persisted using waitForProxyTool
      const toolOne = await waitForProxyTool(request, toolOneName);
      expect(toolOne).toBeDefined();
      expect(toolOne.name).toBe(toolOneName);
      expect(toolOne.catalogId).toBeNull();

      const toolTwo = await waitForProxyTool(request, toolTwoName);
      expect(toolTwo).toBeDefined();
      expect(toolTwo.name).toBe(toolTwoName);
      expect(toolTwo.catalogId).toBeNull();
    });

    test("does not create duplicate tools when same request is sent twice", async ({
      request,
      createLlmProxy,
      makeApiRequest,
      waitForProxyTool,
    }) => {
      const provider = config.providerName.toLowerCase();
      const wiremockStub = `${provider}-tool-persistence-idempotency`;
      const toolName = `e2e_persist_tool_dedup_${provider}`;
      const tool: ToolDefinition = {
        name: toolName,
        description: "Test tool for dedup verification",
        parameters: {
          type: "object",
          properties: { input: { type: "string", description: "Input" } },
          required: ["input"],
        },
      };

      // 1. Create test LLM proxy (tool persistence only applies to llm_proxy agents)
      const createResponse = await createLlmProxy(
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
        data: config.buildRequest("First request", [tool]),
      });

      // 3. Wait for tool to be persisted
      await waitForProxyTool(request, toolName);

      // 4. Send second request with same tool
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: config.endpoint(agentId),
        headers: config.headers(wiremockStub),
        data: config.buildRequest("Second request", [tool]),
      });

      // 5. Small delay for any async processing
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // 6. Query tools and verify no duplicates
      const toolsResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/tools/with-assignments?search=${encodeURIComponent(toolName)}&origin=llm-proxy`,
      });
      const tools = await toolsResponse.json();

      // Filter to exact name match
      const matchingTools = tools.data.filter(
        (t: { name: string }) => t.name === toolName,
      );

      // Should have exactly 1 instance, not 2
      expect(matchingTools.length).toBe(1);
    });

    test.afterEach(async ({ request, deleteAgent }) => {
      if (agentId) {
        await deleteAgent(request, agentId);
        agentId = "";
      }
    });
  });
}
