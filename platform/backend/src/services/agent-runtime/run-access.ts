// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { actorFromUserId } from "@/auth/service-account-user-id";
import ServiceAccountModel from "@/models/service-account";
import { ResourcePermissions } from "@/services/resource-permissions";

type RunActor = {
  organizationId: string;
  agentId: string;
  actorKind: string;
  actorId: string;
};
type RunViewer = { organizationId: string; userId: string };

/** Terminal access lends the actor's credentials, not just its output. */
export function mayAttachAgentRun(
  run: RunActor,
  viewer: RunViewer,
): Promise<boolean> {
  return createAgentRunAccessChecker(viewer)(run);
}

/** Request-local answers: repeated runs must not repeat account/Agent lookups. */
export function createAgentRunAccessChecker(viewer: RunViewer) {
  const actor = actorFromUserId(viewer.userId);
  const accountAccess = new Map<string, Promise<boolean>>();
  const agentAccess = new Map<string, Promise<boolean>>();
  return async (run: RunActor): Promise<boolean> => {
    if (run.organizationId !== viewer.organizationId) return false;
    if (actor.kind === run.actorKind && actor.id === run.actorId) return true;
    // Never lend another person's credentials, even to an administrator.
    if (actor.kind !== "user" || run.actorKind !== "serviceAccount")
      return false;
    let accountAllowed = accountAccess.get(run.actorId);
    if (!accountAllowed) {
      accountAllowed = mayManageAccount(run.actorId, viewer);
      accountAccess.set(run.actorId, accountAllowed);
    }
    if (!(await accountAllowed)) return false;
    let agentAllowed = agentAccess.get(run.agentId);
    if (!agentAllowed) {
      agentAllowed = ResourcePermissions.allows({
        ...viewer,
        resource: "agent",
        scope: run.agentId,
        action: "use",
      });
      agentAccess.set(run.agentId, agentAllowed);
    }
    return agentAllowed;
  };
}

async function mayManageAccount(
  accountId: string,
  viewer: RunViewer,
): Promise<boolean> {
  const account = await ServiceAccountModel.findAccount(
    accountId,
    viewer.organizationId,
  );
  if (!account || account.disabled) return false;
  // Account update is also the permission required to mint its tokens.
  return ResourcePermissions.allows({
    ...viewer,
    resource: "serviceAccount",
    scope: account.id,
    action: "update",
  });
}
