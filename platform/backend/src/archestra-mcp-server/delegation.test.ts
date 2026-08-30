// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ADVISOR_AGENT_DESCRIPTION,
  AGENT_TOOL_PREFIX,
  BUILT_IN_AGENT_IDS,
  BUILT_IN_AGENT_NAMES,
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
import { ProviderError, SubagentProviderError } from "@/routes/chat/errors";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool, getAgentTools } from ".";

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

  test("runs an ordinary delegation as a durable task when the target has Background execution", async ({
    makeAgent,
    makeAgentTool,
  }) => {
    const previous = config.agentBackgroundExecution.enabled;
    config.agentBackgroundExecution.enabled = true;
    const targetAgent = await makeAgent({
      name: "Background Worker",
      backgroundExecution: {
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
      userId: "user-1",
      sessionId: "chatops:slack:thread-1",
      chatOpsBindingId: "binding-1",
      chatOpsThreadId: "thread-1",
    };

    try {
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
    } finally {
      config.agentBackgroundExecution.enabled = previous;
    }
  });

  test("lets a foreground router hand a nested delegation to a Background execution worker", async ({
    makeAgent,
    makeAgentTool,
  }) => {
    const previous = config.agentBackgroundExecution.enabled;
    config.agentBackgroundExecution.enabled = true;
    const router = await makeAgent({ name: "Coding Task Router" });
    const worker = await makeAgent({
      name: "Selected Coding Worker",
      backgroundExecution: {
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
      userId: "user-1",
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

    try {
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
    } finally {
      config.agentBackgroundExecution.enabled = previous;
    }
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
      scope: "org",
    });
    if (fixtures.accessAllSubagents !== false) {
      await AgentModel.update(parent.id, { accessAllSubagents: true });
    }
    const target = await makeAgent({
      name: "Research Bot",
      agentType: "agent",
      organizationId: organization.id,
      scope: "org",
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

  test("offers the advisor built-in, and no other built-in", async ({
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
    });
    const advisor = await makeAgent({
      name: BUILT_IN_AGENT_NAMES.ADVISOR,
      agentType: "agent",
      organizationId: organization.id,
      scope: "org",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.ADVISOR },
    });
    // Backs platform machinery rather than answering questions; delegating to
    // it would mean driving an internal mechanism by hand.
    const compaction = await makeAgent({
      name: BUILT_IN_AGENT_NAMES.CONTEXT_COMPACTION,
      agentType: "agent",
      organizationId: organization.id,
      scope: "org",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.CONTEXT_COMPACTION },
    });

    const names = (
      await getAgentTools({
        agentId: parent.id,
        organizationId: organization.id,
        userId: user.id,
      })
    ).map((t) => t.name);

    expect(names).toContain(`${AGENT_TOOL_PREFIX}${slugify(advisor.name)}`);
    expect(names).not.toContain(
      `${AGENT_TOOL_PREFIX}${slugify(compaction.name)}`,
    );
  });

  test("describes the advisor to the caller with its own guidance", async ({
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
    });
    const advisor = await makeAgent({
      name: BUILT_IN_AGENT_NAMES.ADVISOR,
      agentType: "agent",
      organizationId: organization.id,
      scope: "org",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.ADVISOR },
      description: ADVISOR_AGENT_DESCRIPTION,
    });

    const tool = (
      await getAgentTools({
        agentId: parent.id,
        organizationId: organization.id,
        userId: user.id,
      })
    ).find((t) => t.name === `${AGENT_TOOL_PREFIX}${slugify(advisor.name)}`);

    // What the calling model reads is the shipped guidance, not the one-line
    // summary an administrator sees on the agent — and the closing line, which
    // is what stops a model consulting on every step, has to reach it whole.
    expect(tool?.description).toContain(
      "not for syntax, lookups, or things you already know",
    );
    expect(tool?.description).not.toContain(ADVISOR_AGENT_DESCRIPTION);
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

    expect(tools).toHaveLength(0);
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

    expect(tools).toHaveLength(0);
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
      scope: "org",
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
      scope: "org",
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
    expect(tools).toHaveLength(0);

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

  test("Auto mode reaches the org-wide advisor from another environment (surface and dispatch)", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "member" });
    const env = await EnvironmentModel.create({
      organizationId: organization.id,
      name: "Staging",
    });
    const parent = await makeAgent({
      name: "Staging Parent",
      agentType: "agent",
      organizationId: organization.id,
      scope: "org",
      environmentId: env.id,
    });
    await AgentModel.update(parent.id, { accessAllSubagents: true });
    const advisor = await makeAgent({
      name: BUILT_IN_AGENT_NAMES.ADVISOR,
      agentType: "agent",
      organizationId: organization.id,
      scope: "org",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.ADVISOR },
    });

    // The advisor's env-less row is the one target reachable across the fence.
    const names = (
      await getAgentTools({
        agentId: parent.id,
        organizationId: organization.id,
        userId: user.id,
      })
    ).map((t) => t.name);
    expect(names).toContain(`${AGENT_TOOL_PREFIX}${slugify(advisor.name)}`);

    mockExecuteA2AMessage.mockResolvedValue({ text: "advice" });
    const result = await executeArchestraTool(
      `${AGENT_TOOL_PREFIX}${slugify(advisor.name)}`,
      { message: "Which approach should I take?" },
      {
        agent: { id: parent.id, name: parent.name },
        agentId: parent.id,
        organizationId: organization.id,
        userId: user.id,
      },
    );
    expect(result.isError).toBe(false);
    // The caller's environment rides along so the consultation bills to it.
    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: advisor.id,
        callerEnvironmentId: env.id,
      }),
    );
  });

  test("an environment-scoped stray advisor stays fenced to its own environment", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "member" });
    const envA = await EnvironmentModel.create({
      organizationId: organization.id,
      name: "Env A",
    });
    const envB = await EnvironmentModel.create({
      organizationId: organization.id,
      name: "Env B",
    });
    const parent = await makeAgent({
      name: "Env A Parent",
      agentType: "agent",
      organizationId: organization.id,
      scope: "org",
      environmentId: envA.id,
    });
    await AgentModel.update(parent.id, { accessAllSubagents: true });
    // Residue a pre-collapse replica could leave: an advisor row carrying the
    // discriminator but pinned to an environment. The exception is env-less
    // only, so it must NOT cross from Env A into Env B.
    const strayAdvisor = await makeAgent({
      name: BUILT_IN_AGENT_NAMES.ADVISOR,
      agentType: "agent",
      organizationId: organization.id,
      scope: "org",
      environmentId: envB.id,
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.ADVISOR },
    });

    const names = (
      await getAgentTools({
        agentId: parent.id,
        organizationId: organization.id,
        userId: user.id,
      })
    ).map((t) => t.name);
    expect(names).not.toContain(
      `${AGENT_TOOL_PREFIX}${slugify(strayAdvisor.name)}`,
    );
  });

  test("the advisor exception does not surface another organization's advisor", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const orgA = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, orgA.id, { role: "member" });
    const env = await EnvironmentModel.create({
      organizationId: orgA.id,
      name: "Staging",
    });
    const parent = await makeAgent({
      name: "Org A Parent",
      agentType: "agent",
      organizationId: orgA.id,
      scope: "org",
      environmentId: env.id,
    });
    await AgentModel.update(parent.id, { accessAllSubagents: true });

    const orgB = await makeOrganization();
    const foreignAdvisor = await makeAgent({
      name: BUILT_IN_AGENT_NAMES.ADVISOR,
      agentType: "agent",
      organizationId: orgB.id,
      scope: "org",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.ADVISOR },
    });

    const names = (
      await getAgentTools({
        agentId: parent.id,
        organizationId: orgA.id,
        userId: user.id,
      })
    ).map((t) => t.name);
    expect(names).not.toContain(
      `${AGENT_TOOL_PREFIX}${slugify(foreignAdvisor.name)}`,
    );
  });

  test("an exclusion still hides the advisor from a cross-environment caller", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "member" });
    const env = await EnvironmentModel.create({
      organizationId: organization.id,
      name: "Staging",
    });
    const parent = await makeAgent({
      name: "Staging Parent",
      agentType: "agent",
      organizationId: organization.id,
      scope: "org",
      environmentId: env.id,
    });
    await AgentModel.update(parent.id, { accessAllSubagents: true });
    const advisor = await makeAgent({
      name: BUILT_IN_AGENT_NAMES.ADVISOR,
      agentType: "agent",
      organizationId: organization.id,
      scope: "org",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.ADVISOR },
    });
    await AgentExcludedSubagentModel.replaceForAgent(parent.id, [advisor.id]);

    const names = (
      await getAgentTools({
        agentId: parent.id,
        organizationId: organization.id,
        userId: user.id,
      })
    ).map((t) => t.name);
    expect(names).not.toContain(`${AGENT_TOOL_PREFIX}${slugify(advisor.name)}`);

    const result = await executeArchestraTool(
      `${AGENT_TOOL_PREFIX}${slugify(advisor.name)}`,
      { message: "Which approach should I take?" },
      {
        agent: { id: parent.id, name: parent.name },
        agentId: parent.id,
        organizationId: organization.id,
        userId: user.id,
      },
    );
    expect(result.isError).toBe(true);
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });

  test("Custom mode reaches an explicitly granted advisor from another environment", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeAgentTool,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "member" });
    const env = await EnvironmentModel.create({
      organizationId: organization.id,
      name: "Staging",
    });
    const parent = await makeAgent({
      name: "Staging Parent",
      agentType: "agent",
      organizationId: organization.id,
      scope: "org",
      environmentId: env.id,
    });
    const advisor = await makeAgent({
      name: BUILT_IN_AGENT_NAMES.ADVISOR,
      agentType: "agent",
      organizationId: organization.id,
      scope: "org",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.ADVISOR },
    });
    const advisorTool = await ToolModel.findOrCreateDelegationTool(advisor.id);
    await makeAgentTool(parent.id, advisorTool.id);

    const names = (
      await getAgentTools({
        agentId: parent.id,
        organizationId: organization.id,
        userId: user.id,
      })
    ).map((t) => t.name);
    expect(names).toContain(`${AGENT_TOOL_PREFIX}${slugify(advisor.name)}`);

    mockExecuteA2AMessage.mockResolvedValue({ text: "advice" });
    const result = await executeArchestraTool(
      `${AGENT_TOOL_PREFIX}${slugify(advisor.name)}`,
      { message: "Which approach should I take?" },
      {
        agent: { id: parent.id, name: parent.name },
        agentId: parent.id,
        organizationId: organization.id,
        userId: user.id,
      },
    );
    expect(result.isError).toBe(false);
    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: advisor.id }),
    );
  });

  test("the built-in advisor wins the agent__advisor slug over a user agent of the same name", async ({
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
    });
    // A user agent squatting on the advisor's name, in the caller's own
    // environment — same slug, so only one of the two can be advertised.
    const impostor = await makeAgent({
      name: BUILT_IN_AGENT_NAMES.ADVISOR,
      agentType: "agent",
      organizationId: organization.id,
      scope: "org",
    });
    const advisor = await makeAgent({
      name: BUILT_IN_AGENT_NAMES.ADVISOR,
      agentType: "agent",
      organizationId: organization.id,
      scope: "org",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.ADVISOR },
    });

    const advisorToolName = `${AGENT_TOOL_PREFIX}${slugify(advisor.name)}`;
    const names = (
      await getAgentTools({
        agentId: parent.id,
        organizationId: organization.id,
        userId: user.id,
      })
    ).map((t) => t.name);
    expect(names.filter((n) => n === advisorToolName)).toHaveLength(1);

    mockExecuteA2AMessage.mockResolvedValue({ text: "advice" });
    const result = await executeArchestraTool(
      advisorToolName,
      { message: "Which approach should I take?" },
      {
        agent: { id: parent.id, name: parent.name },
        agentId: parent.id,
        organizationId: organization.id,
        userId: user.id,
      },
    );
    expect(result.isError).toBe(false);
    // Dispatch resolves the built-in, not the impostor — surface and dispatch
    // share the same tie-break.
    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: advisor.id }),
    );
    expect(mockExecuteA2AMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ agentId: impostor.id }),
    );
  });
});
