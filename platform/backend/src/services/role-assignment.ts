// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { getPermissionsForUserContext } from "@/auth/utils";
import OrganizationRoleModel from "@/models/organization-role";
import RoleCompositionModel from "@/models/role-composition";
import { ApiError } from "@/types";

export async function validateTeamRoles(params: {
  roles?: string[];
  organizationId: string;
  userId: string;
}) {
  if (!params.roles?.length) return;
  const caller = await getPermissionsForUserContext(params);
  for (const identifier of params.roles) {
    const role = await OrganizationRoleModel.getByIdentifier(
      identifier,
      params.organizationId,
    );
    if (!role) throw new ApiError(400, "Role not found");
    const { valid, missingPermissions } =
      OrganizationRoleModel.validateRolePermissions(caller, role.permission);
    if (!valid)
      throw new ApiError(
        403,
        `You cannot grant permissions you don't have: ${missingPermissions.join(", ")}`,
      );
  }
}

export async function validateInheritedTeamRoles(params: {
  teamId?: string | null;
  organizationId: string;
  userId: string;
}) {
  if (!params.teamId) return;
  const roles = await RoleCompositionModel.getTeamRoles({
    teamId: params.teamId,
    organizationId: params.organizationId,
  });
  await validateTeamRoles({ ...params, roles });
}
