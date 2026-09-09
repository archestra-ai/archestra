import type { A2AActor } from "@/agents/a2a/a2a-base";
import logger from "@/logging";
import { AgentRunModel, AgentWorkspaceModel } from "@/models";
import { ApiError } from "@/types";
import { resolveAgentRuntimeBackendDriver } from "./backends";
import { cleanupAgentRun } from "./pod-run";

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
    throw new ApiError(404, "Workspace not found");
  const workspace = await AgentWorkspaceModel.findByWorkloadName(
    run.workloadName,
  );
  if (!workspace) throw new ApiError(404, "Workspace not found");
  if (workspace.state === "deleted")
    return { previousState: workspace.state, state: "deleted" as const };
  // An old task ID must not tear down a newer turn in the same workspace.
  if (
    workspace.activeTaskId ||
    !["idle", "suspended", "deleting"].includes(workspace.state)
  ) {
    throw new ApiError(
      409,
      "Stop the active run and wait for its transcript to be saved before deleting the workspace",
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
    throw new ApiError(409, "Workspace lifecycle changed; retry deletion");
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
      "Workspace deletion is pending automatic retry; retrying this request is safe",
    );
  }
  return { previousState: workspace.state, state: "deleted" as const };
}
