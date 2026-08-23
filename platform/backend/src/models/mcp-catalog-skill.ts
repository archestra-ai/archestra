import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import type { McpCatalogSkill, McpSkillMetadataInput } from "@/types";

class McpCatalogSkillModel {
  static async beginRefresh(catalogId: string): Promise<number | null> {
    const [catalog] = await db
      .update(schema.internalMcpCatalogTable)
      .set({
        skillsRefreshGeneration: sql`${schema.internalMcpCatalogTable.skillsRefreshGeneration} + 1`,
      })
      .where(eq(schema.internalMcpCatalogTable.id, catalogId))
      .returning({
        generation: schema.internalMcpCatalogTable.skillsRefreshGeneration,
      });
    return catalog?.generation ?? null;
  }

  static async syncCatalog(params: {
    catalogId: string;
    generation: number;
    skills: McpSkillMetadataInput[];
  }): Promise<boolean> {
    return withDbTransaction(async (tx) => {
      const [catalog] = await tx
        .select({
          generation: schema.internalMcpCatalogTable.skillsRefreshGeneration,
        })
        .from(schema.internalMcpCatalogTable)
        .where(eq(schema.internalMcpCatalogTable.id, params.catalogId))
        .for("update");
      if (!catalog || catalog.generation !== params.generation) return false;

      const uris = params.skills.map((skill) => skill.uri);
      if (uris.length === 0) {
        await tx
          .delete(schema.mcpCatalogSkillsTable)
          .where(eq(schema.mcpCatalogSkillsTable.catalogId, params.catalogId));
        return true;
      }

      await tx
        .delete(schema.mcpCatalogSkillsTable)
        .where(
          and(
            eq(schema.mcpCatalogSkillsTable.catalogId, params.catalogId),
            notInArray(schema.mcpCatalogSkillsTable.uri, uris),
          ),
        );

      for (const skill of params.skills) {
        await tx
          .insert(schema.mcpCatalogSkillsTable)
          .values({ ...skill, catalogId: params.catalogId })
          .onConflictDoUpdate({
            target: [
              schema.mcpCatalogSkillsTable.catalogId,
              schema.mcpCatalogSkillsTable.uri,
            ],
            set: {
              name: skill.name,
              description: skill.description,
              frontmatter: skill.frontmatter,
              resources: skill.resources,
              updatedAt: new Date(),
            },
          });
      }
      return true;
    });
  }

  static async findById(id: string): Promise<McpCatalogSkill | null> {
    const [skill] = await db
      .select()
      .from(schema.mcpCatalogSkillsTable)
      .where(eq(schema.mcpCatalogSkillsTable.id, id))
      .limit(1);
    return skill ?? null;
  }

  static async findByCatalogIdAndUri(params: {
    catalogId: string;
    uri: string;
  }): Promise<McpCatalogSkill | null> {
    const [skill] = await db
      .select()
      .from(schema.mcpCatalogSkillsTable)
      .where(
        and(
          eq(schema.mcpCatalogSkillsTable.catalogId, params.catalogId),
          eq(schema.mcpCatalogSkillsTable.uri, params.uri),
        ),
      )
      .limit(1);
    return skill ?? null;
  }

  static async findByCatalogIds(
    catalogIds: string[],
  ): Promise<McpCatalogSkill[]> {
    if (catalogIds.length === 0) return [];
    return db
      .select()
      .from(schema.mcpCatalogSkillsTable)
      .where(inArray(schema.mcpCatalogSkillsTable.catalogId, catalogIds));
  }
}

export default McpCatalogSkillModel;
