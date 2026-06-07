// biome-ignore-all lint/suspicious/noExplicitAny: tests inspect MCP tool payloads dynamically
import {
  AGENT_TOOL_PREFIX,
  slugify,
  TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON,
  TOOL_RUN_TOOL_FULL_NAME,
  TOOL_TODO_WRITE_FULL_NAME,
  TOOL_WHOAMI_FULL_NAME,
} from "@archestra/shared";
import { vi } from "vitest";
import mcpClient from "@/clients/mcp-client";
import { ToolModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

const mockExecuteA2AMessage = vi.fn();

vi.mock("@/clients/mcp-client", () => ({
  default: {
    executeToolCall: vi.fn(),
  },
}));

vi.mock("@/agents/a2a-executor", () => ({
  executeA2AMessage: (...args: unknown[]) => mockExecuteA2AMessage(...args),
}));

describe("run_tool", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent, makeMember, makeOrganization, makeUser }) => {
    vi.clearAllMocks();

    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    testAgent = await makeAgent({
      name: "Run Tool Agent",
      organizationId: org.id,
    });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      agentId: testAgent.id,
      organizationId: org.id,
      userId: user.id,
      conversationId: "conversation-1",
      tokenAuth: {
        tokenId: "token-1",
        teamId: null,
        isOrganizationToken: true,
        organizationId: org.id,
      },
    };
  });

  test("validates run_tool arguments before dispatch", async () => {
    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      { tool_args: {} },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Validation error in archestra__run_tool",
    );
    expect((result.content[0] as any).text).toContain("tool_name:");
    expect(mcpClient.executeToolCall).not.toHaveBeenCalled();
  });

  test("prevents run_tool from invoking itself by full name", async () => {
    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      { tool_name: TOOL_RUN_TOOL_FULL_NAME },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "run_tool cannot invoke itself",
    );
    expect(mcpClient.executeToolCall).not.toHaveBeenCalled();
  });

  test("prevents run_tool from invoking itself by short name", async () => {
    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      { tool_name: "run_tool" },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "run_tool cannot invoke itself",
    );
    expect(mcpClient.executeToolCall).not.toHaveBeenCalled();
  });

  test("dispatches built-in tools by short name", async ({
    seedAndAssignArchestraTools,
  }) => {
    await seedAndAssignArchestraTools(testAgent.id);
    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      { tool_name: "whoami" },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      agentId: testAgent.id,
      agentName: testAgent.name,
    });
    expect(mcpClient.executeToolCall).not.toHaveBeenCalled();
  });

  test("dispatches built-in tools by full name", async ({
    seedAndAssignArchestraTools,
  }) => {
    await seedAndAssignArchestraTools(testAgent.id);
    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      { tool_name: TOOL_WHOAMI_FULL_NAME },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      agentId: testAgent.id,
      agentName: testAgent.name,
    });
    expect(mcpClient.executeToolCall).not.toHaveBeenCalled();
  });

  test("returns target built-in tool validation errors", async ({
    seedAndAssignArchestraTools,
  }) => {
    await seedAndAssignArchestraTools(testAgent.id);
    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      {
        tool_name: TOOL_TODO_WRITE_FULL_NAME,
        tool_args: {
          todos: [
            {
              id: 1,
              content: "bad status todo",
              status: "blocked",
            },
          ],
        },
      },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Validation error in archestra__todo_write",
    );
    expect((result.content[0] as any).text).toContain("todos[0].status:");
    expect(mcpClient.executeToolCall).not.toHaveBeenCalled();
  });

  test("blocks built-in Archestra tools that are not assigned to the agent", async ({
    makeAgent,
  }) => {
    // Fresh agent with no Archestra tools assigned.
    const unassignedAgent = await makeAgent({
      name: "Unassigned Agent",
      organizationId: mockContext.organizationId,
    });

    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      { tool_name: "swap_agent", tool_args: { agentId: "some-agent-id" } },
      {
        ...mockContext,
        agent: { id: unassignedAgent.id, name: unassignedAgent.name },
        agentId: unassignedAgent.id,
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "is not assigned to this agent",
    );
    expect(mcpClient.executeToolCall).not.toHaveBeenCalled();
  });

  test("routes agent delegation tool names through the built-in dispatcher", async ({
    makeAgent,
    makeAgentTool,
  }) => {
    const targetAgent = await makeAgent({
      name: "Research Agent",
      organizationId: mockContext.organizationId,
    });
    const delegationTool = await ToolModel.findOrCreateDelegationTool(
      targetAgent.id,
    );
    await makeAgentTool(testAgent.id, delegationTool.id);
    mockExecuteA2AMessage.mockResolvedValue({
      messageId: "subagent-message-1",
      text: "Delegated response",
      finishReason: "stop",
    });

    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      {
        tool_name: `${AGENT_TOOL_PREFIX}${slugify(targetAgent.name)}`,
        tool_args: { message: "Research this issue." },
      },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain("Delegated response");
    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: targetAgent.id,
        message: "Research this issue.",
        parentDelegationChain: testAgent.id,
      }),
    );
    expect(mcpClient.executeToolCall).not.toHaveBeenCalled();
  });

  test("requires agent context before dispatching third-party MCP tools", async () => {
    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      { tool_name: "github__search_repositories", tool_args: { query: "x" } },
      { ...mockContext, agentId: undefined },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "run_tool requires agent context to dispatch to third-party MCP tools",
    );
    expect(mcpClient.executeToolCall).not.toHaveBeenCalled();
  });

  test("dispatches third-party MCP tools through the MCP client", async ({
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog();
    const tool = await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });
    await makeAgentTool(testAgent.id, tool.id);

    vi.mocked(mcpClient.executeToolCall).mockResolvedValueOnce({
      content: [{ type: "text", text: "Third-party response" }],
      isError: false,
      _meta: { requestId: "request-1" },
      structuredContent: { ok: true },
    } as any);

    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      {
        tool_name: "github__search_repositories",
        tool_args: { query: "archestra" },
      },
      mockContext,
    );

    expect(mcpClient.executeToolCall).toHaveBeenCalledWith(
      {
        id: expect.stringMatching(/^run-tool-/),
        name: "github__search_repositories",
        arguments: { query: "archestra" },
      },
      testAgent.id,
      mockContext.tokenAuth,
      { conversationId: "conversation-1" },
    );
    expect(result).toMatchObject({
      isError: false,
      _meta: { requestId: "request-1" },
      structuredContent: { ok: true },
    });
    expect(result.content).toEqual([
      { type: "text", text: "Third-party response" },
    ]);
  });

  test("returns a search_tools recovery message for an unavailable third-party tool", async () => {
    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      {
        tool_name: "giphy__image_search_tool",
        tool_args: { query: "cat" },
      },
      mockContext,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as any).text;
    expect(text).toContain('No tool named "giphy__image_search_tool"');
    expect(text).toContain("search_tools");
    expect(text).not.toContain("not enabled for this conversation");
    expect(mcpClient.executeToolCall).not.toHaveBeenCalled();
  });

  test("recovery message wins over the policy refusal when the agent has other tools", async ({
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    // Reproduces the staging case: the agent HAS an assigned tool, so the
    // policy gate's disabled-tool filter is active (non-empty enabled set) and
    // would otherwise emit "not enabled for this conversation" for a
    // hallucinated name. The pre-check must intercept first.
    const catalog = await makeInternalMcpCatalog();
    const assigned = await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });
    await makeAgentTool(testAgent.id, assigned.id);

    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      { tool_name: "giphy__image_search_tool", tool_args: { query: "cat" } },
      mockContext,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as any).text;
    expect(text).toContain('No tool named "giphy__image_search_tool"');
    expect(text).not.toContain("not enabled for this conversation");
    expect(mcpClient.executeToolCall).not.toHaveBeenCalled();
  });

  test("blocks third-party MCP tools when target invocation policy denies the call", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTool,
    makeToolPolicy,
    makeUser,
  }) => {
    const org = await makeOrganization({ globalToolPolicy: "restrictive" });
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      name: "Run Tool Policy Agent",
      organizationId: org.id,
    });
    const catalog = await makeInternalMcpCatalog();
    const tool = await makeTool({
      name: `workspace__export_${crypto.randomUUID().slice(0, 8)}`,
      catalogId: catalog.id,
    });
    await makeAgentTool(agent.id, tool.id);
    await makeToolPolicy(tool.id, {
      action: "block_always",
      reason: "External export blocked",
      conditions: [
        { key: "destination", operator: "equal", value: "external" },
      ],
    });

    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      {
        tool_name: tool.name,
        tool_args: { destination: "external" },
      },
      {
        ...mockContext,
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId: org.id,
        userId: user.id,
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(tool.name);
    expect((result.content[0] as any).text).toContain(
      "External export blocked",
    );
    expect(mcpClient.executeToolCall).not.toHaveBeenCalled();
  });

  test("blocks third-party MCP tools that require approval when approval was not handled", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTool,
    makeToolPolicy,
    makeUser,
  }) => {
    const org = await makeOrganization({ globalToolPolicy: "restrictive" });
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      name: "Run Tool Approval Agent",
      organizationId: org.id,
    });
    const catalog = await makeInternalMcpCatalog();
    const tool = await makeTool({
      name: `workspace__approve_${crypto.randomUUID().slice(0, 8)}`,
      catalogId: catalog.id,
    });
    await makeAgentTool(agent.id, tool.id);
    await makeToolPolicy(tool.id, {
      action: "require_approval",
      conditions: [],
    });

    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      {
        tool_name: tool.name,
        tool_args: { destination: "external" },
      },
      {
        ...mockContext,
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId: org.id,
        userId: user.id,
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(tool.name);
    expect((result.content[0] as any).text).toContain(
      TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON,
    );
    expect(mcpClient.executeToolCall).not.toHaveBeenCalled();
  });

  test("dispatches approval-required third-party MCP tools after chat approval was handled", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTool,
    makeToolPolicy,
    makeUser,
  }) => {
    const org = await makeOrganization({ globalToolPolicy: "restrictive" });
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      name: "Run Tool Approved Agent",
      organizationId: org.id,
    });
    const catalog = await makeInternalMcpCatalog();
    const tool = await makeTool({
      name: `workspace__approved_${crypto.randomUUID().slice(0, 8)}`,
      catalogId: catalog.id,
    });
    await makeAgentTool(agent.id, tool.id);
    await makeToolPolicy(tool.id, {
      action: "require_approval",
      conditions: [],
    });
    vi.mocked(mcpClient.executeToolCall).mockResolvedValueOnce({
      content: [{ type: "text", text: "Approved response" }],
      isError: false,
    } as any);

    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      {
        tool_name: tool.name,
        tool_args: { destination: "external" },
      },
      {
        ...mockContext,
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId: org.id,
        userId: user.id,
        approvalRequiredPoliciesHandled: true,
      },
    );

    expect(result.isError).toBe(false);
    expect(mcpClient.executeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        name: tool.name,
        arguments: { destination: "external" },
      }),
      agent.id,
      mockContext.tokenAuth,
      { conversationId: "conversation-1" },
    );
    expect(result.content).toEqual([
      { type: "text", text: "Approved response" },
    ]);
  });

  test("normalizes non-array third-party content to a text result", async ({
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog();
    const tool = await makeTool({
      name: "github__get_repository",
      catalogId: catalog.id,
    });
    await makeAgentTool(testAgent.id, tool.id);

    vi.mocked(mcpClient.executeToolCall).mockResolvedValueOnce({
      content: { ok: true },
      isError: false,
    } as any);

    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      { tool_name: "github__get_repository", tool_args: { name: "repo" } },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ ok: true }) },
    ]);
  });
});
