import { A2ATaskModel } from "@/models";
import type { A2ATaskFailure } from "@/types/a2a-task";
import {
  type A2AProtocolMessage,
  A2AProtocolRole,
  A2AProtocolTaskState,
} from "./a2a-protocol";
import { a2aTaskRunService } from "./a2a-task-run-service";

/**
 * CAS a running task to FAILED with its terminal event; a no-op when the task
 * is already settled. Lives outside A2AManager so the Agent Runtime can record
 * a launch failure before its cleanup becomes visible to the reconciler.
 */
export async function settleFailedA2ATask(params: {
  taskId: string;
  contextId: string;
  statusReason: string;
  /** Machine-readable classification, recorded for Agent Runtime runs. */
  failure?: A2ATaskFailure;
}): Promise<void> {
  await A2ATaskModel.transitionStateWithEvent({
    id: params.taskId,
    to: A2AProtocolTaskState.Failed,
    allowedFrom: [A2AProtocolTaskState.Submitted, A2AProtocolTaskState.Working],
    statusReason: params.statusReason,
    failure: params.failure,
    eventPayload: {
      statusUpdate: {
        taskId: params.taskId,
        contextId: params.contextId,
        status: {
          state: A2AProtocolTaskState.Failed,
          // Stream followers get the same diagnostics GetTask serves.
          message: buildStatusReasonMessage({
            taskId: params.taskId,
            contextId: params.contextId,
            reason: params.statusReason,
          }),
        },
      },
    },
  });

  // Inside the helper rather than at its call sites: a failure can settle a
  // task from several escape paths, and a parked subscriber must learn about
  // every one of them without waiting out its fallback interval.
  a2aTaskRunService.wakeSubscribers(params.taskId);
}

export function buildStatusReasonMessage(params: {
  taskId: string;
  contextId: string;
  reason: string;
}): A2AProtocolMessage {
  return {
    messageId: `${params.taskId}-status`,
    contextId: params.contextId,
    taskId: params.taskId,
    role: A2AProtocolRole.Agent,
    parts: [{ text: params.reason }],
  };
}
