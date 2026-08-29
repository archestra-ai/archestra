import { randomUUID } from "node:crypto";
import type { A2AActor } from "@/agents/a2a/a2a-base";
import { buildAttachmentsMessageParts } from "@/agents/a2a/a2a-helper";
import type { A2AManager, A2ASystemParams } from "@/agents/a2a/a2a-manager";
import {
  A2AProtocolRole,
  type A2AProtocolTask,
} from "@/agents/a2a/a2a-protocol";
import type { A2AAttachment } from "@/agents/a2a-executor";
import { A2ATaskModel } from "@/models";
import type { A2ATask } from "@/types";
import { persistAgentExecutionInputs } from "./input-files";

/**
 * Launch one durable Agent task and return its handle before the work settles.
 *
 * Runtime selection remains inside A2AManager: an Agent with Background
 * execution uses its deployment; any other Agent uses the foreground loop.
 * Keeping this entry point independent from MCP and HTTP lets every invocation
 * surface share that rule.
 */
export async function startDetachedAgentTask(params: {
  actor: A2AActor;
  agentId: string;
  message: string;
  attachments?: A2AAttachment[];
  systemParams?: A2ASystemParams;
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
    onDetachedTaskRun:
      params.attachments && params.attachments.length > 0
        ? async ({ taskId }) => {
            await persistAgentExecutionInputs({
              taskId,
              organizationId: params.actor.organizationId,
              uploadedByUserId:
                params.actor.kind === "user" ? params.actor.id : null,
              attachments: params.attachments ?? [],
            });
          }
        : undefined,
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
