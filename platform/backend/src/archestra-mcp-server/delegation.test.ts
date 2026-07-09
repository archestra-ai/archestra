// biome-ignore-all lint/suspicious/noExplicitAny: test
import { AGENT_TOOL_PREFIX, slugify } from "@archestra/shared";
import { vi } from "vitest";
import { ToolModel } from "@/models";
import { ProviderError } from "@/routes/chat/errors";
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
    const text = (result.content[0] as any).text;
    expect(text).toContain("No delegation is configured");
    expect(text).toContain(`${AGENT_TOOL_PREFIX}*`);
    expect(text).toContain("Do not guess delegation names");
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

  test("uses the caller user when the gateway token is not user-scoped", async ({
    makeAgent,
    makeAgentTool,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "admin" });
    testAgent = await makeAgent({
      name: "Parent Agent",
      agentType: "agent",
      organizationId: organization.id,
      scope: "personal",
      authorId: user.id,
    });
    const targetAgent = await makeAgent({
      name: "Delegated Agent",
      agentType: "agent",
      organizationId: organization.id,
      scope: "personal",
      authorId: user.id,
    });
    const delegationTool = await ToolModel.findOrCreateDelegationTool(
      targetAgent.id,
    );
    await makeAgentTool(testAgent.id, delegationTool.id);

    mockExecuteA2AMessage.mockResolvedValue({
      messageId: "subagent-message-user-context",
      text: "Handled by subagent",
      finishReason: "stop",
    });

    const result = await executeArchestraTool(
      `${AGENT_TOOL_PREFIX}${slugify(targetAgent.name)}`,
      { message: "Write the requested artifact." },
      {
        agent: { id: testAgent.id, name: testAgent.name },
        agentId: testAgent.id,
        organizationId: organization.id,
        userId: user.id,
        conversationId: crypto.randomUUID(),
        tokenAuth: {
          tokenId: crypto.randomUUID(),
          teamId: null,
          isOrganizationToken: true,
          organizationId: organization.id,
          isUserToken: false,
        },
      },
    );

    expect(result.isError).toBe(false);
    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: targetAgent.id,
        message: "Write the requested artifact.",
        organizationId: organization.id,
        userId: user.id,
      }),
    );
  });

  test("propagates chatops and scheduled run context to delegated subagents", async ({
    makeAgent,
    makeAgentTool,
  }) => {
    const targetAgent = await makeAgent({ name: "ChatOps Worker" });
    const delegationTool = await ToolModel.findOrCreateDelegationTool(
      targetAgent.id,
    );
    await makeAgentTool(testAgent.id, delegationTool.id);

    mockExecuteA2AMessage.mockResolvedValue({
      messageId: "subagent-message-chatops-context",
      text: "Handled by subagent",
      finishReason: "stop",
    });

    const result = await executeArchestraTool(
      `${AGENT_TOOL_PREFIX}${slugify(targetAgent.name)}`,
      { message: "Write the requested artifact." },
      {
        ...mockContext,
        conversationId: "synthetic-chatops-isolation-key",
        chatOpsBindingId: "chatops-binding-1",
        chatOpsThreadId: "thread-1",
        scheduleTriggerRunId: "schedule-run-1",
      },
    );

    expect(result.isError).toBe(false);
    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: targetAgent.id,
        message: "Write the requested artifact.",
        conversationId: "synthetic-chatops-isolation-key",
        chatOpsBindingId: "chatops-binding-1",
        chatOpsThreadId: "thread-1",
        scheduleTriggerRunId: "schedule-run-1",
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

describe("delegation error propagation", () => {
  let callerAgent: Agent;
  let baseContext: ArchestraContext;
  let toolName: string;

  beforeEach(async ({ makeAgent, makeAgentTool }) => {
    vi.clearAllMocks();
    callerAgent = await makeAgent({ name: "Caller Agent" });
    const targetAgent = await makeAgent({ name: "Target Agent" });
    const delegationTool = await ToolModel.findOrCreateDelegationTool(
      targetAgent.id,
    );
    await makeAgentTool(callerAgent.id, delegationTool.id);
    toolName = `${AGENT_TOOL_PREFIX}${slugify(targetAgent.name)}`;
    baseContext = {
      agent: { id: callerAgent.id, name: callerAgent.name },
      agentId: callerAgent.id,
      organizationId: "org-123",
    };
  });

  test("surfaces a subagent failure to the model as a tool error", async () => {
    mockExecuteA2AMessage.mockRejectedValue(new Error("subagent exploded"));

    const result = await executeArchestraTool(
      toolName,
      { message: "hello" },
      baseContext,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("subagent exploded");
  });

  test("rethrows a ProviderError so the parent stream reports the provider", async () => {
    const providerError = new ProviderError({
      message: "upstream is down",
      authenticated: false,
    } as any);
    mockExecuteA2AMessage.mockRejectedValue(providerError);

    await expect(
      executeArchestraTool(toolName, { message: "hello" }, baseContext),
    ).rejects.toBe(providerError);
  });

  test("rethrows an abort so cancellation propagates instead of becoming a tool error", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    mockExecuteA2AMessage.mockRejectedValue(abortError);

    await expect(
      executeArchestraTool(toolName, { message: "hello" }, baseContext),
    ).rejects.toBe(abortError);
  });
});
