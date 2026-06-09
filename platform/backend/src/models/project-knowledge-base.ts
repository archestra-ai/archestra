import { eq, inArray } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";

class ProjectKnowledgeBaseModel {
  static async getKnowledgeBasesForProject(projectId: string): Promise<
    Array<{
      id: string;
      name: string;
      description: string | null;
    }>
  > {
    const rows = await db
      .select({
        id: schema.knowledgeBasesTable.id,
        name: schema.knowledgeBasesTable.name,
        description: schema.knowledgeBasesTable.description,
      })
      .from(schema.projectKnowledgeBasesTable)
      .innerJoin(
        schema.knowledgeBasesTable,
        eq(
          schema.projectKnowledgeBasesTable.knowledgeBaseId,
          schema.knowledgeBasesTable.id,
        ),
      )
      .where(eq(schema.projectKnowledgeBasesTable.projectId, projectId));

    return rows;
  }

  static async getKnowledgeBasesForProjects(projectIds: string[]): Promise<
    Map<
      string,
      Array<{
        id: string;
        name: string;
        description: string | null;
      }>
    >
  > {
    const map = new Map<
      string,
      Array<{ id: string; name: string; description: string | null }>
    >();
    if (projectIds.length === 0) return map;

    const rows = await db
      .select({
        projectId: schema.projectKnowledgeBasesTable.projectId,
        id: schema.knowledgeBasesTable.id,
        name: schema.knowledgeBasesTable.name,
        description: schema.knowledgeBasesTable.description,
      })
      .from(schema.projectKnowledgeBasesTable)
      .innerJoin(
        schema.knowledgeBasesTable,
        eq(
          schema.projectKnowledgeBasesTable.knowledgeBaseId,
          schema.knowledgeBasesTable.id,
        ),
      )
      .where(inArray(schema.projectKnowledgeBasesTable.projectId, projectIds));

    for (const row of rows) {
      const knowledgeBases = map.get(row.projectId) ?? [];
      knowledgeBases.push({
        id: row.id,
        name: row.name,
        description: row.description,
      });
      map.set(row.projectId, knowledgeBases);
    }

    return map;
  }

  static async syncForProject(
    projectId: string,
    knowledgeBaseIds: string[],
  ): Promise<void> {
    await withDbTransaction(async (tx) => {
      await tx
        .delete(schema.projectKnowledgeBasesTable)
        .where(eq(schema.projectKnowledgeBasesTable.projectId, projectId));

      if (knowledgeBaseIds.length > 0) {
        await tx.insert(schema.projectKnowledgeBasesTable).values(
          knowledgeBaseIds.map((knowledgeBaseId) => ({
            projectId,
            knowledgeBaseId,
          })),
        );
      }
    });
  }
}

export default ProjectKnowledgeBaseModel;
