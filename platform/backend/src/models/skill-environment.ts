import { eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";

/**
 * Environment assignments for skills. A skill with no assignments is available
 * to agents in every environment; a skill with assignments is visible only to
 * agents whose environment is one of them (see
 * `skillInEnvironmentPredicate` / `skillVisibleInEnvironment`). Mirrors
 * {@link SkillTeamModel}. Writes go through `SkillModel.createWithFiles` /
 * `updateWithFiles` so they stay atomic with the skill row.
 */
class SkillEnvironmentModel {
  /** Environment IDs assigned to several skills in one query (no N+1). */
  static async getEnvironmentIdsForSkills(
    skillIds: string[],
  ): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    for (const id of skillIds) {
      map.set(id, []);
    }
    if (skillIds.length === 0) return map;

    const rows = await db
      .select({
        skillId: schema.skillEnvironmentsTable.skillId,
        environmentId: schema.skillEnvironmentsTable.environmentId,
      })
      .from(schema.skillEnvironmentsTable)
      .where(inArray(schema.skillEnvironmentsTable.skillId, skillIds));

    for (const { skillId, environmentId } of rows) {
      map.get(skillId)?.push(environmentId);
    }
    return map;
  }

  /** Environment details (id + name) for several skills in one query (no N+1). */
  static async getEnvironmentDetailsForSkills(
    skillIds: string[],
  ): Promise<Map<string, Array<{ id: string; name: string }>>> {
    const map = new Map<string, Array<{ id: string; name: string }>>();
    for (const id of skillIds) {
      map.set(id, []);
    }
    if (skillIds.length === 0) return map;

    const rows = await db
      .select({
        skillId: schema.skillEnvironmentsTable.skillId,
        environmentId: schema.skillEnvironmentsTable.environmentId,
        environmentName: schema.environmentsTable.name,
      })
      .from(schema.skillEnvironmentsTable)
      .innerJoin(
        schema.environmentsTable,
        eq(
          schema.skillEnvironmentsTable.environmentId,
          schema.environmentsTable.id,
        ),
      )
      .where(inArray(schema.skillEnvironmentsTable.skillId, skillIds));

    for (const { skillId, environmentId, environmentName } of rows) {
      map.get(skillId)?.push({ id: environmentId, name: environmentName });
    }
    return map;
  }
}

export default SkillEnvironmentModel;
