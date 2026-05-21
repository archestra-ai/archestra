import { and, asc, count, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type { SkillFile } from "@/types";

class SkillFileModel {
  static async findBySkillId(skillId: string): Promise<SkillFile[]> {
    return await db
      .select()
      .from(schema.skillFilesTable)
      .where(eq(schema.skillFilesTable.skillId, skillId))
      .orderBy(asc(schema.skillFilesTable.path));
  }

  static async findBySkillAndPath(
    skillId: string,
    path: string,
  ): Promise<SkillFile | null> {
    const [result] = await db
      .select()
      .from(schema.skillFilesTable)
      .where(
        and(
          eq(schema.skillFilesTable.skillId, skillId),
          eq(schema.skillFilesTable.path, path),
        ),
      );

    return result ?? null;
  }

  /** Count resource files per skill, keyed by skill id. */
  static async countBySkillIds(
    skillIds: string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (skillIds.length === 0) return counts;

    const rows = await db
      .select({
        skillId: schema.skillFilesTable.skillId,
        count: count(),
      })
      .from(schema.skillFilesTable)
      .where(inArray(schema.skillFilesTable.skillId, skillIds))
      .groupBy(schema.skillFilesTable.skillId);

    for (const row of rows) {
      counts.set(row.skillId, row.count);
    }
    return counts;
  }
}

export default SkillFileModel;
