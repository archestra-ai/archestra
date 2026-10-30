import type { A2AActor } from "@/agents/a2a/a2a-base";
import logger from "@/logging";
import { AgentRunModel, AgentWorkspaceModel } from "@/models";
import { type AgentWorkspaceState, ApiError } from "@/types";
import { resolveAgentRuntimeBackendDriver } from "./backends";
import { cleanupAgentRun } from "./pod-run";

/**
 * Deletes a finished run's saved files ahead of the run itself, so deleting a
 * run frees its volume now rather than at its retention deadline. Returns the
 * files' state afterwards, or null for a run that never had any.
 */
export async function deleteFinishedRunWorkspace(params: {
  actor: A2AActor;
  run: { taskId: string; workloadName: string };
}): Promise<AgentWorkspaceState | null> {
  const workspace = await AgentWorkspaceModel.findByWorkloadName(
    params.run.workloadName,
  );
  if (!workspace) return null;
  if (workspace.state === "deleted") return workspace.state;
  // Files a turn still holds, or that are being suspended, would outlive the
  // run until their retention deadline, so the run waits for them instead.
  if (
    workspace.activeTaskId ||
    !DELETABLE_WORKSPACE_STATES.includes(workspace.state)
  )
    throw new ApiError(
      409,
      "This run's saved files are still being put away. Try deleting it again in a minute.",
    );
  try {
    const { state } = await deleteAgentWorkspace({
      actor: params.actor,
      taskId: params.run.taskId,
    });
    return state;
  } catch (error) {
    // The run is kept, so a retry, and the reconciler, still find its
    // credentials to revoke.
    if (error instanceof ApiError && error.statusCode >= 500)
      throw new ApiError(
        error.statusCode,
        "Couldn't finish deleting this run's saved files. Try deleting it again.",
      );
    throw error;
  }
}

/** Deletion is intentionally separate from cancellation: files are not recoverable. */
export async function deleteAgentWorkspace(params: {
  actor: A2AActor;
  taskId: string;
}) {
  const run = await AgentRunModel.findByTaskId(params.taskId);
  if (
    !run ||
    run.organizationId !== params.actor.organizationId ||
    run.actorKind !== params.actor.kind ||
    run.actorId !== params.actor.id
  )
    throw new ApiError(404, "Saved run not found");
  const workspace = await AgentWorkspaceModel.findByWorkloadName(
    run.workloadName,
  );
  if (!workspace) throw new ApiError(404, "Saved run not found");
  if (workspace.state === "deleted")
    return { previousState: workspace.state, state: "deleted" as const };
  // An old task ID must not tear down a newer turn in the same workspace.
  if (
    workspace.activeTaskId ||
    !DELETABLE_WORKSPACE_STATES.includes(workspace.state)
  ) {
    throw new ApiError(
      409,
      "Stop the active run and wait for its history to be saved before deleting its files",
    );
  }
  if (
    workspace.state !== "deleting" &&
    !(await AgentWorkspaceModel.transition({
      id: workspace.id,
      from: workspace.state,
      to: "deleting",
    }))
  )
    throw new ApiError(
      409,
      "The Agent changed state; retry deleting its files",
    );
  // Persist intent first. A control-plane restart or API failure is retried by
  // the reconciler; claiming a continuation can no longer race this deletion.
  try {
    const backend = resolveAgentRuntimeBackendDriver(workspace.backend);
    const latestRun = await AgentRunModel.findByTaskId(workspace.lastTaskId);
    if (latestRun?.virtualApiKeyId)
      await cleanupAgentRun(latestRun, { requireTranscript: true });
    else if (latestRun) await backend.releaseRun(latestRun);
    await backend.deleteWorkspace(workspace);
    await AgentWorkspaceModel.transition({
      id: workspace.id,
      from: "deleting",
      to: "deleted",
    });
  } catch {
    // All cleanup operations tolerate already-absent resources. Keep the
    // durable intent even when only part of the infrastructure was removed.
    logger.warn(
      { workspaceId: workspace.id },
      "Workspace deletion incomplete; reconciliation will retry cleanup",
    );
    throw new ApiError(
      500,
      "Saved file deletion will retry automatically; you can also retry this request",
    );
  }
  return { previousState: workspace.state, state: "deleted" as const };
}

const DELETABLE_WORKSPACE_STATES: readonly string[] = [
  "idle",
  "suspended",
  "deleting",
];
