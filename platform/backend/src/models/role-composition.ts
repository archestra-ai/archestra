// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { Permissions, Resource } from "@archestra/shared";
import { and, eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import MemberModel from "./member";
import OrganizationRoleModel from "./organization-role";
import TeamModel from "./team";

export default class RoleCompositionModel {
  static async getRoleHolders(params: {
    roleIdentifier: string;
    organizationId: string;
  }) {
    return db
      .select({ userId: schema.membersTable.userId })
      .from(schema.membersTable)
      .where(
        and(
          eq(schema.membersTable.organizationId, params.organizationId),
          sql`(${params.roleIdentifier} = ANY(string_to_array(${schema.membersTable.role}, ',')) OR ${schema.membersTable.userId} IN (
        WITH RECURSIVE granting_teams(id) AS (
          SELECT id FROM team WHERE organization_id = ${params.organizationId} AND ${params.roleIdentifier} = ANY(roles)
          UNION
          SELECT t.id FROM team t INNER JOIN granting_teams parent ON t.parent_team_id = parent.id WHERE t.organization_id = ${params.organizationId}
        ) SELECT user_id FROM team_member WHERE team_id IN (SELECT id FROM granting_teams)
      ))`,
        ),
      );
  }

  static async getTeamRoles(params: {
    teamId: string;
    organizationId: string;
  }): Promise<string[]> {
    const teams = await db
      .select({ roles: schema.teamsTable.roles })
      .from(schema.teamsTable)
      .where(
        and(
          eq(schema.teamsTable.organizationId, params.organizationId),
          sql`${schema.teamsTable.id} IN (
        WITH RECURSIVE ancestors(id, parent_team_id) AS (
          SELECT id, parent_team_id FROM team WHERE id = ${params.teamId} AND organization_id = ${params.organizationId}
          UNION
          SELECT t.id, t.parent_team_id FROM team t INNER JOIN ancestors a ON t.id = a.parent_team_id WHERE t.organization_id = ${params.organizationId}
        ) SELECT id FROM ancestors
      )`,
        ),
      );
    return [...new Set(teams.flatMap((team) => team.roles))];
  }

  static async getUserSources(params: {
    userId: string;
    organizationId: string;
  }) {
    const member = await MemberModel.getByUserId(
      params.userId,
      params.organizationId,
    );
    if (!member) return [];
    const teams = await db
      .select({
        id: schema.teamsTable.id,
        name: schema.teamsTable.name,
        roles: schema.teamsTable.roles,
      })
      .from(schema.teamsTable)
      .where(
        and(
          eq(schema.teamsTable.organizationId, params.organizationId),
          TeamModel.effectiveMembershipCondition({
            userId: params.userId,
            teamIdColumn: schema.teamsTable.id,
          }),
        ),
      );
    const assignments = [
      ...[...new Set(member.role.split(","))].map((role) => ({
        role: role.trim(),
        team: null as { id: string; name: string } | null,
      })),
      ...teams.flatMap((team) =>
        [...new Set(team.roles)].map((role) => ({
          role,
          team: { id: team.id, name: team.name },
        })),
      ),
    ].filter((source) => source.role);
    const permissions = await OrganizationRoleModel.getPermissionsBatch({
      identifiers: assignments.map((source) => source.role),
      organizationId: params.organizationId,
    });
    return assignments.map((source) => ({
      ...source,
      permissions: permissions[source.role] ?? {},
    }));
  }

  static async getUserPermissions(params: {
    userId: string;
    organizationId: string;
  }): Promise<Permissions> {
    const sources = await RoleCompositionModel.getUserSources(params);
    return RoleCompositionModel.mergePermissions(
      sources.map((source) => source.permissions),
    );
  }

  static mergePermissions(grants: Permissions[]): Permissions {
    const result: Permissions = {};
    for (const grant of grants) {
      for (const [resource, actions] of Object.entries(grant)) {
        const key = resource as Resource;
        result[key] = [...new Set([...(result[key] ?? []), ...actions])];
      }
    }
    return result;
  }
}
