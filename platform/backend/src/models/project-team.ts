import { eq, inArray } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";

class ProjectTeamModel {
  static async getTeamDetailsForProject(
    projectId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const rows = await db
      .select({
        id: schema.projectTeamsTable.teamId,
        name: schema.teamsTable.name,
      })
      .from(schema.projectTeamsTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.projectTeamsTable.teamId, schema.teamsTable.id),
      )
      .where(eq(schema.projectTeamsTable.projectId, projectId));

    return rows;
  }

  static async getTeamDetailsForProjects(
    projectIds: string[],
  ): Promise<Map<string, Array<{ id: string; name: string }>>> {
    const map = new Map<string, Array<{ id: string; name: string }>>();
    if (projectIds.length === 0) return map;

    const rows = await db
      .select({
        projectId: schema.projectTeamsTable.projectId,
        id: schema.projectTeamsTable.teamId,
        name: schema.teamsTable.name,
      })
      .from(schema.projectTeamsTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.projectTeamsTable.teamId, schema.teamsTable.id),
      )
      .where(inArray(schema.projectTeamsTable.projectId, projectIds));

    for (const row of rows) {
      const teams = map.get(row.projectId) ?? [];
      teams.push({ id: row.id, name: row.name });
      map.set(row.projectId, teams);
    }

    return map;
  }

  static async syncProjectTeams(
    projectId: string,
    teamIds: string[],
  ): Promise<void> {
    await withDbTransaction(async (tx) => {
      await tx
        .delete(schema.projectTeamsTable)
        .where(eq(schema.projectTeamsTable.projectId, projectId));

      if (teamIds.length > 0) {
        await tx.insert(schema.projectTeamsTable).values(
          teamIds.map((teamId) => ({
            projectId,
            teamId,
          })),
        );
      }
    });
  }
}

export default ProjectTeamModel;
