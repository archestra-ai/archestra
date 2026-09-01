import {
  MAX_SKILL_COMPATIBILITY_LENGTH,
  MAX_SKILL_DESCRIPTION_LENGTH,
} from "@archestra/shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
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
import { hardDelete, restore, softDelete } from "@/database/soft-delete";
import logger from "@/logging";
import { skillInEnvironmentPredicate } from "@/services/environments/environment-isolation";
import { isBuiltInSkillSourceRef } from "@/skills/built-in-skills";
import { SKILL_MANIFEST_FILENAME } from "@/skills/parser";
import {
  buildSkillPublicationArtifacts,
  computeFileDigest,
} from "@/skills/skill-manifest-serializer";
import type {
  InsertSkill,
  InsertSkillFile,
  PublishableSkill,
  Skill,
  SkillManifestSource,
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
import { chunkForBulkStatement } from "@/utils/db";
import SkillUserModel from "./skill-user";
import SkillVersionModel, { type VersionFileInput } from "./skill-version";

/**
 * Every `skills` column except `content` — the projection the MCP publication
 * queries select.
 *
 * Shared with `AgentSkillModel.findSkillsByAgent`, which resolves the same
 * surface for Custom mode, so the two modes can never disagree about which
 * columns a published skill carries.
 */
export function publishableSkillColumns() {
  const { content: _body, ...columns } = getTableColumns(schema.skillsTable);
  return columns;
}

/**
 * Match the one skill a `skill://` URI names.
 *
 * A name is unique only within its visibility, which is why the URI carries a
 * scope segment: `authorId` null means the URI named a shared skill (team or
 * org), and a set `authorId` means it named that user's personal one. Passing
 * the parsed URI's `authorId` straight through therefore reproduces the scope
 * discriminator without the caller restating it.
 *
 * Selects at most one live row: `skills_org_shared_name_idx` and
 * `skills_org_personal_name_idx` make a name unique within exactly the
 * visibility this predicate pins, so there is never a second candidate. The
 * publication gates (`publishableSkillPredicate`) are composed alongside this
 * predicate by each query, not folded in here.
 *
 * Shared by both publication modes so a URI resolves to the same row whether
 * the gateway is in Auto or Custom mode.
 */
export function skillUriKeyPredicate(params: {
  name: string;
  authorId: string | null;
}): SQL | undefined {
  return params.authorId === null
    ? and(
        eq(schema.skillsTable.name, params.name),
        ne(schema.skillsTable.scope, "personal"),
      )
    : and(
        eq(schema.skillsTable.name, params.name),
        eq(schema.skillsTable.scope, "personal"),
        eq(schema.skillsTable.authorId, params.authorId),
      );
}

/**
 * Every publication gate that is a property of the skill row itself, as one
 * SQL predicate: not templated (per-user Handlebars rendering has no stable
 * bytes to digest), not agent-delegated (delegation has no MCP counterpart),
 * spec-compliant frontmatter (SEP-2640 hosts refuse entries whose URI segment
 * breaks the Agent Skills naming rules or whose fields exceed its length
 * limits), a personal skill still holding its author (the author id is a URI
 * segment, so without one no `skill://` URI can name the skill), no
 * unpublishable file path, and publication artifacts present for the row and
 * every file it publishes.
 *
 * SQL rather than TypeScript so the paging `LIMIT` bounds the work: a gate
 * settled after the window is cut forces the caller to re-read until the page
 * fills, which on a catalog dense in unpublishable skills degrades to a full
 * scan per page. The TS twins in `services/agent-skill-resolution.ts` remain
 * only as assertions; `skill.test.ts` pins the name and path gates against
 * their TypeScript counterparts so the two cannot drift.
 */
export function publishableSkillPredicate(): SQL | undefined {
  return and(
    eq(schema.skillsTable.templated, false),
    isNull(schema.skillsTable.agentName),
    // Twin of `isSpecCompliantSkillName` (shared/agent-skills.ts): 1-64 chars,
    // lowercase ASCII runs with single hyphens between them.
    //
    // `COLLATE "C"` because `[a-z]` is a collation-dependent range in Postgres:
    // under the glibc UTF-8 locales most deployments run, accented letters sort
    // inside it, so `café` would pass here and be rejected by the TypeScript
    // twin — which withholds the row, logs an invariant violation, and shortens
    // the page. C collation is plain byte ordering, which is what the twin does.
    sql`char_length(${schema.skillsTable.name}) <= 64
      AND ${schema.skillsTable.name} COLLATE "C" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    // Twins of `isSpecCompliantSkillDescription` / `isSpecCompliantSkillCompatibility`
    // (shared/agent-skills.ts). `char_length` counts code points, which is what
    // the TypeScript twins count. An empty compatibility gates like NULL — the
    // serializer omits it — so only its upper bound appears here.
    sql`char_length(${schema.skillsTable.description}) BETWEEN 1 AND ${MAX_SKILL_DESCRIPTION_LENGTH}`,
    sql`char_length(coalesce(${schema.skillsTable.compatibility}, '')) <= ${MAX_SKILL_COMPATIBILITY_LENGTH}`,
    // A personal skill whose author row was deleted (`author_id` is ON DELETE
    // SET NULL) has no author URI segment, so nothing can name it: withheld
    // here rather than left to throw inside URI building at serve time.
    sql`NOT (${schema.skillsTable.scope} = 'personal' AND ${schema.skillsTable.authorId} IS NULL)`,
    publishableFilePathsPredicate(),
    nonCollidingFilePathsPredicate(),
    // Twin of `storedArtifacts` (services/skill-publication.ts): both halves
    // are written together, so either being null means the row predates
    // migration 0407 or an invalidating write reset it.
    isNotNull(schema.skillsTable.frontmatterBlob),
    isNotNull(schema.skillsTable.digest),
    digestedFilesPredicate(),
  );
}

/**
 * Excludes skills holding a resource-file path no `skill://` URI can name.
 *
 * The SQL twin of `isPublishableSkillFilePath`. The verdict turns on
 * `skill_files.path`, a different table from the one paging keys off, so
 * settling it in application code means reading every candidate's files before
 * a window can be cut. In SQL it is a semi-join the paging `LIMIT` sits behind.
 *
 * Mirrors `hasRoundTrippableSegments`: at least one segment, no empty segment
 * (a leading, trailing or doubled `/`), and no `.` or `..` segment.
 */
function publishableFilePathsPredicate(): SQL {
  return sql`NOT EXISTS (
    SELECT 1
    FROM ${schema.skillFilesTable}
    WHERE ${schema.skillFilesTable.skillId} = ${schema.skillsTable.id}
      AND (
        ${schema.skillFilesTable.path} !~ '^[^/]+(/[^/]+)*$'
        OR ${schema.skillFilesTable.path} ~ '(^|/)[.]{1,2}(/|$)'
      )
  )`;
}

/**
 * Excludes skills where one stored path is a parent directory of another.
 *
 * The SQL twin of `hasPublishableFilePathSet`. `left(...)` rather than `LIKE`
 * because a path is user-supplied text: `_` and `%` in it are LIKE wildcards,
 * which would withhold skills whose paths merely resemble one another.
 */
function nonCollidingFilePathsPredicate(): SQL {
  return sql`NOT EXISTS (
    SELECT 1
    FROM ${schema.skillFilesTable} AS parent_file
    JOIN ${schema.skillFilesTable} AS child_file
      ON child_file.skill_id = parent_file.skill_id
    WHERE parent_file.skill_id = ${schema.skillsTable.id}
      AND left(child_file.path, char_length(parent_file.path) + 1)
          = parent_file.path || '/'
  )`;
}

/**
 * Excludes skills holding a resource file that carries no digest.
 *
 * The SQL twin of the file loop in `resolveSkillPublicationArtifacts`, which
 * withholds the whole skill rather than the file: a resource list missing one
 * of a skill's readable files is, to a conforming host, a verification
 * failure. A stored top-level `SKILL.md` is exempt in both places — the served
 * manifest is composed from the skill row, so whatever a legacy row holds
 * under that path is shadowed and never published.
 *
 * Settled in SQL for the same reason as the path gate: the verdict lives in
 * `skill_files`, so in application code it would be a read of every
 * candidate's files before a window could be cut — and a page cut before the
 * verdict can come back empty with a cursor, which plenty of clients read as
 * "this gateway publishes nothing".
 */
function digestedFilesPredicate(): SQL {
  return sql`NOT EXISTS (
    SELECT 1
    FROM ${schema.skillFilesTable}
    WHERE ${schema.skillFilesTable.skillId} = ${schema.skillsTable.id}
      AND ${schema.skillFilesTable.digest} IS NULL
      AND ${schema.skillFilesTable.path} <> ${SKILL_MANIFEST_FILENAME}
  )`;
}

/**
 * The keyset page window: rows strictly after `afterId` in id order.
 *
 * Keyset rather than OFFSET because the exposed set changes under a client that
 * pages it — an offset would silently skip a skill whenever one ahead of the
 * window is deleted, where resuming after an id cannot.
 */
export function afterIdPredicate(afterId: string | undefined): SQL | undefined {
  return afterId ? gt(schema.skillsTable.id, afterId) : undefined;
}

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
    /** Skill ids matching a `?labels=` filter; omit when not filtering. */
    labelFilteredIds?: string[];
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
    /** Skill ids matching a `?labels=` filter; omit when not filtering. */
    labelFilteredIds?: string[];
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
   * Environment assignments for a batch of skills, keyed by skill id. Every
   * requested id is present — an unassigned skill maps to an empty array — so
   * the result feeds `skillVisibleInEnvironment` without a missing-key case.
   */
  static async findEnvironmentIdsBySkillIds(
    ids: string[],
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>(ids.map((id) => [id, []]));
    if (ids.length === 0) return result;

    const rows = await db
      .select({
        skillId: schema.skillEnvironmentsTable.skillId,
        environmentId: schema.skillEnvironmentsTable.environmentId,
      })
      .from(schema.skillEnvironmentsTable)
      .where(inArray(schema.skillEnvironmentsTable.skillId, ids));

    for (const row of rows) {
      result.get(row.skillId)?.push(row.environmentId);
    }
    return result;
  }

  /**
   * One keyset page of the org-scoped skills visible in an environment, in id
   * order, already stripped of this agent's exclusions and of anything whose
   * file paths cannot be published.
   *
   * Backs Auto mode for the gateway's `skill://` surface, which is deliberately
   * org-scope only: team and personal skills reach a gateway only by explicit
   * assignment.
   *
   * Bounded on purpose. This read used to return the whole org and let the
   * route settle publishability afterwards, which made a single `skills/list`
   * page cost a full catalog scan plus a full `skill_files` scan — and cost it
   * again on the next page. Every filter that can be a predicate is one, so
   * `limit` bounds the work rather than merely trimming its result.
   *
   * Projects `content` away: a body is needed only for the single skill a
   * manifest read renders (see {@link SkillModel.findManifestSourceById}).
   */
  static async findOrgScopedInEnvironment(params: {
    organizationId: string;
    environmentId: string | null;
    /** Drop the skills this agent has excluded from its Auto-mode surface. */
    excludedForAgentId: string;
    /** Resume after this id; omit to start at the first page. */
    afterId?: string;
    limit: number;
  }): Promise<PublishableSkill[]> {
    return await db
      .select(publishableSkillColumns())
      .from(schema.skillsTable)
      .where(
        and(
          eq(schema.skillsTable.organizationId, params.organizationId),
          eq(schema.skillsTable.scope, "org"),
          skillInEnvironmentPredicate(params.environmentId),
          notDeleted(schema.skillsTable),
          notExcludedByAgentPredicate(params.excludedForAgentId),
          publishableSkillPredicate(),
          afterIdPredicate(params.afterId),
        ),
      )
      .orderBy(asc(schema.skillsTable.id))
      .limit(params.limit);
  }

  /**
   * The single org-scoped skill a `skill://` URI names, or null.
   *
   * The by-key twin of {@link SkillModel.findOrgScopedInEnvironment}: serving
   * one skill's manifest or one of its files does not need the org's catalog,
   * only the row the URI addresses. Same predicates, so a skill reachable
   * through the listing is reachable through its own URI and no other.
   */
  static async findOrgScopedByUriKey(params: {
    organizationId: string;
    environmentId: string | null;
    name: string;
    authorId: string | null;
  }): Promise<PublishableSkill | null> {
    const [skill] = await db
      .select(publishableSkillColumns())
      .from(schema.skillsTable)
      .where(
        and(
          eq(schema.skillsTable.organizationId, params.organizationId),
          eq(schema.skillsTable.scope, "org"),
          skillUriKeyPredicate(params),
          skillInEnvironmentPredicate(params.environmentId),
          notDeleted(schema.skillsTable),
          publishableSkillPredicate(),
        ),
      )
      .limit(1);

    return skill ?? null;
  }

  /**
   * Everything one skill's `SKILL.md` is composed from, in a single row read.
   *
   * Single-row on purpose, and the only read a manifest may be served from. The
   * published blob and the body it wraps are written together and kept together
   * by migration 0407's invalidation trigger, but that is a guarantee about the
   * row, not about a reader: composing the blob from a snapshot taken when the
   * skill was resolved and the body from a second read moments later produces
   * bytes that were never committed — matching neither the digest advertised
   * before the intervening write nor the one advertised after. One read cannot
   * straddle a write, so it cannot tear.
   *
   * Null when the row was deleted since it was resolved — soft deletion
   * included, since that is the only kind this surface sees. Without the
   * filter, a read already in flight when someone deletes a skill would serve
   * its manifest one last time.
   */
  static async findManifestSourceById(
    id: string,
  ): Promise<SkillManifestSource | null> {
    const [row] = await db
      .select({
        name: schema.skillsTable.name,
        description: schema.skillsTable.description,
        license: schema.skillsTable.license,
        compatibility: schema.skillsTable.compatibility,
        allowedTools: schema.skillsTable.allowedTools,
        metadata: schema.skillsTable.metadata,
        content: schema.skillsTable.content,
        frontmatterBlob: schema.skillsTable.frontmatterBlob,
        digest: schema.skillsTable.digest,
      })
      .from(schema.skillsTable)
      .where(and(eq(schema.skillsTable.id, id), notDeleted(schema.skillsTable)))
      .limit(1);

    return row ?? null;
  }

  /**
   * One keyset page of skills whose publication artifacts are missing — rows
   * written before migration 0407, or reset by a write outside the model
   * layer. Read only by the periodic backfill
   * (services/skill-publication-backfill.ts); every model write path stores
   * the artifacts together with the bytes they cover, and the gateway
   * withholds a row in this state rather than serving it undigested.
   *
   * Soft-deleted rows are included on purpose: digesting them is idempotent
   * and makes a later restore servable immediately.
   */
  static async findRowSizesMissingPublicationArtifacts(params: {
    /** Resume after this id; omit to start at the first page. */
    afterId?: string;
    limit: number;
  }): Promise<Array<{ id: string; chars: number }>> {
    return await db
      .select({
        id: schema.skillsTable.id,
        chars: sql<number>`char_length(${schema.skillsTable.content})`,
      })
      .from(schema.skillsTable)
      .where(
        and(
          or(
            isNull(schema.skillsTable.frontmatterBlob),
            isNull(schema.skillsTable.digest),
          ),
          afterIdPredicate(params.afterId),
        ),
      )
      .orderBy(asc(schema.skillsTable.id))
      .limit(params.limit);
  }

  /**
   * The manifest fields of specific still-undigested skills — the second half
   * of the backfill's read, sized by
   * {@link SkillModel.findRowSizesMissingPublicationArtifacts}.
   *
   * The artifact-missing filter is re-applied because a model-layer write may
   * have digested a row since its size was read; such a row needs nothing and
   * is simply absent from the result.
   */
  static async findManifestSourcesMissingArtifacts(
    ids: string[],
  ): Promise<
    Array<
      Pick<
        Skill,
        | "id"
        | "name"
        | "description"
        | "license"
        | "compatibility"
        | "allowedTools"
        | "metadata"
        | "content"
      >
    >
  > {
    if (ids.length === 0) return [];

    return await db
      .select({
        id: schema.skillsTable.id,
        name: schema.skillsTable.name,
        description: schema.skillsTable.description,
        license: schema.skillsTable.license,
        compatibility: schema.skillsTable.compatibility,
        allowedTools: schema.skillsTable.allowedTools,
        metadata: schema.skillsTable.metadata,
        content: schema.skillsTable.content,
      })
      .from(schema.skillsTable)
      .where(
        and(
          inArray(schema.skillsTable.id, ids),
          or(
            isNull(schema.skillsTable.frontmatterBlob),
            isNull(schema.skillsTable.digest),
          ),
        ),
      );
  }

  /**
   * How many skills still lack publication artifacts.
   *
   * Read by the backfill to report what remains after a failed pass: the
   * listing query filters these rows out, so without this number a withheld
   * catalog looks exactly like an empty one.
   */
  static async countRowsMissingPublicationArtifacts(): Promise<number> {
    const [row] = await db
      .select({ value: count() })
      .from(schema.skillsTable)
      .where(
        or(
          isNull(schema.skillsTable.frontmatterBlob),
          isNull(schema.skillsTable.digest),
        ),
      );
    return row?.value ?? 0;
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
      /**
       * Git commit the initial bytes came from, stamped on version 1. Passed
       * only by the GitHub import; see `skill_versions.source_commit`.
       */
      versionSourceCommit?: string;
    },
    tx?: Transaction,
  ): Promise<Skill | null> {
    const run = async (tx: Transaction) => {
      const [skill] = await tx
        .insert(schema.skillsTable)
        .values({
          ...params.skill,
          latestVersion: 1,
          // Publication artifacts are derived from the columns written in this
          // same statement, so a skill is publishable from the moment it exists.
          ...buildSkillPublicationArtifacts(params.skill),
        })
        .onConflictDoNothing()
        .returning();

      if (!skill) return null;

      if (params.files.length > 0) {
        // Digest written with the bytes it covers; the application is the
        // single digest producer (see `computeFileDigest`).
        await tx.insert(schema.skillFilesTable).values(
          params.files.map((file) => ({
            ...file,
            skillId: skill.id,
            digest: computeFileDigest({
              content: file.content,
              encoding: file.encoding ?? "utf8",
            }),
          })),
        );
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
        sourceCommit: params.versionSourceCommit,
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
   * a concurrent write. It is opt-in per caller: `edit_skill` always passes one
   * (its schema requires `baseVersion`), the REST update route forwards one only
   * when the client sends it, and `update_skill` never does — it composes a whole
   * manifest from its arguments and owes nothing to a prior read.
   */
  static async updateWithFiles(params: {
    id: string;
    skill: UpdateSkill;
    files?: Omit<InsertSkillFile, "skillId">[];
    teamIds?: string[];
    /** Replaces the environment assignments; [] clears them (every environment). */
    environmentIds?: string[];
    expectedLatestVersion?: number;
    /**
     * Git commit the new bytes came from, stamped on the forked version and
     * dropped when the payload is unchanged and nothing forks. Passed only by
     * the GitHub sync; see `skill_versions.source_commit`.
     */
    versionSourceCommit?: string;
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
        // Carries an internal code because the update route raises other 409s
        // (a name collision, a read-only GitHub-synced skill) and a client that
        // has to offer a reload cannot tell them apart on the status alone.
        // The message stays client-neutral: it reaches both the REST route and
        // `edit_skill`, so the caller appends its own way back rather than
        // being named here.
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
          // Digest written with the bytes, as on insert above.
          await tx.insert(schema.skillFilesTable).values(
            params.files.map((file) => ({
              ...file,
              skillId: params.id,
              digest: computeFileDigest({
                content: file.content,
                encoding: file.encoding ?? "utf8",
              }),
            })),
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
      // `files` reuses the untouched rows).
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

      // Refresh what the gateway publishes from the row this update produced.
      // Frontmatter lives on the skill, not on the version, so this covers a
      // frontmatter-only edit that forks nothing — and fills in a legacy row
      // whose artifacts were never computed. Folded into the version bump when
      // there is one, so the common path still writes the row once.
      const artifacts = buildSkillPublicationArtifacts(skill);
      const artifactsChanged =
        skill.frontmatterBlob !== artifacts.frontmatterBlob ||
        skill.digest !== artifacts.digest;

      if (!latest || latest.contentHash !== contentHash) {
        const nextVersion = skill.latestVersion + 1;
        await SkillVersionModel.insertVersion(tx, {
          skillId: params.id,
          version: nextVersion,
          content: skill.content,
          contentHash,
          files: versionFiles,
          sourceCommit: params.versionSourceCommit,
        });
        const [bumped] = await tx
          .update(schema.skillsTable)
          .set({ latestVersion: nextVersion, ...artifacts })
          .where(eq(schema.skillsTable.id, params.id))
          .returning();
        return bumped ?? skill;
      }

      if (artifactsChanged) {
        const [refreshed] = await tx
          .update(schema.skillsTable)
          .set(artifacts)
          .where(eq(schema.skillsTable.id, params.id))
          .returning();
        return refreshed ?? skill;
      }

      return skill;
    });
  }

  /**
   * Persist publication artifacts computed by the startup backfill for rows
   * that predate migration 0407 (its twin reader is
   * {@link SkillModel.findRowSizesMissingPublicationArtifacts}).
   *
   * The `IS NULL` guard keeps the write from clobbering an edit that landed
   * between the backfill's read and its write, and `updatedAt` is untouched
   * because filling a derived column is not an edit (raw SQL never fires the
   * `$onUpdate` stamp the query builder would).
   */
  static async fillPublicationArtifacts(
    rows: Array<{ id: string; frontmatterBlob: string; digest: string }>,
  ): Promise<void> {
    for (const chunk of chunkForBulkStatement(rows)) {
      const values = sql.join(
        chunk.map(
          (row) =>
            sql`(${row.id}::uuid, ${row.frontmatterBlob}::text, ${row.digest}::text)`,
        ),
        sql`, `,
      );
      await db.execute(sql`
        UPDATE skills AS s
        SET frontmatter_blob = v.frontmatter_blob, digest = v.digest
        FROM (VALUES ${values}) AS v(id, frontmatter_blob, digest)
        WHERE s.id = v.id
          AND (s.digest IS NULL OR s.frontmatter_blob IS NULL)
      `);
    }
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
   *
   * `sessionId` and `contextTokens` are what make an activation costable — the
   * session whose following turns carried the skill, and the tokens the injected
   * block itself added. Both are optional: a caller that cannot supply them
   * records an activation with no cost dimension rather than none at all.
   */
  static recordUsage(params: {
    skillId: string;
    userId: string | null;
    /** LLM session the activation happened in (`interactions.session_id`). */
    sessionId?: string | null;
    /** Measured tokens of the injected activation block. */
    contextTokens?: number | null;
  }): void {
    const { skillId, userId, sessionId, contextTokens } = params;
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
    const eventWrite = db.insert(schema.skillUsageEventsTable).values({
      skillId,
      userId,
      sessionId: sessionId ?? null,
      contextTokens: contextTokens ?? null,
      createdAt: usedAt,
    });
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
   * Move one skill to a visibility scope, replacing its team assignments and
   * per-person grants in the same transaction.
   *
   * Deliberately not routed through {@link SkillModel.updateWithFiles}: nothing
   * versioned changes here (a version snapshots the SKILL.md body and resource
   * files, and the publication artifacts derive from the frontmatter), so this
   * must not read the file set back or risk forking a version. Team and user
   * rows are replaced wholesale rather than diffed — the caller already
   * resolved the target sets.
   *
   * Returns the updated row, or null when no live skill has that id.
   */
  static async updateVisibility(params: {
    id: string;
    scope: ResourceVisibilityScope;
    /** Replaces the team assignments. Empty for non-`team` scopes. */
    teamIds: string[];
    /** Replaces the per-person grants. Empty for non-`personal` scopes. */
    userIds: string[];
  }): Promise<Skill | null> {
    return await withDbTransaction(async (tx) => {
      const [skill] = await tx
        .update(schema.skillsTable)
        .set({ scope: params.scope })
        .where(
          and(
            eq(schema.skillsTable.id, params.id),
            notDeleted(schema.skillsTable),
          ),
        )
        .returning();

      if (!skill) return null;

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

      await SkillUserModel.syncSkillUsers(params.id, params.userIds, tx);

      return skill;
    });
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
   * Soft-delete a batch of skills in one statement. Returns how many rows
   * transitioned from active to deleted, so an id already deleted by a
   * concurrent request is not double-counted.
   */
  static async deleteMany(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return await softDelete(
      db,
      schema.skillsTable,
      inArray(schema.skillsTable.id, ids),
    );
  }

  /**
   * Soft-delete every personal skill a user authored, ahead of deleting the
   * user. `skills.author_id` is `ON DELETE SET NULL`, so without this the
   * skills would survive as active orphans — personal rows whose author id,
   * being a `skill://` URI segment, no longer exists for any URI to carry.
   * Soft rather than hard so no cascade FK can make it fail: a user who asked
   * to be removed must still be removed, and an admin can purge the rows
   * later.
   */
  static async deletePersonalSkillsForUser(
    userId: string,
    tx?: Transaction,
  ): Promise<number> {
    return await softDelete(
      tx ?? db,
      schema.skillsTable,
      and(
        eq(schema.skillsTable.scope, "personal"),
        eq(schema.skillsTable.authorId, userId),
      ),
    );
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
   * Permanently destroy a soft-deleted skill: every version (and, by cascade,
   * every version file), then the skill row itself — which cascades its files,
   * team/user grants, environment assignments, usage events, share links, and
   * connection-setup links. Irreversible.
   *
   * Versions must go FIRST and explicitly. `skill_versions.skill_id` is
   * `ON DELETE SET NULL`, so deleting the skill alone would silently ORPHAN the
   * version rows and their file contents — leaving the skill's actual bytes
   * behind, unreachable and undeletable, which is the opposite of what a purge
   * is for.
   *
   * That delete can fail: `skill_sandbox_skill_mounts.skill_version_id` is
   * `ON DELETE RESTRICT`, so a sandbox still holding this skill blocks it. The
   * violation is deliberately NOT caught here — an aborted Postgres transaction
   * cannot be continued from the inside, so the caller catches it outside this
   * transaction and answers 409.
   *
   * Returns false if there was no soft-deleted row to take, which is how a
   * restore that won the race reports itself.
   */
  static async purge(params: {
    id: string;
    organizationId: string;
  }): Promise<boolean> {
    return withDbTransaction(async (tx) => {
      // The row lock is the race guard: a concurrent restore either commits
      // first (leaving no soft-deleted row for us to find) or blocks until this
      // transaction commits and then finds no row at all.
      const [locked] = await tx
        .select({ id: schema.skillsTable.id })
        .from(schema.skillsTable)
        .where(
          and(
            eq(schema.skillsTable.id, params.id),
            eq(schema.skillsTable.organizationId, params.organizationId),
            isNotNull(schema.skillsTable.deletedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!locked) return false;

      await tx
        .delete(schema.skillVersionsTable)
        .where(eq(schema.skillVersionsTable.skillId, params.id));
      await hardDelete(
        tx,
        schema.skillsTable,
        eq(schema.skillsTable.id, params.id),
      );
      return true;
    });
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

  /**
   * Identity of a skill for the audit trail, and nothing else. The
   * permanent-delete route uses this rather than {@link findByIdForAudit}: a
   * purge is audited by identity only, never by keeping a copy of the content
   * it destroyed. Includes soft-deleted rows — the purge target is always one.
   */
  static async findIdentityForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await db
      .select({
        id: schema.skillsTable.id,
        name: schema.skillsTable.name,
      })
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

  /**
   * Audit lookup for the bulk routes: the visibility-relevant columns of
   * several skills at once, scoped to an org and including soft-deleted rows —
   * a bulk delete's "after" side has to name the skills it just removed.
   *
   * Sorted by id so two reads of an unchanged batch produce an identical
   * snapshot and the audit diff stays empty; row order from the DB is
   * unspecified.
   */
  static async findVisibilityForAudit(params: {
    ids: string[];
    organizationId: string;
  }): Promise<
    Array<{
      id: string;
      name: string;
      scope: ResourceVisibilityScope;
      deleted: boolean;
    }>
  > {
    if (params.ids.length === 0) return [];
    const rows = await db
      .select({
        id: schema.skillsTable.id,
        name: schema.skillsTable.name,
        scope: schema.skillsTable.scope,
        deletedAt: schema.skillsTable.deletedAt,
      })
      .from(schema.skillsTable)
      .where(
        and(
          inArray(schema.skillsTable.id, params.ids),
          eq(schema.skillsTable.organizationId, params.organizationId),
        ),
      )
      .orderBy(asc(schema.skillsTable.id));
    return rows.map(({ deletedAt, ...row }) => ({
      ...row,
      deleted: deletedAt !== null,
    }));
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

/**
 * Excludes the skills an agent has taken off its Auto-mode surface.
 *
 * A semi-join rather than the id list the by-key path probes with, for the same
 * reason the file-path gate is one: it has to compose with the paging `LIMIT`,
 * and an exclusion set an admin can grow without bound must not be materialized
 * to cut a fifty-row window.
 */
function notExcludedByAgentPredicate(agentId: string): SQL {
  return sql`NOT EXISTS (
    SELECT 1
    FROM ${schema.agentExcludedSkillsTable}
    WHERE ${schema.agentExcludedSkillsTable.skillId} = ${schema.skillsTable.id}
      AND ${schema.agentExcludedSkillsTable.agentId} = ${agentId}
  )`;
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
  // `id` closes the ordering: rows created in one transaction share a
  // `createdAt` (Postgres `now()` is transaction time), so without it a page
  // boundary — or the marketplace's skill cap — could fall differently on
  // each query for the same data.
  return [
    direction(column),
    desc(schema.skillsTable.createdAt),
    asc(schema.skillsTable.id),
  ];
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
  /**
   * Skill ids matching the caller's `?labels=` filter, resolved once by the
   * route so the list and count queries agree without resolving twice.
   */
  labelFilteredIds?: string[];
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
    ...(params.labelFilteredIds !== undefined
      ? [inArray(schema.skillsTable.id, params.labelFilteredIds)]
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
