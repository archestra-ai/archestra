import { randomUUID } from "node:crypto";
import type { A2AActor } from "@/agents/a2a/a2a-base";
import { buildAttachmentsMessageParts } from "@/agents/a2a/a2a-helper";
import type { A2AManager, A2ASystemParams } from "@/agents/a2a/a2a-manager";
import {
  A2AProtocolRole,
  type A2AProtocolTask,
} from "@/agents/a2a/a2a-protocol";
import logger from "@/logging";
import { A2ATaskModel } from "@/models";
import type { A2ATask } from "@/types";
import type { A2AAttachment } from "@/types/a2a-attachment";

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
  /** Persist the caller's durable task association before execution starts. */
  onTaskCreated?: (taskId: string) => Promise<void>;
}): Promise<A2ATask> {
  const response = await (await taskManager.get()).sendMessage({
    actor: params.actor,
    agentId: params.agentId,
    request: {
      message: {
        messageId: randomUUID(),
        role: A2AProtocolRole.User,
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

/**
 * Cancel every task a user still has in progress, such as their Agent Runtime
 * runs, when the user may no longer act. A task that cannot be canceled is
 * logged and skipped, so the caller's own change still goes through.
 */
export async function cancelUnfinishedTasksOfUser(params: {
  userId: string;
  organizationId: string;
  statusReason: string;
}): Promise<void> {
  const tasks = await A2ATaskModel.findUnfinishedByActor({
    actorKind: "user",
    actorId: params.userId,
  });
  if (tasks.length === 0) return;
  const manager = await taskManager.get();
  for (const task of tasks) {
    if (!task.agentId) continue;
    try {
      await manager.cancelTask({
        actor: {
          kind: "user",
          id: params.userId,
          organizationId: params.organizationId,
        },
        agentId: task.agentId,
        request: { id: task.id },
        statusReason: params.statusReason,
      });
    } catch (error) {
      logger.warn(
        { err: error, taskId: task.id, userId: params.userId },
        "Could not cancel a task of a user who may no longer act",
      );
    }
  }
}

// === Internal helpers ===

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
