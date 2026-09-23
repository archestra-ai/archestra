// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { and, eq, inArray } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

/**
 * Grant-based access checks for skills, plus the retired `skill_team`
 * junction's readers that the cutover and the edit forms still use.
 */
class SkillTeamModel {
  /**
   * Skill IDs a user can read within an organization: a grant on the skill, or
   * at `*`, decides. Without a `userId` (org/team-token sessions) only a skill
   * published to the organization at large is returned.
   */
  static async getUserAccessibleSkillIds(params: {
    organizationId: string;
    userId?: string;
  }): Promise<string[]> {
    const { organizationId, userId } = params;
    const rows = await db
      .select({ id: schema.skillsTable.id })
      .from(schema.skillsTable)
      .where(
        and(
          eq(schema.skillsTable.organizationId, organizationId),
          userId === undefined
            ? ResourcePermissionPolicyModel.organizationAccessCondition({
                organizationId,
                resource: "skill",
                scopeColumn: schema.skillsTable.id,
                action: "read",
                legacyCondition: eq(schema.skillsTable.scope, "org"),
              })
            : ResourcePermissionPolicyModel.grantCondition({
                organizationId,
                userId,
                resource: "skill",
                action: "read",
                scopeColumn: schema.skillsTable.id,
              }),
        ),
      );
    return rows.map((row) => row.id);
  }

  /**
   * Whether a user can access a specific skill within an organization. A skill
   * from another organization is never accessible. A user needs a grant on the
   * skill (or at `*`); without a `userId` (org/team-token sessions) only an
   * organization-wide grant counts.
   *
   * Takes the already-loaded skill row — every caller resolves the skill
   * before checking access, so there is no need to re-fetch it here.
   */
  static async userHasSkillAccess(params: {
    organizationId: string;
    userId?: string;
    skill: { id: string; organizationId: string };
    action?: "read" | "use";
  }): Promise<boolean> {
    const { skill, organizationId, userId } = params;
    if (skill.organizationId !== organizationId) return false;
    const action = params.action ?? "read";
    if (userId !== undefined) {
      const [granted] = await db
        .select({ id: schema.skillsTable.id })
        .from(schema.skillsTable)
        .where(
          and(
            eq(schema.skillsTable.id, skill.id),
            ResourcePermissionPolicyModel.grantCondition({
              organizationId,
              userId,
              resource: "skill",
              action,
              scopeColumn: schema.skillsTable.id,
            }),
          ),
        )
        .limit(1);
      return granted !== undefined;
    }

    const policies = await ResourcePermissionPolicyModel.findApplicable({
      organizationId,
      resource: "skill",
      scope: skill.id,
    });
    return policies.some((policy) =>
      ResourcePermissionPolicyModel.isOrganizationWide({
        policy,
        scope: skill.id,
        action,
      }),
    );
  }

  /** Team IDs assigned to a skill. */
  static async getTeamsForSkill(skillId: string): Promise<string[]> {
    const rows = await db
      .select({ teamId: schema.skillTeamsTable.teamId })
      .from(schema.skillTeamsTable)
      .where(eq(schema.skillTeamsTable.skillId, skillId));
    return rows.map((r) => r.teamId);
  }

  /** Team details (id + name) for several skills in one query (no N+1). */
  static async getTeamDetailsForSkills(
    skillIds: string[],
  ): Promise<Map<string, Array<{ id: string; name: string }>>> {
    const map = new Map<string, Array<{ id: string; name: string }>>();
    for (const id of skillIds) {
      map.set(id, []);
    }
    if (skillIds.length === 0) return map;

    const rows = await db
      .select({
        skillId: schema.skillTeamsTable.skillId,
        teamId: schema.skillTeamsTable.teamId,
        teamName: schema.teamsTable.name,
      })
      .from(schema.skillTeamsTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.skillTeamsTable.teamId, schema.teamsTable.id),
      )
      .where(inArray(schema.skillTeamsTable.skillId, skillIds));

    for (const { skillId, teamId, teamName } of rows) {
      map.get(skillId)?.push({ id: teamId, name: teamName });
    }
    return map;
  }

  /** Replace a skill's team assignments with the given set. */
  static async syncSkillTeams(
    skillId: string,
    teamIds: string[],
  ): Promise<void> {
    await withDbTransaction(async (tx) => {
      await tx
        .delete(schema.skillTeamsTable)
        .where(eq(schema.skillTeamsTable.skillId, skillId));

      if (teamIds.length > 0) {
        await tx
          .insert(schema.skillTeamsTable)
          .values(teamIds.map((teamId) => ({ skillId, teamId })));
      }
    });
  }
}

export default SkillTeamModel;
