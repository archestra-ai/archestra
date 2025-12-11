import type { Permissions } from "@shared";
import logger from "@/logging";
import MemberModel from "@/models/member";
import OrganizationRoleModel from "@/models/organization-role.ee";

export async function getUserPermissions(
  userId: string,
  organizationId: string,
): Promise<Permissions> {
  logger.debug(
    { userId, organizationId },
    "UserModel.getUserPermissions: fetching permissions",
  );
  // Get user's member record to find their role
  const memberRecord = await MemberModel.getByUserId(userId, organizationId);

  if (!memberRecord) {
    logger.debug(
      { userId, organizationId },
      "UserModel.getUserPermissions: no member record found",
    );
    return {};
  }

  const permissions = await OrganizationRoleModel.getPermissions(
    memberRecord.role,
    organizationId,
  );
  logger.debug(
    { userId, organizationId, role: memberRecord.role },
    "UserModel.getUserPermissions: completed",
  );
  return permissions;
}
