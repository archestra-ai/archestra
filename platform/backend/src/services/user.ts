import type { Permissions } from "@archestra/shared";
import { MemberModel, OrganizationRoleModel } from "@/models";
import { ApiError } from "@/types";

export async function getUserPermissions(params: {
  userId: string;
  organizationId: string;
}): Promise<Permissions> {
  const member = await MemberModel.getByUserId(
    params.userId,
    params.organizationId,
  );

  // TODO: this should be handled by MemberModel.getByUserId.
  // Do not touching it now because getByUserId is used all over the codebase now.
  if (!member || !member.role) {
    throw new ApiError(404, "User is not a member of any organization");
  }

  return OrganizationRoleModel.getPermissions(
    member.role,
    params.organizationId,
  );
}

// listImpersonableUsers list users which could be impersonated by the current user
export async function listImpersonableUsers(params: {
  organizationId: string;
  currentUserId: string;
}) {
  const members = await MemberModel.findAllByOrganization(
    params.organizationId,
  );
  // Exclude the caller only. System-level `user.role = "admin"` is synced
  // onto anyone whose org role grants `member:impersonate`, so filtering
  // those out made it impossible to view-as another admin — the role
  // debugger's actual job. better-auth is configured to allow it.
  return members
    .filter((m) => m.id !== params.currentUserId)
    .map(({ systemRole: _systemRole, ...rest }) => rest);
}
