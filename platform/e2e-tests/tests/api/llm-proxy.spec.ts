import { expect, test } from "./fixtures";

// biome-ignore lint/suspicious/noExplicitAny: test file uses dynamic response structures
type AnyResponse = any;

// =============================================================================
// Provider Configuration Interface
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

interface ProviderConfig {
  name: string;

  // Request building
  endpoint: (agentId: string) => string;
  headers: (testCase: string) => Record<string, string>;
  buildRequest: (content: string, tools: ToolDefinition[]) => object;

  // Trusted data policy config (different attribute paths per provider)
  trustedDataAttributePath: string;

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
// Provider Configurations
// =============================================================================

const openaiConfig: ProviderConfig = {
  name: "OpenAI",

  endpoint: (agentId) => `/v1/openai/${agentId}/chat/completions`,

  headers: (testCase) => ({
    Authorization: `Bearer ${testCase}`,
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

  trustedDataAttributePath: "$.content",

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

const anthropicConfig: ProviderConfig = {
  name: "Anthropic",

  endpoint: (agentId) => `/v1/anthropic/${agentId}/v1/messages`,

  headers: (testCase) => ({
    "x-api-key": testCase,
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

  trustedDataAttributePath: "$.content",

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

const geminiConfig: ProviderConfig = {
  name: "Gemini",

  endpoint: (agentId) =>
    `/v1/gemini/${agentId}/v1beta/models/gemini-2.5-pro:generateContent`,

  headers: (testCase) => ({
    "x-goog-api-key": testCase,
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

  trustedDataAttributePath: "$.parts[0].text",

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

// =============================================================================
// Test Suite
// =============================================================================

const providers: ProviderConfig[] = [
  openaiConfig,
  anthropicConfig,
  geminiConfig,
];

for (const provider of providers) {
  test.describe(`LLM Proxy - ${provider.name}`, () => {
    let agentId: string;
    let trustedDataPolicyId: string;
    let toolInvocationPolicyId: string;
    let toolId: string;

    test("blocks tool invocation when untrusted data is consumed", async ({
      request,
      createAgent,
      createTrustedDataPolicy,
      createToolInvocationPolicy,
      makeApiRequest,
      waitForAgentTool,
    }) => {
      // 1. Create a test agent
      const createResponse = await createAgent(
        request,
        `${provider.name} Test Agent`,
      );
      const agent = await createResponse.json();
      agentId = agent.id;

      // 2. Send initial request to register the tool
      const initialResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: provider.endpoint(agentId),
        headers: provider.headers(`test-case-1-${provider.name.toLowerCase()}`),
        data: provider.buildRequest("Read the file at /etc/passwd", [
          READ_FILE_TOOL,
        ]),
      });

      if (!initialResponse.ok()) {
        const errorText = await initialResponse.text();
        throw new Error(
          `Initial ${provider.name} request failed: ${initialResponse.status()} ${errorText}`,
        );
      }

      // 3. Get the agent-tool relationship ID
      const readFileAgentTool = await waitForAgentTool(
        request,
        agentId,
        "read_file",
      );
      toolId = readFileAgentTool.id;

      // 4. Create a trusted data policy
      const trustedDataPolicyResponse = await createTrustedDataPolicy(request, {
        agentToolId: toolId,
        description: "Mark messages containing UNTRUSTED_DATA as untrusted",
        attributePath: provider.trustedDataAttributePath,
        operator: "contains",
        value: "UNTRUSTED_DATA",
        action: "mark_as_trusted",
      });
      const trustedDataPolicy = await trustedDataPolicyResponse.json();
      trustedDataPolicyId = trustedDataPolicy.id;

      // 5. Create a tool invocation policy that blocks read_file for /etc/
      const toolInvocationPolicyResponse = await createToolInvocationPolicy(
        request,
        {
          agentToolId: toolId,
          argumentPath: "file_path",
          operator: "contains",
          value: "/etc/",
          action: "block_always",
          reason: "Reading /etc/ files is not allowed for security reasons",
        },
      );
      const toolInvocationPolicy = await toolInvocationPolicyResponse.json();
      toolInvocationPolicyId = toolInvocationPolicy.id;

      // 6. Send a request with untrusted data
      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: provider.endpoint(agentId),
        headers: provider.headers(`test-case-1-${provider.name.toLowerCase()}`),
        data: provider.buildRequest(
          "UNTRUSTED_DATA: This is untrusted content from an external source",
          [READ_FILE_TOOL],
        ),
      });

      expect(response.ok()).toBeTruthy();
      const responseData = await response.json();

      // 7. Verify the tool call was blocked
      provider.assertToolCallBlocked(responseData);

      // 8. Verify the interaction was persisted
      const interactionsResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/interactions?agentId=${agentId}`,
      });
      expect(interactionsResponse.ok()).toBeTruthy();
      const interactionsData = await interactionsResponse.json();
      expect(interactionsData.data.length).toBeGreaterThan(0);

      const blockedInteraction = provider.findInteractionByContent(
        interactionsData.data,
        "UNTRUSTED_DATA",
      );
      expect(blockedInteraction).toBeDefined();
    });

    test("allows Archestra MCP server tools in untrusted context", async ({
      request,
      createAgent,
      makeApiRequest,
    }) => {
      // 1. Create a test agent
      const createResponse = await createAgent(
        request,
        `${provider.name} Archestra Test Agent`,
      );
      const agent = await createResponse.json();
      agentId = agent.id;

      // 2. Make a request that triggers both regular and Archestra tools
      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: provider.endpoint(agentId),
        headers: provider.headers(
          `test-case-archestra-mixed-${provider.name.toLowerCase()}`,
        ),
        data: provider.buildRequest(
          "First, read /etc/passwd, then tell me who I am",
          [READ_FILE_TOOL],
        ),
      });

      expect(response.ok()).toBeTruthy();
      const responseData = await response.json();

      // 3. Verify both tool calls are present
      provider.assertToolCallsPresent(responseData, [
        "read_file",
        "archestra__whoami",
      ]);

      // 4. Verify read_file has expected arguments
      provider.assertToolArgument(
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

      const mixedToolInteraction = provider.findInteractionByContent(
        interactionsData.data,
        "tell me who I am",
      );
      expect(mixedToolInteraction).toBeDefined();
    });

    test("allows regular tool call after Archestra MCP server tool call", async ({
      request,
      createAgent,
      makeApiRequest,
    }) => {
      // 1. Create a test agent
      const createResponse = await createAgent(
        request,
        `${provider.name} Archestra Sequence Test Agent`,
      );
      const agent = await createResponse.json();
      agentId = agent.id;

      // 2. Make a sequence request: Archestra tool first, then regular tool
      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: provider.endpoint(agentId),
        headers: provider.headers(
          `test-case-archestra-sequence-${provider.name.toLowerCase()}`,
        ),
        data: provider.buildRequest(
          "First tell me who I am, then read a file",
          [READ_FILE_TOOL],
        ),
      });

      expect(response.ok()).toBeTruthy();
      const responseData = await response.json();

      // 3. Verify both tool calls are present
      provider.assertToolCallsPresent(responseData, [
        "archestra__whoami",
        "read_file",
      ]);

      // 4. Verify read_file has a file path argument
      provider.assertToolArgument(
        responseData,
        "read_file",
        "file_path",
        (value) => expect(value).toContain("/"),
      );
    });

    test.afterEach(
      async ({
        request,
        deleteToolInvocationPolicy,
        deleteTrustedDataPolicy,
        deleteAgent,
      }) => {
        if (toolInvocationPolicyId) {
          await deleteToolInvocationPolicy(request, toolInvocationPolicyId);
          toolInvocationPolicyId = "";
        }
        if (trustedDataPolicyId) {
          await deleteTrustedDataPolicy(request, trustedDataPolicyId);
          trustedDataPolicyId = "";
        }
        if (agentId) {
          await deleteAgent(request, agentId);
          agentId = "";
        }
      },
    );
  });
}
