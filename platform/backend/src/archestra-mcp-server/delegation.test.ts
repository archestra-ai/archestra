// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  AGENT_TOOL_PREFIX,
  BUILT_IN_AGENT_IDS,
  SELF_FORK_TOOL_NAME,
  slugify,
} from "@archestra/shared";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import {
  AgentExcludedSubagentModel,
  AgentModel,
  EnvironmentModel,
  ToolModel,
} from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import { ProviderError, SubagentProviderError } from "@/routes/chat/errors";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool, getAgentTools } from ".";

/** The delegation targets a surface offers, without the caller's own fork. */
function delegationTargets(tools: Array<{ name: string }>) {
  return tools.filter((tool) => tool.name !== SELF_FORK_TOOL_NAME);
}

const mockExecuteA2AMessage = vi.fn();
const mockStartDelegatedTask = vi.fn();

vi.mock("@/agents/a2a-executor", () => ({
  executeA2AMessage: (...args: unknown[]) => mockExecuteA2AMessage(...args),
}));
vi.mock("@/archestra-mcp-server/tasks", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/archestra-mcp-server/tasks")>();
  return {
    ...actual,
    startDelegatedTask: (...args: unknown[]) => mockStartDelegatedTask(...args),
  };
});

describe("delegation tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent, makeUser, makeMember }) => {
    vi.clearAllMocks();
    testAgent = await makeAgent({ name: "Test Agent" });
    const caller = await makeUser();
    await makeMember(caller.id, testAgent.organizationId);
    mockContext = {
      userId: caller.id,
      agent: { id: testAgent.id, name: testAgent.name },
      agentId: testAgent.id,
      organizationId: testAgent.organizationId,
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
      organizationId: testAgent.organizationId,
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

  test("runs an ordinary delegation as a durable task when the target has Agent Runtime", async ({
    makeAgent,
    makeAgentTool,
  }) => {
    const targetAgent = await makeAgent({
      organizationId: testAgent.organizationId,
      name: "Background Worker",
      runtime: {
        image: "example.invalid/background-worker:test",
        command: null,
        inferenceProtocol: "openai_responses",
        backend: "kubernetes",
        steerMode: "pipe",
        privileged: false,
        resources: null,
        environment: null,
        credentials: null,
        ttlHours: null,
        idleTimeoutMinutes: null,
      },
    });
    const delegationTool = await ToolModel.findOrCreateDelegationTool(
      targetAgent.id,
    );
    await makeAgentTool(testAgent.id, delegationTool.id);
    mockStartDelegatedTask.mockResolvedValue({
      content: [{ type: "text", text: "Task task-1 started" }],
      isError: false,
    });
    const context = {
      ...mockContext,
      userId: mockContext.userId,
      sessionId: "chatops:slack:thread-1",
      chatOpsBindingId: "binding-1",
      chatOpsThreadId: "thread-1",
    };

    const result = await executeArchestraTool(
      `${AGENT_TOOL_PREFIX}${slugify(targetAgent.name)}`,
      { message: "Implement the change." },
      context,
    );

    expect(result.isError).toBe(false);
    expect(mockStartDelegatedTask).toHaveBeenCalledWith({
      agentId: targetAgent.id,
      message: "Implement the change.",
      context,
    });
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });

  test("lets a foreground router hand a nested delegation to an Agent Runtime worker", async ({
    makeAgent,
    makeAgentTool,
  }) => {
    const router = await makeAgent({
      organizationId: testAgent.organizationId,
      name: "Coding Task Router",
    });
    const worker = await makeAgent({
      organizationId: testAgent.organizationId,
      name: "Selected Coding Worker",
      runtime: {
        image: "example.invalid/coding-worker:test",
        command: ["coding-worker"],
        inferenceProtocol: "openai_responses",
        backend: "kubernetes",
        steerMode: "pipe",
        privileged: false,
        resources: null,
        environment: null,
        credentials: null,
        ttlHours: null,
        idleTimeoutMinutes: null,
      },
    });
    const routerTool = await ToolModel.findOrCreateDelegationTool(router.id);
    const workerTool = await ToolModel.findOrCreateDelegationTool(worker.id);
    await makeAgentTool(testAgent.id, routerTool.id);
    await makeAgentTool(router.id, workerTool.id);

    const rootContext = {
      ...mockContext,
      userId: mockContext.userId,
      sessionId: "chatops:slack:thread-1",
      chatOpsBindingId: "binding-1",
      chatOpsThreadId: "thread-1",
    };
    mockStartDelegatedTask.mockResolvedValue({
      content: [{ type: "text", text: "Task task-1 started" }],
      isError: false,
    });
    mockExecuteA2AMessage.mockImplementationOnce(async (params) => {
      const nestedContext: ArchestraContext = {
        agent: { id: router.id, name: router.name },
        agentId: router.id,
        organizationId: params.organizationId,
        userId: params.userId,
        sessionId: params.sessionId,
        delegationChain: `${params.parentDelegationChain}:${router.id}`,
        chatOpsBindingId: params.chatOpsBindingId,
        chatOpsThreadId: params.chatOpsThreadId,
      };
      const nestedResult = await executeArchestraTool(
        `${AGENT_TOOL_PREFIX}${slugify(worker.name)}`,
        { message: "Run the complete original task." },
        nestedContext,
      );
      expect(nestedResult.isError).toBe(false);
      return {
        messageId: "router-message-1",
        text: "The selected worker has started.",
        finishReason: "stop",
      };
    });

    const result = await executeArchestraTool(
      `${AGENT_TOOL_PREFIX}${slugify(router.name)}`,
      { message: "Ask which coding worker to use." },
      rootContext,
    );

    expect(result.isError).toBe(false);
    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: router.id,
        parentDelegationChain: testAgent.id,
        userId: rootContext.userId,
        sessionId: rootContext.sessionId,
        chatOpsBindingId: rootContext.chatOpsBindingId,
        chatOpsThreadId: rootContext.chatOpsThreadId,
      }),
    );
    expect(mockStartDelegatedTask).toHaveBeenCalledWith({
      agentId: worker.id,
      message: "Run the complete original task.",
      context: expect.objectContaining({
        agentId: router.id,
        delegationChain: `${testAgent.id}:${router.id}`,
        userId: rootContext.userId,
        sessionId: rootContext.sessionId,
        chatOpsBindingId: rootContext.chatOpsBindingId,
        chatOpsThreadId: rootContext.chatOpsThreadId,
      }),
    });
  });

  for (const enabled of [true, false]) {
    test(`executes delegation and propagates trust with APPA enabled=${enabled}`, async ({
      makeAgent,
      makeAgentTool,
    }) => {
      config.openappa.enabled = enabled;
      await GuardrailsDeploymentModel.setEnabled(true);
      const targetAgent = await makeAgent({
        organizationId: testAgent.organizationId,
        name: "Security Review Agent",
      });
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
      expect(result.content).toEqual([
        { type: "text", text: "Handled by subagent" },
      ]);
      expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: targetAgent.id,
          message: "Review the latest findings.",
          organizationId: mockContext.organizationId,
          userId: mockContext.userId,
          parentDelegationChain: testAgent.id,
          parentContextIsTrusted: false,
        }),
      );
    });
  }

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
      access: "personal",
      authorId: user.id,
    });
    const targetAgent = await makeAgent({
      name: "Delegated Agent",
      agentType: "agent",
      organizationId: organization.id,
      access: "personal",
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
    const targetAgent = await makeAgent({
      organizationId: testAgent.organizationId,
      name: "ChatOps Worker",
    });
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
    const targetAgent = await makeAgent({
      organizationId: testAgent.organizationId,
      name: "Research Agent",
    });
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
        userId: mockContext.userId,
        parentDelegationChain: testAgent.id,
        parentContextIsTrusted: undefined,
      }),
    );
  });
});

describe("delegation error propagation", () => {
  let callerAgent: Agent;
  let baseContext: ArchestraContext;
  let targetAgent: Agent;
  let toolName: string;

  beforeEach(async ({ makeAgent, makeAgentTool }) => {
    vi.clearAllMocks();
    callerAgent = await makeAgent({ name: "Caller Agent" });
    targetAgent = await makeAgent({ name: "Target Agent" });
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

  test("rethrows a ProviderError with the originating subagent", async () => {
    const providerError = new ProviderError({
      message: "upstream is down",
      authenticated: false,
    } as any);
    mockExecuteA2AMessage.mockRejectedValue(providerError);

    const error = await executeArchestraTool(
      toolName,
      { message: "hello" },
      baseContext,
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(SubagentProviderError);
    expect(error.chatErrorResponse).toBe(providerError.chatErrorResponse);
    expect(error.subagentId).toBe(targetAgent.id);
    expect(error.subagentName).toBe(targetAgent.name);
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

describe("Auto-mode subagent delegation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // A parent agent in Auto mode plus an org-scoped target the caller can reach,
  // with no explicit delegation wiring between them.
  async function setupAutoMode(fixtures: {
    makeOrganization: any;
    makeUser: any;
    makeMember: any;
    makeAgent: any;
    accessAllSubagents?: boolean;
  }) {
    const { makeOrganization, makeUser, makeMember, makeAgent } = fixtures;
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "member" });
    const parent = await makeAgent({
      name: "Parent Agent",
      agentType: "agent",
      organizationId: organization.id,
    });
    if (fixtures.accessAllSubagents !== false) {
      await AgentModel.update(parent.id, { accessAllSubagents: true });
    }
    const target = await makeAgent({
      name: "Research Bot",
      agentType: "agent",
      organizationId: organization.id,
    });
    return { organization, user, parent, target };
  }

  test("exposes accessible internal agents as delegation tools", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { organization, user, parent, target } = await setupAutoMode({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    });

    const tools = await getAgentTools({
      agentId: parent.id,
      organizationId: organization.id,
      userId: user.id,
    });
    const names = tools.map((t) => t.name);

    expect(names).toContain(`${AGENT_TOOL_PREFIX}${slugify(target.name)}`);
    // The agent never delegates to itself.
    expect(names).not.toContain(`${AGENT_TOOL_PREFIX}${slugify(parent.name)}`);
  });

  test("Auto mode excludes platform built-ins while offering ordinary subagents", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { organization, user, parent, target } = await setupAutoMode({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    });
    const builtIn = await makeAgent({
      name: "Platform Compaction",
      agentType: "agent",
      organizationId: organization.id,
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.CONTEXT_COMPACTION },
    });
    const tools = await getAgentTools({
      agentId: parent.id,
      organizationId: organization.id,
      userId: user.id,
    });
    const names = tools.map((tool) => tool.name);
    expect(names).toContain(`${AGENT_TOOL_PREFIX}${slugify(target.name)}`);
    expect(names).not.toContain(`${AGENT_TOOL_PREFIX}${slugify(builtIn.name)}`);
  });

  test("omits excluded delegation targets from the surface", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { organization, user, parent, target } = await setupAutoMode({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    });
    await AgentExcludedSubagentModel.replaceForAgent(parent.id, [target.id]);

    const tools = await getAgentTools({
      agentId: parent.id,
      organizationId: organization.id,
      userId: user.id,
    });

    expect(tools.map((t) => t.name)).not.toContain(
      `${AGENT_TOOL_PREFIX}${slugify(target.name)}`,
    );
  });

  test("does not expand for system/token flows (no real user)", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { organization, parent } = await setupAutoMode({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    });

    // Auto mode is on, but there is no authenticated user: fall back to
    // explicit delegations only (none configured here).
    const tools = await getAgentTools({
      agentId: parent.id,
      organizationId: organization.id,
      userId: "system",
      skipAccessCheck: true,
    });

    expect(delegationTargets(tools)).toHaveLength(0);
  });

  test("Custom mode ignores accessible agents (explicit only)", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { organization, user, parent } = await setupAutoMode({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      accessAllSubagents: false,
    });

    const tools = await getAgentTools({
      agentId: parent.id,
      organizationId: organization.id,
      userId: user.id,
    });

    expect(delegationTargets(tools)).toHaveLength(0);
  });

  test("dispatches to an accessible target without explicit assignment", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { organization, user, parent, target } = await setupAutoMode({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    });

    mockExecuteA2AMessage.mockResolvedValue({
      messageId: "auto-delegation-1",
      text: "Handled by subagent",
      finishReason: "stop",
    });

    const result = await executeArchestraTool(
      `${AGENT_TOOL_PREFIX}${slugify(target.name)}`,
      { message: "Do the research." },
      {
        agent: { id: parent.id, name: parent.name },
        agentId: parent.id,
        organizationId: organization.id,
        userId: user.id,
      },
    );

    expect(result.isError).toBe(false);
    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: target.id,
        message: "Do the research.",
        organizationId: organization.id,
        userId: user.id,
      }),
    );
  });

  test("refuses to dispatch to an excluded target", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { organization, user, parent, target } = await setupAutoMode({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    });
    await AgentExcludedSubagentModel.replaceForAgent(parent.id, [target.id]);

    const result = await executeArchestraTool(
      `${AGENT_TOOL_PREFIX}${slugify(target.name)}`,
      { message: "Do the research." },
      {
        agent: { id: parent.id, name: parent.name },
        agentId: parent.id,
        organizationId: organization.id,
        userId: user.id,
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "No delegation is configured",
    );
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });

  test("Auto mode never crosses environment boundaries (surface and dispatch)", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { organization, user, parent, target } = await setupAutoMode({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    });
    const otherEnv = await EnvironmentModel.create({
      organizationId: organization.id,
      name: "Other Environment",
    });
    const crossEnvTarget = await makeAgent({
      name: "Cross Env Bot",
      agentType: "agent",
      organizationId: organization.id,
      environmentId: otherEnv.id,
    });

    // Surface: the parent (Default environment) sees only same-environment
    // targets.
    const tools = await getAgentTools({
      agentId: parent.id,
      organizationId: organization.id,
      userId: user.id,
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain(`${AGENT_TOOL_PREFIX}${slugify(target.name)}`);
    expect(names).not.toContain(
      `${AGENT_TOOL_PREFIX}${slugify(crossEnvTarget.name)}`,
    );

    // Dispatch stays symmetric with the surface.
    const result = await executeArchestraTool(
      `${AGENT_TOOL_PREFIX}${slugify(crossEnvTarget.name)}`,
      { message: "Do the research." },
      {
        agent: { id: parent.id, name: parent.name },
        agentId: parent.id,
        organizationId: organization.id,
        userId: user.id,
      },
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "No delegation is configured",
    );
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });

  test("Custom mode drops an explicit delegation whose target is in another environment", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeAgentTool,
  }) => {
    const { organization, user, parent } = await setupAutoMode({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      accessAllSubagents: false,
    });
    const otherEnv = await EnvironmentModel.create({
      organizationId: organization.id,
      name: "Other Environment",
    });
    const crossEnvTarget = await makeAgent({
      name: "Cross Env Expert",
      agentType: "agent",
      organizationId: organization.id,
      environmentId: otherEnv.id,
    });

    // Explicitly wire a delegation row to the cross-environment target.
    const [delegationTool] = await db
      .insert(schema.toolsTable)
      .values({
        name: `${AGENT_TOOL_PREFIX}${slugify(crossEnvTarget.name)}`,
        delegateToAgentId: crossEnvTarget.id,
      })
      .returning();
    await makeAgentTool(parent.id, delegationTool.id);

    // The assignment exists but is neither advertised nor dispatchable.
    const tools = await getAgentTools({
      agentId: parent.id,
      organizationId: organization.id,
      userId: user.id,
    });
    expect(delegationTargets(tools)).toHaveLength(0);

    const result = await executeArchestraTool(
      `${AGENT_TOOL_PREFIX}${slugify(crossEnvTarget.name)}`,
      { message: "Do the research." },
      {
        agent: { id: parent.id, name: parent.name },
        agentId: parent.id,
        organizationId: organization.id,
        userId: user.id,
      },
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "No delegation is configured",
    );
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });
});

describe("self-fork and attested returns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function setup(fixtures: {
    makeOrganization: any;
    makeUser: any;
    makeMember: any;
    makeAgent: any;
  }) {
    const organization = await fixtures.makeOrganization();
    const user = await fixtures.makeUser();
    await fixtures.makeMember(user.id, organization.id, { role: "member" });
    const parent = await fixtures.makeAgent({
      name: "Parent Agent",
      agentType: "agent",
      organizationId: organization.id,
    });
    await AgentModel.update(parent.id, { accessAllSubagents: true });
    const target = await fixtures.makeAgent({
      name: "Research Bot",
      agentType: "agent",
      organizationId: organization.id,
    });
    return { organization, user, parent, target };
  }

  test("offers every agent a fork of itself", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { organization, user, parent } = await setup({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    });

    const tools = await getAgentTools({
      agentId: parent.id,
      organizationId: organization.id,
      userId: user.id,
    });

    expect(tools.find((tool) => tool.name === SELF_FORK_TOOL_NAME)).toEqual(
      expect.objectContaining({
        _meta: expect.objectContaining({ targetAgentId: parent.id }),
      }),
    );
  });

  for (const active of [true, false]) {
    test(`offers return_schema to own agents only while Guardrails v2 is ${active ? "active" : "off"}`, async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    }) => {
      config.openappa.enabled = true;
      await GuardrailsDeploymentModel.setEnabled(active);
      const { organization, user, parent, target } = await setup({
        makeOrganization,
        makeUser,
        makeMember,
        makeAgent,
      });

      const tools = await getAgentTools({
        agentId: parent.id,
        organizationId: organization.id,
        userId: user.id,
      });
      const attests = (name: string) =>
        Object.hasOwn(
          tools.find((tool) => tool.name === name)?.inputSchema.properties ??
            {},
          "return_schema",
        );

      expect(attests(SELF_FORK_TOOL_NAME)).toBe(active);
      expect(attests(`${AGENT_TOOL_PREFIX}${slugify(target.name)}`)).toBe(
        active,
      );
    });
  }

  test("a fork runs the calling agent itself", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { organization, user, parent } = await setup({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    });
    mockExecuteA2AMessage.mockResolvedValue({
      messageId: "fork-message",
      text: "Summarized",
      finishReason: "stop",
    });

    const result = await executeArchestraTool(
      SELF_FORK_TOOL_NAME,
      { message: "Summarize the logs." },
      {
        userId: user.id,
        agent: { id: parent.id, name: parent.name },
        agentId: parent.id,
        organizationId: organization.id,
      },
    );

    expect(result.isError).toBeFalsy();
    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: parent.id,
        selfFork: true,
        parentDelegationChain: parent.id,
      }),
    );
  });
});
