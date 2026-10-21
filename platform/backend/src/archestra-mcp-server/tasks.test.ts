import { spawn, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  TOOL_CANCEL_RUN_FULL_NAME,
  TOOL_GET_RUN_FULL_NAME,
  TOOL_LIST_AGENT_RUNS_FULL_NAME,
  TOOL_POST_RUN_FILE_FULL_NAME,
  TOOL_POST_RUN_MESSAGE_FULL_NAME,
  TOOL_RUN_TOOL_FULL_NAME,
  TOOL_START_RUN_FULL_NAME,
} from "@archestra/shared";
import { vi } from "vitest";
import { A2AManager } from "@/agents/a2a/a2a-manager";
import * as a2aExecutor from "@/agents/a2a-executor";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import config from "@/config";
import db, { schema } from "@/database";
import { agentRuntimeManager } from "@/k8s/agent-runtime";
import {
  A2AContextModel,
  A2AMessageModel,
  A2ATaskModel,
  AgentRunModel,
  AgentTeamModel,
  AgentWorkspaceModel,
  ChatOpsChannelBindingModel,
  MemberModel,
} from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import { RouteCategory } from "@/observability/tracing";
import { openappaActor } from "@/openappa/actor";
import { superyellSession } from "@/openappa/unenforced";
import { kubernetesAgentRuntimeBackendDriver as backend } from "@/services/agent-runtime/backends/kubernetes";
import { runtimeOpenAppaSession } from "@/services/agent-runtime/runtime-identity";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { type Agent, ApiError } from "@/types";
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
      access: { teams: [] },
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
    const target = await makeAgent({
      organizationId,
      authorId: actorId,
      agentType: "agent",
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
    // The link names every missing key and carries no `section`, which
    // agentDetailHref would otherwise rewrite away along with `setup`.
    expect(text).toContain(`/agents/${target.id}?setup=credentials&keys=`);
    expect(text).toContain("GITHUB_TOKEN%2CCLAUDE_CODE_OAUTH_TOKEN");
    // A question form shows the link as dead text, so the model is told to
    // hand it over in its reply.
    expect(text).toContain(
      "Put this link in your reply text, never inside a question form",
    );
    expect(
      await AgentRunModel.listForAgent({ agentId: target.id, organizationId }),
    ).toEqual([]);
  });

  test.for([
    false,
    true,
  ])("run controls remain callable without individual assignment (wrapped=%s)", async (wrapped, {
    makeAgent,
  }) => {
    const unassignedAgent = await makeAgent({
      organizationId,
      authorId: actorId,
      agentType: "mcp_gateway",
    });

    const result = await executeArchestraTool(
      wrapped ? TOOL_RUN_TOOL_FULL_NAME : TOOL_GET_RUN_FULL_NAME,
      wrapped
        ? {
            tool_name: TOOL_GET_RUN_FULL_NAME,
            tool_args: { task_id: crypto.randomUUID() },
          }
        : { task_id: crypto.randomUUID() },
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
    const started = result.structuredContent as { run: { task_id: string } };
    expect(started).toMatchObject({
      runtime: "foreground",
      session_id: null,
      run_url: null,
    });
    const read = await executeArchestraTool(
      TOOL_GET_RUN_FULL_NAME,
      { task_id: started.run.task_id },
      chatContext,
    );
    expect(read.isError).not.toBe(true);
    expect(read.structuredContent).toMatchObject({
      session_id: null,
      run_url: null,
    });
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

  async function seedRuntimeTask() {
    const task = await seedChatopsTask({
      actorUserId: actorId,
      withTarget: true,
    });
    await AgentWorkspaceModel.create({
      id: task.id,
      organizationId,
      agentId: callingAgent.id,
      actorKind: "user",
      actorId,
      backend: "kubernetes",
      runtimeScope: "test",
      workloadName: `test-${task.id.slice(0, 8)}`,
      state: "active",
      activeTaskId: task.id,
      lastTaskId: task.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return task;
  }

  test.each([
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_REJECTED",
  ] as const)("cancel_run explains a terminal %s outcome", async (state) => {
    const task = await seedChatopsTask({
      actorUserId: actorId,
      withTarget: false,
    });
    await A2ATaskModel.updateState(task.id, state);
    const result = await executeArchestraTool(
      TOOL_CANCEL_RUN_FULL_NAME,
      { task_id: task.id },
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining(state) },
    ]);
    expect(JSON.stringify(result.content)).toContain(
      "No cancellation was performed",
    );
    expect((await A2ATaskModel.findById(task.id))?.state).toBe(state);
    expect(await AgentRunModel.findByTaskId(task.id)).not.toBeNull();
  });

  test("concurrent cancellations report the persisted outcome without an internal error", async () => {
    const task = await seedChatopsTask({
      actorUserId: actorId,
      withTarget: false,
    });
    const results = await Promise.all(
      [0, 1].map(() =>
        executeArchestraTool(
          TOOL_CANCEL_RUN_FULL_NAME,
          { task_id: task.id },
          context,
        ),
      ),
    );
    expect(results.filter((result) => !result.isError)).toHaveLength(1);
    const refused = results.find((result) => result.isError);
    expect(JSON.stringify(refused?.content)).toContain("TASK_STATE_CANCELED");
    expect((await A2ATaskModel.findById(task.id))?.state).toBe(
      "TASK_STATE_CANCELED",
    );
  });

  test("completion racing cancel_run preserves completion and explains the refusal", async () => {
    const task = await seedChatopsTask({
      actorUserId: actorId,
      withTarget: false,
    });
    // Both operations use the real database. Completion starts while the tool
    // resolves access, reproducing a run finishing after the caller's lookup.
    const [result, completed] = await Promise.all([
      executeArchestraTool(
        TOOL_CANCEL_RUN_FULL_NAME,
        { task_id: task.id },
        context,
      ),
      A2ATaskModel.transitionStateWithEvent({
        id: task.id,
        to: "TASK_STATE_COMPLETED",
        allowedFrom: ["TASK_STATE_WORKING"],
        eventPayload: {
          statusUpdate: {
            taskId: task.id,
            contextId: task.contextId,
            status: { state: "TASK_STATE_COMPLETED" },
          },
        },
      }),
    ]);
    expect(completed?.state).toBe("TASK_STATE_COMPLETED");
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("TASK_STATE_COMPLETED");
    expect((await A2ATaskModel.findById(task.id))?.state).toBe(
      "TASK_STATE_COMPLETED",
    );
  });

  test("cancel_run does not reveal another actor's terminal outcome", async ({
    makeUser,
  }) => {
    const owner = await makeUser();
    const task = await seedChatopsTask({
      actorUserId: owner.id,
      withTarget: false,
    });
    await A2ATaskModel.updateState(task.id, "TASK_STATE_COMPLETED");
    const result = await executeArchestraTool(
      TOOL_CANCEL_RUN_FULL_NAME,
      { task_id: task.id },
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "Error: Run not found" },
    ]);
  });

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
      expect(JSON.parse((written.content[0] as { text: string }).text)).toEqual(
        written.structuredContent,
      );
      const read = await executeArchestraTool(
        "archestra__read_workspace_file",
        { task_id: task.id, path: "notes.txt" },
        context,
      );
      expect(read.structuredContent).toMatchObject({
        content: "hello",
        encoding: "utf8",
      });
      expect(JSON.parse((read.content[0] as { text: string }).text)).toEqual(
        read.structuredContent,
      );
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
          llm_session_id: null,
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

  test("lists the logged telemetry key shared by continued turns, never a task or workspace handle", async ({
    makeInteraction,
  }) => {
    await MemberModel.updateRole(actorId, organizationId, "editor");
    const first = await seedChatopsTask({
      actorUserId: actorId,
      withTarget: false,
    });
    const run = await AgentRunModel.findByTaskId(first.id);
    if (!run) throw new Error("Run fixture missing");
    const workspace = await AgentWorkspaceModel.create({
      organizationId,
      agentId: callingAgent.id,
      actorKind: "user",
      actorId,
      workloadName: run.workloadName,
      backend: "kubernetes",
      runtimeScope: "test",
      state: "idle",
      lastTaskId: first.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });
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
      workloadName: run.workloadName,
      backend: "kubernetes",
      runtimeScope: "test",
    });
    const key = run.workloadName;
    await makeInteraction(callingAgent.id, { sessionId: key, userId: actorId });
    const result = await executeArchestraTool(
      TOOL_LIST_AGENT_RUNS_FULL_NAME,
      { agent_ids: [callingAgent.id] },
      context,
    );
    expect(result.isError).toBeFalsy();
    const { runs } = result.structuredContent as {
      runs: { task_id: string; llm_session_id: string | null }[];
    };
    expect(runs).toHaveLength(2);
    expect(runs.map((item) => item.llm_session_id)).toEqual([key, key]);
    expect(key).not.toBe(first.id);
    expect(key).not.toBe(next.id);
    expect(key).not.toBe(workspace.id);
  });

  test("keeps logged keys after workspace expiry and withholds missing, policy-scoped or unreadable sessions", async ({
    makeInteraction,
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    await MemberModel.updateRole(actorId, organizationId, "editor");
    const other = await makeUser();
    const foreignOrg = await makeOrganization();
    const foreignAgent = await makeAgent({ organizationId: foreignOrg.id });
    let expiredTaskId: string | undefined;
    let expiredKey: string | undefined;
    for (const scenario of [
      "missing-workspace",
      "policy-session",
      "no-logs",
      "other-user",
      "other-organization",
    ]) {
      const task = await seedChatopsTask({
        actorUserId: actorId,
        withTarget: false,
      });
      const run = await AgentRunModel.findByTaskId(task.id);
      if (!run) throw new Error("Run fixture missing");
      const key = run.workloadName;
      if (scenario === "missing-workspace") {
        expiredTaskId = task.id;
        expiredKey = key;
      }
      if (scenario !== "missing-workspace") {
        await AgentWorkspaceModel.create({
          organizationId,
          agentId: callingAgent.id,
          actorKind: "user",
          actorId,
          workloadName: run.workloadName,
          backend: "kubernetes",
          runtimeScope: "test",
          lastTaskId: task.id,
          expiresAt: new Date(Date.now() + 3600_000),
        });
      }
      if (scenario !== "no-logs") {
        await makeInteraction(
          scenario === "other-organization" ? foreignAgent.id : callingAgent.id,
          {
            sessionId:
              scenario === "policy-session" ? `user:${actorId}|${key}` : key,
            userId: scenario === "other-user" ? other.id : actorId,
          },
        );
      }
      // A logged task ID is not proof of the runtime's telemetry identity.
      await makeInteraction(callingAgent.id, {
        sessionId: task.id,
        userId: actorId,
      });
    }
    const result = await executeArchestraTool(
      TOOL_LIST_AGENT_RUNS_FULL_NAME,
      { agent_ids: [callingAgent.id] },
      context,
    );
    expect(result.isError).toBeFalsy();
    const { runs } = result.structuredContent as {
      runs: { task_id: string; llm_session_id: string | null }[];
    };
    expect(runs).toHaveLength(5);
    expect(
      runs.find((item) => item.task_id === expiredTaskId)?.llm_session_id,
    ).toBe(expiredKey);
    expect(
      runs
        .filter((item) => item.task_id !== expiredTaskId)
        .every((item) => item.llm_session_id === null),
    ).toBe(true);
  });

  test("an organization runtime uses its telemetry header and requires log admin for another actor's requests", async ({
    makeInteraction,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    await MemberModel.updateRole(actorId, organizationId, "editor");
    const taskContext = await A2AContextModel.create({
      actorKind: "organization",
      actorId: organizationId,
    });
    const task = await A2ATaskModel.create({
      contextId: taskContext.id,
      agentId: callingAgent.id,
      state: "TASK_STATE_WORKING",
    });
    const run = await AgentRunModel.create({
      organizationId,
      taskId: task.id,
      agentId: callingAgent.id,
      actorKind: "organization",
      actorId: organizationId,
      actorUserId: null,
      workloadName: `test-${task.id}`,
      backend: "kubernetes",
      runtimeScope: "test",
    });
    await AgentWorkspaceModel.create({
      organizationId,
      agentId: callingAgent.id,
      actorKind: "organization",
      actorId: organizationId,
      workloadName: run.workloadName,
      backend: "kubernetes",
      runtimeScope: "test",
      lastTaskId: task.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const key = run.workloadName;
    await makeInteraction(callingAgent.id, { sessionId: key });
    const admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: "admin" });
    const restricted = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: { agent: ["read"] },
    });
    await makeMember(restricted.id, organizationId, { role: role.role });
    const adminOnly = await makeUser();
    const adminOnlyRole = await makeCustomRole(organizationId, {
      permission: { agent: ["read"], log: ["admin"] },
    });
    await makeMember(adminOnly.id, organizationId, {
      role: adminOnlyRole.role,
    });
    for (const [userId, expected] of [
      [adminOnly.id, null],
      [actorId, null],
      [restricted.id, null],
      [admin.id, key],
    ] as const) {
      const result = await executeArchestraTool(
        TOOL_LIST_AGENT_RUNS_FULL_NAME,
        { agent_ids: [callingAgent.id] },
        { ...context, userId },
      );
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        runs: [{ task_id: task.id, llm_session_id: expected }],
      });
    }
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
    // Chat sends MCP text content to the model. Structured data alone is not
    // enough for the model to recover the ID and steer the matching run.
    const modelText = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    expect(JSON.parse(modelText)).toEqual(result.structuredContent);

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
      access: "personal",
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

  test("post_run_message refuses another actor's run and a finished turn", async ({
    makeUser,
  }) => {
    const other = await makeUser();
    const foreign = await seedChatopsTask({
      actorUserId: other.id,
      withTarget: true,
    });
    const own = await seedChatopsTask({
      actorUserId: actorId,
      withTarget: true,
    });
    await A2ATaskModel.updateState(own.id, "TASK_STATE_COMPLETED");
    for (const task of [foreign, own]) {
      const result = await executeArchestraTool(
        TOOL_POST_RUN_MESSAGE_FULL_NAME,
        { task_id: task.id, message: "Working on it." },
        context,
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(
        task === foreign ? "Run not found" : "not active",
      );
    }
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

  describe("post_run_file with a workspace path", () => {
    let root: string;
    let upload: ReturnType<typeof vi.spyOn>;
    let stopServingWorkspace: () => void;

    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), "run-file-"));
      stopServingWorkspace = serveWorkspaceFrom(path.join(root, "workspace"));
      await mkdir(path.join(root, "workspace"));
      upload = vi
        .spyOn(chatOpsManager, "uploadFileToBindingThread")
        .mockResolvedValue();
    });

    afterEach(async () => {
      // This file shares its worker with other files: nothing may outlive it.
      upload.mockRestore();
      stopServingWorkspace();
      await rm(root, { recursive: true, force: true });
    });

    test("uploads the exact bytes of the file, named after its path", async () => {
      const task = await seedRuntimeTask();
      const bytes = Buffer.from([0, 255, 13, 10, 128, 65, 0x66, 0x74, 0x79]);
      await mkdir(path.join(root, "workspace", "demo"));
      await writeFile(path.join(root, "workspace", "demo", "demo.mp4"), bytes);

      const result = await postRunFile({
        task_id: task.id,
        path: "demo/demo.mp4",
      });

      expect(result.isError).toBeFalsy();
      expect(upload).toHaveBeenCalledOnce();
      expect(upload.mock.calls[0][0]).toMatchObject({
        filename: "demo.mp4",
        data: bytes,
      });
      // The pinned copy is released once the bytes are read.
      expect(
        await readdir(path.join(root, "workspace", ".archestra-transfers")),
      ).toEqual([]);
    });

    test("refuses paths that leave the workspace, directories and oversized files", async () => {
      const task = await seedRuntimeTask();
      const workspace = path.join(root, "workspace");
      await writeFile(path.join(root, "outside.mp4"), "outside bytes");
      await symlink(root, path.join(workspace, "escape"));
      await symlink(
        path.join(root, "outside.mp4"),
        path.join(workspace, "linked.mp4"),
      );
      await mkdir(path.join(workspace, "folder"));
      // Sparse: one byte over the cap without writing 40 MB.
      await truncate(
        await writeFile(path.join(workspace, "big.mp4"), "").then(() =>
          path.join(workspace, "big.mp4"),
        ),
        40 * 1024 * 1024 + 1,
      );

      for (const [unsafe, reason] of [
        ["../outside.mp4", "without traversal"],
        ["escape/outside.mp4", "Could not read"],
        ["linked.mp4", "Only regular files"],
        ["folder", "Only regular files"],
        ["big.mp4", "keep run files under 40MB"],
        ["/home/node/workspace/", "Pass the path of a file"],
        ["/home/node/workspace", "Pass the path of a file"],
        ["././", "Pass the path of a file"],
        ["/etc/passwd", "without traversal"],
      ] as const) {
        const result = await postRunFile({
          task_id: task.id,
          path: unsafe,
          filename: "demo.mp4",
        });
        expect(result.isError, unsafe).toBe(true);
        expect(JSON.stringify(result.content), unsafe).toContain(reason);
      }
      expect(upload).not.toHaveBeenCalled();
    });

    test("needs exactly one of path and content_base64", async () => {
      const task = await seedRuntimeTask();
      await writeFile(path.join(root, "workspace", "demo.mp4"), "video");

      for (const args of [
        {
          path: "demo.mp4",
          content_base64: Buffer.from("x").toString("base64"),
        },
        { filename: "demo.mp4" },
      ]) {
        const result = await postRunFile({ task_id: task.id, ...args });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(
          "Pass exactly one of path or content_base64",
        );
      }
      const unnamed = await postRunFile({
        task_id: task.id,
        content_base64: Buffer.from("x").toString("base64"),
      });
      expect(JSON.stringify(unnamed.content)).toContain(
        "Pass filename with content_base64",
      );
      expect(upload).not.toHaveBeenCalled();
    });

    test("reads an absolute path under the workspace root and a ./ path", async () => {
      const task = await seedRuntimeTask();
      await mkdir(path.join(root, "workspace", "demo"));
      await writeFile(
        path.join(root, "workspace", "demo", "demo.mp4"),
        "video",
      );

      for (const given of [
        "/home/node/workspace/demo/demo.mp4",
        "./demo/demo.mp4",
      ]) {
        const result = await postRunFile({ task_id: task.id, path: given });
        expect(result.isError, given).toBeFalsy();
      }
      expect(upload).toHaveBeenCalledTimes(2);
      for (const [call] of upload.mock.calls) {
        expect(call).toMatchObject({
          filename: "demo.mp4",
          data: Buffer.from("video"),
        });
      }
    });

    describe("with Guardrails on", () => {
      const PARENT = "user:parent|conversation";
      const originalOpenappa = config.openappa.enabled;

      beforeEach(async () => {
        config.openappa.enabled = true;
        await GuardrailsDeploymentModel.setEnabled(true);
      });

      afterEach(() => {
        config.openappa.enabled = originalOpenappa;
      });

      test("a bound run's own proofless call is refused until its session is superyelled", async () => {
        const task = await seedRuntimeTask();
        const child = await bindToParent(task.id);
        await writeFile(path.join(root, "workspace", "demo.mp4"), "video");

        const governed = await postRunFile({
          task_id: task.id,
          path: "demo.mp4",
        });
        expect(governed.isError).toBe(true);
        expect(JSON.stringify(governed.content)).toContain(
          "carried no proof of its source",
        );
        expect(upload).not.toHaveBeenCalled();

        await superyellSession(child);
        const superyelled = await postRunFile({
          task_id: task.id,
          path: "demo.mp4",
        });
        expect(superyelled.isError).toBeFalsy();
        expect(upload.mock.calls[0][0]).toMatchObject({
          filename: "demo.mp4",
          data: Buffer.from("video"),
        });
      });

      test("the parent session still cannot post its child's file", async () => {
        const task = await seedRuntimeTask();
        await bindToParent(task.id);
        await writeFile(path.join(root, "workspace", "demo.mp4"), "video");

        const result = await postRunFile(
          { task_id: task.id, path: "demo.mp4" },
          {
            openappaRuntimeCall: {
              session: {
                organization_id: organizationId,
                caller_id: "user:parent",
                session_id: PARENT,
              },
              toolCallId: "call-1",
              spawn: false,
            },
          },
        );

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(
          "cannot be posted from another session",
        );
        expect(upload).not.toHaveBeenCalled();
      });

      /** Records the run's session the way a protected spawn leaves it. */
      async function bindToParent(taskId: string) {
        const workspace = await AgentWorkspaceModel.findById(taskId);
        if (!workspace) throw new Error("workspace not seeded");
        const child = runtimeOpenAppaSession({
          organizationId,
          workspaceId: workspace.id,
          workloadName: workspace.workloadName,
          actorKind: "user",
          actorId,
        });
        await db.insert(schema.openappaSessionsTable).values({
          actor: openappaActor(child.session_id),
          root: openappaActor(PARENT),
          organizationId,
          callerId: child.caller_id,
          sessionId: child.session_id,
          parentId: PARENT,
          startDecision: { decision: "ack" },
        });
        return { ...child, parent_id: PARENT };
      }
    });

    /** A chatops run with a live workspace, as a delegated run has. */
    function postRunFile(
      args: Record<string, unknown>,
      extra: Partial<ArchestraContext> = {},
    ) {
      return executeArchestraTool(TOOL_POST_RUN_FILE_FULL_NAME, args, {
        ...context,
        ...extra,
      });
    }
  });

  describe("workspace file tools with a workspace path", () => {
    let root: string;
    let workspace: string;
    let stopServingWorkspace: () => void;

    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), "workspace-file-"));
      workspace = path.join(root, "workspace");
      await mkdir(workspace);
      stopServingWorkspace = serveWorkspaceFrom(workspace);
    });

    afterEach(async () => {
      // This file shares its worker with other files: nothing may outlive it.
      stopServingWorkspace();
      await rm(root, { recursive: true, force: true });
    });

    test("say why a missing file could not be read, written or downloaded", async () => {
      const task = await seedRuntimeTask();
      // The reason is the helper's OSError text for the folder that is missing.
      const missing = "No such file or directory.*'reports'";

      const read = await executeArchestraTool(
        "archestra__read_workspace_file",
        { task_id: task.id, path: "reports/notes.md" },
        context,
      );
      const written = await executeArchestraTool(
        "archestra__write_workspace_file",
        { task_id: task.id, path: "reports/notes.md", content: "hello" },
        context,
      );
      const download = await executeArchestraTool(
        "archestra__transfer_workspace_file",
        {
          task_id: task.id,
          direction: "download",
          path: "reports/notes.md",
          local_path: "/tmp/notes.md",
        },
        context,
      );

      expect(read).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: expect.stringMatching(
              new RegExp(
                `^Error: Could not read reports/notes\\.md from the run's workspace: .*${missing}`,
              ),
            ),
          },
        ],
      });
      expect(written).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: expect.stringMatching(
              new RegExp(
                `^Error: Could not write reports/notes\\.md to the run's workspace: .*${missing}`,
              ),
            ),
          },
        ],
      });
      expect(download).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: expect.stringMatching(
              new RegExp(
                `^Error: Could not authorize the download of reports/notes\\.md: .*${missing}`,
              ),
            ),
          },
        ],
      });
    });

    test("a binary file read as text asks for base64", async () => {
      const task = await seedRuntimeTask();
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
      await writeFile(path.join(workspace, "image.png"), bytes);

      const asText = await executeArchestraTool(
        "archestra__read_workspace_file",
        { task_id: task.id, path: "image.png" },
        context,
      );
      const asBase64 = await executeArchestraTool(
        "archestra__read_workspace_file",
        { task_id: task.id, path: "image.png", encoding: "base64" },
        context,
      );

      expect(asText).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: "Error: Could not read image.png from the run's workspace: This file is not UTF-8 text. Read it with encoding base64.",
          },
        ],
      });
      expect(asBase64.isError).toBeFalsy();
      expect(asBase64.structuredContent).toMatchObject({
        encoding: "base64",
        content: bytes.toString("base64"),
      });
    });

    test("an unexpected failure stays generic", async () => {
      const task = await seedRuntimeTask();
      vi.mocked(backend.accessWorkspaceFile).mockRejectedValueOnce(
        new Error("exec into pod agent-run-1234 failed"),
      );

      const read = await executeArchestraTool(
        "archestra__read_workspace_file",
        { task_id: task.id, path: "notes.md" },
        context,
      );

      expect(read).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: "Error: An internal error occurred while reading workspace file",
          },
        ],
      });
    });
  });
});

/**
 * Runs the real in-Pod file helper on this machine against `workspace`, in
 * place of the exec into the Pod. Its path rules are what the tests exercise.
 * Returns the function that puts the real exec back.
 */
function serveWorkspaceFrom(workspace: string): () => void {
  const helper = path.resolve(
    import.meta.dirname,
    "../static/workspace-files.py",
  );
  const env = {
    ...process.env,
    ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ROOT: workspace,
  };
  const command = vi
    .spyOn(backend, "runWorkspaceTransferCommand")
    .mockImplementation(async ({ args }) => {
      const run = spawnSync("python3", [helper, ...args], {
        env,
        encoding: "utf8",
        timeout: 30_000,
      });
      const reply = JSON.parse(run.stdout);
      if (reply.ok !== true) throw new ApiError(400, reply.error);
      return reply;
    });
  const file = vi
    .spyOn(backend, "accessWorkspaceFile")
    .mockImplementation(async ({ request }) => {
      const run = spawnSync("python3", [helper], {
        env,
        input: JSON.stringify(request),
        encoding: "utf8",
        timeout: 30_000,
      });
      const { ok, error, ...result } = JSON.parse(run.stdout);
      if (ok !== true) throw new ApiError(400, error);
      return result;
    });
  const range = vi
    .spyOn(backend, "readWorkspaceTransferRange")
    .mockImplementation(async ({ transferId, offset, length }) => {
      const child = spawn(
        "python3",
        [helper, "read-range", transferId, String(offset), String(length)],
        { env },
      );
      return {
        stdout: child.stdout,
        completed: new Promise<void>((resolve, reject) =>
          child.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error("read-range failed")),
          ),
        ),
      };
    });
  return () => {
    command.mockRestore();
    file.mockRestore();
    range.mockRestore();
  };
}
