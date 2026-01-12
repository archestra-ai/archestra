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

async function setupTestResources(params: {
  request: APIRequestContext;
  makeApiRequest: TestFixtures["makeApiRequest"];
}): Promise<TestResources> {
  const { request, makeApiRequest } = params;
  const timestamp = Date.now();

  // 1. Create team if needed
  const createTeamResponse = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/teams",
    data: { name: `Policy Test Team ${timestamp}` },
  });
  const team = await createTeamResponse.json();
  const teamId = team.id;

  // 2. Create profile
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

  // 3. Create tool
  const createToolResponse = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/tools",
    data: {
      name: `test_tool_${timestamp}`,
      description: "A test tool for policy testing",
      inputSchema: {
        type: "object",
        properties: {
          input: { type: "string" },
        },
      },
    },
  });
  const tool = await createToolResponse.json();

  // 4. Assign tool to profile
  await makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/agent-tools",
    data: { profileId: profile.id, toolId: tool.id },
  });

  return {
    profileId: profile.id,
    toolId: tool.id,
    tool: {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    },
    teamId,
  };
}

async function cleanupTestResources(params: {
  request: APIRequestContext;
  makeApiRequest: TestFixtures["makeApiRequest"];
  resources: TestResources;
}): Promise<void> {
  const { request, makeApiRequest, resources } = params;

  await makeApiRequest({
    request,
    method: "delete",
    urlSuffix: `/api/tools/${resources.toolId}`,
    ignoreStatusCheck: true,
  });
  await makeApiRequest({
    request,
    method: "delete",
    urlSuffix: `/api/agents/${resources.profileId}`,
    ignoreStatusCheck: true,
  });
  await makeApiRequest({
    request,
    method: "delete",
    urlSuffix: `/api/teams/${resources.teamId}`,
    ignoreStatusCheck: true,
  });
}

// =============================================================================
// Tests
// =============================================================================

test.describe("policies with context conditions", () => {
  test("should block tool call by team", async ({
    request,
    makeApiRequest,
    createToolInvocationPolicy,
    deleteToolInvocationPolicy,
  }) => {
    const resources = await setupTestResources({
      request,
      makeApiRequest,
    });

    // Create policy with context.teamIds condition
    const policyResponse = await createToolInvocationPolicy(request, {
      toolId: resources.toolId,
      conditions: [
        {
          key: "context.teamIds",
          operator: "contains",
          value: resources.teamId,
        },
      ],
      action: "block_always",
      reason: "Blocked for specific team",
    });
    const policy = await policyResponse.json();

    // Make LLM request - should be blocked
    const wiremockStub = "anthropic-blocks-tool-untrusted-data";
    const llmResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/v1/anthropic/${resources.profileId}/v1/messages`,
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
            name: resources.tool.name,
            description: resources.tool.description,
            input_schema: resources.tool.inputSchema,
          },
        ],
      },
    });

    expect(llmResponse.ok()).toBeTruthy();
    const responseData = await llmResponse.json();

    // Verify tool call was blocked
    const textContent = responseData.content.find(
      (c: { type: string }) => c.type === "text",
    );
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain("denied");
    expect(textContent.text).toContain("Blocked for specific team");

    // Create another profile with a different team - should NOT be blocked
    const otherResources = await setupTestResources({
      request,
      makeApiRequest,
    });

    // Assign the same tool to the other profile
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/agent-tools",
      data: { profileId: otherResources.profileId, toolId: resources.toolId },
    });

    const allowedResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/v1/anthropic/${otherResources.profileId}/v1/messages`,
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
            name: resources.tool.name,
            description: resources.tool.description,
            input_schema: resources.tool.inputSchema,
          },
        ],
      },
    });

    expect(allowedResponse.ok()).toBeTruthy();
    const allowedData = await allowedResponse.json();

    // Verify tool call was NOT blocked (tool_use present, no denial)
    const toolUseContent = allowedData.content.find(
      (c: { type: string }) => c.type === "tool_use",
    );
    expect(toolUseContent).toBeDefined();

    // Cleanup
    await deleteToolInvocationPolicy(request, policy.id);
    await cleanupTestResources({ request, makeApiRequest, resources });
    await cleanupTestResources({
      request,
      makeApiRequest,
      resources: otherResources,
    });
  });

  test("should block tool call by external agent id", async ({
    request,
    makeApiRequest,
    createToolInvocationPolicy,
    deleteToolInvocationPolicy,
  }) => {
    const blockedExternalAgentId = "blocked-external-agent";
    const resources = await setupTestResources({ request, makeApiRequest });

    // Create policy with context.externalAgentId condition
    const policyResponse = await createToolInvocationPolicy(request, {
      toolId: resources.toolId,
      conditions: [
        {
          key: "context.externalAgentId",
          operator: "equal",
          value: blockedExternalAgentId,
        },
      ],
      action: "block_always",
      reason: "Blocked for specific external agent",
    });
    const policy = await policyResponse.json();

    const wiremockStub = "anthropic-blocks-tool-untrusted-data";

    // Make LLM request WITH the blocked external agent id - should be blocked
    const blockedResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/v1/anthropic/${resources.profileId}/v1/messages`,
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
            name: resources.tool.name,
            description: resources.tool.description,
            input_schema: resources.tool.inputSchema,
          },
        ],
      },
    });

    expect(blockedResponse.ok()).toBeTruthy();
    const blockedData = await blockedResponse.json();

    // Verify tool call was blocked
    const textContent = blockedData.content.find(
      (c: { type: string }) => c.type === "text",
    );
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain("denied");
    expect(textContent.text).toContain("Blocked for specific external agent");

    // Make LLM request with DIFFERENT external agent id - should NOT be blocked
    const allowedResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/v1/anthropic/${resources.profileId}/v1/messages`,
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
            name: resources.tool.name,
            description: resources.tool.description,
            input_schema: resources.tool.inputSchema,
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

    // Cleanup
    await deleteToolInvocationPolicy(request, policy.id);
    await cleanupTestResources({ request, makeApiRequest, resources });
  });

  test("should block tool result by team", async ({
    request,
    makeApiRequest,
    createTrustedDataPolicy,
    deleteTrustedDataPolicy,
  }) => {
    const resources = await setupTestResources({
      request,
      makeApiRequest,
    });

    // Create trusted data policy with context.teamIds condition
    const policyResponse = await createTrustedDataPolicy(request, {
      toolId: resources.toolId,
      conditions: [
        {
          key: "context.teamIds",
          operator: "contains",
          value: resources.teamId,
        },
      ],
      action: "block_always",
      description: "Blocked result for specific team",
    });
    const policy = await policyResponse.json();

    // Make LLM request - should be blocked
    const wiremockStub = "anthropic-blocks-tool-untrusted-data";
    const llmResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/v1/anthropic/${resources.profileId}/v1/messages`,
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
            name: resources.tool.name,
            description: resources.tool.description,
            input_schema: resources.tool.inputSchema,
          },
        ],
      },
    });

    expect(llmResponse.ok()).toBeTruthy();
    const responseData = await llmResponse.json();

    // Verify tool result was blocked
    const textContent = responseData.content.find(
      (c: { type: string }) => c.type === "text",
    );
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain("denied");
    expect(textContent.text).toContain("Blocked result for specific team");

    // Create another profile with a different team - should NOT be blocked
    const otherResources = await setupTestResources({
      request,
      makeApiRequest,
    });

    // Assign the same tool to the other profile
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/agent-tools",
      data: { profileId: otherResources.profileId, toolId: resources.toolId },
    });

    const allowedResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/v1/anthropic/${otherResources.profileId}/v1/messages`,
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
            name: resources.tool.name,
            description: resources.tool.description,
            input_schema: resources.tool.inputSchema,
          },
        ],
      },
    });

    expect(allowedResponse.ok()).toBeTruthy();
    const allowedData = await allowedResponse.json();

    // Verify tool result was NOT blocked (tool_use present, no denial)
    const toolUseContent = allowedData.content.find(
      (c: { type: string }) => c.type === "tool_use",
    );
    expect(toolUseContent).toBeDefined();

    // Cleanup
    await deleteTrustedDataPolicy(request, policy.id);
    await cleanupTestResources({ request, makeApiRequest, resources });
    await cleanupTestResources({
      request,
      makeApiRequest,
      resources: otherResources,
    });
  });

  test("should block tool result by external agent id", async ({
    request,
    makeApiRequest,
    createTrustedDataPolicy,
    deleteTrustedDataPolicy,
  }) => {
    const blockedExternalAgentId = "blocked-external-agent";
    const resources = await setupTestResources({ request, makeApiRequest });

    // Create trusted data policy with context.externalAgentId condition
    const policyResponse = await createTrustedDataPolicy(request, {
      toolId: resources.toolId,
      conditions: [
        {
          key: "context.externalAgentId",
          operator: "equal",
          value: blockedExternalAgentId,
        },
      ],
      action: "block_always",
      description: "Blocked result for specific external agent",
    });
    const policy = await policyResponse.json();

    const wiremockStub = "anthropic-blocks-tool-untrusted-data";

    // Make LLM request WITH the blocked external agent id - should be blocked
    const blockedResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/v1/anthropic/${resources.profileId}/v1/messages`,
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
            name: resources.tool.name,
            description: resources.tool.description,
            input_schema: resources.tool.inputSchema,
          },
        ],
      },
    });

    expect(blockedResponse.ok()).toBeTruthy();
    const blockedData = await blockedResponse.json();

    // Verify tool result was blocked
    const textContent = blockedData.content.find(
      (c: { type: string }) => c.type === "text",
    );
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain("denied");
    expect(textContent.text).toContain(
      "Blocked result for specific external agent",
    );

    // Make LLM request with DIFFERENT external agent id - should NOT be blocked
    const allowedResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/v1/anthropic/${resources.profileId}/v1/messages`,
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
            name: resources.tool.name,
            description: resources.tool.description,
            input_schema: resources.tool.inputSchema,
          },
        ],
      },
    });

    expect(allowedResponse.ok()).toBeTruthy();
    const allowedData = await allowedResponse.json();

    // Verify tool result was NOT blocked
    const toolUseContent = allowedData.content.find(
      (c: { type: string }) => c.type === "tool_use",
    );
    expect(toolUseContent).toBeDefined();

    // Cleanup
    await deleteTrustedDataPolicy(request, policy.id);
    await cleanupTestResources({ request, makeApiRequest, resources });
  });
});
