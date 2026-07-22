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

  /** Fetch all resource files for a set of skills, grouped by skill id. */
  static async findBySkillIds(
    skillIds: string[],
  ): Promise<Map<string, SkillFile[]>> {
    const map = new Map<string, SkillFile[]>();
    if (skillIds.length === 0) return map;

    for (const id of skillIds) map.set(id, []);

    const rows = await db
      .select()
      .from(schema.skillFilesTable)
      .where(inArray(schema.skillFilesTable.skillId, skillIds))
      .orderBy(asc(schema.skillFilesTable.path));

    for (const row of rows) {
      const list = map.get(row.skillId);
      if (list) list.push(row);
    }
    return map;
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
