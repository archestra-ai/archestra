import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  like,
  or,
} from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import type { InsertSkill, InsertSkillFile, Skill, UpdateSkill } from "@/types";

class SkillModel {
  static async findByOrganization(params: {
    organizationId: string;
    limit?: number;
    offset?: number;
    search?: string;
    sourceRepo?: string;
    /** When set, restricts results to these skill IDs (scope filtering). */
    accessibleSkillIds?: string[];
  }): Promise<Skill[]> {
    let query = db
      .select()
      .from(schema.skillsTable)
      .where(and(...buildOrgFilters(params)))
      .orderBy(desc(schema.skillsTable.createdAt))
      .$dynamic();

    if (params.limit !== undefined) {
      query = query.limit(params.limit);
    }
    if (params.offset !== undefined) {
      query = query.offset(params.offset);
    }

    return await query;
  }

  static async countByOrganization(params: {
    organizationId: string;
    search?: string;
    sourceRepo?: string;
    accessibleSkillIds?: string[];
  }): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.skillsTable)
      .where(and(...buildOrgFilters(params)));

    return result?.count ?? 0;
  }

  /**
   * Distinct `owner/repo` strings across the org's imported skills, derived
   * from the `source_ref` provenance column (formatted as
   * `owner/repo@ref:path`).
   */
  static async findDistinctSourceRepos(params: {
    organizationId: string;
    /** when set, restricts results to these skill IDs (scope filtering). */
    accessibleSkillIds?: string[];
  }): Promise<string[]> {
    const rows = await db
      .selectDistinct({ sourceRef: schema.skillsTable.sourceRef })
      .from(schema.skillsTable)
      .where(
        and(
          ...buildOrgFilters(params),
          isNotNull(schema.skillsTable.sourceRef),
        ),
      );

    const repos = new Set<string>();
    for (const { sourceRef } of rows) {
      if (!sourceRef) continue;
      const atIdx = sourceRef.indexOf("@");
      const repo = atIdx === -1 ? sourceRef : sourceRef.slice(0, atIdx);
      if (repo) repos.add(repo);
    }
    return [...repos].sort();
  }

  static async findById(id: string): Promise<Skill | null> {
    const [result] = await db
      .select()
      .from(schema.skillsTable)
      .where(eq(schema.skillsTable.id, id));

    return result ?? null;
  }

  static async findByIds(ids: string[]): Promise<Skill[]> {
    if (ids.length === 0) return [];
    return await db
      .select()
      .from(schema.skillsTable)
      .where(inArray(schema.skillsTable.id, ids));
  }

  static async findByName(
    organizationId: string,
    name: string,
  ): Promise<Skill | null> {
    const [result] = await db
      .select()
      .from(schema.skillsTable)
      .where(
        and(
          eq(schema.skillsTable.organizationId, organizationId),
          eq(schema.skillsTable.name, name),
        ),
      );

    return result ?? null;
  }

  /**
   * Create a skill, its bundled resource files, and its team assignments in
   * one transaction.
   *
   * Returns `null` when a skill with the same name already exists in the
   * organization. The insert is atomic (`ON CONFLICT DO NOTHING` on the
   * org+name unique index), so this is race-free against concurrent creates.
   * When `teamIds` is supplied the team rows are inserted in the same
   * transaction, so a failed assignment cannot leave a scoped skill orphaned.
   */
  static async createWithFiles(params: {
    skill: InsertSkill;
    files: Omit<InsertSkillFile, "skillId">[];
    teamIds?: string[];
  }): Promise<Skill | null> {
    return await withDbTransaction(async (tx) => {
      const [skill] = await tx
        .insert(schema.skillsTable)
        .values(params.skill)
        .onConflictDoNothing({
          target: [schema.skillsTable.organizationId, schema.skillsTable.name],
        })
        .returning();

      if (!skill) return null;

      if (params.files.length > 0) {
        await tx
          .insert(schema.skillFilesTable)
          .values(params.files.map((file) => ({ ...file, skillId: skill.id })));
      }

      if (params.teamIds && params.teamIds.length > 0) {
        await tx
          .insert(schema.skillTeamsTable)
          .values(
            params.teamIds.map((teamId) => ({ skillId: skill.id, teamId })),
          );
      }

      return skill;
    });
  }

  /**
   * Update a skill's metadata and replace its resource files.
   *
   * Passing `files` replaces the full set; omitting it leaves files untouched.
   */
  static async updateWithFiles(params: {
    id: string;
    skill: UpdateSkill;
    files?: Omit<InsertSkillFile, "skillId">[];
  }): Promise<Skill | null> {
    return await withDbTransaction(async (tx) => {
      const [skill] = await tx
        .update(schema.skillsTable)
        .set(params.skill)
        .where(eq(schema.skillsTable.id, params.id))
        .returning();

      if (!skill) return null;

      if (params.files !== undefined) {
        await tx
          .delete(schema.skillFilesTable)
          .where(eq(schema.skillFilesTable.skillId, params.id));

        if (params.files.length > 0) {
          await tx
            .insert(schema.skillFilesTable)
            .values(
              params.files.map((file) => ({ ...file, skillId: params.id })),
            );
        }
      }

      return skill;
    });
  }

  static async delete(id: string): Promise<boolean> {
    const rows = await db
      .delete(schema.skillsTable)
      .where(eq(schema.skillsTable.id, id))
      .returning({ id: schema.skillsTable.id });

    return rows.length > 0;
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await db
      .select()
      .from(schema.skillsTable)
      .where(
        and(
          eq(schema.skillsTable.id, id),
          eq(schema.skillsTable.organizationId, organizationId),
        ),
      )
      .limit(1);

    return row ?? null;
  }
}

function buildOrgFilters(params: {
  organizationId: string;
  search?: string;
  sourceRepo?: string;
  accessibleSkillIds?: string[];
}) {
  const normalizedSearch = params.search?.trim();
  const normalizedSourceRepo = params.sourceRepo?.trim();
  return [
    eq(schema.skillsTable.organizationId, params.organizationId),
    ...(params.accessibleSkillIds !== undefined
      ? [inArray(schema.skillsTable.id, params.accessibleSkillIds)]
      : []),
    ...(normalizedSearch
      ? [
          or(
            ilike(schema.skillsTable.name, `%${normalizedSearch}%`),
            ilike(schema.skillsTable.description, `%${normalizedSearch}%`),
          ),
        ]
      : []),
    ...(normalizedSourceRepo
      ? [like(schema.skillsTable.sourceRef, `${normalizedSourceRepo}@%`)]
      : []),
  ];
}

export default SkillModel;
