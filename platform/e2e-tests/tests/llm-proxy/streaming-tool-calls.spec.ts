import type { SupportedProvider } from "@shared";
import { expect, test } from "../api-fixtures";

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

interface StreamingToolCallTestConfig {
  providerName: string;
  providerSlug: string;
  endpoint: (agentId: string) => string;
  headers: (wiremockStub: string) => Record<string, string>;
  buildStreamingRequest: (content: string, tools: ToolDefinition[]) => object;
  expectedToolName: string;
}

// =============================================================================
// Shared Tool Definition
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
// OpenAI-compatible streaming request builder (shared by multiple providers)
// =============================================================================

function buildOpenAIStreamingRequest(
  model: string,
  content: string,
  tools: ToolDefinition[],
): object {
  return {
    model,
    stream: true,
    messages: [{ role: "user", content }],
    tools: tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    })),
  };
}

// =============================================================================
// Test Configurations
// =============================================================================

const openaiConfig: StreamingToolCallTestConfig = {
  providerName: "OpenAI",
  providerSlug: "openai",
  endpoint: (agentId) => `/v1/openai/${agentId}/chat/completions`,
  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),
  buildStreamingRequest: (content, tools) =>
    buildOpenAIStreamingRequest("gpt-4", content, tools),
  expectedToolName: "read_file",
};

const azureConfig: StreamingToolCallTestConfig = {
  providerName: "Azure",
  providerSlug: "azure",
  endpoint: (agentId) => `/v1/azure/${agentId}/chat/completions`,
  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),
  buildStreamingRequest: (content, tools) =>
    buildOpenAIStreamingRequest("gpt-4o", content, tools),
  expectedToolName: "read_file",
};

const azureResponsesConfig: StreamingToolCallTestConfig = {
  providerName: "Azure Responses",
  providerSlug: "azure-responses",
  endpoint: (agentId) => `/v1/azure/${agentId}/responses`,
  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),
  buildStreamingRequest: (content, tools) => ({
    model: "gpt-4.1",
    stream: true,
    input: content,
    tools: tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  }),
  expectedToolName: "read_file",
};

const anthropicConfig: StreamingToolCallTestConfig = {
  providerName: "Anthropic",
  providerSlug: "anthropic",
  endpoint: (agentId) => `/v1/anthropic/${agentId}/v1/messages`,
  headers: (wiremockStub) => ({
    "x-api-key": wiremockStub,
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  }),
  buildStreamingRequest: (content, tools) => ({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 1024,
    stream: true,
    messages: [{ role: "user", content }],
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    })),
  }),
  expectedToolName: "read_file",
};

const geminiConfig: StreamingToolCallTestConfig = {
  providerName: "Gemini",
  providerSlug: "gemini",
  endpoint: (agentId) =>
    `/v1/gemini/${agentId}/v1beta/models/gemini-2.5-pro:streamGenerateContent`,
  headers: (wiremockStub) => ({
    "x-goog-api-key": wiremockStub,
    "Content-Type": "application/json",
  }),
  buildStreamingRequest: (content, tools) => ({
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
  expectedToolName: "read_file",
};

const cohereConfig: StreamingToolCallTestConfig = {
  providerName: "Cohere",
  providerSlug: "cohere",
  endpoint: (agentId) => `/v1/cohere/${agentId}/chat`,
  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),
  buildStreamingRequest: (content, tools) => ({
    model: "command-r-plus-08-2024",
    stream: true,
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
  expectedToolName: "read_file",
};

const cerebrasConfig: StreamingToolCallTestConfig = {
  providerName: "Cerebras",
  providerSlug: "cerebras",
  endpoint: (agentId) => `/v1/cerebras/${agentId}/chat/completions`,
  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),
  buildStreamingRequest: (content, tools) =>
    buildOpenAIStreamingRequest(
      "llama-4-scout-17b-16e-instruct",
      content,
      tools,
    ),
  expectedToolName: "read_file",
};

const groqConfig: StreamingToolCallTestConfig = {
  providerName: "Groq",
  providerSlug: "groq",
  endpoint: (agentId) => `/v1/groq/${agentId}/chat/completions`,
  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),
  buildStreamingRequest: (content, tools) =>
    buildOpenAIStreamingRequest("llama-3.1-8b-instant", content, tools),
  expectedToolName: "read_file",
};

const mistralConfig: StreamingToolCallTestConfig = {
  providerName: "Mistral",
  providerSlug: "mistral",
  endpoint: (agentId) => `/v1/mistral/${agentId}/chat/completions`,
  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),
  buildStreamingRequest: (content, tools) =>
    buildOpenAIStreamingRequest("mistral-large-latest", content, tools),
  expectedToolName: "read_file",
};

const vllmConfig: StreamingToolCallTestConfig = {
  providerName: "vLLM",
  providerSlug: "vllm",
  endpoint: (agentId) => `/v1/vllm/${agentId}/chat/completions`,
  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),
  buildStreamingRequest: (content, tools) =>
    buildOpenAIStreamingRequest(
      "meta-llama/Llama-3.1-8B-Instruct",
      content,
      tools,
    ),
  expectedToolName: "read_file",
};

const ollamaConfig: StreamingToolCallTestConfig = {
  providerName: "Ollama",
  providerSlug: "ollama",
  endpoint: (agentId) => `/v1/ollama/${agentId}/chat/completions`,
  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),
  buildStreamingRequest: (content, tools) =>
    buildOpenAIStreamingRequest("qwen2:0.5b", content, tools),
  expectedToolName: "read_file",
};

const zhipuaiConfig: StreamingToolCallTestConfig = {
  providerName: "Zhipuai",
  providerSlug: "zhipuai",
  endpoint: (agentId) => `/v1/zhipuai/${agentId}/chat/completions`,
  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),
  buildStreamingRequest: (content, tools) =>
    buildOpenAIStreamingRequest("glm-4.5-flash", content, tools),
  expectedToolName: "read_file",
};

const minimaxConfig: StreamingToolCallTestConfig = {
  providerName: "Minimax",
  providerSlug: "minimax",
  endpoint: (agentId) => `/v1/minimax/${agentId}/chat/completions`,
  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),
  buildStreamingRequest: (content, tools) =>
    buildOpenAIStreamingRequest("MiniMax-M2.1", content, tools),
  expectedToolName: "read_file",
};

const deepseekConfig: StreamingToolCallTestConfig = {
  providerName: "DeepSeek",
  providerSlug: "deepseek",
  endpoint: (agentId) => `/v1/deepseek/${agentId}/chat/completions`,
  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),
  buildStreamingRequest: (content, tools) =>
    buildOpenAIStreamingRequest("deepseek-chat", content, tools),
  expectedToolName: "read_file",
};

const openrouterConfig: StreamingToolCallTestConfig = {
  providerName: "OpenRouter",
  providerSlug: "openrouter",
  endpoint: (agentId) => `/v1/openrouter/${agentId}/chat/completions`,
  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),
  buildStreamingRequest: (content, tools) =>
    buildOpenAIStreamingRequest(
      "test-openrouter-streaming-tool-calls",
      content,
      tools,
    ),
  expectedToolName: "read_file",
};

const xaiConfig: StreamingToolCallTestConfig = {
  providerName: "xAI",
  providerSlug: "xai",
  endpoint: (agentId) => `/v1/xai/${agentId}/chat/completions`,
  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),
  buildStreamingRequest: (content, tools) =>
    buildOpenAIStreamingRequest("grok-2-1212", content, tools),
  expectedToolName: "read_file",
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
  groq: groqConfig,
  mistral: mistralConfig,
  vllm: vllmConfig,
  ollama: ollamaConfig,
  zhipuai: zhipuaiConfig,
  deepseek: deepseekConfig,
  minimax: minimaxConfig,
  bedrock: null, // Bedrock uses binary AWS EventStream format which cannot be mocked via WireMock SSE
  openrouter: openrouterConfig,
  perplexity: null, // Perplexity does not support tool calling
  xai: xaiConfig,
  azure: azureConfig,
} satisfies Record<SupportedProvider, StreamingToolCallTestConfig | null>;

const testConfigs = [
  ...Object.values(testConfigsMap).filter(
    (c): c is StreamingToolCallTestConfig => c !== null,
  ),
  azureResponsesConfig,
];

for (const config of testConfigs) {
  test.describe(`LLMProxy-StreamingToolCalls-${config.providerName}`, () => {
    let agentId: string;

    test.afterEach(async ({ request, deleteAgent }) => {
      if (agentId) {
        await deleteAgent(request, agentId);
        agentId = "";
      }
    });

    test("streams tool calls in response", async ({
      request,
      createAgent,
      makeApiRequest,
    }) => {
      const wiremockStub = `${config.providerSlug}-streaming-tool-calls`;

      // 1. Create a test agent
      const createResponse = await createAgent(
        request,
        `Streaming Tool Calls Test - ${config.providerName}`,
        "personal",
      );
      const agent = await createResponse.json();
      agentId = agent.id;

      // 2. Send a streaming request with tools
      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: config.endpoint(agentId),
        headers: config.headers(wiremockStub),
        data: config.buildStreamingRequest("Read the file /tmp/test", [
          READ_FILE_TOOL,
        ]),
      });

      // 3. Verify the response is successful
      expect(response.ok()).toBeTruthy();

      // 4. Read the full response body and verify tool call data is present
      const body = await response.text();
      expect(body).toContain(config.expectedToolName);
      expect(body).toContain("/tmp/test");
    });
  });
}
