import { expect, test } from "./fixtures";

test.describe("LLM Proxy - OpenAI", () => {
  const OPENAI_TEST_CASE_1_HEADER = "Bearer test-case-1-openai-tool-call";

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
    const createResponse = await createAgent(request, "OpenAI Test Agent");
    const agent = await createResponse.json();
    agentId = agent.id;

    // 2. Send initial request to register the tool and get the toolId
    // First, let's make a request to create the tool
    const initialResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/v1/openai/${agentId}/chat/completions`,
      data: {
        model: "gpt-4",
        messages: [
          {
            role: "user",
            content: "Read the file at /etc/passwd",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
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
            },
          },
        ],
      },
      headers: {
        Authorization: OPENAI_TEST_CASE_1_HEADER,
        "Content-Type": "application/json",
      },
    });

    if (!initialResponse.ok()) {
      const errorText = await initialResponse.text();
      throw new Error(
        `Initial OpenAI request failed: ${initialResponse.status()} ${errorText}`,
      );
    }

    // Get the agent-tool relationship ID from the backend (with retry/polling for eventual consistency)
    const readFileAgentTool = await waitForAgentTool(
      request,
      agentId,
      "read_file",
    );
    toolId = readFileAgentTool.id;

    // 3. Create a trusted data policy that marks messages with "untrusted" in content as untrusted
    const trustedDataPolicyResponse = await createTrustedDataPolicy(request, {
      agentToolId: toolId,
      description: "Mark messages containing UNTRUSTED_DATA as untrusted",
      attributePath: "$.content",
      operator: "contains",
      value: "UNTRUSTED_DATA",
      action: "mark_as_trusted",
    });
    const trustedDataPolicy = await trustedDataPolicyResponse.json();
    trustedDataPolicyId = trustedDataPolicy.id;

    // 4. Create a tool invocation policy that blocks read_file when context is untrusted
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

    // 5. Send a request with untrusted data
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/v1/openai/${agentId}/chat/completions`,
      headers: {
        Authorization: OPENAI_TEST_CASE_1_HEADER,
        "Content-Type": "application/json",
      },
      data: {
        model: "gpt-4",
        messages: [
          {
            role: "user",
            content:
              "UNTRUSTED_DATA: This is untrusted content from an external source",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
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
            },
          },
        ],
      },
    });

    expect(response.ok()).toBeTruthy();
    const responseData = await response.json();

    // 6. Verify the tool call was blocked
    expect(responseData.choices).toBeDefined();
    expect(responseData.choices[0]).toBeDefined();
    expect(responseData.choices[0].message).toBeDefined();

    const message = responseData.choices[0].message;

    // The response should contain a refusal or content indicating the tool was blocked
    expect(message.refusal || message.content).toBeTruthy();
    expect(message.refusal || message.content).toContain("read_file");
    expect(message.refusal || message.content).toContain("denied");

    // The original tool_calls should not be present (they were replaced with the refusal)
    // OR if present, they should be wrapped in a refusal
    if (message.tool_calls) {
      expect(message.refusal || message.content).toContain(
        "tool invocation policy",
      );
    }

    // 7. Verify the interaction was persisted
    const interactionsResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/interactions?agentId=${agentId}`,
    });
    expect(interactionsResponse.ok()).toBeTruthy();
    const interactionsData = await interactionsResponse.json();
    expect(interactionsData.data.length).toBeGreaterThan(0);

    // Find the interaction with untrusted data
    // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
    const blockedInteraction = interactionsData.data.find((i: any) =>
      // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
      i.request?.messages?.some((m: any) =>
        m.content?.includes("UNTRUSTED_DATA"),
      ),
    );
    expect(blockedInteraction).toBeDefined();
  });

  test("allows Archestra MCP server tools in untrusted context", async ({
    request,
    createAgent,
    makeApiRequest,
  }) => {
    // 1. Create a test agent
    const createResponse = await createAgent(request, "Archestra Test Agent");
    const agent = await createResponse.json();
    agentId = agent.id;

    // 2. First, make a tool call that makes the context untrusted
    const untrustedContextResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/v1/openai/${agentId}/chat/completions`,
      data: {
        model: "gpt-4",
        messages: [
          {
            role: "user",
            content: "First, read /etc/passwd, then tell me who I am",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
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
            },
          },
        ],
      },
      headers: {
        Authorization: "Bearer test-case-archestra-mixed",
        "Content-Type": "application/json",
      },
    });

    expect(untrustedContextResponse.ok()).toBeTruthy();
    const responseData = await untrustedContextResponse.json();

    // 3. Verify the response contains tool calls
    expect(responseData.choices).toBeDefined();
    expect(responseData.choices[0]).toBeDefined();
    expect(responseData.choices[0].message).toBeDefined();
    expect(responseData.choices[0].message.tool_calls).toBeDefined();
    expect(responseData.choices[0].message.tool_calls.length).toBe(2);

    // 4. Verify both tool calls are present - read_file and archestra__whoami
    const toolCalls = responseData.choices[0].message.tool_calls;
    const readFileCall = toolCalls.find(
      (call: { function: { name: string } }) =>
        call.function.name === "read_file",
    );
    const archestraCall = toolCalls.find(
      (call: { function: { name: string } }) =>
        call.function.name === "archestra__whoami",
    );

    expect(readFileCall).toBeDefined();
    expect(archestraCall).toBeDefined();

    // 5. Verify read_file call has the expected arguments
    const readFileArgs = JSON.parse(readFileCall.function.arguments);
    expect(readFileArgs.file_path).toBe("/etc/passwd");

    // 6. Verify the interaction was persisted
    const interactionsResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/interactions?agentId=${agentId}`,
    });
    expect(interactionsResponse.ok()).toBeTruthy();
    const interactionsData = await interactionsResponse.json();
    expect(interactionsData.data.length).toBeGreaterThan(0);

    // Find the interaction with mixed tool calls
    // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
    const mixedToolInteraction = interactionsData.data.find((i: any) =>
      // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
      i.request?.messages?.some((m: any) =>
        m.content?.includes("tell me who I am"),
      ),
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
      "Archestra Sequence Test Agent",
    );
    const agent = await createResponse.json();
    agentId = agent.id;

    // 2. Make a sequence of tool calls: first Archestra tool, then regular tool
    const sequenceResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/v1/openai/${agentId}/chat/completions`,
      data: {
        model: "gpt-4",
        messages: [
          {
            role: "user",
            content: "First tell me who I am, then read a file",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
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
            },
          },
        ],
      },
      headers: {
        Authorization: "Bearer test-case-archestra-sequence",
        "Content-Type": "application/json",
      },
    });

    expect(sequenceResponse.ok()).toBeTruthy();
    const responseData = await sequenceResponse.json();

    // 3. Verify the response contains tool calls
    expect(responseData.choices).toBeDefined();
    expect(responseData.choices[0]).toBeDefined();
    expect(responseData.choices[0].message).toBeDefined();
    expect(responseData.choices[0].message.tool_calls).toBeDefined();
    expect(responseData.choices[0].message.tool_calls.length).toBe(2);

    // 4. Verify both tool calls are present - archestra__whoami and read_file
    const toolCalls = responseData.choices[0].message.tool_calls;
    const archestraCall = toolCalls.find(
      (call: { function: { name: string } }) =>
        call.function.name === "archestra__whoami",
    );
    const readFileCall = toolCalls.find(
      (call: { function: { name: string } }) =>
        call.function.name === "read_file",
    );

    expect(archestraCall).toBeDefined();
    expect(readFileCall).toBeDefined();

    // 5. Verify read_file call has expected arguments
    const readFileArgs = JSON.parse(readFileCall.function.arguments);
    expect(readFileArgs.file_path).toContain("/");
  });

  test.afterEach(
    async ({
      request,
      deleteToolInvocationPolicy,
      deleteTrustedDataPolicy,
      deleteAgent,
    }) => {
      // Clean up: delete the created resources
      if (toolInvocationPolicyId) {
        await deleteToolInvocationPolicy(request, toolInvocationPolicyId);
      }
      if (trustedDataPolicyId) {
        await deleteTrustedDataPolicy(request, trustedDataPolicyId);
      }
      if (agentId) {
        await deleteAgent(request, agentId);
      }
    },
  );
});

test.describe("LLM Proxy - Anthropic", () => {
  const ANTHROPIC_TEST_CASE_1_HEADER = "test-case-1-anthropic-tool-call";

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
    const createResponse = await createAgent(request, "Anthropic Test Agent");
    const agent = await createResponse.json();
    agentId = agent.id;

    // 2. Send initial request to register the tool and get the toolId
    const initialResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/v1/anthropic/${agentId}/v1/messages`,
      headers: {
        "x-api-key": ANTHROPIC_TEST_CASE_1_HEADER,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      data: {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: "Read the file at /etc/passwd",
          },
        ],
        tools: [
          {
            name: "read_file",
            description: "Read a file from the filesystem",
            input_schema: {
              type: "object",
              properties: {
                file_path: {
                  type: "string",
                  description: "The path to the file to read",
                },
              },
              required: ["file_path"],
            },
          },
        ],
      },
    });

    if (!initialResponse.ok()) {
      const errorText = await initialResponse.text();
      throw new Error(
        `Initial Anthropic request failed: ${initialResponse.status()} ${errorText}`,
      );
    }

    // Get the agent-tool relationship ID from the backend (with retry/polling for eventual consistency)
    const readFileAgentTool = await waitForAgentTool(
      request,
      agentId,
      "read_file",
    );
    toolId = readFileAgentTool.id;

    // 3. Create a trusted data policy that marks messages with "UNTRUSTED_DATA" in content as untrusted
    const trustedDataPolicyResponse = await createTrustedDataPolicy(request, {
      agentToolId: toolId,
      description: "Mark messages containing UNTRUSTED_DATA as untrusted",
      attributePath: "$.content",
      operator: "contains",
      value: "UNTRUSTED_DATA",
      action: "mark_as_trusted",
    });
    const trustedDataPolicy = await trustedDataPolicyResponse.json();
    trustedDataPolicyId = trustedDataPolicy.id;

    // 4. Create a tool invocation policy that blocks read_file when accessing /etc/
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

    // 5. Send a request with untrusted data
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/v1/anthropic/${agentId}/v1/messages`,
      headers: {
        "x-api-key": ANTHROPIC_TEST_CASE_1_HEADER,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      data: {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content:
              "UNTRUSTED_DATA: This is untrusted content from an external source",
          },
        ],
        tools: [
          {
            name: "read_file",
            description: "Read a file from the filesystem",
            input_schema: {
              type: "object",
              properties: {
                file_path: {
                  type: "string",
                  description: "The path to the file to read",
                },
              },
              required: ["file_path"],
            },
          },
        ],
      },
    });

    expect(response.ok()).toBeTruthy();
    const responseData = await response.json();

    // 6. Verify the tool call was blocked
    expect(responseData.content).toBeDefined();
    expect(responseData.content.length).toBeGreaterThan(0);

    // The response should have text content indicating the tool was blocked
    const textContent = responseData.content.find(
      // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
      (c: any) => c.type === "text",
    );
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain("read_file");
    expect(textContent.text).toContain("denied");

    // The original tool_use blocks should not be present (replaced with text refusal)
    const toolUseContent = responseData.content.filter(
      // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
      (c: any) => c.type === "tool_use",
    );
    expect(toolUseContent.length).toBe(0);

    // 7. Verify the interaction was persisted
    const interactionsResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/interactions?agentId=${agentId}`,
    });
    expect(interactionsResponse.ok()).toBeTruthy();
    const interactionsData = await interactionsResponse.json();
    expect(interactionsData.data.length).toBeGreaterThan(0);

    // Find the interaction with untrusted data
    // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
    const blockedInteraction = interactionsData.data.find((i: any) =>
      // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
      i.request?.messages?.some((m: any) =>
        m.content?.includes("UNTRUSTED_DATA"),
      ),
    );
    expect(blockedInteraction).toBeDefined();
  });

  test.afterEach(
    async ({
      request,
      deleteToolInvocationPolicy,
      deleteTrustedDataPolicy,
      deleteAgent,
    }) => {
      // Clean up: delete the created resources
      if (toolInvocationPolicyId) {
        await deleteToolInvocationPolicy(request, toolInvocationPolicyId);
      }
      if (trustedDataPolicyId) {
        await deleteTrustedDataPolicy(request, trustedDataPolicyId);
      }
      if (agentId) {
        await deleteAgent(request, agentId);
      }
    },
  );
});

test.describe("LLM Proxy - Gemini", () => {
  const GEMINI_TEST_CASE_1_HEADER = "test-case-1-gemini-tool-call";

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
    const createResponse = await createAgent(request, "Gemini Test Agent");
    const agent = await createResponse.json();
    agentId = agent.id;

    // 2. Send initial request to register the tool and get the toolId
    const initialResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/v1/gemini/${agentId}/v1beta/models/gemini-2.0-flash-exp:generateContent`,
      headers: {
        "x-goog-api-key": GEMINI_TEST_CASE_1_HEADER,
        "Content-Type": "application/json",
      },
      data: {
        contents: [
          {
            role: "user",
            parts: [
              {
                text: "Read the file at /etc/passwd",
              },
            ],
          },
        ],
        tools: [
          {
            functionDeclarations: [
              {
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
              },
            ],
          },
        ],
      },
    });

    if (!initialResponse.ok()) {
      const errorText = await initialResponse.text();
      throw new Error(
        `Initial Gemini request failed: ${initialResponse.status()} ${errorText}`,
      );
    }

    // Get the agent-tool relationship ID from the backend (with retry/polling for eventual consistency)
    const readFileAgentTool = await waitForAgentTool(
      request,
      agentId,
      "read_file",
    );
    toolId = readFileAgentTool.id;

    // 3. Create a trusted data policy that marks messages with "UNTRUSTED_DATA" in content as untrusted
    const trustedDataPolicyResponse = await createTrustedDataPolicy(request, {
      agentToolId: toolId,
      description: "Mark messages containing UNTRUSTED_DATA as untrusted",
      attributePath: "$.parts[0].text",
      operator: "contains",
      value: "UNTRUSTED_DATA",
      action: "mark_as_trusted",
    });
    const trustedDataPolicy = await trustedDataPolicyResponse.json();
    trustedDataPolicyId = trustedDataPolicy.id;

    // 4. Create a tool invocation policy that blocks read_file when accessing /etc/
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

    // 5. Send a request with untrusted data
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/v1/gemini/${agentId}/v1beta/models/gemini-2.0-flash-exp:generateContent`,
      headers: {
        "x-goog-api-key": GEMINI_TEST_CASE_1_HEADER,
        "Content-Type": "application/json",
      },
      data: {
        contents: [
          {
            role: "user",
            parts: [
              {
                text: "UNTRUSTED_DATA: This is untrusted content from an external source",
              },
            ],
          },
        ],
        tools: [
          {
            functionDeclarations: [
              {
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
              },
            ],
          },
        ],
      },
    });

    expect(response.ok()).toBeTruthy();
    const responseData = await response.json();

    // 6. Verify the tool call was blocked
    expect(responseData.candidates).toBeDefined();
    expect(responseData.candidates.length).toBeGreaterThan(0);
    expect(responseData.candidates[0].content).toBeDefined();
    expect(responseData.candidates[0].content.parts).toBeDefined();

    const parts = responseData.candidates[0].content.parts;

    // The response should have text content indicating the tool was blocked
    // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
    const textPart = parts.find((p: any) => p.text);
    expect(textPart).toBeDefined();
    expect(textPart.text).toContain("read_file");
    expect(textPart.text).toContain("denied");

    // The original functionCall parts should not be present (replaced with text refusal)
    // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
    const functionCallParts = parts.filter((p: any) => p.functionCall);
    expect(functionCallParts.length).toBe(0);

    // 7. Verify the interaction was persisted
    const interactionsResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/interactions?agentId=${agentId}`,
    });
    expect(interactionsResponse.ok()).toBeTruthy();
    const interactionsData = await interactionsResponse.json();
    expect(interactionsData.data.length).toBeGreaterThan(0);

    // Find the interaction with untrusted data
    // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
    const blockedInteraction = interactionsData.data.find((i: any) =>
      // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
      i.request?.contents?.some((c: any) =>
        // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
        c.parts?.some((p: any) => p.text?.includes("UNTRUSTED_DATA")),
      ),
    );
    expect(blockedInteraction).toBeDefined();
  });

  test.afterEach(
    async ({
      request,
      deleteToolInvocationPolicy,
      deleteTrustedDataPolicy,
      deleteAgent,
    }) => {
      // Clean up: delete the created resources
      if (toolInvocationPolicyId) {
        await deleteToolInvocationPolicy(request, toolInvocationPolicyId);
      }
      if (trustedDataPolicyId) {
        await deleteTrustedDataPolicy(request, trustedDataPolicyId);
      }
      if (agentId) {
        await deleteAgent(request, agentId);
      }
    },
  );
});
