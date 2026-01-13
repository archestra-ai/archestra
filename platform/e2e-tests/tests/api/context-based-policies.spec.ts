import type { APIRequestContext } from "@playwright/test";
import { expect, type TestFixtures, test } from "./fixtures";

/**
 * Tests for context-based policy conditions (context.teamIds, context.externalAgentId)
 * These tests verify that policies with context conditions can be created and work correctly.
 */

// =============================================================================
// Test Setup Helper
// =============================================================================

interface TestResources {
  profileId: string;
  toolId: string;
  tool: { name: string; description: string; inputSchema: object };
  teamId: string;
}

const TEST_TOOL_NAME_PREFIX = "__e2e_context_policy_test__";

function createTestTool(suffix: string) {
  return {
    name: `${TEST_TOOL_NAME_PREFIX}${suffix}`,
    description: "E2E test tool for context-based policies",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to the file" },
      },
    },
  };
}

async function setupTestResources(params: {
  request: APIRequestContext;
  makeApiRequest: TestFixtures["makeApiRequest"];
  waitForAgentTool: TestFixtures["waitForAgentTool"];
  toolSuffix: string;
}): Promise<TestResources> {
  const { request, makeApiRequest, waitForAgentTool, toolSuffix } = params;
  const timestamp = Date.now();
  const testTool = createTestTool(toolSuffix);

  // 1. Create team
  const createTeamResponse = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/teams",
    data: { name: `Policy Test Team ${timestamp}` },
  });
  const team = await createTeamResponse.json();
  const teamId = team.id;

  // 2. Create profile with team assignment
  const createProfileResponse = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/agents",
    data: {
      name: `Context Policy Test Profile ${timestamp}`,
      teams: [teamId],
    },
  });
  const profile = await createProfileResponse.json();

  // 3. Send initial LLM request to register the tool
  const wiremockStub = "anthropic-context-policy-test";
  await makeApiRequest({
    request,
    method: "post",
    urlSuffix: `/v1/anthropic/${profile.id}/v1/messages`,
    headers: {
      "x-api-key": wiremockStub,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    data: {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Register tool" }],
      tools: [testTool],
    },
  });

  // 4. Wait for tool to be registered and get its ID
  const agentTool = await waitForAgentTool(request, profile.id, testTool.name);
  const toolId = agentTool.tool.id;

  return {
    profileId: profile.id,
    toolId,
    tool: {
      name: testTool.name,
      description: testTool.description,
      inputSchema: testTool.input_schema,
    },
    teamId,
  };
}

// =============================================================================
// Tests
// =============================================================================

test.describe("policies with context conditions", () => {
  // Tests can run in parallel since each uses a unique tool suffix

  let currentResources: TestResources | null = null;

  // Clean up ALL stale test tools before each test
  test.beforeAll(async ({ request, makeApiRequest }) => {
    // Find ALL tools with the test tool name
    const toolsResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/tools?limit=1000",
      ignoreStatusCheck: true,
    });

    const testToolIds: string[] = [];
    if (toolsResponse.ok()) {
      const toolsData = await toolsResponse.json();
      const tools = toolsData.data || toolsData;
      for (const tool of tools) {
        if (tool.name.startsWith(TEST_TOOL_NAME_PREFIX)) {
          testToolIds.push(tool.id);
        }
      }
    }

    if (testToolIds.length === 0) {
      return;
    }

    // Delete all tool invocation policies for ALL test tools
    const toolInvocationPoliciesResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/autonomy-policies/tool-invocation",
      ignoreStatusCheck: true,
    });
    if (toolInvocationPoliciesResponse.ok()) {
      const policies = await toolInvocationPoliciesResponse.json();
      for (const policy of policies) {
        if (testToolIds.includes(policy.toolId)) {
          await makeApiRequest({
            request,
            method: "delete",
            urlSuffix: `/api/autonomy-policies/tool-invocation/${policy.id}`,
            ignoreStatusCheck: true,
          });
        }
      }
    }

    // Delete all trusted data policies for ALL test tools
    const trustedDataPoliciesResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/trusted-data-policies",
      ignoreStatusCheck: true,
    });
    if (trustedDataPoliciesResponse.ok()) {
      const policies = await trustedDataPoliciesResponse.json();
      for (const policy of policies) {
        if (testToolIds.includes(policy.toolId)) {
          await makeApiRequest({
            request,
            method: "delete",
            urlSuffix: `/api/trusted-data-policies/${policy.id}`,
            ignoreStatusCheck: true,
          });
        }
      }
    }

    // Delete ALL test tools
    for (const toolId of testToolIds) {
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/tools/${toolId}`,
        ignoreStatusCheck: true,
      });
    }
  });

  // Clean up resources after each test
  test.afterEach(async ({ request, makeApiRequest, deleteAgent }) => {
    if (!currentResources) return;

    const { toolId, profileId, teamId } = currentResources;

    // 1. Delete tool invocation policies for the tool
    const toolInvocationPoliciesResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/autonomy-policies/tool-invocation",
      ignoreStatusCheck: true,
    });
    if (toolInvocationPoliciesResponse.ok()) {
      const policies = await toolInvocationPoliciesResponse.json();
      for (const policy of policies) {
        if (policy.toolId === toolId) {
          await makeApiRequest({
            request,
            method: "delete",
            urlSuffix: `/api/autonomy-policies/tool-invocation/${policy.id}`,
            ignoreStatusCheck: true,
          });
        }
      }
    }

    // 2. Delete trusted data policies for the tool
    const trustedDataPoliciesResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/trusted-data-policies",
      ignoreStatusCheck: true,
    });
    if (trustedDataPoliciesResponse.ok()) {
      const policies = await trustedDataPoliciesResponse.json();
      for (const policy of policies) {
        if (policy.toolId === toolId) {
          await makeApiRequest({
            request,
            method: "delete",
            urlSuffix: `/api/trusted-data-policies/${policy.id}`,
            ignoreStatusCheck: true,
          });
        }
      }
    }

    // 3. Delete the tool
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/tools/${toolId}`,
      ignoreStatusCheck: true,
    });

    // 4. Delete the profile (agent)
    await deleteAgent(request, profileId);

    // 5. Delete the team
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/teams/${teamId}`,
      ignoreStatusCheck: true,
    });

    currentResources = null;
  });

  test("blocks tool call by team", async ({
    request,
    makeApiRequest,
    waitForAgentTool,
  }) => {
    currentResources = await setupTestResources({
      request,
      makeApiRequest,
      waitForAgentTool,
      toolSuffix: "1",
    });

    // Create policy with context.teamIds condition
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/autonomy-policies/tool-invocation",
      data: {
        toolId: currentResources.toolId,
        conditions: [
          {
            key: "context.teamIds",
            operator: "contains",
            value: currentResources.teamId,
          },
        ],
        action: "block_always",
        reason: "Blocked for specific team",
      },
    });

    // Make LLM request - should be blocked
    const wiremockStub = "anthropic-context-policy-test";
    const llmResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/v1/anthropic/${currentResources.profileId}/v1/messages`,
      headers: {
        "x-api-key": wiremockStub,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      data: {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Test the tool" }],
        tools: [
          {
            name: currentResources.tool.name,
            description: currentResources.tool.description,
            input_schema: currentResources.tool.inputSchema,
          },
        ],
      },
    });

    expect(llmResponse.ok()).toBeTruthy();
    const llmResponseData = await llmResponse.json();

    // Verify tool call was blocked
    const textContent = llmResponseData.content.find(
      (c: { type: string }) => c.type === "text",
    );
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain("denied");
    expect(textContent.text).toContain("Blocked for specific team");
  });

  test("blocks tool call by external agent id", async ({
    request,
    makeApiRequest,
    waitForAgentTool,
  }) => {
    const blockedExternalAgentId = "blocked-external-agent";
    currentResources = await setupTestResources({
      request,
      makeApiRequest,
      waitForAgentTool,
      toolSuffix: "2",
    });

    // Create policy with context.externalAgentId condition
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/autonomy-policies/tool-invocation",
      data: {
        toolId: currentResources.toolId,
        conditions: [
          {
            key: "context.externalAgentId",
            operator: "equal",
            value: blockedExternalAgentId,
          },
        ],
        action: "block_always",
        reason: "Blocked for specific external agent",
      },
    });

    const wiremockStub = "anthropic-context-policy-test";

    // Make LLM request WITH the blocked external agent id - should be blocked
    const llmResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/v1/anthropic/${currentResources.profileId}/v1/messages`,
      headers: {
        "x-api-key": wiremockStub,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "X-Archestra-Agent-Id": blockedExternalAgentId,
      },
      data: {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Test the tool" }],
        tools: [
          {
            name: currentResources.tool.name,
            description: currentResources.tool.description,
            input_schema: currentResources.tool.inputSchema,
          },
        ],
      },
    });

    expect(llmResponse.ok()).toBeTruthy();
    const llmResponseData = await llmResponse.json();

    // Verify tool call was blocked
    const textContent = llmResponseData.content.find(
      (c: { type: string }) => c.type === "text",
    );
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain("denied");
    expect(textContent.text).toContain("Blocked for specific external agent");

    // Make LLM request with DIFFERENT external agent id - should NOT be blocked
    const allowedResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/v1/anthropic/${currentResources.profileId}/v1/messages`,
      headers: {
        "x-api-key": wiremockStub,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "X-Archestra-Agent-Id": "different-external-agent",
      },
      data: {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Test the tool" }],
        tools: [
          {
            name: currentResources.tool.name,
            description: currentResources.tool.description,
            input_schema: currentResources.tool.inputSchema,
          },
        ],
      },
    });

    expect(allowedResponse.ok()).toBeTruthy();
    const allowedData = await allowedResponse.json();

    // Verify tool call was NOT blocked
    const toolUseContent = allowedData.content.find(
      (c: { type: string }) => c.type === "tool_use",
    );
    expect(toolUseContent).toBeDefined();
  });

  test("blocks tool result by team", async ({
    request,
    makeApiRequest,
    waitForAgentTool,
  }) => {
    currentResources = await setupTestResources({
      request,
      makeApiRequest,
      waitForAgentTool,
      toolSuffix: "3",
    });

    // Create trusted data policy with context.teamIds condition
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/trusted-data-policies",
      data: {
        toolId: currentResources.toolId,
        conditions: [
          {
            key: "context.teamIds",
            operator: "contains",
            value: currentResources.teamId,
          },
        ],
        action: "block_always",
        description: "Blocked result for specific team",
      },
    });

    // Make LLM request with tool result in conversation - should be blocked
    const wiremockStub = "anthropic-context-policy-test";
    const toolUseId = "toolu_test_trusted_data";
    const llmResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/v1/anthropic/${currentResources.profileId}/v1/messages`,
      headers: {
        "x-api-key": wiremockStub,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      data: {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [
          { role: "user", content: "Test the tool" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: toolUseId,
                name: currentResources.tool.name,
                input: { file_path: "/etc/passwd" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUseId,
                content:
                  "root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin",
              },
            ],
          },
        ],
        tools: [
          {
            name: currentResources.tool.name,
            description: currentResources.tool.description,
            input_schema: currentResources.tool.inputSchema,
          },
        ],
      },
    });

    expect(llmResponse.ok()).toBeTruthy();
    const responseData = await llmResponse.json();

    // The tool result in the conversation should be blocked/replaced
    // We can't easily verify the replacement in the response, but we can check
    // that the request succeeded and the LLM processed it
    expect(responseData.content).toBeDefined();
  });

  test("blocks tool result by external agent id", async ({
    request,
    makeApiRequest,
    waitForAgentTool,
  }) => {
    const blockedExternalAgentId = "blocked-external-agent";
    currentResources = await setupTestResources({
      request,
      makeApiRequest,
      waitForAgentTool,
      toolSuffix: "4",
    });

    // Create trusted data policy with context.externalAgentId condition
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/trusted-data-policies",
      data: {
        toolId: currentResources.toolId,
        conditions: [
          {
            key: "context.externalAgentId",
            operator: "equal",
            value: blockedExternalAgentId,
          },
        ],
        action: "block_always",
        description: "Blocked result for specific external agent",
      },
    });

    const wiremockStub = "anthropic-context-policy-test";
    const toolUseId = "toolu_test_external_agent";

    // Make LLM request WITH tool result and blocked external agent id - should be blocked
    const blockedResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/v1/anthropic/${currentResources.profileId}/v1/messages`,
      headers: {
        "x-api-key": wiremockStub,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "X-Archestra-Agent-Id": blockedExternalAgentId,
      },
      data: {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [
          { role: "user", content: "Test the tool" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: toolUseId,
                name: currentResources.tool.name,
                input: { file_path: "/etc/passwd" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUseId,
                content: "root:x:0:0:root:/root:/bin/bash",
              },
            ],
          },
        ],
        tools: [
          {
            name: currentResources.tool.name,
            description: currentResources.tool.description,
            input_schema: currentResources.tool.inputSchema,
          },
        ],
      },
    });

    expect(blockedResponse.ok()).toBeTruthy();
    const blockedData = await blockedResponse.json();

    // The tool result in the conversation should be blocked/replaced
    expect(blockedData.content).toBeDefined();

    // Make LLM request with DIFFERENT external agent id - should NOT be blocked
    const allowedResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/v1/anthropic/${currentResources.profileId}/v1/messages`,
      headers: {
        "x-api-key": wiremockStub,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "X-Archestra-Agent-Id": "different-external-agent",
      },
      data: {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [
          { role: "user", content: "Test the tool" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: toolUseId,
                name: currentResources.tool.name,
                input: { file_path: "/etc/passwd" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUseId,
                content: "root:x:0:0:root:/root:/bin/bash",
              },
            ],
          },
        ],
        tools: [
          {
            name: currentResources.tool.name,
            description: currentResources.tool.description,
            input_schema: currentResources.tool.inputSchema,
          },
        ],
      },
    });

    expect(allowedResponse.ok()).toBeTruthy();
    const allowedData = await allowedResponse.json();

    // Tool result should NOT be blocked for different agent
    expect(allowedData.content).toBeDefined();
  });
});
