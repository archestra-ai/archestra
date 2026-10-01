import { randomUUID } from "node:crypto";
import type { A2AActor } from "@/agents/a2a/a2a-base";
import { AgentRunModel, AgentWorkspaceModel } from "@/models";
import { ApiError } from "@/types";
import {
  type AgentWorkspaceFileRequest,
  AgentWorkspaceFileRequestSchema,
} from "@/types/agent-workspace-file";
import { sanitizeUploadFilename } from "@/utils/upload-filename";
import { resolveAgentRuntimeBackendDriver } from "./backends";
import { AGENT_RUNTIME_ATTACHMENTS_DIR } from "./runtime-contract";

/** Shared owner-only file access for API and MCP callers. Shared run viewers
 * must not gain access to the owner's live filesystem or credentials. */
export async function accessAgentWorkspaceFile(params: {
  actor: A2AActor;
  taskId: string;
  request: AgentWorkspaceFileRequest;
}) {
  const request = AgentWorkspaceFileRequestSchema.parse(params.request);
  const session = await authorizeAgentWorkspaceAccess(params);
  return resolveAgentRuntimeBackendDriver(session.backend).accessWorkspaceFile({
    session,
    request,
  });
}

/** Place a file the owner dropped on the live terminal beside the run's other
 * inputs, outside the Agent's working tree, and return its absolute path. */
export async function stageAgentRunTerminalFile(params: {
  actor: A2AActor;
  taskId: string;
  name: string;
  data: Buffer;
}): Promise<{ path: string }> {
  const session = await authorizeAgentWorkspaceAccess(params);
  // A fresh directory per drop keeps the original name without collisions.
  const path = `${AGENT_RUNTIME_ATTACHMENTS_DIR}/${params.taskId}/terminal/${randomUUID().slice(0, 8)}/${sanitizeUploadFilename(params.name)}`;
  await resolveAgentRuntimeBackendDriver(session.backend).writeRuntimeFile({
    session,
    path,
    data: params.data,
  });
  return { path };
}

/** Run the owner-only workspace gate and return the session behind it.
 *
 * Transfers repeat this for every request rather than trusting a ticket alone,
 * so a resumed chunk revalidates ownership, lifecycle and retention, and keeps
 * extending the workspace's deadline while bytes are still moving.
 */
export async function authorizeAgentWorkspaceAccess(params: {
  actor: A2AActor;
  taskId: string;
}) {
  const session = await AgentRunModel.findByTaskId(params.taskId);
  if (
    !session ||
    session.organizationId !== params.actor.organizationId ||
    session.actorKind !== params.actor.kind ||
    session.actorId !== params.actor.id
  ) {
    throw new ApiError(404, "Workspace not found");
  }
  let workspace = await AgentWorkspaceModel.findByWorkloadName(
    session.workloadName,
  );
  if (
    !workspace ||
    !["active", "idle", "suspended", "resuming"].includes(workspace.state) ||
    workspace.expiresAt.getTime() <= Date.now()
  ) {
    throw new ApiError(
      409,
      "The workspace must be running and retained to access files",
    );
  }
  if (workspace.state === "suspended") {
    await AgentWorkspaceModel.transition({
      id: workspace.id,
      from: "suspended",
      to: "resuming",
    });
    workspace = await AgentWorkspaceModel.findByWorkloadName(
      session.workloadName,
    );
    if (!workspace) throw new ApiError(404, "Workspace not found");
  }
  if (workspace.state === "resuming") {
    // The supervisor only restores the environment. It never starts a model
    // turn for a filesystem operation, and the persisted intent is retryable.
    await resolveAgentRuntimeBackendDriver(session.backend).resumeWorkspace(
      session,
    );
    // Another caller may already have finished this resume. The activity CAS
    // below revalidates the current state and deadline before any file access.
    await AgentWorkspaceModel.finishResume(workspace.id);
  }
  if (!(await AgentWorkspaceModel.recordActivity(workspace.id))) {
    throw new ApiError(
      409,
      "Workspace lifecycle changed; retry after it is resumed",
    );
  }
  return session;
}
