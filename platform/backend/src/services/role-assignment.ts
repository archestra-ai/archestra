// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { getPermissionsForUserContext } from "@/auth/utils";
import OrganizationRoleModel from "@/models/organization-role";
import RoleCompositionModel from "@/models/role-composition";
import TeamModel from "@/models/team";
import { ApiError } from "@/types";
import { ResourcePermissions } from "./resource-permissions";

/** Team membership administration delegates the team's existing access. */
export async function validateNewTeamMembership(params: {
  teamId: string;
  organizationId: string;
  userId: string;
}) {
  if (await TeamModel.isUserTeamAdmin(params.teamId, params.userId)) return;
  await validateInheritedTeamRoles(params);
}

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
    await ResourcePermissions.validateSubjectAssignment({
      ...params,
      subjects: [{ type: "role", id: role.id }],
    });
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
  const teams = await RoleCompositionModel.getTeamSources({
    teamId: params.teamId,
    organizationId: params.organizationId,
  });
  await ResourcePermissions.validateSubjectAssignment({
    ...params,
    subjects: teams.map((team) => ({ type: "team", id: team.id })),
  });
  await validateTeamRoles({
    ...params,
    roles: [...new Set(teams.flatMap((team) => team.roles))],
  });
}
