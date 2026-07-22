import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  like,
  or,
  sql,
} from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import logger from "@/logging";
import { skillInEnvironmentPredicate } from "@/services/environments/environment-isolation";
import type {
  InsertSkill,
  InsertSkillFile,
  Skill,
  SortDirection,
  UpdateSkill,
} from "@/types";
import { ApiError } from "@/types";
import type {
  SkillFileEncoding,
  SkillFileKind,
  SkillGithubSyncInterval,
  SkillSortBy,
} from "@/types/skill";
import type { ResourceVisibilityScope } from "@/types/visibility";
import { trackBackgroundWork } from "@/utils/background-work";
import SkillVersionModel, { type VersionFileInput } from "./skill-version";

class SkillModel {
  static async findByOrganization(params: {
    organizationId: string;
    limit?: number;
    offset?: number;
    search?: string;
    sourceRepo?: string;
    /** When set, restricts results to these skill IDs (scope filtering). */
    accessibleSkillIds?: string[];
    /**
     * When set (null = Default environment), restricts results to skills
     * visible from that environment: strict match, built-in skills exempt.
     * Omit for management surfaces that list every environment.
     */
    environmentId?: string | null;
    sorting?: { sortBy?: SkillSortBy; sortDirection?: SortDirection };
  }): Promise<Skill[]> {
    let query = db
      .select()
      .from(schema.skillsTable)
      .where(and(...buildOrgFilters(params)))
      .orderBy(...buildOrderBy(params.sorting))
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
    /** Same environment-visibility filter as `findByOrganization`. */
    environmentId?: string | null;
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

  /** Locate a shipped built-in skill by its stable `source_ref` within an org. */
  static async findBuiltIn(params: {
    organizationId: string;
    sourceRef: string;
  }): Promise<Skill | null> {
    const [result] = await db
      .select()
      .from(schema.skillsTable)
      .where(
        and(
          eq(schema.skillsTable.organizationId, params.organizationId),
          eq(schema.skillsTable.sourceType, "built_in"),
          eq(schema.skillsTable.sourceRef, params.sourceRef),
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
   * When `teamIds` / `environmentIds` are supplied the junction rows are
   * inserted in the same transaction, so a failed assignment cannot leave a
   * scoped skill orphaned.
   */
  static async createWithFiles(
    params: {
      skill: InsertSkill;
      files: Omit<InsertSkillFile, "skillId">[];
      teamIds?: string[];
      /** Environments the skill is restricted to; empty/omitted = every environment. */
      environmentIds?: string[];
    },
    tx?: Transaction,
  ): Promise<Skill | null> {
    const run = async (tx: Transaction) => {
      const [skill] = await tx
        .insert(schema.skillsTable)
        .values({ ...params.skill, latestVersion: 1 })
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

      if (params.environmentIds && params.environmentIds.length > 0) {
        await tx.insert(schema.skillEnvironmentsTable).values(
          params.environmentIds.map((environmentId) => ({
            skillId: skill.id,
            environmentId,
          })),
        );
      }

      // every skill starts at immutable version 1.
      const versionFiles = toVersionFiles(params.files);
      await SkillVersionModel.insertVersion(tx, {
        skillId: skill.id,
        version: 1,
        content: skill.content,
        contentHash: SkillVersionModel.computeContentHash({
          content: skill.content,
          files: versionFiles,
        }),
        files: versionFiles,
      });

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
   * Passing `teamIds` / `environmentIds` replaces those assignments (an empty
   * array clears them); omitting them leaves them untouched. Doing the
   * metadata, file, and junction writes in one transaction means a failed sync
   * (e.g. a team deleted mid-request) rolls the whole update back, so a scope
   * change can never be committed with a team set that leaves the skill
   * orphaned.
   *
   * When `expectedLatestVersion` is set, the update is a compare-and-set: it
   * throws `ApiError(409)` (rolling back) if the skill's head has already moved
   * past that version, so an edit computed from a stale snapshot cannot clobber
   * a concurrent update. Omit it to keep last-write-wins (the full-manifest
   * `update_skill` path, whose payload is self-contained).
   */
  static async updateWithFiles(params: {
    id: string;
    skill: UpdateSkill;
    files?: Omit<InsertSkillFile, "skillId">[];
    teamIds?: string[];
    /** Replaces the environment assignments; [] clears them (every environment). */
    environmentIds?: string[];
    expectedLatestVersion?: number;
  }): Promise<Skill | null> {
    return await withDbTransaction(async (tx) => {
      const [skill] = await tx
        .update(schema.skillsTable)
        .set(params.skill)
        .where(eq(schema.skillsTable.id, params.id))
        .returning();

      if (!skill) return null;

      // The UPDATE above locked the row for this tx, so latestVersion is the
      // committed head; a mismatch means a concurrent edit forked past the base
      // this edit was computed from — reject and roll back before forking.
      if (
        params.expectedLatestVersion !== undefined &&
        skill.latestVersion !== params.expectedLatestVersion
      ) {
        throw new ApiError(
          409,
          `Skill "${skill.name}" has moved to version ${skill.latestVersion}; the edit was based on version ${params.expectedLatestVersion}. Reload the skill with load_skill and retry.`,
        );
      }

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

      if (params.environmentIds !== undefined) {
        await tx
          .delete(schema.skillEnvironmentsTable)
          .where(eq(schema.skillEnvironmentsTable.skillId, params.id));

        if (params.environmentIds.length > 0) {
          await tx.insert(schema.skillEnvironmentsTable).values(
            params.environmentIds.map((environmentId) => ({
              skillId: params.id,
              environmentId,
            })),
          );
        }
      }

      // fork an immutable version iff the canonical payload changed. The hash is
      // computed over the resulting file set (read back here so an omitted
      // `files` reuses the untouched rows), so a metadata-only edit is a no-op.
      const currentFiles = await tx
        .select()
        .from(schema.skillFilesTable)
        .where(eq(schema.skillFilesTable.skillId, params.id))
        .orderBy(asc(schema.skillFilesTable.path));
      const versionFiles = toVersionFiles(currentFiles);
      const contentHash = SkillVersionModel.computeContentHash({
        content: skill.content,
        files: versionFiles,
      });
      const latest = await SkillVersionModel.findBySkillAndVersion(
        params.id,
        skill.latestVersion,
        tx,
      );
      if (!latest || latest.contentHash !== contentHash) {
        const nextVersion = skill.latestVersion + 1;
        await SkillVersionModel.insertVersion(tx, {
          skillId: params.id,
          version: nextVersion,
          content: skill.content,
          contentHash,
          files: versionFiles,
        });
        const [bumped] = await tx
          .update(schema.skillsTable)
          .set({ latestVersion: nextVersion })
          .where(eq(schema.skillsTable.id, params.id))
          .returning();
        return bumped ?? skill;
      }

      return skill;
    });
  }

  /**
   * GitHub-synced skills whose per-row interval has elapsed since the last
   * sync (never-synced rows are always due). Backs the `check_due_skill_
   * github_syncs` worker tick; uses the partial `skills_github_sync_due_idx`.
   */
  static async findDueGithubSyncs(): Promise<Skill[]> {
    return await db
      .select()
      .from(schema.skillsTable)
      .where(
        and(
          isNotNull(schema.skillsTable.githubSyncInterval),
          sql`(${schema.skillsTable.lastSyncedAt} IS NULL OR ${schema.skillsTable.lastSyncedAt} <= now() - CASE ${schema.skillsTable.githubSyncInterval}
            WHEN '15m' THEN interval '15 minutes'
            WHEN '1h' THEN interval '1 hour'
            ELSE interval '1 day'
          END)`,
        ),
      );
  }

  /**
   * Synced skills whose scheduled pulls authenticate with this stored PAT.
   * Deleting the PAT is blocked while this is non-zero.
   */
  static async countSyncedReferencingGithubPat(
    githubPatId: string,
  ): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.skillsTable)
      .where(
        and(
          eq(schema.skillsTable.githubPatId, githubPatId),
          isNotNull(schema.skillsTable.githubSyncInterval),
        ),
      );
    return result?.count ?? 0;
  }

  /** Same guard for GitHub App configs referenced by synced skills. */
  static async countSyncedReferencingGithubAppConfig(
    githubAppConfigId: string,
  ): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.skillsTable)
      .where(
        and(
          eq(schema.skillsTable.githubAppConfigId, githubAppConfigId),
          isNotNull(schema.skillsTable.githubSyncInterval),
        ),
      );
    return result?.count ?? 0;
  }

  /**
   * Stamp the outcome of a sync attempt: `lastSyncedAt` = now, `lastSyncError`
   * set (failure) or cleared (success). `updatedAt` is preserved — the stamp
   * itself is bookkeeping, not an edit; a content change goes through
   * `updateWithFiles` and bumps `updatedAt` there.
   */
  static async markGithubSyncResult(
    id: string,
    error: string | null,
  ): Promise<void> {
    await db
      .update(schema.skillsTable)
      .set({
        lastSyncedAt: new Date(),
        lastSyncError: error,
        updatedAt: sql`${schema.skillsTable.updatedAt}`,
      })
      .where(eq(schema.skillsTable.id, id));
  }

  /**
   * Change a synced skill's pull frequency, or disconnect it (`sync: null`):
   * clears the schedule, tracking ref, App config, and last error, leaving the
   * skill an editable snapshot with its `github` provenance intact.
   */
  static async setGithubSync(
    id: string,
    sync: { interval: SkillGithubSyncInterval } | null,
  ): Promise<Skill | null> {
    const [updated] = await db
      .update(schema.skillsTable)
      .set(
        sync
          ? { githubSyncInterval: sync.interval }
          : {
              githubSyncInterval: null,
              githubSyncRef: null,
              githubAppConfigId: null,
              githubPatId: null,
              lastSyncError: null,
            },
      )
      .where(eq(schema.skillsTable.id, id))
      .returning();
    return updated ?? null;
  }

  /**
   * Count one activation: bump `usageCount`, stamp `lastUsedAt`, and append a
   * `skill_usage_events` row attributing the activation to `userId` (which
   * backs per-user usage analytics). `updatedAt` is explicitly preserved — a
   * usage tick is not an edit. Fire-and-forget: never throws and needs no
   * awaiting (metrics must not fail or slow an activation); the writes are
   * registered as background work so the test teardown can drain them, and
   * they are independent so an event failure never loses the counter tick.
   */
  static recordUsage(params: { skillId: string; userId: string | null }): void {
    const { skillId, userId } = params;
    const usedAt = new Date();
    const counterWrite = db
      .update(schema.skillsTable)
      .set({
        usageCount: sql`${schema.skillsTable.usageCount} + 1`,
        lastUsedAt: usedAt,
        updatedAt: sql`${schema.skillsTable.updatedAt}`,
      })
      .where(eq(schema.skillsTable.id, skillId));
    const eventWrite = db
      .insert(schema.skillUsageEventsTable)
      .values({ skillId, userId, createdAt: usedAt });
    trackBackgroundWork(
      Promise.allSettled([counterWrite, eventWrite]).then((results) => {
        for (const result of results) {
          if (result.status === "rejected") {
            logger.warn(
              { error: result.reason, skillId },
              "[Skills] Failed to record usage",
            );
          }
        }
      }),
    );
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
    if (!row) return null;

    // environment assignments live in a junction table; include them (sorted
    // for a stable diff) so an environment change shows up in the audit record.
    const environmentIds = await db
      .select({
        environmentId: schema.skillEnvironmentsTable.environmentId,
      })
      .from(schema.skillEnvironmentsTable)
      .where(eq(schema.skillEnvironmentsTable.skillId, id));
    return {
      ...row,
      environmentIds: environmentIds.map((r) => r.environmentId).sort(),
    };
  }
}

/** Normalize a resource file set into the shape a version snapshot stores. */
function toVersionFiles(
  files: {
    path: string;
    content: string;
    encoding?: SkillFileEncoding;
    kind: SkillFileKind;
  }[],
): VersionFileInput[] {
  return files.map((file) => ({
    path: file.path,
    content: file.content,
    encoding: file.encoding ?? "utf8",
    kind: file.kind,
  }));
}

/**
 * Order clause for the skills list. Defaults to most-used first;
 * `createdAt desc` breaks ties so never-used skills list newest-first.
 */
function buildOrderBy(sorting?: {
  sortBy?: SkillSortBy;
  sortDirection?: SortDirection;
}) {
  const direction = sorting?.sortDirection === "asc" ? asc : desc;
  const column = {
    usageCount: schema.skillsTable.usageCount,
    // never-used skills sort as oldest (asc first / desc last), instead of
    // Postgres's default NULLS FIRST on desc.
    lastUsedAt: sql`COALESCE(${schema.skillsTable.lastUsedAt}, '-infinity'::timestamp)`,
    name: schema.skillsTable.name,
    createdAt: schema.skillsTable.createdAt,
  }[sorting?.sortBy ?? "usageCount"];
  return [direction(column), desc(schema.skillsTable.createdAt)];
}

function buildOrgFilters(params: {
  organizationId: string;
  search?: string;
  sourceRepo?: string;
  accessibleSkillIds?: string[];
  environmentId?: string | null;
}) {
  const normalizedSearch = params.search?.trim();
  const normalizedSourceRepo = params.sourceRepo?.trim();
  return [
    eq(schema.skillsTable.organizationId, params.organizationId),
    ...(params.accessibleSkillIds !== undefined
      ? [inArray(schema.skillsTable.id, params.accessibleSkillIds)]
      : []),
    ...(params.environmentId !== undefined
      ? [skillInEnvironmentPredicate(params.environmentId)]
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
