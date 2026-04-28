// biome-ignore-all lint/suspicious/noExplicitAny: tests inspect MCP tool payloads dynamically
import {
  AGENT_TOOL_PREFIX,
  slugify,
  TOOL_RUN_TOOL_FULL_NAME,
  TOOL_TODO_WRITE_FULL_NAME,
  TOOL_WHOAMI_FULL_NAME,
} from "@shared";
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

  test("dispatches built-in tools by short name", async () => {
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

  test("dispatches built-in tools by full name", async () => {
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

  test("returns target built-in tool validation errors", async () => {
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

  test("dispatches third-party MCP tools through the MCP client", async () => {
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

  test("normalizes non-array third-party content to a text result", async () => {
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
