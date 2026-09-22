import {
  TOOL_GET_RUN_FULL_NAME,
  TOOL_LIST_RUNS_FULL_NAME,
  TOOL_START_RUN_FULL_NAME,
  TOOL_STEER_RUN_FULL_NAME,
} from "@archestra/shared";
import { HttpResponse, http } from "msw";
import { onTestFinished, vi } from "vitest";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import config from "@/config";
import { agentRuntimeManager } from "@/k8s/agent-runtime";
import {
  A2AContextModel,
  A2AMessageModel,
  A2ATaskModel,
  AgentRunInputModel,
  AgentRunModel,
  AgentWorkspaceModel,
} from "@/models";
import { kubernetesAgentRuntimeBackendDriver as backend } from "@/services/agent-runtime/backends/kubernetes";
import { claudeCodeAccountManager } from "@/services/agent-runtime/claude-code-account";
import { resolveAgentRuntime } from "@/services/agent-runtime/pod-run";
import { beforeEach, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import type { Agent, ResolvedAgentRuntime } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const oauthServer = useMswServer();

let agent: Agent;
let runtime: ResolvedAgentRuntime;
let context: ArchestraContext;
let userId: string;

beforeEach(
  async ({
    makeOrganization,
    makeAdmin,
    makeMember,
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const previous = {
      enabled: config.agentRuntime.enabled,
      url: config.agentRuntime.platformBaseUrl,
    };
    config.agentRuntime.enabled = true;
    config.agentRuntime.platformBaseUrl = "https://platform.example.test";
    onTestFinished(() => {
      config.agentRuntime.enabled = previous.enabled;
      config.agentRuntime.platformBaseUrl = previous.url;
    });
    vi.spyOn(agentRuntimeManager, "isEnabled", "get").mockReturnValue(true);
    vi.spyOn(backend, "isEnabled", "get").mockReturnValue(true);
    const org = await makeOrganization();
    const user = await makeAdmin();
    userId = user.id;
    await makeMember(userId, org.id, { role: "admin" });
    agent = await makeAgent({
      organizationId: org.id,
      authorId: userId,
      agentType: "agent",
      scope: "org",
      runtime: {
        image: "example.test/claude-code:current",
        command: ["archestra-claude-code"],
        inferenceProtocol: "anthropic",
        backend: "kubernetes",
        steerMode: "tmux_keys",
        privileged: false,
        resources: null,
        environment: null,
        credentials: null,
        ttlHours: null,
        maxCostUsd: null,
        idleTimeoutMinutes: null,
        claudeCode: { authentication: "subscription" },
      },
    });
    const resolved = resolveAgentRuntime(agent);
    if (!resolved) throw new Error("Expected runtime");
    runtime = resolved;
    await seedAndAssignArchestraTools(agent.id);
    context = {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      userId,
      organizationId: org.id,
    };
  },
);

test.for([
  "initial",
  "continuation",
] as const)("%s reports a disconnected personal account before creating detached work", async (mode) => {
  await connect({ ...runtime, image: "example.test/claude-code:previous" });
  await claudeCodeAccountManager.disconnect({ runtime, userId });
  const previous = mode === "continuation" ? await retainedRun() : null;
  const result = await executeArchestraTool(
    mode === "initial" ? TOOL_START_RUN_FULL_NAME : TOOL_STEER_RUN_FULL_NAME,
    previous
      ? { task_id: previous.taskId, message: "Revise the UI and demo it" }
      : { agent_id: agent.id, message: "Implement the UI" },
    context,
  );
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("CLAUDE_CODE_ACCOUNT");
  // No `section`: the Agent detail page rewrites an unresolvable one through
  // agentDetailHref, which rebuilds the URL from `section` alone and drops the
  // `setup` that opens the dialog.
  expect(JSON.stringify(result.content)).toContain(
    `/agents/${agent.id}?setup=credentials&keys=CLAUDE_CODE_ACCOUNT`,
  );
  const tasks = await A2ATaskModel.listForActor({
    actorKind: "user",
    actorId: userId,
    agentId: agent.id,
    pageSize: 100,
  });
  expect(tasks.tasks).toHaveLength(previous ? 1 : 0);
});

test("a continuation reuses the account after an image change and reports a later startup failure to the original thread", async () => {
  await connect({ ...runtime, image: "example.test/claude-code:previous" });
  const previous = await retainedRun();
  const notify = vi
    .spyOn(chatOpsManager, "notifyBindingThread")
    .mockResolvedValue();
  vi.spyOn(backend, "continueRun").mockRejectedValue(
    new Error("Runtime transport unavailable"),
  );
  vi.spyOn(backend, "stopRun").mockResolvedValue(undefined);
  vi.spyOn(backend, "releaseRun").mockResolvedValue();
  const result = await executeArchestraTool(
    TOOL_STEER_RUN_FULL_NAME,
    { task_id: previous.taskId, message: "Revise the UI and demo it" },
    context,
  );
  expect(result.isError).toBe(false);
  const reply = JSON.parse((result.content[0] as { text: string }).text);
  expect(reply.task_id).not.toBe(previous.taskId);
  expect(reply.status).toBe("accepted");
  await expect
    .poll(async () => (await A2ATaskModel.findById(reply.task_id))?.state)
    .toBe("TASK_STATE_FAILED");
  await expect.poll(() => notify.mock.calls.length).toBe(1);
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({
      bindingId:
        previous.completionTarget?.type === "chatops"
          ? previous.completionTarget.bindingId
          : "",
      threadId: "thread-test",
      text: expect.stringContaining("Runtime transport unavailable"),
    }),
  );
});

test("an external gateway steers the current turn using the original session handle", async ({
  makeAgent,
}) => {
  const previous = await retainedRun();
  const previousTask = await A2ATaskModel.findById(previous.taskId);
  if (!previousTask) throw new Error("Missing task fixture");
  const currentTask = await A2ATaskModel.create({
    contextId: previousTask.contextId,
    agentId: agent.id,
    state: "TASK_STATE_WORKING",
  });
  const current = await AgentRunModel.create({
    organizationId: agent.organizationId,
    agentId: agent.id,
    taskId: currentTask.id,
    actorKind: "user",
    actorId: userId,
    actorUserId: userId,
    workloadName: previous.workloadName,
    backend: "kubernetes",
    runtimeScope: previous.runtimeScope,
  });
  for (const [taskId, text] of [
    [
      previous.taskId,
      "Decode numeric HTML entities in the existing repository",
    ],
    [currentTask.id, "Cover invalid Unicode code points too"],
  ]) {
    await A2AMessageModel.create({
      contextId: previousTask.contextId,
      taskId,
      role: "ROLE_USER",
      parts: [{ text }],
      content: { role: "user", content: text },
    });
  }
  await AgentWorkspaceModel.claim({
    id: previous.taskId,
    organizationId: agent.organizationId,
    actorKind: "user",
    actorId: userId,
    agentId: agent.id,
    taskId: currentTask.id,
  });
  const gateway = await makeAgent({
    organizationId: agent.organizationId,
    agentType: "mcp_gateway",
  });
  const externalContext = {
    ...context,
    agentId: gateway.id,
    agent: { id: gateway.id, name: gateway.name },
    sessionId: "another-client-conversation",
  };
  const steer = vi.spyOn(backend, "steer").mockResolvedValue();
  const launch = vi.spyOn(backend, "launch");
  const continuation = vi.spyOn(backend, "continueRun");
  for (const taskId of [previous.taskId, currentTask.id, previous.taskId]) {
    const result = await executeArchestraTool(
      TOOL_STEER_RUN_FULL_NAME,
      { task_id: taskId, message: "Keep working on the existing draft" },
      externalContext,
    );
    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(
      result.structuredContent,
    );
    expect(result.structuredContent).toMatchObject({
      task_id: currentTask.id,
      session_id: previous.taskId,
    });
    expect(steer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          id: current.id,
          workloadName: previous.workloadName,
        }),
      }),
    );
  }
  const status = await executeArchestraTool(
    TOOL_GET_RUN_FULL_NAME,
    { task_id: previous.taskId },
    externalContext,
  );
  expect(status.structuredContent).toMatchObject({
    session_id: previous.taskId,
    run: { task_id: currentTask.id },
    run_url: expect.stringContaining(`/chat/runs/${previous.taskId}`),
    workspace: { can_continue: true, continuation_error: null },
    requests: [
      {
        task_id: previous.taskId,
        text: "Decode numeric HTML entities in the existing repository",
        truncated: false,
      },
      {
        task_id: currentTask.id,
        text: "Cover invalid Unicode code points too",
        truncated: false,
      },
    ],
  });
  expect(JSON.parse((status.content[0] as { text: string }).text)).toEqual(
    status.structuredContent,
  );
  const listed = await executeArchestraTool(
    TOOL_LIST_RUNS_FULL_NAME,
    { agent_id: agent.id },
    externalContext,
  );
  const listedText = JSON.parse((listed.content[0] as { text: string }).text);
  expect(listedText).toEqual(listed.structuredContent);
  expect(listedText.runs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ task_id: currentTask.id }),
    ]),
  );
  expect(launch).not.toHaveBeenCalled();
  expect(continuation).not.toHaveBeenCalled();
  expect(
    (
      await A2ATaskModel.listForActor({
        actorKind: "user",
        actorId: userId,
        agentId: agent.id,
        pageSize: 100,
      })
    ).tasks,
  ).toHaveLength(2);
});

test.for([
  "expired",
  "deleted",
] as const)("a %s session rejects steering without creating a replacement task", async (unavailable) => {
  const previous = await retainedRun();
  const retained = await executeArchestraTool(
    TOOL_GET_RUN_FULL_NAME,
    { task_id: previous.taskId },
    context,
  );
  expect(retained.structuredContent).toMatchObject({
    workspace: { can_continue: true, continuation_error: null },
  });
  if (unavailable === "expired") {
    vi.useFakeTimers({ toFake: ["Date"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.setSystemTime(Date.now() + 7200_000);
  } else {
    await AgentWorkspaceModel.transition({
      id: previous.taskId,
      from: "idle",
      to: "deleted",
    });
  }
  const expired = await executeArchestraTool(
    TOOL_GET_RUN_FULL_NAME,
    { task_id: previous.taskId },
    context,
  );
  expect(expired.structuredContent).toMatchObject({
    workspace: {
      can_continue: false,
      continuation_error: expect.stringContaining(
        unavailable === "expired" ? "session expired" : "workspace was removed",
      ),
    },
  });
  const result = await executeArchestraTool(
    TOOL_STEER_RUN_FULL_NAME,
    { task_id: previous.taskId, message: "Continue the draft" },
    context,
  );
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain(
    "No new session was started",
  );
  expect(
    (
      await A2ATaskModel.listForActor({
        actorKind: "user",
        actorId: userId,
        agentId: agent.id,
        pageSize: 100,
      })
    ).tasks,
  ).toHaveLength(1);
});

test("steering rejects literal NUL characters with an actionable error before delivery", async () => {
  const previous = await retainedRun();
  const steer = vi.spyOn(backend, "steer");
  const continuation = vi.spyOn(backend, "continueRun");
  const result = await executeArchestraTool(
    TOOL_STEER_RUN_FULL_NAME,
    { task_id: previous.taskId, message: "Test the character \0 too" },
    context,
  );
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("U+0000");
  expect(steer).not.toHaveBeenCalled();
  expect(continuation).not.toHaveBeenCalled();
  expect(
    (
      await A2ATaskModel.listForActor({
        actorKind: "user",
        actorId: userId,
        agentId: agent.id,
        pageSize: 100,
      })
    ).tasks,
  ).toHaveLength(1);
});

test("start_run persists handoff files before launching the runtime", async () => {
  await connect(runtime);
  const contents = "Draft for the next turn\n";
  let stagedBeforeLaunch = false;
  vi.spyOn(backend, "launch").mockImplementation(async (spec) => {
    const files = await AgentRunInputModel.findByTaskId(spec.taskId);
    stagedBeforeLaunch =
      files.length === 1 && files[0].fileData.toString() === contents;
    throw new Error("Test launch stopped after checking inputs");
  });
  vi.spyOn(backend, "stopRun").mockResolvedValue(undefined);
  vi.spyOn(backend, "releaseRun").mockResolvedValue();
  vi.spyOn(backend, "deleteWorkspace").mockResolvedValue();
  const result = await executeArchestraTool(
    TOOL_START_RUN_FULL_NAME,
    {
      agent_id: agent.id,
      message: "Continue the attached document",
      attachments: [
        {
          name: "draft.txt",
          contentType: "text/plain",
          contentBase64: Buffer.from(contents).toString("base64"),
        },
      ],
    },
    context,
  );
  expect(result.isError).not.toBe(true);
  const reply = result.structuredContent as {
    session_id: string;
    run: { task_id: string };
  };
  expect(reply.session_id).toBe(reply.run.task_id);
  expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(
    reply,
  );
  await expect
    .poll(async () => (await A2ATaskModel.findById(reply.run.task_id))?.state)
    .toBe("TASK_STATE_FAILED");
  expect(stagedBeforeLaunch).toBe(true);
});

test("invalid handoff attachment data is rejected before creating a run", async () => {
  const result = await executeArchestraTool(
    TOOL_START_RUN_FULL_NAME,
    {
      agent_id: agent.id,
      message: "Read the attachment",
      attachments: [
        {
          name: "draft.txt",
          contentType: "text/plain",
          contentBase64: "not base64",
        },
      ],
    },
    context,
  );
  expect(result.isError).toBe(true);
  expect(
    (
      await A2ATaskModel.listForActor({
        actorKind: "user",
        actorId: userId,
        agentId: agent.id,
        pageSize: 100,
      })
    ).tasks,
  ).toHaveLength(0);
});

async function connect(approvedRuntime: ResolvedAgentRuntime) {
  oauthServer.use(
    http.post("https://platform.claude.com/v1/oauth/token", () =>
      HttpResponse.json({
        access_token: `sk-ant-oat01-${"example".repeat(8)}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "user:inference",
      }),
    ),
  );
  const owner = { runtime: approvedRuntime, userId };
  const flow = await claudeCodeAccountManager.start(owner);
  await claudeCodeAccountManager.complete({
    ...owner,
    flowId: flow.flowId as string,
    code: `example-code#${new URL(flow.authorizationUrl as string).searchParams.get("state")}`,
  });
}

async function retainedRun() {
  const a2aContext = await A2AContextModel.create({
    actorKind: "user",
    actorId: userId,
  });
  const task = await A2ATaskModel.create({
    contextId: a2aContext.id,
    agentId: agent.id,
    state: "TASK_STATE_COMPLETED",
  });
  const session = await AgentRunModel.create({
    organizationId: agent.organizationId,
    agentId: agent.id,
    taskId: task.id,
    actorKind: "user",
    actorId: userId,
    actorUserId: userId,
    workloadName: `retained-${task.id}`,
    backend: "kubernetes",
    runtimeScope: backend.resolveRuntimeScope({}),
    completionTarget: {
      type: "chatops",
      bindingId: crypto.randomUUID(),
      threadId: "thread-test",
    },
  });
  await AgentRunModel.close({ id: session.id });
  await AgentWorkspaceModel.create({
    id: task.id,
    organizationId: agent.organizationId,
    agentId: agent.id,
    actorKind: "user",
    actorId: userId,
    backend: "kubernetes",
    runtimeScope: session.runtimeScope,
    workloadName: session.workloadName,
    state: "idle",
    lastTaskId: task.id,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return session;
}
