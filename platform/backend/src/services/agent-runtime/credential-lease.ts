import { hasScopedPermission } from "@archestra/shared";
import type { A2AActor } from "@/agents/a2a/a2a-base";
import AgentRunModel from "@/models/agent-run";
import MemberModel from "@/models/member";
import OpenAppaSessionModel from "@/models/openappa-session";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { scopedSessionId } from "@/openappa/actor";
import { ResourcePermissions } from "@/services/resource-permissions";
import { ApiError } from "@/types";
import { runtimeProxySession } from "./proxy-session";
import { runtimeOpenAppaSession } from "./runtime-identity";

/** Leased runtime keys cannot change their caller, Agent, placement, or root. */
export async function assertRuntimeCredentialLease(params: {
  organizationId: string;
  virtualApiKeyId: string;
  agentId: string;
  callerId: string | undefined;
  sessionId: string | undefined;
  parentId: string | undefined;
  enforceSession: boolean;
}): Promise<void> {
  const lease = await AgentRunModel.findRuntimeCredentialLease(params);
  if (
    !lease ||
    (lease.key.scope === "personal" && !lease.key.authorId) ||
    (lease.key.expiresAt && lease.key.expiresAt.getTime() <= Date.now())
  ) {
    throw new ApiError(401, "The credential owner is unavailable");
  }
  const { run, workspace } = lease;
  if (!run) return;
  if (params.agentId !== run.agentId) {
    throw new ApiError(
      401,
      "The runtime credential belongs to a different Agent",
    );
  }
  if (
    !workspace ||
    workspace.expiresAt.getTime() <= Date.now() ||
    workspace.state === "deleted" ||
    workspace.state === "deleting" ||
    workspace.agentId !== run.agentId ||
    workspace.actorKind !== run.actorKind ||
    workspace.actorId !== run.actorId ||
    workspace.runtimeScope !== run.runtimeScope ||
    workspace.backend !== run.backend
  ) {
    throw new ApiError(401, "The runtime credential lease is unavailable");
  }
  const active =
    !run.endedAt &&
    workspace.state === "active" &&
    workspace.activeTaskId === run.taskId;
  if (!active) {
    // Keep identity/expiry for continuation, not spend permission between turns.
    throw new ApiError(401, "The runtime credential has no active turn");
  }
  const credential = runtimeProxySession({
    organizationId: params.organizationId,
    virtualApiKeyId: params.virtualApiKeyId,
    workspaceId: workspace.workloadName,
    actor: {
      kind: run.actorKind,
      id: run.actorId,
      organizationId: run.organizationId,
    },
  });
  const expected = runtimeOpenAppaSession({
    organizationId: params.organizationId,
    workspaceId: workspace.id,
    workloadName: workspace.workloadName,
    actorKind: run.actorKind,
    actorId: run.actorId,
  });
  const callerId = expected.caller_id;
  if (
    !callerId ||
    (params.callerId !== credential.caller_id && params.callerId !== callerId)
  ) {
    throw new ApiError(
      401,
      "The runtime credential caller differs from its issued lease",
    );
  }
  await assertRuntimeKeyPermission({
    organizationId: params.organizationId,
    virtualApiKeyId: params.virtualApiKeyId,
    actor: {
      kind: run.actorKind,
      id: run.actorId,
      organizationId: run.organizationId,
    },
  });
  if (!params.enforceSession) return;
  if (
    params.sessionId === workspace.workloadName ||
    params.sessionId === expected.session_id
  )
    return;
  if (!params.parentId) {
    throw new ApiError(
      401,
      "The runtime credential cannot start another workspace root",
    );
  }
  if (!params.sessionId)
    throw new ApiError(401, "The runtime child session is missing");
  const parentId = params.parentId.startsWith(`${callerId}|`)
    ? params.parentId
    : scopedSessionId(callerId, params.parentId);
  const parent = await OpenAppaSessionModel.familySession({
    organizationId: params.organizationId,
    callerId,
    sessionId: parentId,
  });
  if (
    !parent ||
    (parentId !== expected.session_id &&
      !(await OpenAppaSessionModel.hasAncestor({
        organizationId: params.organizationId,
        callerId,
        sessionId: parentId,
        ancestorSessionId: expected.session_id,
      })))
  ) {
    throw new ApiError(
      401,
      "The runtime child belongs to a different workspace root",
    );
  }
  // Native child creation still requires the actual released spawn binding.
}

/** Read current grants, not the actor's cached role or a retired visibility hint. */
export async function assertRuntimeKeyPermission(params: {
  organizationId: string;
  virtualApiKeyId: string;
  actor: A2AActor;
}): Promise<void> {
  const permission = {
    organizationId: params.organizationId,
    resource: "llmVirtualKey" as const,
    scope: params.virtualApiKeyId,
    action: "use" as const,
  };
  if (
    params.actor.kind === "user" &&
    !(await MemberModel.getByUserId(params.actor.id, params.organizationId))
  ) {
    throw new ApiError(
      403,
      "The runtime actor is no longer a member of this organization",
    );
  }
  const canUse =
    params.actor.kind === "user"
      ? hasScopedPermission({
          grants: (
            await ResourcePermissions.getEffective({
              ...permission,
              userId: params.actor.id,
            })
          ).grants,
          required: permission,
        })
      : await ResourcePermissionPolicyModel.sharedCredentialHasAccess({
          ...permission,
          teamId: params.actor.kind === "team" ? params.actor.id : null,
        });
  if (!canUse)
    throw new ApiError(
      403,
      "The retained runtime credential is no longer permitted for this actor",
    );
}
