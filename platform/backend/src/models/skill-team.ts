import { and, eq, inArray, sql } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import type { ResourceVisibilityScope } from "@/types/visibility";

/**
 * Team assignments and scope-based access for skills.
 *
 * Mirrors {@link AgentTeamModel}: a skill is accessible when it is org-scoped,
 * authored by the user (personal scope), or team-scoped and assigned to one of
 * the user's teams. Skill admins bypass these checks.
 */
class SkillTeamModel {
  /**
   * Skill IDs a user can access within an organization: org-scoped skills,
   * their own personal skills, and team-scoped skills assigned to one of their
   * teams. Without a `userId` (org/team-token sessions) only org-scoped skills
   * are returned.
   *
   * Admins bypass scope filtering entirely, so callers should skip this for
   * them rather than passing a flag.
   */
  static async getUserAccessibleSkillIds(params: {
    organizationId: string;
    userId?: string;
  }): Promise<string[]> {
    const { organizationId, userId } = params;
    if (userId === undefined) {
      const result = await db.execute<{ id: string }>(sql`
        SELECT id FROM skills
        WHERE scope = 'org' AND organization_id = ${organizationId}
      `);
      return result.rows.map((r) => r.id);
    }

    const result = await db.execute<{ id: string }>(sql`
      SELECT id FROM skills
        WHERE scope = 'org' AND organization_id = ${organizationId}
      UNION
      SELECT id FROM skills
        WHERE author_id = ${userId} AND scope = 'personal'
          AND organization_id = ${organizationId}
      UNION
      SELECT st.skill_id AS id
        FROM skill_team st
        INNER JOIN skills s ON st.skill_id = s.id
        INNER JOIN team_member tm ON st.team_id = tm.team_id
        WHERE tm.user_id = ${userId} AND s.scope = 'team'
          AND s.organization_id = ${organizationId}
    `);
    return result.rows.map((r) => r.id);
  }

  /**
   * Whether a user can access a specific skill within an organization. A skill
   * from another organization is never accessible. Admins always can; otherwise
   * org → all, personal → author only, team → member of an assigned team.
   * Without a `userId` (org/team-token sessions) only org-scoped skills are
   * accessible.
   *
   * Takes the already-loaded skill row — every caller resolves the skill
   * before checking access, so there is no need to re-fetch it here.
   */
  static async userHasSkillAccess(params: {
    organizationId: string;
    userId?: string;
    skill: {
      id: string;
      organizationId: string;
      scope: ResourceVisibilityScope;
      authorId: string | null;
    };
    isSkillAdmin: boolean;
  }): Promise<boolean> {
    const { skill, organizationId, userId } = params;
    if (skill.organizationId !== organizationId) return false;
    if (params.isSkillAdmin) return true;

    switch (skill.scope) {
      case "org":
        return true;
      case "personal":
        return userId !== undefined && skill.authorId === userId;
      case "team": {
        if (userId === undefined) return false;
        const [match] = await db
          .select({ teamId: schema.skillTeamsTable.teamId })
          .from(schema.skillTeamsTable)
          .innerJoin(
            schema.teamMembersTable,
            eq(schema.skillTeamsTable.teamId, schema.teamMembersTable.teamId),
          )
          .where(
            and(
              eq(schema.skillTeamsTable.skillId, skill.id),
              eq(schema.teamMembersTable.userId, userId),
            ),
          )
          .limit(1);
        return match !== undefined;
      }
      default:
        return false;
    }
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
