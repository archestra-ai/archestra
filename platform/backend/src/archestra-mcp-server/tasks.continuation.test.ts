import {
  TOOL_START_RUN_FULL_NAME,
  TOOL_STEER_RUN_FULL_NAME,
} from "@archestra/shared";
import { onTestFinished, vi } from "vitest";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import config from "@/config";
import { agentRuntimeManager } from "@/k8s/agent-runtime";
import { claudeCodeAccountRuntime } from "@/k8s/agent-runtime/claude-code-account";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
} from "@/models";
import { kubernetesAgentRuntimeBackendDriver as backend } from "@/services/agent-runtime/backends/kubernetes";
import { claudeCodeAccountManager } from "@/services/agent-runtime/claude-code-account";
import { resolveAgentRuntime } from "@/services/agent-runtime/pod-run";
import { beforeEach, expect, test } from "@/test";
import type { Agent, ResolvedAgentRuntime } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

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
] as const)("%s reports an image-bound credential refusal before creating detached work", async (mode) => {
  await connect({ ...runtime, image: "example.test/claude-code:previous" });
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
  expect(JSON.stringify(result.content)).toContain(
    `/agents/${agent.id}?section=advanced&setup=credentials`,
  );
  const tasks = await A2ATaskModel.listForActor({
    actorKind: "user",
    actorId: userId,
    agentId: agent.id,
    pageSize: 100,
  });
  expect(tasks.tasks).toHaveLength(previous ? 1 : 0);
});

test("an accepted continuation exposes its new task ID and reports a later startup failure to the original thread", async () => {
  await connect(runtime);
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

async function connect(approvedRuntime: ResolvedAgentRuntime) {
  vi.spyOn(claudeCodeAccountRuntime, "create").mockResolvedValue();
  vi.spyOn(claudeCodeAccountRuntime, "delete").mockResolvedValue();
  vi.spyOn(claudeCodeAccountRuntime, "status").mockResolvedValue({
    state: "connecting",
  });
  vi.spyOn(claudeCodeAccountRuntime, "complete").mockResolvedValue({
    state: "connected",
    token: `sk-ant-oat01-${"example".repeat(8)}`,
    models: [],
  });
  const owner = { runtime: approvedRuntime, userId };
  const flow = await claudeCodeAccountManager.start(owner);
  await claudeCodeAccountManager.complete({
    ...owner,
    flowId: flow.flowId as string,
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
