// biome-ignore-all lint/suspicious/noExplicitAny: test
import { AGENT_TOOL_PREFIX, slugify } from "@shared";
import { vi } from "vitest";
import { ToolModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

const mockExecuteA2AMessage = vi.fn();

vi.mock("@/agents/a2a-executor", () => ({
  executeA2AMessage: (...args: unknown[]) => mockExecuteA2AMessage(...args),
}));

describe("delegation tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent }) => {
    vi.clearAllMocks();
    testAgent = await makeAgent({ name: "Test Agent" });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      agentId: testAgent.id,
      organizationId: "org-123",
    };
  });

  test("returns error when message is missing", async () => {
    const result = await executeArchestraTool(
      `${AGENT_TOOL_PREFIX}some_agent`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Validation error in agent__some_agent",
    );
    expect((result.content[0] as any).text).toContain("message:");
  });

  test("returns error when agentId is missing from context", async () => {
    const noAgentContext: ArchestraContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      organizationId: "org-123",
    };
    const result = await executeArchestraTool(
      `${AGENT_TOOL_PREFIX}some_agent`,
      { message: "hello" },
      noAgentContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("No agent context");
  });

  test("returns error when organizationId is missing from context", async () => {
    const noOrgContext: ArchestraContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      agentId: testAgent.id,
    };
    const result = await executeArchestraTool(
      `${AGENT_TOOL_PREFIX}some_agent`,
      { message: "hello" },
      noOrgContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Organization context not available",
    );
  });

  test("returns error when delegation target not found", async () => {
    const result = await executeArchestraTool(
      `${AGENT_TOOL_PREFIX}nonexistent_agent`,
      { message: "hello" },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "not found or not configured for delegation",
    );
  });

  test("propagates the current trust state to delegated subagents", async ({
    makeAgent,
    makeAgentTool,
  }) => {
    const targetAgent = await makeAgent({ name: "Security Review Agent" });
    const delegationTool = await ToolModel.findOrCreateDelegationTool(
      targetAgent.id,
    );
    await makeAgentTool(testAgent.id, delegationTool.id);

    mockExecuteA2AMessage.mockResolvedValue({
      messageId: "subagent-message-1",
      text: "Handled by subagent",
      finishReason: "stop",
    });

    const result = await executeArchestraTool(
      `${AGENT_TOOL_PREFIX}${slugify(targetAgent.name)}`,
      { message: "Review the latest findings." },
      {
        ...mockContext,
        contextIsTrusted: false,
      },
    );

    expect(result.isError).toBe(false);
    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: targetAgent.id,
        message: "Review the latest findings.",
        organizationId: mockContext.organizationId,
        userId: "system",
        parentDelegationChain: testAgent.id,
        parentContextIsTrusted: false,
      }),
    );
  });

  test("leaves trust propagation unset when the parent context was never evaluated", async ({
    makeAgent,
    makeAgentTool,
  }) => {
    const targetAgent = await makeAgent({ name: "Research Agent" });
    const delegationTool = await ToolModel.findOrCreateDelegationTool(
      targetAgent.id,
    );
    await makeAgentTool(testAgent.id, delegationTool.id);

    mockExecuteA2AMessage.mockResolvedValue({
      messageId: "subagent-message-2",
      text: "Handled by subagent",
      finishReason: "stop",
    });

    const result = await executeArchestraTool(
      `${AGENT_TOOL_PREFIX}${slugify(targetAgent.name)}`,
      { message: "Investigate the issue." },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: targetAgent.id,
        message: "Investigate the issue.",
        organizationId: mockContext.organizationId,
        userId: "system",
        parentDelegationChain: testAgent.id,
        parentContextIsTrusted: undefined,
      }),
    );
  });
});
