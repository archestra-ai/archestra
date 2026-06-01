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
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import type { InsertSkill, InsertSkillFile, Skill, UpdateSkill } from "@/types";
import type { ResourceVisibilityScope } from "@/types/visibility";

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
   * All skills sharing a name within an org. Since name uniqueness is now
   * per-scope (personal names per author, shared names per org), a single
   * `(org, name)` can resolve to several rows — a caller's personal skill plus
   * a team/org skill of the same name. Callers filter these by accessibility
   * and pick one; `findByName` returns an arbitrary row and must not be used
   * for access-scoped lookup.
   */
  static async findAllByName(
    organizationId: string,
    name: string,
  ): Promise<Skill[]> {
    return await db
      .select()
      .from(schema.skillsTable)
      .where(
        and(
          eq(schema.skillsTable.organizationId, organizationId),
          eq(schema.skillsTable.name, name),
        ),
      )
      .orderBy(desc(schema.skillsTable.createdAt));
  }

  /**
   * Of `names`, the ones an import by `userId` would collide with, mirroring the
   * two partial unique indexes: a shared (team/org) skill of that name, or the
   * importer's own personal skill of that name. Another user's personal skill is
   * deliberately excluded — per-scope uniqueness lets personal names coexist, so
   * it cannot block this user's import. Backs the discover "name exists" hint.
   */
  static async findImportNameCollisions(params: {
    organizationId: string;
    userId: string;
    names: string[];
  }): Promise<Set<string>> {
    if (params.names.length === 0) return new Set();

    const sharedScopes: ResourceVisibilityScope[] = ["team", "org"];
    const rows = await db
      .select({ name: schema.skillsTable.name })
      .from(schema.skillsTable)
      .where(
        and(
          eq(schema.skillsTable.organizationId, params.organizationId),
          inArray(schema.skillsTable.name, params.names),
          or(
            inArray(schema.skillsTable.scope, sharedScopes),
            and(
              eq(schema.skillsTable.scope, "personal"),
              eq(schema.skillsTable.authorId, params.userId),
            ),
          ),
        ),
      );

    return new Set(rows.map((row) => row.name));
  }

  /**
   * Create a skill, its bundled resource files, and its team assignments in
   * one transaction.
   *
   * Returns `null` when a name conflict already exists in the skill's
   * visibility namespace (personal names per author, team/org names per org).
   * The insert is atomic (`ON CONFLICT DO NOTHING`, matching whichever partial
   * unique index applies), so this is race-free against concurrent creates.
   * When `teamIds` is supplied the team rows are inserted in the same
   * transaction, so a failed assignment cannot leave a scoped skill orphaned.
   */
  static async createWithFiles(
    params: {
      skill: InsertSkill;
      files: Omit<InsertSkillFile, "skillId">[];
      teamIds?: string[];
    },
    tx?: Transaction,
  ): Promise<Skill | null> {
    const run = async (tx: Transaction) => {
      const [skill] = await tx
        .insert(schema.skillsTable)
        .values(params.skill)
        .onConflictDoNothing()
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
    };

    // join a caller-supplied transaction so the create can be made atomic with
    // other writes (e.g. agent→skill conversion deleting the source agent).
    return tx ? await run(tx) : await withDbTransaction(run);
  }

  /**
   * Update a skill's metadata, resource files, and team assignments atomically.
   *
   * Passing `files` replaces the full set; omitting it leaves files untouched.
   * Passing `teamIds` replaces the team assignments (an empty array clears
   * them); omitting it leaves them untouched. Doing the metadata, file, and
   * team writes in one transaction means a failed team sync (e.g. a team
   * deleted mid-request) rolls the whole update back, so a scope change can
   * never be committed with a team set that leaves the skill orphaned.
   */
  static async updateWithFiles(params: {
    id: string;
    skill: UpdateSkill;
    files?: Omit<InsertSkillFile, "skillId">[];
    teamIds?: string[];
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

      if (params.teamIds !== undefined) {
        await tx
          .delete(schema.skillTeamsTable)
          .where(eq(schema.skillTeamsTable.skillId, params.id));

        if (params.teamIds.length > 0) {
          await tx
            .insert(schema.skillTeamsTable)
            .values(
              params.teamIds.map((teamId) => ({ skillId: params.id, teamId })),
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
