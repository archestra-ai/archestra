import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import { restore, softDelete } from "@/database/soft-delete";
import logger from "@/logging";
import { skillInEnvironmentPredicate } from "@/services/environments/environment-isolation";
import { isBuiltInSkillSourceRef } from "@/skills/built-in-skills";
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
    scope?: ResourceVisibilityScope;
    /** Restrict team-scoped results to skills assigned to these teams. */
    teamIds?: string[];
    /** Restrict personal-scoped results to these authors. */
    authorIds?: string[];
    /** Hide skills authored by these users (authorless rows are kept). */
    excludeAuthorIds?: string[];
    /**
     * When set, hides personal skills owned by other users (the admin
     * default view; mirrors the agents list).
     */
    excludeOtherPersonalForUserId?: string;
    /** Active rows (default) or the soft-deleted trash. */
    status?: SkillRecordStatus;
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
    scope?: ResourceVisibilityScope;
    teamIds?: string[];
    authorIds?: string[];
    excludeAuthorIds?: string[];
    excludeOtherPersonalForUserId?: string;
    /** Active rows (default) or the soft-deleted trash. */
    status?: SkillRecordStatus;
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
   *
   * Built-in skills also carry a `source_ref`, but it is a `builtin:<id>`
   * identity token rather than a repository — and one that embeds the
   * unbranded product id, which would leak into the white-labeled repository
   * filter. They are excluded, matching how the skills table suppresses the
   * same refs in favor of the app-name badge.
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
      if (isBuiltInSkillSourceRef(sourceRef)) continue;
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
      .where(
        and(eq(schema.skillsTable.id, id), notDeleted(schema.skillsTable)),
      );

    return result ?? null;
  }

  static async findByIds(ids: string[]): Promise<Skill[]> {
    if (ids.length === 0) return [];
    return await db
      .select()
      .from(schema.skillsTable)
      .where(
        and(
          inArray(schema.skillsTable.id, ids),
          notDeleted(schema.skillsTable),
        ),
      );
  }

  /**
   * Locate a shipped built-in skill by its stable `source_ref` within an org.
   *
   * Deliberately includes soft-deleted rows: the startup seeder uses this to
   * reconcile shipped definitions, and a soft-deleted built-in must be seen
   * (and skipped) there — otherwise every boot would resurrect it as a fresh
   * copy. Deleting a built-in skill is a durable opt-out.
   */
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
          notDeleted(schema.skillsTable),
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
          // mirrors the partial unique indexes, which exclude soft-deleted
          // rows — a deleted skill's name is free for re-use.
          notDeleted(schema.skillsTable),
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
   * `expectedLatestVersion` anchors the edit to the head it was computed from:
   * the update is a compare-and-set that throws `ApiError(409)` (rolling back)
   * if the skill has already moved past it, so a stale snapshot cannot clobber
   * a concurrent write. Every caller that read the skill before editing it
   * passes one. Omit it only when the payload owes nothing to a prior read —
   * `update_skill`, which composes a whole manifest from its arguments.
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
        .where(
          and(
            eq(schema.skillsTable.id, params.id),
            notDeleted(schema.skillsTable),
          ),
        )
        .returning();

      if (!skill) return null;

      // The UPDATE above locked the row for this tx, so latestVersion is the
      // committed head; a mismatch means a concurrent edit forked past the base
      // this edit was computed from — reject and roll back before forking.
      if (
        params.expectedLatestVersion !== undefined &&
        skill.latestVersion !== params.expectedLatestVersion
      ) {
        // Carries an internal code because the update route raises a second
        // kind of 409 — a name collision — and a client that has to tell an
        // "editing a stale copy" from a "that name is taken" cannot do it on
        // the status alone. The message stays client-neutral: this reaches the
        // web editor, the version-history restore, and `edit_skill` alike, so
        // each one appends its own way back rather than being named here.
        throw new ApiError(
          409,
          `Skill "${skill.name}" has moved to version ${skill.latestVersion}; the edit was based on version ${params.expectedLatestVersion}.`,
          "skill_version_conflict",
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
          notDeleted(schema.skillsTable),
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
   * Deleting the PAT is blocked while this is non-zero. Soft-deleted skills
   * don't count — they no longer sync, so they must not block credential
   * deletion (their FK is ON DELETE SET NULL).
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
          notDeleted(schema.skillsTable),
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
          notDeleted(schema.skillsTable),
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
      .where(
        and(eq(schema.skillsTable.id, id), notDeleted(schema.skillsTable)),
      );
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
      .where(and(eq(schema.skillsTable.id, id), notDeleted(schema.skillsTable)))
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
      .where(
        and(eq(schema.skillsTable.id, skillId), notDeleted(schema.skillsTable)),
      );
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

  /**
   * Soft-delete a skill (frees its name for re-use via the partial unique
   * indexes). Junction rows, files, and versions are kept — reads are
   * filtered instead.
   */
  static async delete(id: string): Promise<boolean> {
    const count = await softDelete(
      db,
      schema.skillsTable,
      eq(schema.skillsTable.id, id),
    );
    return count > 0;
  }

  /**
   * Restore a soft-deleted skill by clearing `deletedAt`. A pure un-delete:
   * no other column is touched. The GitHub sync config and credentials are
   * left as-is — if the skill's credential was nulled (FK `ON DELETE SET
   * NULL`) while it was deleted, the sync handler simply falls back to an
   * unauthenticated (public) pull and, for a now-private repo, records a
   * `lastSyncError` without crashing. Returns whether a soft-deleted row
   * transitioned back to active.
   */
  static async restore(id: string, tx?: Transaction): Promise<boolean> {
    const count = await restore(
      tx ?? db,
      schema.skillsTable,
      eq(schema.skillsTable.id, id),
    );
    return count > 0;
  }

  /**
   * The soft-deleted row scoped to its org — the restore route's lookup, used
   * to authorize and conflict-check before un-deleting. `findById`/`findByIds`
   * filter deleted rows, so they cannot serve this path.
   */
  static async findDeletedById(
    id: string,
    organizationId: string,
  ): Promise<Skill | null> {
    const [row] = await db
      .select()
      .from(schema.skillsTable)
      .where(
        and(
          eq(schema.skillsTable.id, id),
          eq(schema.skillsTable.organizationId, organizationId),
          isNotNull(schema.skillsTable.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Whether restoring `skill` would collide with an active skill on either
   * partial name-uniqueness index. Returns a 409 message, or null when clear.
   * Advisory only: the partial unique index is the real guard, so the restore
   * route also maps its violation to a 409 in case a create races this check.
   */
  static async getRestoreConflictMessage(skill: Skill): Promise<string | null> {
    if (skill.scope === "personal") {
      // The personal index is (org, authorId, name); NULLs are distinct in a
      // unique index, so an authorless row can never collide — skip the check.
      if (!skill.authorId) return null;
      const [conflict] = await db
        .select({ id: schema.skillsTable.id })
        .from(schema.skillsTable)
        .where(
          and(
            eq(schema.skillsTable.organizationId, skill.organizationId),
            eq(schema.skillsTable.authorId, skill.authorId),
            eq(schema.skillsTable.name, skill.name),
            eq(schema.skillsTable.scope, "personal"),
            ne(schema.skillsTable.id, skill.id),
            notDeleted(schema.skillsTable),
          ),
        )
        .limit(1);
      return conflict
        ? `Cannot restore: a personal skill named "${skill.name}" already exists.`
        : null;
    }

    // team + org share the (org, name) partial index over scope in team/org.
    const [conflict] = await db
      .select({ id: schema.skillsTable.id })
      .from(schema.skillsTable)
      .where(
        and(
          eq(schema.skillsTable.organizationId, skill.organizationId),
          eq(schema.skillsTable.name, skill.name),
          inArray(schema.skillsTable.scope, ["team", "org"]),
          ne(schema.skillsTable.id, skill.id),
          notDeleted(schema.skillsTable),
        ),
      )
      .limit(1);
    return conflict
      ? `Cannot restore: a shared skill named "${skill.name}" already exists.`
      : null;
  }

  /** Audit lookup: the raw row scoped to an org, including soft-deleted. */
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
  scope?: ResourceVisibilityScope;
  teamIds?: string[];
  authorIds?: string[];
  excludeAuthorIds?: string[];
  excludeOtherPersonalForUserId?: string;
  status?: SkillRecordStatus;
}) {
  const normalizedSearch = params.search?.trim();
  const normalizedSourceRepo = params.sourceRepo?.trim();
  return [
    eq(schema.skillsTable.organizationId, params.organizationId),
    // Only the org list/count methods pass `status`; every other caller
    // (source-repo scan, name lookups, etc.) omits it and stays active-only.
    getSkillStatusCondition(params.status ?? "active"),
    ...(params.accessibleSkillIds !== undefined
      ? [inArray(schema.skillsTable.id, params.accessibleSkillIds)]
      : []),
    ...(params.environmentId !== undefined
      ? [skillInEnvironmentPredicate(params.environmentId)]
      : []),
    ...(params.scope ? [eq(schema.skillsTable.scope, params.scope)] : []),
    ...(params.teamIds?.length
      ? [
          inArray(
            schema.skillsTable.id,
            db
              .select({ skillId: schema.skillTeamsTable.skillId })
              .from(schema.skillTeamsTable)
              .where(inArray(schema.skillTeamsTable.teamId, params.teamIds)),
          ),
        ]
      : []),
    ...(params.authorIds?.length
      ? [inArray(schema.skillsTable.authorId, params.authorIds)]
      : []),
    ...(params.excludeAuthorIds?.length
      ? [
          or(
            isNull(schema.skillsTable.authorId),
            notInArray(schema.skillsTable.authorId, params.excludeAuthorIds),
          ),
        ]
      : []),
    ...(params.excludeOtherPersonalForUserId
      ? [
          or(
            ne(schema.skillsTable.scope, "personal"),
            eq(
              schema.skillsTable.authorId,
              params.excludeOtherPersonalForUserId,
            ),
          ),
        ]
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

type SkillRecordStatus = "active" | "deleted";

/** Active rows vs the soft-deleted trash, for the list `status` filter. */
function getSkillStatusCondition(status: SkillRecordStatus): SQL {
  return status === "deleted"
    ? isNotNull(schema.skillsTable.deletedAt)
    : notDeleted(schema.skillsTable);
}

export default SkillModel;
