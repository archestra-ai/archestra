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

interface ToolInvocationTestConfig {
  providerName: string;

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
// Test Configurations
// =============================================================================

const openaiConfig: ToolInvocationTestConfig = {
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
    interactions.find((i) =>
      i.request?.messages?.some((m: { content?: string }) =>
        m.content?.includes(content),
      ),
    ),
};

const anthropicConfig: ToolInvocationTestConfig = {
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
    interactions.find((i) =>
      i.request?.messages?.some((m: { content?: string }) =>
        m.content?.includes(content),
      ),
    ),
};

const geminiConfig: ToolInvocationTestConfig = {
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
    interactions.find((i) =>
      i.request?.contents?.some((c: { parts?: Array<{ text?: string }> }) =>
        c.parts?.some((p) => p.text?.includes(content)),
      ),
    ),
};

const cerebrasConfig: ToolInvocationTestConfig = {
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
    interactions.find((i) =>
      i.request?.messages?.some((m: { content?: string }) =>
        m.content?.includes(content),
      ),
    ),
};

const vllmConfig: ToolInvocationTestConfig = {
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
    interactions.find((i) =>
      i.request?.messages?.some((m: { content?: string }) =>
        m.content?.includes(content),
      ),
    ),
};

const ollamaConfig: ToolInvocationTestConfig = {
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
    interactions.find((i) =>
      i.request?.messages?.some((m: { content?: string }) =>
        m.content?.includes(content),
      ),
    ),
};

const zhipuaiConfig: ToolInvocationTestConfig = {
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
    interactions.find((i) =>
      i.request?.messages?.some((m: { content?: string }) =>
        m.content?.includes(content),
      ),
    ),
};

// =============================================================================
// Test Suite
// =============================================================================

const testConfigs: ToolInvocationTestConfig[] = [
  openaiConfig,
  anthropicConfig,
  geminiConfig,
  cerebrasConfig,
  vllmConfig,
  ollamaConfig,
  zhipuaiConfig,
];

for (const config of testConfigs) {
  test.describe(`LLMProxy-ToolInvocation-${config.providerName}`, () => {
    // Each test is self-contained with its own local variables and cleanup.
    // This allows parallel execution without shared mutable state collisions.

    test("blocks tool invocation when untrusted data is consumed", async ({
      request,
      deleteAgent,
      createTrustedDataPolicy,
      deleteTrustedDataPolicy,
      createToolInvocationPolicy,
      deleteToolInvocationPolicy,
      makeApiRequest,
      waitForAgentTool,
    }) => {
      const wiremockStub = `${config.providerName.toLowerCase()}-blocks-tool-untrusted-data`;

      // 1. Create a test agent with considerContextUntrusted=true
      // This marks the entire context as untrusted, which is required for tool invocation
      // policies to block tool calls. Without this, the context is trusted by default when
      // there are no previous tool results to evaluate.
      const createResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/agents",
        data: {
          name: `${config.providerName} Test Agent`,
          teams: [],
          considerContextUntrusted: true,
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
          READ_FILE_TOOL,
        ]),
      });

      if (!initialResponse.ok()) {
        const errorText = await initialResponse.text();
        throw new Error(
          `Initial ${config.providerName} request failed: ${initialResponse.status()} ${errorText}`,
        );
      }

      // 3. Get the tool ID from the agent-tool relationship
      const readFileAgentTool = await waitForAgentTool(
        request,
        agentId,
        "read_file",
      );
      const toolId = readFileAgentTool.tool.id;

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
          [READ_FILE_TOOL],
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
      createAgent,
      deleteAgent,
      makeApiRequest,
    }) => {
      const wiremockStub = `${config.providerName.toLowerCase()}-allows-archestra-untrusted-context`;

      // 1. Create a test agent
      const createResponse = await createAgent(
        request,
        `${config.providerName} Archestra Test Agent`,
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
      createAgent,
      deleteAgent,
      makeApiRequest,
    }) => {
      const wiremockStub = `${config.providerName.toLowerCase()}-allows-regular-after-archestra`;

      // 1. Create a test agent
      const createResponse = await createAgent(
        request,
        `${config.providerName} Archestra Sequence Test Agent`,
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
