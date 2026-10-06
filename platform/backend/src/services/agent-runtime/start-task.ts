import { randomUUID } from "node:crypto";
import type { A2AActor } from "@/agents/a2a/a2a-base";
import { buildAttachmentsMessageParts } from "@/agents/a2a/a2a-helper";
import type { A2AManager, A2ASystemParams } from "@/agents/a2a/a2a-manager";
import {
  A2AProtocolRole,
  type A2AProtocolTask,
} from "@/agents/a2a/a2a-protocol";
import type { A2AAttachment } from "@/agents/a2a-executor";
import { withSessionAdvisoryLock } from "@/database";
import logger from "@/logging";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
} from "@/models";
import { type A2ATask, ApiError } from "@/types";
import { isTerminalA2ATaskState } from "@/types/a2a-task";
import { persistAgentRunInputs } from "./input-files";

/**
 * Launch one durable Agent task and return its handle before the work settles.
 *
 * Runtime selection remains inside A2AManager: an Agent with a dedicated runtime
 * run uses its runtime; any other Agent uses the foreground loop.
 * Keeping this entry point independent from MCP and HTTP lets every invocation
 * surface share that rule.
 */
export async function startDetachedAgentTask(params: {
  actor: A2AActor;
  agentId: string;
  message: string;
  attachments?: A2AAttachment[];
  systemParams?: A2ASystemParams;
  /**
   * Server-derived continuity key. Resolved to one actor-owned context.
   * Not a client-supplied context id, and never a reason to change the actor.
   */
  contextKey?: string;
  /** Persist the caller's durable task association before execution starts. */
  onTaskCreated?: (taskId: string) => Promise<void>;
}): Promise<A2ATask> {
  const externalThread = params.contextKey?.trim();
  if (!externalThread) {
    return await sendDetachedAgentTask(params);
  }

  const context = await A2AContextModel.getOrCreateForExternalThread({
    organizationId: params.actor.organizationId,
    actorKind: params.actor.kind,
    actorId: params.actor.id,
    agentId: params.agentId,
    externalThread,
  });
  // The task is the durable launch guard, including after a timeout/restart
  // before AgentRun or workspace publication. Never replace that live launch.
  return await withContinuationLock(context.id, async () => {
    if (
      await A2ATaskModel.findPendingRuntimeLaunch({
        contextId: context.id,
        agentId: params.agentId,
      })
    ) {
      throw new ApiError(409, "The prior runtime launch is still pending");
    }
    const task = await sendDetachedAgentTask(params, context.id);
    await waitForContinuationRecord(task.id);
    return task;
  });
}

export async function cancelDetachedAgentTask(params: {
  actor: A2AActor;
  agentId: string;
  taskId: string;
}): Promise<A2AProtocolTask> {
  return await (await taskManager.get()).cancelTask({
    actor: params.actor,
    agentId: params.agentId,
    request: { id: params.taskId },
  });
}

// === Internal helpers ===

async function sendDetachedAgentTask(
  params: {
    actor: A2AActor;
    agentId: string;
    message: string;
    attachments?: A2AAttachment[];
    systemParams?: A2ASystemParams;
    onTaskCreated?: (taskId: string) => Promise<void>;
  },
  contextId?: string,
): Promise<A2ATask> {
  const response = await (await taskManager.get()).sendMessage({
    actor: params.actor,
    agentId: params.agentId,
    request: {
      message: {
        messageId: randomUUID(),
        role: A2AProtocolRole.User,
        ...(contextId ? { contextId } : {}),
        parts: [
          { text: params.message },
          ...buildAttachmentsMessageParts(params.attachments ?? []),
        ],
      },
    },
    systemParams: params.systemParams,
    taskRun: { createTask: true, detached: true },
    onDetachedTaskRun: async ({ taskId }) => {
      await params.onTaskCreated?.(taskId);
      if (
        params.attachments &&
        params.attachments.length > 0 &&
        !params.systemParams?.runtimeEmailTurn
      ) {
        await persistAgentRunInputs({
          taskId,
          organizationId: params.actor.organizationId,
          uploadedByUserId:
            params.actor.kind === "user" ? params.actor.id : null,
          attachments: params.attachments,
        });
      }
    },
  });
  if (!response.task) {
    throw new Error("The Agent answered without creating a durable task");
  }

  const task = await A2ATaskModel.findById(response.task.id);
  if (!task) {
    throw new Error("Started task was not persisted");
  }
  return task;
}

const CONTINUATION_RECORD_TIMEOUT_MS = 30_000;
const continuationTails = new Map<string, Promise<void>>();

function withContinuationLock<T>(
  contextId: string,
  body: () => Promise<T>,
): Promise<T> {
  const key = `a2a-context-continuation:${contextId}`;
  const previous = continuationTails.get(key) ?? Promise.resolve();
  const run = previous.then(
    () => withSessionAdvisoryLock(key, body),
    () => withSessionAdvisoryLock(key, body),
  );
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  continuationTails.set(key, settled);
  void settled.finally(() => {
    if (continuationTails.get(key) === settled) {
      continuationTails.delete(key);
    }
  });
  return run;
}

/**
 * Briefly let a normal follow-up see the workspace. A slow launch still returns
 * its durable task so the caller keeps its deduplication and completion watcher;
 * the persisted pending-launch guard protects later turns after lock release.
 */
async function waitForContinuationRecord(taskId: string): Promise<void> {
  const deadline = Date.now() + CONTINUATION_RECORD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const run = await AgentRunModel.findByTaskId(taskId);
    if (run) {
      const workspace = await AgentWorkspaceModel.findByWorkloadName(
        run.workloadName,
      );
      if (
        workspace &&
        workspace.state !== "deleted" &&
        workspace.state !== "deleting"
      ) {
        return;
      }
    }
    const task = await A2ATaskModel.findById(taskId);
    if (task && isTerminalA2ATaskState(task.state)) {
      return;
    }
    await delay(50);
  }
  logger.warn(
    { taskId },
    "Runtime continuation record is still pending; retaining the durable task",
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Avoid the AgentModel -> MCP registry -> task tools import cycle. */
class LazyTaskManager {
  private managerPromise: Promise<A2AManager> | null = null;

  async get(): Promise<A2AManager> {
    this.managerPromise ??= import("@/agents/a2a/a2a-manager").then(
      ({ A2AManager }) => new A2AManager({ taskMode: "full" }),
    );
    return this.managerPromise;
  }
}

const taskManager = new LazyTaskManager();
