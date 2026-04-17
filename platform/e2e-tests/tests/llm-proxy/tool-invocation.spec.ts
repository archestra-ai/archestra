import type { SupportedProvider } from "@shared";
import { expect, test } from "../api-fixtures";

// Run all provider tests sequentially to avoid WireMock stub timing issues
// when multiple providers run in parallel against the same backend.
test.describe.configure({ mode: "serial" });

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

interface ToolInvocationTestConfig {
  providerName: string;
  providerSlug: string;

  // Request building
  endpoint: (agentId: string) => string;
  // WireMock stub selection: The stub name is passed in the auth header (Authorization, x-api-key, etc.)
  // WireMock uses "contains" matching on these headers to select which mock response to return
  headers: (wiremockStub: string) => Record<string, string>;
  buildRequest: (content: string, tools: ToolDefinition[]) => object;

  // Trusted data policy config (different attribute paths per provider)
  trustedDataPolicyAttributePath: string;

  // Assertions
  assertToolCallBlocked: (response: AnyResponse) => void;
  assertToolCallsPresent: (
    response: AnyResponse,
    expectedTools: string[],
  ) => void;
  assertToolArgument: (
    response: AnyResponse,
    toolName: string,
    argName: string,
    matcher: (value: unknown) => void,
  ) => void;

  // Interaction query helpers
  findInteractionByContent: (
    interactions: AnyResponse[],
    content: string,
  ) => AnyResponse | undefined;
}

function extractRequestTextContent(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractRequestTextContent(item));
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  return Object.values(record).flatMap((item) =>
    extractRequestTextContent(item),
  );
}

function interactionContainsContent(
  interaction: AnyResponse,
  content: string,
): boolean {
  return extractRequestTextContent(interaction.request).some((text) =>
    text.includes(content),
  );
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
// OpenAI-Compatible Config Factory
// =============================================================================

/**
 * Factory for providers that use the OpenAI-compatible chat/completions format.
 * OpenAI, Cerebras, Mistral, vLLM, Ollama, and Zhipuai all share identical
 * response structures and assertion logic — only endpoint, model, and headers differ.
 */
function makeOpenAiCompatibleToolConfig(params: {
  providerName: string;
  endpoint: (agentId: string) => string;
  model: string;
  trustedDataPolicyAttributePath?: string;
}): ToolInvocationTestConfig {
  return {
    providerName: params.providerName,
    providerSlug: params.providerName.toLowerCase(),

    endpoint: params.endpoint,

    headers: (wiremockStub) => ({
      Authorization: `Bearer ${wiremockStub}`,
      "Content-Type": "application/json",
    }),

    buildRequest: (content, tools) => ({
      model: params.model,
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

    trustedDataPolicyAttributePath:
      params.trustedDataPolicyAttributePath ?? "$.content",

    assertToolCallBlocked: (response) => {
      expect(response.choices).toBeDefined();
      expect(response.choices[0]).toBeDefined();
      expect(response.choices[0].message).toBeDefined();

      const message = response.choices[0].message;
      const refusalOrContent = message.refusal || message.content;

      expect(refusalOrContent).toBeTruthy();
      expect(refusalOrContent).toContain("read_file");
      expect(refusalOrContent).toContain("denied");

      if (message.tool_calls) {
        expect(refusalOrContent).toContain("tool invocation policy");
      }
    },

    assertToolCallsPresent: (response, expectedTools) => {
      expect(response.choices).toBeDefined();
      expect(response.choices[0]).toBeDefined();
      expect(response.choices[0].message).toBeDefined();
      expect(response.choices[0].message.tool_calls).toBeDefined();

      const toolCalls = response.choices[0].message.tool_calls;
      expect(toolCalls.length).toBe(expectedTools.length);

      for (const toolName of expectedTools) {
        const found = toolCalls.find(
          (tc: { function: { name: string } }) => tc.function.name === toolName,
        );
        expect(found).toBeDefined();
      }
    },

    assertToolArgument: (response, toolName, argName, matcher) => {
      const toolCalls = response.choices[0].message.tool_calls;
      const toolCall = toolCalls.find(
        (tc: { function: { name: string } }) => tc.function.name === toolName,
      );
      const args = JSON.parse(toolCall.function.arguments);
      matcher(args[argName]);
    },

    findInteractionByContent: (interactions, content) =>
      interactions.find((interaction) =>
        interactionContainsContent(interaction, content),
      ),
  };
}

// =============================================================================
// Test Configurations
// =============================================================================

const openaiConfig = makeOpenAiCompatibleToolConfig({
  providerName: "OpenAI",
  endpoint: (agentId) => `/v1/openai/${agentId}/chat/completions`,
  model: "gpt-4",
});

const azureResponsesConfig: ToolInvocationTestConfig = {
  providerName: "Azure Responses",
  providerSlug: "azure-responses",

  endpoint: (agentId) => `/v1/azure/${agentId}/responses`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  buildRequest: (content, tools) => ({
    model: "gpt-4.1",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: content }],
      },
    ],
    tools: tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  }),

  trustedDataPolicyAttributePath: "$.content[0].text",

  assertToolCallBlocked: (response) => {
    expect(response.output).toBeDefined();

    const functionCalls = response.output.filter(
      (item: { type: string }) => item.type === "function_call",
    );
    expect(functionCalls.length).toBe(0);

    const assistantMessage = response.output.find(
      (item: { type: string }) => item.type === "message",
    );
    expect(assistantMessage).toBeDefined();

    const combinedText = assistantMessage.content
      .map(
        (part: { text?: string; refusal?: string }) =>
          part.text ?? part.refusal,
      )
      .filter(Boolean)
      .join("\n");

    expect(combinedText).toContain("read_file");
    expect(combinedText).toContain("denied");
  },

  assertToolCallsPresent: (response, expectedTools) => {
    expect(response.output).toBeDefined();

    const functionCalls = response.output.filter(
      (item: { type: string }) => item.type === "function_call",
    );
    expect(functionCalls.length).toBe(expectedTools.length);

    for (const toolName of expectedTools) {
      const found = functionCalls.find(
        (item: { name: string }) => item.name === toolName,
      );
      expect(found).toBeDefined();
    }
  },

  assertToolArgument: (response, toolName, argName, matcher) => {
    const functionCalls = response.output.filter(
      (item: { type: string }) => item.type === "function_call",
    );
    const toolCall = functionCalls.find(
      (item: { name: string }) => item.name === toolName,
    );
    const args = JSON.parse(toolCall.arguments);
    matcher(args[argName]);
  },

  findInteractionByContent: (interactions, content) =>
    interactions.find((interaction) =>
      interactionContainsContent(interaction, content),
    ),
};

const groqConfig: ToolInvocationTestConfig = {
  providerName: "Groq",
  providerSlug: "groq",

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

  trustedDataPolicyAttributePath: "$.content",

  assertToolCallBlocked: (response) => {
    expect(response.choices).toBeDefined();
    expect(response.choices[0]).toBeDefined();
    expect(response.choices[0].message).toBeDefined();

    const message = response.choices[0].message;
    const refusalOrContent = message.refusal || message.content;

    expect(refusalOrContent).toBeTruthy();
    expect(refusalOrContent).toContain("read_file");
    expect(refusalOrContent).toContain("denied");

    if (message.tool_calls) {
      expect(refusalOrContent).toContain("tool invocation policy");
    }
  },

  assertToolCallsPresent: (response, expectedTools) => {
    expect(response.choices).toBeDefined();
    expect(response.choices[0]).toBeDefined();
    expect(response.choices[0].message).toBeDefined();
    expect(response.choices[0].message.tool_calls).toBeDefined();

    const toolCalls = response.choices[0].message.tool_calls;
    expect(toolCalls.length).toBe(expectedTools.length);

    for (const toolName of expectedTools) {
      const found = toolCalls.find(
        (tc: { function: { name: string } }) => tc.function.name === toolName,
      );
      expect(found).toBeDefined();
    }
  },

  assertToolArgument: (response, toolName, argName, matcher) => {
    const toolCalls = response.choices[0].message.tool_calls;
    const toolCall = toolCalls.find(
      (tc: { function: { name: string } }) => tc.function.name === toolName,
    );
    const args = JSON.parse(toolCall.function.arguments);
    matcher(args[argName]);
  },

  findInteractionByContent: (interactions, content) =>
    interactions.find((interaction) =>
      interactionContainsContent(interaction, content),
    ),
};

const xaiConfig: ToolInvocationTestConfig = {
  ...makeOpenAiCompatibleToolConfig({
    providerName: "xAI",
    endpoint: (agentId) => `/v1/xai/${agentId}/chat/completions`,
    model: "grok-4-1-fast-non-reasoning",
  }),
};

const anthropicConfig: ToolInvocationTestConfig = {
  providerName: "Anthropic",
  providerSlug: "anthropic",

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

  trustedDataPolicyAttributePath: "$.content",

  assertToolCallBlocked: (response) => {
    expect(response.content).toBeDefined();
    expect(response.content.length).toBeGreaterThan(0);

    const textContent = response.content.find(
      (c: { type: string }) => c.type === "text",
    );
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain("read_file");
    expect(textContent.text).toContain("denied");

    const toolUseContent = response.content.filter(
      (c: { type: string }) => c.type === "tool_use",
    );
    expect(toolUseContent.length).toBe(0);
  },

  assertToolCallsPresent: (response, expectedTools) => {
    expect(response.content).toBeDefined();
    expect(response.content.length).toBeGreaterThan(0);

    const toolUseBlocks = response.content.filter(
      (block: { type: string }) => block.type === "tool_use",
    );
    expect(toolUseBlocks.length).toBe(expectedTools.length);

    for (const toolName of expectedTools) {
      const found = toolUseBlocks.find(
        (block: { name: string }) => block.name === toolName,
      );
      expect(found).toBeDefined();
    }
  },

  assertToolArgument: (response, toolName, argName, matcher) => {
    const toolUseBlocks = response.content.filter(
      (block: { type: string }) => block.type === "tool_use",
    );
    const toolCall = toolUseBlocks.find(
      (block: { name: string }) => block.name === toolName,
    );
    matcher(toolCall.input[argName]);
  },

  findInteractionByContent: (interactions, content) =>
    interactions.find((interaction) =>
      interactionContainsContent(interaction, content),
    ),
};

const geminiConfig: ToolInvocationTestConfig = {
  providerName: "Gemini",
  providerSlug: "gemini",

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

  trustedDataPolicyAttributePath: "$.parts[0].text",

  assertToolCallBlocked: (response) => {
    expect(response.candidates).toBeDefined();
    expect(response.candidates.length).toBeGreaterThan(0);
    expect(response.candidates[0].content).toBeDefined();
    expect(response.candidates[0].content.parts).toBeDefined();

    const parts = response.candidates[0].content.parts;
    const textPart = parts.find((p: { text?: string }) => p.text);

    expect(textPart).toBeDefined();
    expect(textPart.text).toContain("read_file");
    expect(textPart.text).toContain("denied");

    const functionCallParts = parts.filter(
      (p: { functionCall?: unknown }) => p.functionCall,
    );
    expect(functionCallParts.length).toBe(0);
  },

  assertToolCallsPresent: (response, expectedTools) => {
    expect(response.candidates).toBeDefined();
    expect(response.candidates.length).toBeGreaterThan(0);
    expect(response.candidates[0].content).toBeDefined();
    expect(response.candidates[0].content.parts).toBeDefined();

    const parts = response.candidates[0].content.parts;
    const functionCallParts = parts.filter(
      (p: { functionCall?: unknown }) => p.functionCall,
    );
    expect(functionCallParts.length).toBe(expectedTools.length);

    for (const toolName of expectedTools) {
      const found = functionCallParts.find(
        (p: { functionCall: { name: string } }) =>
          p.functionCall.name === toolName,
      );
      expect(found).toBeDefined();
    }
  },

  assertToolArgument: (response, toolName, argName, matcher) => {
    const parts = response.candidates[0].content.parts;
    const functionCallParts = parts.filter(
      (p: { functionCall?: unknown }) => p.functionCall,
    );
    const toolCall = functionCallParts.find(
      (p: { functionCall: { name: string } }) =>
        p.functionCall.name === toolName,
    );
    matcher(toolCall.functionCall.args[argName]);
  },

  findInteractionByContent: (interactions, content) =>
    interactions.find((interaction) =>
      interactionContainsContent(interaction, content),
    ),
};

const cohereConfig: ToolInvocationTestConfig = {
  providerName: "Cohere",
  providerSlug: "cohere",

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

  trustedDataPolicyAttributePath: "$.content[0].text",

  assertToolCallBlocked: (response) => {
    expect(response.message).toBeDefined();

    const textContent = response.message.content?.find(
      (c: { type: string }) => c.type === "text",
    );
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain("read_file");
    expect(textContent.text).toContain("denied");

    const hasToolCalls = response.message.tool_calls?.length > 0;
    expect(hasToolCalls).toBeFalsy();
  },

  assertToolCallsPresent: (response, expectedTools) => {
    expect(response.message).toBeDefined();
    expect(response.message.tool_calls).toBeDefined();

    const toolCalls = response.message.tool_calls;
    expect(toolCalls.length).toBe(expectedTools.length);

    for (const toolName of expectedTools) {
      const found = toolCalls.find(
        (tc: { function: { name: string } }) => tc.function.name === toolName,
      );
      expect(found).toBeDefined();
    }
  },

  assertToolArgument: (response, toolName, argName, matcher) => {
    const toolCalls = response.message.tool_calls;
    const toolCall = toolCalls.find(
      (tc: { function: { name: string } }) => tc.function.name === toolName,
    );
    const args = JSON.parse(toolCall.function.arguments);
    matcher(args[argName]);
  },

  findInteractionByContent: (interactions, content) =>
    interactions.find((interaction) =>
      interactionContainsContent(interaction, content),
    ),
};

const cerebrasConfig = makeOpenAiCompatibleToolConfig({
  providerName: "Cerebras",
  endpoint: (agentId) => `/v1/cerebras/${agentId}/chat/completions`,
  model: "llama-4-scout-17b-16e-instruct",
});

const mistralConfig = makeOpenAiCompatibleToolConfig({
  providerName: "Mistral",
  endpoint: (agentId) => `/v1/mistral/${agentId}/chat/completions`,
  model: "mistral-large-latest",
});

const vllmConfig = makeOpenAiCompatibleToolConfig({
  providerName: "vLLM",
  endpoint: (agentId) => `/v1/vllm/${agentId}/chat/completions`,
  model: "meta-llama/Llama-3.1-8B-Instruct",
});

const ollamaConfig = makeOpenAiCompatibleToolConfig({
  providerName: "Ollama",
  endpoint: (agentId) => `/v1/ollama/${agentId}/chat/completions`,
  model: "qwen2:0.5b",
});

const zhipuaiConfig = makeOpenAiCompatibleToolConfig({
  providerName: "Zhipuai",
  endpoint: (agentId) => `/v1/zhipuai/${agentId}/chat/completions`,
  model: "glm-4.5-flash",
});

const minimaxConfig = makeOpenAiCompatibleToolConfig({
  providerName: "Minimax",
  endpoint: (agentId) => `/v1/minimax/${agentId}/chat/completions`,
  model: "MiniMax-M2.1",
});

const deepseekConfig = makeOpenAiCompatibleToolConfig({
  providerName: "DeepSeek",
  endpoint: (agentId) => `/v1/deepseek/${agentId}/chat/completions`,
  model: "deepseek-chat",
});

const bedrockConfig: ToolInvocationTestConfig = {
  providerName: "Bedrock",
  providerSlug: "bedrock",

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

  trustedDataPolicyAttributePath: "$.content[0].text",

  assertToolCallBlocked: (response) => {
    expect(response.output).toBeDefined();
    expect(response.output.message).toBeDefined();

    const content = response.output.message.content;
    const textBlock = content.find(
      (c: { text?: string }) => "text" in c && c.text,
    );
    expect(textBlock).toBeDefined();
    expect(textBlock.text).toContain("read_file");
    expect(textBlock.text).toContain("denied");

    const toolUseBlocks = content.filter(
      (c: { toolUse?: unknown }) => "toolUse" in c,
    );
    expect(toolUseBlocks.length).toBe(0);
  },

  assertToolCallsPresent: (response, expectedTools) => {
    expect(response.output).toBeDefined();
    expect(response.output.message).toBeDefined();

    const content = response.output.message.content;
    const toolUseBlocks = content.filter(
      (c: { toolUse?: unknown }) => "toolUse" in c,
    );
    expect(toolUseBlocks.length).toBe(expectedTools.length);

    for (const toolName of expectedTools) {
      const found = toolUseBlocks.find(
        (c: { toolUse: { name: string } }) => c.toolUse.name === toolName,
      );
      expect(found).toBeDefined();
    }
  },

  assertToolArgument: (response, toolName, argName, matcher) => {
    const content = response.output.message.content;
    const toolUseBlocks = content.filter(
      (c: { toolUse?: unknown }) => "toolUse" in c,
    );
    const toolCall = toolUseBlocks.find(
      (c: { toolUse: { name: string } }) => c.toolUse.name === toolName,
    );
    matcher(toolCall.toolUse.input[argName]);
  },

  findInteractionByContent: (interactions, content) =>
    interactions.find((interaction) =>
      interactionContainsContent(interaction, content),
    ),
};

const openrouterConfig: ToolInvocationTestConfig = {
  ...makeOpenAiCompatibleToolConfig({
    providerName: "OpenRouter",
    endpoint: (agentId) => `/v1/openrouter/${agentId}/chat/completions`,
    model: "openrouter/auto",
  }),
};

const azureConfig: ToolInvocationTestConfig = {
  ...makeOpenAiCompatibleToolConfig({
    providerName: "Azure",
    endpoint: (agentId) => `/v1/azure/${agentId}/chat/completions`,
    model: "gpt-4o",
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
  groq: groqConfig,
  xai: xaiConfig,
  mistral: mistralConfig,
  vllm: vllmConfig,
  ollama: ollamaConfig,
  zhipuai: zhipuaiConfig,
  minimax: minimaxConfig,
  deepseek: deepseekConfig,
  bedrock: bedrockConfig,
  openrouter: openrouterConfig,
  perplexity: null, // Perplexity does not support tool calling
  azure: azureConfig,
} satisfies Record<SupportedProvider, ToolInvocationTestConfig | null>;

const testConfigs = [
  ...Object.values(testConfigsMap).filter(
    (c): c is ToolInvocationTestConfig => c !== null,
  ),
  azureResponsesConfig,
];

for (const config of testConfigs) {
  test.describe(`LLMProxy-ToolInvocation-${config.providerName}`, () => {
    // Each test is self-contained with its own local variables and cleanup.
    // This allows parallel execution without shared mutable state collisions.
    //
    // Extra retries for these tests as they can be flaky due to WireMock stub timing issues
    // when running in parallel with multiple providers. Increased to 3 retries (4 total attempts)
    // as Cerebras tests have shown higher flakiness rates in CI.
    test.describe.configure({ retries: 3 });

    test("blocks tool invocation when untrusted data is consumed", async ({
      request,
      deleteAgent,
      createTrustedDataPolicy,
      deleteTrustedDataPolicy,
      createToolInvocationPolicy,
      deleteToolInvocationPolicy,
      makeApiRequest,
      waitForProxyTool,
    }) => {
      const wiremockStub = `${config.providerSlug}-blocks-tool-untrusted-data`;
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const toolName = `e2e_read_file_${config.providerSlug}`;
      const readFileTool: ToolDefinition = {
        ...READ_FILE_TOOL,
        name: toolName,
      };

      // 1. Create a test agent with considerContextUntrusted=true
      // This marks the entire context as untrusted, which is required for tool invocation
      // policies to block tool calls. Without this, the context is trusted by default when
      // there are no previous tool results to evaluate.
      const createResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/agents",
        data: {
          name: `${config.providerName} Test Agent ${uniqueSuffix}`,
          teams: [],
          considerContextUntrusted: true,
          agentType: "llm_proxy",
          scope: "personal",
        },
      });
      const agent = await createResponse.json();
      const agentId = agent.id;

      // 2. Send initial request to register the tool
      const initialResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: config.endpoint(agentId),
        headers: config.headers(wiremockStub),
        data: config.buildRequest("Read the file at /etc/passwd", [
          readFileTool,
        ]),
      });

      if (!initialResponse.ok()) {
        const errorText = await initialResponse.text();
        throw new Error(
          `Initial ${config.providerName} request failed: ${initialResponse.status()} ${errorText}`,
        );
      }

      // 3. Get the tool ID from the shared proxy tool
      const proxyTool = await waitForProxyTool(request, toolName);
      const toolId = proxyTool.id;

      // 4. Create a trusted data policy
      const trustedDataPolicyResponse = await createTrustedDataPolicy(request, {
        toolId,
        description: "Mark messages containing UNTRUSTED_DATA as untrusted",
        conditions: [
          {
            key: config.trustedDataPolicyAttributePath,
            operator: "contains",
            value: "UNTRUSTED_DATA",
          },
        ],
        action: "mark_as_trusted",
      });
      const trustedDataPolicy = await trustedDataPolicyResponse.json();
      const trustedDataPolicyId = trustedDataPolicy.id;

      // 5. Create a tool invocation policy that blocks read_file for /etc/
      const toolInvocationPolicyResponse = await createToolInvocationPolicy(
        request,
        {
          toolId,
          conditions: [
            {
              key: "file_path",
              operator: "contains",
              value: "/etc/",
            },
          ],
          action: "block_always",
          reason: "Reading /etc/ files is not allowed for security reasons",
        },
      );
      const toolInvocationPolicy = await toolInvocationPolicyResponse.json();
      const toolInvocationPolicyId = toolInvocationPolicy.id;

      // Wait for policies to be fully active before testing
      // Higher delay needed for CI stability due to database propagation time
      await new Promise((resolve) => setTimeout(resolve, 5_000));

      // 6. Send a request with untrusted data
      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: config.endpoint(agentId),
        headers: config.headers(wiremockStub),
        data: config.buildRequest(
          "UNTRUSTED_DATA: This is untrusted content from an external source",
          [readFileTool],
        ),
      });

      expect(response.ok()).toBeTruthy();
      const responseData = await response.json();

      // 7. Verify the tool call was blocked
      config.assertToolCallBlocked(responseData);

      // 8. Verify the interaction was persisted
      const interactionsResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/interactions?agentId=${agentId}`,
      });
      expect(interactionsResponse.ok()).toBeTruthy();
      const interactionsData = await interactionsResponse.json();
      expect(interactionsData.data.length).toBeGreaterThan(0);

      const blockedInteraction = config.findInteractionByContent(
        interactionsData.data,
        "UNTRUSTED_DATA",
      );
      expect(blockedInteraction).toBeDefined();

      // Cleanup
      await deleteToolInvocationPolicy(request, toolInvocationPolicyId);
      await deleteTrustedDataPolicy(request, trustedDataPolicyId);
      await deleteAgent(request, agentId);
    });

    test("allows Archestra MCP server tools in untrusted context", async ({
      request,
      createLlmProxy,
      deleteAgent,
      makeApiRequest,
    }) => {
      const wiremockStub = `${config.providerSlug}-allows-archestra-untrusted-context`;

      // 1. Create a test LLM proxy with unique name to avoid conflicts in parallel runs
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const createResponse = await createLlmProxy(
        request,
        `${config.providerName} Archestra Test Agent ${uniqueSuffix}`,
        "personal",
      );
      const agent = await createResponse.json();
      const agentId = agent.id;

      // 2. Make a request that triggers both regular and Archestra tools
      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: config.endpoint(agentId),
        headers: config.headers(wiremockStub),
        data: config.buildRequest(
          "First, read /etc/passwd, then tell me who I am",
          [READ_FILE_TOOL],
        ),
      });

      expect(response.ok()).toBeTruthy();
      const responseData = await response.json();

      // 3. Verify both tool calls are present
      config.assertToolCallsPresent(responseData, [
        "read_file",
        "archestra__whoami",
      ]);

      // 4. Verify read_file has expected arguments
      config.assertToolArgument(
        responseData,
        "read_file",
        "file_path",
        (value) => expect(value).toBe("/etc/passwd"),
      );

      // 5. Verify the interaction was persisted
      const interactionsResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/interactions?agentId=${agentId}`,
      });
      expect(interactionsResponse.ok()).toBeTruthy();
      const interactionsData = await interactionsResponse.json();
      expect(interactionsData.data.length).toBeGreaterThan(0);

      const mixedToolInteraction = config.findInteractionByContent(
        interactionsData.data,
        "tell me who I am",
      );
      expect(mixedToolInteraction).toBeDefined();

      // Cleanup
      await deleteAgent(request, agentId);
    });

    test("allows regular tool call after Archestra MCP server tool call", async ({
      request,
      createLlmProxy,
      deleteAgent,
      makeApiRequest,
    }) => {
      const wiremockStub = `${config.providerSlug}-allows-regular-after-archestra`;

      // 1. Create a test LLM proxy with unique name to avoid conflicts in parallel runs
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const createResponse = await createLlmProxy(
        request,
        `${config.providerName} Archestra Sequence Test Agent ${uniqueSuffix}`,
        "personal",
      );
      const agent = await createResponse.json();
      const agentId = agent.id;

      // 2. Make a sequence request: Archestra tool first, then regular tool
      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: config.endpoint(agentId),
        headers: config.headers(wiremockStub),
        data: config.buildRequest("First tell me who I am, then read a file", [
          READ_FILE_TOOL,
        ]),
      });

      expect(response.ok()).toBeTruthy();
      const responseData = await response.json();

      // 3. Verify both tool calls are present
      config.assertToolCallsPresent(responseData, [
        "archestra__whoami",
        "read_file",
      ]);

      // 4. Verify read_file has a file path argument
      config.assertToolArgument(
        responseData,
        "read_file",
        "file_path",
        (value) => expect(value).toContain("/"),
      );

      // Cleanup
      await deleteAgent(request, agentId);
    });
  });
}

test.describe("LLMProxy-ToolInvocation-Azure Responses Follow-up Context", () => {
  test.describe.configure({ retries: 3 });

  test("blocks tool invocation when prior Azure Responses tool output is untrusted", async ({
    request,
    deleteAgent,
    createTrustedDataPolicy,
    deleteTrustedDataPolicy,
    createToolInvocationPolicy,
    deleteToolInvocationPolicy,
    makeApiRequest,
    waitForProxyTool,
  }) => {
    const config = azureResponsesConfig;
    const wiremockStub = `${config.providerSlug}-blocks-tool-untrusted-data`;
    const uniqueSuffix = crypto.randomUUID().slice(0, 8);
    const toolName = "e2e_read_file_azure-responses";
    const readFileTool: ToolDefinition = {
      ...READ_FILE_TOOL,
      name: toolName,
    };

    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/agents",
      data: {
        name: `${config.providerName} Follow-up Context Agent ${uniqueSuffix}`,
        teams: [],
        agentType: "llm_proxy",
        scope: "personal",
      },
    });
    const agent = await createResponse.json();
    const agentId = agent.id;

    const initialResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: config.endpoint(agentId),
      headers: config.headers(wiremockStub),
      data: config.buildRequest("Read the file at /tmp/test", [readFileTool]),
    });

    if (!initialResponse.ok()) {
      const errorText = await initialResponse.text();
      throw new Error(
        `Initial ${config.providerName} request failed: ${initialResponse.status()} ${errorText}`,
      );
    }

    const proxyTool = await waitForProxyTool(request, toolName);
    const toolId = proxyTool.id;

    const trustedDataPolicyResponse = await createTrustedDataPolicy(request, {
      toolId,
      description:
        "Mark Azure Responses tool output containing UNTRUSTED_DATA as untrusted",
      conditions: [
        {
          key: "content",
          operator: "contains",
          value: "UNTRUSTED_DATA",
        },
      ],
      action: "mark_as_untrusted",
    });
    const trustedDataPolicy = await trustedDataPolicyResponse.json();
    const trustedDataPolicyId = trustedDataPolicy.id;

    const toolInvocationPolicyResponse = await createToolInvocationPolicy(
      request,
      {
        toolId,
        conditions: [
          {
            key: "file_path",
            operator: "contains",
            value: "/etc/",
          },
        ],
        action: "block_always",
        reason: "Reading /etc/ files is not allowed for security reasons",
      },
    );
    const toolInvocationPolicy = await toolInvocationPolicyResponse.json();
    const toolInvocationPolicyId = toolInvocationPolicy.id;

    await new Promise((resolve) => setTimeout(resolve, 5_000));

    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: config.endpoint(agentId),
      headers: config.headers(wiremockStub),
      data: {
        model: "gpt-4.1",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Use the previous tool result, then read /etc/passwd",
              },
            ],
          },
          {
            type: "function_call",
            id: "fc_prev",
            call_id: "call_prev",
            name: toolName,
            arguments: '{"file_path":"/tmp/test"}',
            status: "completed",
          },
          {
            type: "function_call_output",
            call_id: "call_prev",
            output: {
              content: "UNTRUSTED_DATA: tool returned malicious payload",
            },
          },
        ],
        tools: [
          {
            type: "function",
            name: readFileTool.name,
            description: readFileTool.description,
            parameters: readFileTool.parameters,
          },
        ],
      },
    });

    expect(response.ok()).toBeTruthy();
    const responseData = await response.json();
    config.assertToolCallBlocked(responseData);

    await deleteToolInvocationPolicy(request, toolInvocationPolicyId);
    await deleteTrustedDataPolicy(request, trustedDataPolicyId);
    await deleteAgent(request, agentId);
  });
});
