import {
  TOOL_GET_RUN_FULL_NAME,
  TOOL_LIST_AGENT_RUNS_FULL_NAME,
  TOOL_POST_RUN_FILE_FULL_NAME,
  TOOL_START_RUN_FULL_NAME,
} from "@archestra/shared";
import { onTestFinished, vi } from "vitest";
import { A2AManager } from "@/agents/a2a/a2a-manager";
import * as a2aExecutor from "@/agents/a2a-executor";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import config from "@/config";
import { agentRuntimeManager } from "@/k8s/agent-runtime";
import {
  A2AContextModel,
  A2AMessageModel,
  A2ATaskModel,
  AgentRunModel,
  AgentTeamModel,
  AgentWorkspaceModel,
  ChatOpsChannelBindingModel,
} from "@/models";
import { RouteCategory } from "@/observability/tracing";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

describe("run tools", () => {
  let callingAgent: Agent;
  let actorId: string;
  let organizationId: string;
  let context: ArchestraContext;

  beforeEach(
    async ({
      makeAgent,
      makeMember,
      makeOrganization,
      makeUser,
      seedAndAssignArchestraTools,
    }) => {
      vi.spyOn(agentRuntimeManager, "isEnabled", "get").mockReturnValue(true);
      const organization = await makeOrganization();
      const actor = await makeUser();
      await makeMember(actor.id, organization.id, { role: "member" });
      actorId = actor.id;
      organizationId = organization.id;
      callingAgent = await makeAgent({
        organizationId,
        authorId: actorId,
        agentType: "agent",
        scope: "org",
      });
      await seedAndAssignArchestraTools(callingAgent.id);
      context = {
        agent: { id: callingAgent.id, name: callingAgent.name },
        agentId: callingAgent.id,
        userId: actorId,
        organizationId,
      };
    },
  );

  test("does not start work on a team Agent the actor cannot access", async ({
    makeAgent,
    makeTeam,
    makeUser,
  }) => {
    const owner = await makeUser();
    const team = await makeTeam(organizationId, owner.id);
    const target = await makeAgent({
      organizationId,
      authorId: owner.id,
      agentType: "agent",
      scope: "team",
    });
    await AgentTeamModel.syncAgentTeams(target.id, [team.id]);

    const result = await executeArchestraTool(
      TOOL_START_RUN_FULL_NAME,
      { agent_id: target.id, message: "Do the restricted work" },
      context,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(
      "Agent not found",
    );
  });

  test("returns a setup link and every missing credential before starting a run", async ({
    makeAgent,
  }) => {
    const originalEnabled = config.agentRuntime.enabled;
    config.agentRuntime.enabled = true;
    onTestFinished(() => {
      config.agentRuntime.enabled = originalEnabled;
    });
    const target = await makeAgent({
      organizationId,
      authorId: actorId,
      agentType: "agent",
      scope: "org",
      runtime: {
        image: "example.com/coding-agent:latest",
        command: null,
        inferenceProtocol: "openai_responses",
        backend: "kubernetes",
        steerMode: "pipe",
        privileged: false,
        resources: null,
        environment: null,
        credentials: [
          {
            key: "GITHUB_TOKEN",
            label: "GitHub token",
            scope: "per_user",
            required: true,
          },
          {
            key: "CLAUDE_CODE_OAUTH_TOKEN",
            label: "Claude Code token",
            scope: "per_user",
            required: true,
          },
        ],
        ttlHours: null,
        maxCostUsd: null,
        idleTimeoutMinutes: null,
      },
    });
    const result = await executeArchestraTool(
      TOOL_START_RUN_FULL_NAME,
      { agent_id: target.id, message: "Review the example repository" },
      context,
    );
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("GITHUB_TOKEN");
    expect(text).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(text).toContain(
      `/agents/${target.id}?section=advanced&setup=credentials`,
    );
    expect(
      await AgentRunModel.listForAgent({ agentId: target.id, organizationId }),
    ).toEqual([]);
  });

  test("run controls remain callable without individual assignment", async ({
    makeAgent,
  }) => {
    const unassignedAgent = await makeAgent({
      organizationId,
      authorId: actorId,
      agentType: "mcp_gateway",
      scope: "org",
    });

    const result = await executeArchestraTool(
      TOOL_GET_RUN_FULL_NAME,
      { task_id: crypto.randomUUID() },
      {
        ...context,
        agent: { id: unassignedAgent.id, name: unassignedAgent.name },
        agentId: unassignedAgent.id,
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(
      "Run not found",
    );
    expect((result.content[0] as { text: string }).text).not.toContain(
      "not assigned",
    );
  });

  test("preserves the originating chat thread on a delegated run", async ({
    makeAgent,
  }) => {
    const target = await makeAgent({
      organizationId,
      authorId: actorId,
      agentType: "agent",
      scope: "org",
    });
    vi.spyOn(a2aExecutor, "executeA2AMessage").mockResolvedValue({
      text: "Finished",
      messageId: crypto.randomUUID(),
      finishReason: "stop",
      responseUiMessage: {
        id: crypto.randomUUID(),
        role: "assistant",
        parts: [{ type: "text", text: "Finished" }],
      },
    });
    const sendMessage = vi.spyOn(A2AManager.prototype, "sendMessage");
    const chatContext: ArchestraContext = {
      ...context,
      sessionId: "slack:C123:T456",
      chatOpsBindingId: crypto.randomUUID(),
      chatOpsThreadId: "T456",
    };

    const result = await executeArchestraTool(
      TOOL_START_RUN_FULL_NAME,
      { agent_id: target.id, message: "Do the work" },
      chatContext,
    );

    expect(result.isError).not.toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: target.id,
        systemParams: {
          sessionId: chatContext.sessionId,
          routeCategory: RouteCategory.CHATOPS,
          completionTarget: {
            type: "chatops",
            bindingId: chatContext.chatOpsBindingId,
            threadId: chatContext.chatOpsThreadId,
          },
        },
        taskRun: { createTask: true, detached: true },
      }),
    );
  });

  async function seedChatopsTask(params: {
    actorUserId: string;
    withTarget: boolean;
    bindingId?: string;
    threadId?: string;
    prompt?: string;
  }) {
    const a2aContext = await A2AContextModel.create({
      actorKind: "user",
      actorId: params.actorUserId,
    });
    const task = await A2ATaskModel.create({
      contextId: a2aContext.id,
      agentId: callingAgent.id,
      state: "TASK_STATE_WORKING",
    });
    if (params.prompt) {
      await A2AMessageModel.create({
        contextId: a2aContext.id,
        taskId: task.id,
        role: "ROLE_USER",
        parts: [{ text: params.prompt }],
        content: {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: params.prompt }],
        },
      });
    }
    await AgentRunModel.create({
      organizationId,
      taskId: task.id,
      agentId: callingAgent.id,
      actorKind: "user",
      actorId: params.actorUserId,
      actorUserId: params.actorUserId,
      workloadName: `test-${task.id.slice(0, 8)}`,
      backend: "kubernetes",
      runtimeScope: "test",
      completionTarget: params.withTarget
        ? {
            type: "chatops",
            bindingId:
              params.bindingId ?? "9c2b1f60-0000-4000-8000-000000000001",
            threadId: params.threadId ?? "1788208728.803109",
          }
        : null,
    });
    return task;
  }

  test("get_run resolves the current turn from the original session ID", async () => {
    const first = await seedChatopsTask({
      actorUserId: actorId,
      withTarget: false,
    });
    const firstRun = await AgentRunModel.findByTaskId(first.id);
    if (!firstRun) throw new Error("Run fixture missing");
    await AgentRunModel.close({ id: firstRun.id, logs: "first answer" });
    const next = await A2ATaskModel.create({
      contextId: first.contextId,
      agentId: callingAgent.id,
      state: "TASK_STATE_WORKING",
    });
    await AgentRunModel.create({
      organizationId,
      taskId: next.id,
      agentId: callingAgent.id,
      actorKind: "user",
      actorId,
      actorUserId: actorId,
      workloadName: firstRun.workloadName,
      backend: "kubernetes",
      runtimeScope: "test",
    });
    await AgentWorkspaceModel.create({
      id: first.id,
      organizationId,
      agentId: callingAgent.id,
      actorKind: "user",
      actorId,
      backend: "kubernetes",
      runtimeScope: "test",
      workloadName: firstRun.workloadName,
      state: "active",
      lastTaskId: next.id,
      activeTaskId: next.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const result = await executeArchestraTool(
      TOOL_GET_RUN_FULL_NAME,
      { task_id: first.id },
      context,
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      run: { task_id: next.id, state: "working" },
    });
  });

  test("workspace file tools accept the task ID and enforce original ownership", async ({
    makeUser,
    makeMember,
  }) => {
    const task = await seedChatopsTask({
      actorUserId: actorId,
      withTarget: false,
    });
    const run = await AgentRunModel.findByTaskId(task.id);
    if (!run) throw new Error("Run fixture missing");
    await AgentWorkspaceModel.create({
      organizationId,
      agentId: callingAgent.id,
      actorKind: "user",
      actorId,
      backend: "kubernetes",
      runtimeScope: run.runtimeScope,
      workloadName: run.workloadName,
      state: "idle",
      lastTaskId: task.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const access = vi
      .spyOn(agentRuntimeManager, "accessWorkspaceFile")
      .mockResolvedValue({
        path: "notes.txt",
        size: 5,
        sha256: "test-digest",
        content_base64: Buffer.from("hello").toString("base64"),
      });
    try {
      const written = await executeArchestraTool(
        "archestra__write_workspace_file",
        { task_id: task.id, path: "notes.txt", content: "hello" },
        context,
      );
      expect(written.isError).toBeFalsy();
      const read = await executeArchestraTool(
        "archestra__read_workspace_file",
        { task_id: task.id, path: "notes.txt" },
        context,
      );
      expect(read.structuredContent).toMatchObject({
        content: "hello",
        encoding: "utf8",
      });
      expect(access).toHaveBeenCalledTimes(2);
      const other = await makeUser();
      await makeMember(other.id, organizationId, { role: "member" });
      const denied = await executeArchestraTool(
        "archestra__read_workspace_file",
        { task_id: task.id, path: "notes.txt" },
        { ...context, userId: other.id },
      );
      expect(denied.isError).toBe(true);
      expect(access).toHaveBeenCalledTimes(2);
    } finally {
      access.mockRestore();
    }
  });

  test("lists accessible Agent runs with live and thread links", async () => {
    const binding = await ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "slack",
      channelId: "C01234567",
      workspaceId: "T01234567",
      channelName: "engineering",
      workspaceName: "Workspace",
      agentId: callingAgent.id,
    });
    const task = await seedChatopsTask({
      actorUserId: actorId,
      withTarget: true,
      bindingId: binding.id,
      prompt: "Add a character counter.",
    });

    const result = await executeArchestraTool(
      TOOL_LIST_AGENT_RUNS_FULL_NAME,
      { agent_ids: [callingAgent.id], limit: 20 },
      context,
    );

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      summary: { total: 1, active: 1, by_state: { TASK_STATE_WORKING: 1 } },
      runs: [
        {
          task_id: task.id,
          prompt: "Add a character counter.",
          state: "TASK_STATE_WORKING",
          hard_deadline_at: expect.any(String),
          last_model_activity_at: null,
          attention_state: null,
          agent: { id: callingAgent.id, name: callingAgent.name },
          requester: { kind: "user", id: actorId },
          thread: {
            provider: "slack",
            channel_id: "C01234567",
            channel_name: "engineering",
            thread_id: "1788208728.803109",
            url: "https://app.slack.com/client/T01234567/C01234567/thread/C01234567-1788208728.803109",
          },
        },
      ],
    });
    expect(
      (
        result.structuredContent as {
          runs: Array<{ run_url: string }>;
        }
      ).runs[0]?.run_url,
    ).toMatch(new RegExp(`/chat/runs/${task.id}$`));
  });

  test("recovers an older run only from the trusted current thread before limiting", async () => {
    const bindingId = crypto.randomUUID();
    const threadId = "thread-original";
    const original = await seedChatopsTask({
      actorUserId: actorId,
      withTarget: true,
      bindingId,
      threadId,
    });
    await seedChatopsTask({
      actorUserId: actorId,
      withTarget: true,
      bindingId,
      threadId: "another-thread",
    });
    await seedChatopsTask({
      actorUserId: actorId,
      withTarget: true,
      bindingId: crypto.randomUUID(),
      threadId,
    });
    await seedChatopsTask({ actorUserId: actorId, withTarget: false });
    const result = await executeArchestraTool(
      TOOL_LIST_AGENT_RUNS_FULL_NAME,
      { agent_ids: [callingAgent.id], current_thread_only: true, limit: 1 },
      { ...context, chatOpsBindingId: bindingId, chatOpsThreadId: threadId },
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      runs: [{ task_id: original.id }],
      summary: { total: 1 },
    });
    expect(
      await AgentRunModel.listDashboard({
        agentIds: [callingAgent.id],
        organizationId: crypto.randomUUID(),
        limit: 100,
        thread: { bindingId, threadId },
      }),
    ).toEqual([]);
    expect(
      await AgentRunModel.listDashboard({
        agentIds: [crypto.randomUUID()],
        organizationId,
        limit: 100,
        thread: { bindingId, threadId },
      }),
    ).toEqual([]);
    const second = await seedChatopsTask({
      actorUserId: actorId,
      withTarget: true,
      bindingId,
      threadId,
    });
    const multiple = await executeArchestraTool(
      TOOL_LIST_AGENT_RUNS_FULL_NAME,
      { agent_ids: [callingAgent.id], current_thread_only: true },
      { ...context, chatOpsBindingId: bindingId, chatOpsThreadId: threadId },
    );
    expect(multiple.structuredContent).toMatchObject({
      summary: { total: 2 },
      runs: [{ task_id: second.id }, { task_id: original.id }],
    });
    const empty = await executeArchestraTool(
      TOOL_LIST_AGENT_RUNS_FULL_NAME,
      { agent_ids: [callingAgent.id], current_thread_only: true },
      { ...context, chatOpsBindingId: bindingId, chatOpsThreadId: "no-runs" },
    );
    expect(empty.structuredContent).toMatchObject({
      runs: [],
      summary: { total: 0 },
    });
  });

  test("thread recovery fails closed when either trusted context field is missing", async () => {
    await seedChatopsTask({ actorUserId: actorId, withTarget: true });
    for (const messagingContext of [
      {},
      { chatOpsBindingId: crypto.randomUUID() },
      { chatOpsThreadId: "thread" },
    ]) {
      const result = await executeArchestraTool(
        TOOL_LIST_AGENT_RUNS_FULL_NAME,
        { agent_ids: [callingAgent.id], current_thread_only: true },
        { ...context, ...messagingContext },
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(
        "Current messaging thread context is unavailable",
      );
    }
  });

  test("does not reveal runs for an inaccessible Agent", async ({
    makeAgent,
    makeUser,
  }) => {
    const otherUser = await makeUser();
    const privateAgent = await makeAgent({
      organizationId,
      authorId: otherUser.id,
      agentType: "agent",
      scope: "personal",
    });

    const result = await executeArchestraTool(
      TOOL_LIST_AGENT_RUNS_FULL_NAME,
      { agent_ids: [privateAgent.id], current_thread_only: true },
      {
        ...context,
        chatOpsBindingId: crypto.randomUUID(),
        chatOpsThreadId: "thread",
      },
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Agent not found");
  });

  test("post_run_file uploads into the run's chatops thread", async () => {
    const task = await seedChatopsTask({
      actorUserId: actorId,
      withTarget: true,
    });
    const upload = vi
      .spyOn(chatOpsManager, "uploadFileToBindingThread")
      .mockResolvedValue();

    const result = await executeArchestraTool(
      TOOL_POST_RUN_FILE_FULL_NAME,
      {
        task_id: task.id,
        filename: "demo.mp4",
        content_base64: Buffer.from("not-really-a-video").toString("base64"),
        comment: "demo recording",
      },
      context,
    );

    expect(result.isError).toBeFalsy();
    expect(upload).toHaveBeenCalledWith({
      bindingId: "9c2b1f60-0000-4000-8000-000000000001",
      threadId: "1788208728.803109",
      filename: "demo.mp4",
      data: Buffer.from("not-really-a-video"),
      comment: "demo recording",
    });
    upload.mockRestore();
  });

  test("post_run_file refuses a run with no messaging-channel thread", async () => {
    const task = await seedChatopsTask({
      actorUserId: actorId,
      withTarget: false,
    });
    const upload = vi
      .spyOn(chatOpsManager, "uploadFileToBindingThread")
      .mockResolvedValue();

    const result = await executeArchestraTool(
      TOOL_POST_RUN_FILE_FULL_NAME,
      {
        task_id: task.id,
        filename: "demo.mp4",
        content_base64: Buffer.from("x").toString("base64"),
      },
      context,
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "does not report to a messaging-channel thread",
    );
    expect(upload).not.toHaveBeenCalled();
    upload.mockRestore();
  });

  test("post_run_file only serves the person the run acts as", async ({
    makeUser,
    makeMember,
  }) => {
    const otherUser = await makeUser();
    await makeMember(otherUser.id, organizationId, { role: "member" });
    const task = await seedChatopsTask({
      actorUserId: otherUser.id,
      withTarget: true,
    });
    const upload = vi
      .spyOn(chatOpsManager, "uploadFileToBindingThread")
      .mockResolvedValue();

    const result = await executeArchestraTool(
      TOOL_POST_RUN_FILE_FULL_NAME,
      {
        task_id: task.id,
        filename: "demo.mp4",
        content_base64: Buffer.from("x").toString("base64"),
      },
      context,
    );

    expect(result.isError).toBe(true);
    expect(upload).not.toHaveBeenCalled();
    upload.mockRestore();
  });
});
