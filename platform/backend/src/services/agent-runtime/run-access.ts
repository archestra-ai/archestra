// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { actorFromUserId } from "@/auth/service-account-user-id";
import ServiceAccountModel from "@/models/service-account";
import { ResourcePermissions } from "@/services/resource-permissions";

/** Terminal access lends the actor's credentials, not just its output. */
export async function mayAttachAgentRun(
  run: {
    organizationId: string;
    agentId: string;
    actorKind: string;
    actorId: string;
  },
  viewer: { organizationId: string; userId: string },
): Promise<boolean> {
  if (run.organizationId !== viewer.organizationId) return false;
  const actor = actorFromUserId(viewer.userId);
  if (actor.kind === run.actorKind && actor.id === run.actorId) return true;
  // Never lend another person's credentials, even to an administrator.
  if (actor.kind !== "user" || run.actorKind !== "serviceAccount") return false;
  const account = await ServiceAccountModel.findAccount(
    run.actorId,
    viewer.organizationId,
  );
  if (!account || account.disabled) return false;
  // Account update is also the permission required to mint its tokens.
  const context = {
    organizationId: viewer.organizationId,
    userId: viewer.userId,
  };
  return (
    (await ResourcePermissions.allows({
      ...context,
      resource: "serviceAccount",
      scope: account.id,
      action: "update",
    })) &&
    (await ResourcePermissions.allows({
      ...context,
      resource: "agent",
      scope: run.agentId,
      action: "use",
    }))
  );
}
