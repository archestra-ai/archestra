import { eq } from "drizzle-orm";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
} from "@/models";
import * as podRun from "@/services/agent-runtime/pod-run";
import { afterEach, beforeEach, expect, test } from "@/test";
import type { AgentRuntime } from "@/types";
import { ApiError } from "@/types";
import { isTerminalA2ATaskState } from "@/types/a2a-task";
import { startDetachedAgentTask } from "./start-task";

const runtime: AgentRuntime = {
  image: "example.invalid/runtime-agent:test",
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
};

type Launch = {
  taskId: string;
  resumeFromTaskId?: string;
  actorId: string;
  agentId: string;
};

const launches: Launch[] = [];
let rejectExplicitResume = false;
let holdFirstLaunch: Promise<void> | null = null;

function completedResult() {
  const messageId = crypto.randomUUID();
  return {
    messageId,
    text: "done",
    finishReason: "stop" as const,
    responseUiMessage: {
      id: messageId,
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: "done" }],
    },
  };
}

beforeEach(() => {
  launches.length = 0;
  rejectExplicitResume = false;
  holdFirstLaunch = null;
  config.agentRuntime.enabled = true;
  vi.spyOn(podRun, "runTaskInAgentRuntime").mockImplementation(
    async (params) => {
      launches.push({
        taskId: params.taskId,
        resumeFromTaskId: params.resumeFromTaskId,
        actorId: params.actor.id,
        agentId: params.agentId,
      });
      if (
        holdFirstLaunch &&
        launches.length === 1 &&
        !params.resumeFromTaskId
      ) {
        await holdFirstLaunch;
      }
      if (params.resumeFromTaskId) {
        const prior = await AgentRunModel.findByTaskId(params.resumeFromTaskId);
        const workspace = prior
          ? await AgentWorkspaceModel.findByWorkloadName(prior.workloadName)
          : null;
        if (
          rejectExplicitResume ||
          !prior ||
          !workspace ||
          workspace.organizationId !== params.organizationId ||
          workspace.actorKind !== params.actor.kind ||
          workspace.actorId !== params.actor.id ||
          workspace.agentId !== params.agentId ||
          workspace.state === "deleted" ||
          workspace.state === "deleting" ||
          workspace.expiresAt.getTime() <= Date.now() ||
          workspace.activeTaskId
        ) {
          throw new ApiError(
            409,
            "The prior workspace is unavailable for this actor, Agent, or environment",
          );
        }
        await AgentRunModel.create({
          organizationId: params.organizationId,
          agentId: params.agentId,
          taskId: params.taskId,
          actorKind: params.actor.kind,
          actorId: params.actor.id,
          actorUserId: params.actor.kind === "user" ? params.actor.id : null,
          backend: "kubernetes",
          runtimeScope: workspace.runtimeScope,
          workloadName: workspace.workloadName,
        });
        const claimed = await AgentWorkspaceModel.claim({
          id: workspace.id,
          organizationId: params.organizationId,
          actorKind: params.actor.kind,
          actorId: params.actor.id,
          agentId: params.agentId,
          taskId: params.taskId,
        });
        if (!claimed) {
          throw new ApiError(
            409,
            "This workspace is already in use or its retention deadline has passed",
          );
        }
        return completedResult();
      }

      const workloadName = `workspace-${params.taskId}`;
      await AgentRunModel.create({
        organizationId: params.organizationId,
        agentId: params.agentId,
        taskId: params.taskId,
        actorKind: params.actor.kind,
        actorId: params.actor.id,
        actorUserId: params.actor.kind === "user" ? params.actor.id : null,
        backend: "kubernetes",
        runtimeScope: "test",
        workloadName,
      });
      await AgentWorkspaceModel.create({
        id: params.taskId,
        organizationId: params.organizationId,
        agentId: params.agentId,
        actorKind: params.actor.kind,
        actorId: params.actor.id,
        backend: "kubernetes",
        runtimeScope: "test",
        workloadName,
        state: "idle",
        lastTaskId: params.taskId,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      return completedResult();
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function settle(taskId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const task = await A2ATaskModel.findById(taskId);
    if (task && isTerminalA2ATaskState(task.state)) return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`task ${taskId} did not settle`);
}

test("same sender key reuses the retained workspace and a different actor does not", async ({
  makeOrganization,
  makeInternalAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeInternalAgent({
    organizationId: org.id,
    runtime,
  });
  const other = await makeInternalAgent({
    organizationId: org.id,
    runtime,
  });
  const actor = {
    id: "system",
    kind: "system" as const,
    organizationId: org.id,
  };
  const contextKey = JSON.stringify([
    "email",
    "outlook",
    "agents@example.com",
    "conversation:thread-1",
    "sender@example.com",
  ]);

  const first = await startDetachedAgentTask({
    actor,
    agentId: agent.id,
    message: "first",
    contextKey,
  });
  await settle(first.id);
  const second = await startDetachedAgentTask({
    actor,
    agentId: agent.id,
    message: "follow up",
    contextKey,
  });
  await settle(second.id);
  const otherActor = await startDetachedAgentTask({
    actor: { ...actor, id: "other-system" },
    agentId: agent.id,
    message: "other actor",
    contextKey,
  });
  await settle(otherActor.id);
  const otherAgent = await startDetachedAgentTask({
    actor,
    agentId: other.id,
    message: "other agent",
    contextKey,
  });
  await settle(otherAgent.id);

  expect(second.contextId).toBe(first.contextId);
  expect(launches[1]?.resumeFromTaskId).toBe(first.id);
  expect(otherActor.contextId).not.toBe(first.contextId);
  expect(otherAgent.contextId).not.toBe(first.contextId);
  expect(launches[2]?.resumeFromTaskId).toBeUndefined();
  expect(launches[3]?.resumeFromTaskId).toBeUndefined();
  expect(launches[2]?.actorId).toBe("other-system");
});

test("concurrent first turns share one workspace instead of launching two", async ({
  makeOrganization,
  makeInternalAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeInternalAgent({
    organizationId: org.id,
    runtime,
  });
  let releaseFirst: () => void = () => {};
  holdFirstLaunch = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const actor = {
    id: "system",
    kind: "system" as const,
    organizationId: org.id,
  };
  const started = startDetachedAgentTask({
    actor,
    agentId: agent.id,
    message: "first",
    contextKey: "thread-race",
  });
  await vi.waitFor(() => {
    expect(launches).toHaveLength(1);
  });
  const followed = startDetachedAgentTask({
    actor,
    agentId: agent.id,
    message: "second",
    contextKey: "thread-race",
  });
  releaseFirst();
  const [first, second] = await Promise.all([started, followed]);
  await settle(first.id);
  await settle(second.id);

  expect(second.contextId).toBe(first.contextId);
  expect(launches.filter((launch) => !launch.resumeFromTaskId)).toHaveLength(1);
  expect(launches[1]?.resumeFromTaskId).toBe(first.id);
});

test("an explicit unavailable resume is not replaced with a new workspace", async ({
  makeOrganization,
  makeInternalAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeInternalAgent({
    organizationId: org.id,
    runtime,
  });
  const actor = {
    id: "system",
    kind: "system" as const,
    organizationId: org.id,
  };
  const first = await startDetachedAgentTask({
    actor,
    agentId: agent.id,
    message: "first",
    contextKey: "thread-unavailable",
  });
  await settle(first.id);
  rejectExplicitResume = true;
  const resumed = await startDetachedAgentTask({
    actor,
    agentId: agent.id,
    message: "follow up",
    contextKey: "thread-unavailable",
  });
  const failed = await settle(resumed.id);

  expect(launches).toHaveLength(2);
  expect(launches[1]?.resumeFromTaskId).toBe(first.id);
  expect(failed.state).toBe("TASK_STATE_FAILED");
  expect(
    launches.filter((launch) => launch.resumeFromTaskId === undefined),
  ).toHaveLength(1);
});

test("an expired retained workspace starts a new runtime instead of resuming it", async ({
  makeOrganization,
  makeInternalAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeInternalAgent({
    organizationId: org.id,
    runtime,
  });
  const actor = {
    id: "system",
    kind: "system" as const,
    organizationId: org.id,
  };
  const first = await startDetachedAgentTask({
    actor,
    agentId: agent.id,
    message: "first",
    contextKey: "thread-expired",
  });
  await settle(first.id);
  const run = await AgentRunModel.findByTaskId(first.id);
  if (!run) throw new Error("expected run");
  const workspace = await AgentWorkspaceModel.findByWorkloadName(
    run.workloadName,
  );
  if (!workspace) throw new Error("expected workspace");
  await db
    .update(schema.agentWorkspacesTable)
    .set({ expiresAt: new Date(Date.now() - 1_000) })
    .where(eq(schema.agentWorkspacesTable.id, workspace.id));

  const second = await startDetachedAgentTask({
    actor,
    agentId: agent.id,
    message: "after expiry",
    contextKey: "thread-expired",
  });
  await settle(second.id);

  expect(second.contextId).toBe(first.contextId);
  expect(launches[1]?.resumeFromTaskId).toBeUndefined();
  expect(launches[1]?.taskId).not.toBe(first.id);
});

test("a timed-out launch retains its task and blocks a replacement until the workspace is published", async ({
  makeOrganization,
  makeInternalAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeInternalAgent({ organizationId: org.id, runtime });
  const actor = {
    id: "system",
    kind: "system" as const,
    organizationId: org.id,
  };
  let releaseFirst = () => {};
  holdFirstLaunch = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  const started = startDetachedAgentTask({
    actor,
    agentId: agent.id,
    message: "slow first turn",
    contextKey: "slow-launch",
  });
  try {
    await vi.waitFor(() => expect(launches).toHaveLength(1));
    vi.setSystemTime(Date.now() + 31_000);
    const first = await started;
    expect(first.id).toBe(launches[0]?.taskId);
    expect(await AgentRunModel.findByTaskId(first.id)).toBeNull();
    await expect(
      startDetachedAgentTask({
        actor,
        agentId: agent.id,
        message: "follow-up",
        contextKey: "slow-launch",
      }),
    ).rejects.toThrow("prior runtime launch is still pending");
    expect(launches).toHaveLength(1);
    releaseFirst();
    await settle(first.id);
    const second = await startDetachedAgentTask({
      actor,
      agentId: agent.id,
      message: "after publication",
      contextKey: "slow-launch",
    });
    await settle(second.id);
    expect(launches[1]?.resumeFromTaskId).toBe(first.id);
    expect(launches.filter((launch) => !launch.resumeFromTaskId)).toHaveLength(
      1,
    );
  } finally {
    releaseFirst();
    await started.catch(() => undefined);
    const taskId = launches[0]?.taskId;
    if (taskId) await settle(taskId);
  }
});

test("a persisted pending launch fences a new process without an in-memory continuation tail", async ({
  makeOrganization,
  makeInternalAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeInternalAgent({ organizationId: org.id, runtime });
  const actor = {
    id: "system",
    kind: "system" as const,
    organizationId: org.id,
  };
  const contextKey = "restarted-launch";
  const context = await A2AContextModel.getOrCreateForExternalThread({
    organizationId: org.id,
    actorKind: actor.kind,
    actorId: actor.id,
    agentId: agent.id,
    externalThread: contextKey,
  });
  const pending = await A2ATaskModel.createForRun({
    contextId: context.id,
    agentId: agent.id,
  });
  for (const state of ["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"] as const) {
    if (state === "TASK_STATE_WORKING") {
      await A2ATaskModel.updateState(pending.id, state);
    }
    await expect(
      startDetachedAgentTask({
        actor,
        agentId: agent.id,
        message: "retry after restart",
        contextKey,
      }),
    ).rejects.toThrow("prior runtime launch is still pending");
    expect(launches).toHaveLength(0);
  }
});
