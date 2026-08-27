import { createHash } from "node:crypto";
import { urlSlugify } from "@archestra/shared";
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import { softDelete } from "@/database/soft-delete";
import { buildTokenizedSearchFilter } from "@/database/utils/text-search";
import { ApiError } from "@/types";
import {
  APP_NAME_MAX_LENGTH,
  type App,
  type InsertApp,
  isReservedAppSlug,
} from "@/types/app";
import type { AgentLabelWithDetails } from "@/types/label";
import { isUniqueConstraintError } from "@/utils/db";
import { isUuid } from "@/utils/uuid";
import AppAccessModel from "./app-access";
import AppLabelModel from "./app-label";
import AppToolModel from "./app-tool";
import AppVersionModel, { type VersionPayload } from "./app-version";
import McpCatalogTeamModel from "./mcp-catalog-team";
import McpCatalogUserModel from "./mcp-catalog-user";

/** Raw `apps` row (no `scope`/`environmentId`/`icon` — those live on the backing catalog). */
type AppRow = typeof schema.appsTable.$inferSelect;

/** Length of the `-<hex>` a colliding generated slug is disambiguated with. */
const COLLISION_SUFFIX_LENGTH = 7;

// An app's visibility (`scope`), `environmentId` and display `icon` are owned by
// its backing catalog (FR-30). Reads JOIN apps→mcp_server→internal_mcp_catalog
// and surface them as derived fields so the `App` type stays whole for the rest
// of the code. Keeping the icon there (rather than duplicating it on the app
// row) means the app and the registry entry that fronts it cannot disagree
// about it, whichever surface last edited it.
const appWithCatalogColumns = {
  ...getTableColumns(schema.appsTable),
  scope: schema.internalMcpCatalogTable.scope,
  environmentId: schema.internalMcpCatalogTable.environmentId,
  icon: schema.internalMcpCatalogTable.icon,
};

function appWithCatalogQuery() {
  return db
    .select(appWithCatalogColumns)
    .from(schema.appsTable)
    .innerJoin(
      schema.mcpServersTable,
      eq(schema.appsTable.mcpServerId, schema.mcpServersTable.id),
    )
    .innerJoin(
      schema.internalMcpCatalogTable,
      eq(schema.mcpServersTable.catalogId, schema.internalMcpCatalogTable.id),
    );
}

/**
 * What `creationGraceSessionKey` becomes when someone sets `locked` or
 * `enabled` deliberately — the write that ends the window an org default's
 * creating session was building in.
 *
 * Restricting (locking, or disabling) always ends it: a lock or a disable a
 * person asked for must hold against every session, the app's creator
 * included. Relaxing ends it too — *unless the other flag still shuts that
 * session out*, because unlocking an app that is still disabled (or enabling
 * one still locked) is not the moment to take the build away from the chat
 * that is halfway through it. Left set, the key costs nothing: the next
 * deliberate restriction clears it.
 *
 * Evaluated in the same UPDATE that flips the flag, so the two are decided
 * against one consistent row rather than a read the write could race.
 */
function settledGrace(
  change: { locked: boolean } | { enabled: boolean },
): SQL<string | null> | null {
  const stillRestricted =
    "locked" in change
      ? // Unlocking: the disable default may still be holding the app shut.
        sql`NOT ${schema.appsTable.enabled}`
      : // Enabling: the lock default may still be refusing every edit.
        sql`${schema.appsTable.locked}`;
  const restricting = "locked" in change ? change.locked : !change.enabled;
  if (restricting) return null;
  return sql`CASE WHEN ${stillRestricted} THEN ${schema.appsTable.creationGraceSessionKey} ELSE NULL END`;
}

function buildOrgFilters(params: {
  organizationId: string;
  search?: string;
  accessibleAppIds?: string[];
  enabled?: boolean;
}) {
  // Per-token rather than one whole-string substring: an app is usually named
  // from memory ("merge queue take a number" for "Merge Queue — Take a Number"),
  // and a single LIKE makes the match hinge on reproducing the saved word order
  // and punctuation exactly. Still a conjunction, so extra words keep narrowing.
  const searchFilter = buildTokenizedSearchFilter({
    query: params.search,
    columns: [schema.appsTable.name, schema.appsTable.description],
  });
  return [
    eq(schema.appsTable.organizationId, params.organizationId),
    notDeleted(schema.appsTable),
    ...(params.accessibleAppIds !== undefined
      ? [inArray(schema.appsTable.id, params.accessibleAppIds)]
      : []),
    ...(params.enabled !== undefined
      ? [eq(schema.appsTable.enabled, params.enabled)]
      : []),
    ...(searchFilter ? [searchFilter] : []),
  ];
}

/**
 * Attach labels to a batch of app rows in one query (no N+1). `App` carries
 * `labels` as a required field, so every read path funnels through here.
 */
async function withLabels<T extends { id: string }>(
  rows: T[],
): Promise<(T & { labels: AgentLabelWithDetails[] })[]> {
  if (rows.length === 0) return [];
  const labelsByApp = await AppLabelModel.getLabelsForApps(
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    ...row,
    labels: labelsByApp.get(row.id) ?? [],
  }));
}

/** Single-row convenience wrapper around {@link withLabels}. */
async function withLabelsOne<T extends { id: string }>(
  row: T | undefined,
): Promise<(T & { labels: AgentLabelWithDetails[] }) | null> {
  if (!row) return null;
  const [hydrated] = await withLabels([row]);
  return hydrated ?? null;
}

/**
 * Scope-aware CRUD for apps, mirroring `SkillModel`/`AgentModel`. Create and
 * update fork an immutable `app_versions` snapshot in the same transaction
 * (with content-hash no-op suppression) and keep `apps.latest_version` pointing
 * at the head. Team assignments are written here transactionally; the read side
 * (accessibility + batch team loaders) lives in `AppAccessModel`.
 */
class AppModel {
  /**
   * Active apps in an org, newest first; `accessibleAppIds` applies scope
   * filtering. `enabled` filters on the lifecycle state — the chat `list_apps`
   * tool passes `true` so disabled apps never surface as reusable to a model,
   * while the REST list omits it so the Apps page still shows the author
   * their own disabled apps (where re-enabling lives).
   */
  static async findByOrganization(params: {
    organizationId: string;
    limit?: number;
    offset?: number;
    search?: string;
    accessibleAppIds?: string[];
    enabled?: boolean;
  }): Promise<App[]> {
    let query = appWithCatalogQuery()
      .where(and(...buildOrgFilters(params)))
      .orderBy(desc(schema.appsTable.createdAt))
      .$dynamic();

    if (params.limit !== undefined) query = query.limit(params.limit);
    if (params.offset !== undefined) query = query.offset(params.offset);
    return await withLabels(await query);
  }

  static async countByOrganization(params: {
    organizationId: string;
    search?: string;
    accessibleAppIds?: string[];
  }): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.appsTable)
      .where(and(...buildOrgFilters(params)));
    return result?.count ?? 0;
  }

  /** A single active app by id (no access check). */
  static async findById(id: string): Promise<App | null> {
    const [result] = await appWithCatalogQuery().where(
      and(eq(schema.appsTable.id, id), notDeleted(schema.appsTable)),
    );
    return await withLabelsOne(result);
  }

  /**
   * Map backing-catalog ids → app ids for active apps, batched. Lets the
   * registry link a `serverType:"app"` catalog card to the app it backs. Only
   * catalogs that back an active app appear in the result.
   */
  static async getAppIdsByCatalogIds(
    catalogIds: string[],
  ): Promise<Map<string, string>> {
    if (catalogIds.length === 0) return new Map();
    const rows = await db
      .select({
        catalogId: schema.mcpServersTable.catalogId,
        appId: schema.appsTable.id,
      })
      .from(schema.appsTable)
      .innerJoin(
        schema.mcpServersTable,
        eq(schema.appsTable.mcpServerId, schema.mcpServersTable.id),
      )
      .where(
        and(
          inArray(schema.mcpServersTable.catalogId, catalogIds),
          notDeleted(schema.appsTable),
        ),
      );
    return new Map(
      rows
        .filter((r): r is { catalogId: string; appId: string } => !!r.catalogId)
        .map((r) => [r.catalogId, r.appId]),
    );
  }

  /**
   * Map backing-catalog ids → the backing app's `enabled` flag, batched. Lets
   * the capability picker mark a `serverType:"app"` catalog whose app is still
   * disabled (author-only, shown greyed as "Disabled"). Only catalogs that
   * back an active app appear in the result.
   */
  static async getAppEnabledByCatalogIds(
    catalogIds: string[],
  ): Promise<Map<string, boolean>> {
    if (catalogIds.length === 0) return new Map();
    const rows = await db
      .select({
        catalogId: schema.mcpServersTable.catalogId,
        enabled: schema.appsTable.enabled,
      })
      .from(schema.appsTable)
      .innerJoin(
        schema.mcpServersTable,
        eq(schema.appsTable.mcpServerId, schema.mcpServersTable.id),
      )
      .where(
        and(
          inArray(schema.mcpServersTable.catalogId, catalogIds),
          notDeleted(schema.appsTable),
        ),
      );
    return new Map(
      rows
        .filter(
          (r): r is { catalogId: string; enabled: boolean } => !!r.catalogId,
        )
        .map((r) => [r.catalogId, r.enabled]),
    );
  }

  /** A single active app by its backing mcp_server id (the catalog→app link). */
  static async findByMcpServerId(mcpServerId: string): Promise<App | null> {
    const [result] = await appWithCatalogQuery().where(
      and(
        eq(schema.appsTable.mcpServerId, mcpServerId),
        notDeleted(schema.appsTable),
      ),
    );
    return await withLabelsOne(result);
  }

  /**
   * Active apps whose backing install is one of the user's PERSONAL MCP
   * installs — the apps that would be left detached (their `mcp_server_id` FK
   * only nulls) if those installs were purged without deleting the app first.
   * `organizationId` limits the sweep to installs on that organization's
   * catalogs; omitted, it spans every organization (user deletion).
   */
  static async findBackedByPersonalInstallsOfUser(params: {
    userId: string;
    organizationId?: string;
  }): Promise<Pick<App, "id" | "mcpServerId">[]> {
    const rows = await db
      .select({
        id: schema.appsTable.id,
        mcpServerId: schema.appsTable.mcpServerId,
      })
      .from(schema.appsTable)
      .innerJoin(
        schema.mcpServersTable,
        eq(schema.appsTable.mcpServerId, schema.mcpServersTable.id),
      )
      .leftJoin(
        schema.internalMcpCatalogTable,
        eq(schema.mcpServersTable.catalogId, schema.internalMcpCatalogTable.id),
      )
      .where(
        and(
          eq(schema.mcpServersTable.ownerId, params.userId),
          eq(schema.mcpServersTable.scope, "personal"),
          notDeleted(schema.appsTable),
          params.organizationId
            ? eq(
                schema.internalMcpCatalogTable.organizationId,
                params.organizationId,
              )
            : undefined,
        ),
      );
    return rows;
  }

  /** A single active app scoped to an org. */
  static async findByIdInOrg(
    id: string,
    organizationId: string,
  ): Promise<App | null> {
    const [result] = await appWithCatalogQuery().where(
      and(
        eq(schema.appsTable.id, id),
        eq(schema.appsTable.organizationId, organizationId),
        notDeleted(schema.appsTable),
      ),
    );
    return await withLabelsOne(result);
  }

  /**
   * The id of the active app matching an author's name, if any (else null).
   * Mirrors the partial unique index `apps_org_author_name_uidx`
   * (organizationId, authorId, name WHERE deleted_at IS NULL). Id-only select
   * on purpose: the winning row may not be catalog-backed yet, so no JOINs.
   */
  static async findIdByOrgAuthorName({
    organizationId,
    authorId,
    name,
  }: {
    organizationId: string;
    authorId: string;
    name: string;
  }): Promise<string | null> {
    const [result] = await db
      .select({ id: schema.appsTable.id })
      .from(schema.appsTable)
      .where(
        and(
          eq(schema.appsTable.organizationId, organizationId),
          eq(schema.appsTable.authorId, authorId),
          eq(schema.appsTable.name, name),
          notDeleted(schema.appsTable),
        ),
      );
    return result?.id ?? null;
  }

  /**
   * Resolve a `/a/<segment>` URL segment — a slug or an app id — to an app id
   * within one organization, or null when nothing matches. Callers still run
   * the view check on the resolved id; this only turns a segment into an id.
   */
  static async resolveIdFromIdOrSlug({
    idOrSlug,
    organizationId,
  }: {
    idOrSlug: string;
    organizationId: string;
  }): Promise<string | null> {
    // `apps.id` is a uuid column. Casting it to text so it can be compared
    // against a possibly-non-uuid slug defeats the primary-key index and forces
    // a sequential scan, so only compare against `id` when the segment is
    // itself a uuid, and otherwise rely on the indexed `slug` lookup.
    const matchesIdOrSlug = isUuid(idOrSlug)
      ? or(
          eq(schema.appsTable.id, idOrSlug),
          eq(schema.appsTable.slug, idOrSlug),
        )
      : eq(schema.appsTable.slug, idOrSlug);

    const [row] = await db
      .select({ id: schema.appsTable.id })
      .from(schema.appsTable)
      .where(
        and(
          matchesIdOrSlug,
          eq(schema.appsTable.organizationId, organizationId),
          notDeleted(schema.appsTable),
        ),
      )
      .limit(1);

    return row?.id ?? null;
  }

  /**
   * A free `/a/` slug derived from an app name, suffixed on collision. Racy by
   * construction — `apps_org_slug_uidx` is the real guard, and the caller maps
   * its violation to a 409.
   */
  static async generateUniqueSlug({
    name,
    organizationId,
  }: {
    name: string;
    organizationId: string;
  }): Promise<string> {
    // Everything AppSlugSchema refuses from a user must also be unreachable by
    // derivation: an empty slugification (a punctuation-only name), a uuid shape
    // (it would shadow an id in resolveIdFromIdOrSlug), and a reserved segment.
    // The truncation leaves room for the collision suffix.
    const slugified = urlSlugify(name)
      .slice(0, APP_NAME_MAX_LENGTH - COLLISION_SUFFIX_LENGTH)
      // Truncating mid-word can leave the trailing hyphen the shape forbids.
      .replace(/-+$/, "");
    const usable =
      slugified !== "" && !isUuid(slugified) && !isReservedAppSlug(slugified);
    const baseSlug = usable ? slugified : "app";

    const [existing] = await db
      .select({ id: schema.appsTable.id })
      .from(schema.appsTable)
      .where(
        and(
          eq(schema.appsTable.organizationId, organizationId),
          eq(schema.appsTable.slug, baseSlug),
          notDeleted(schema.appsTable),
        ),
      )
      .limit(1);

    return existing
      ? `${baseSlug}-${crypto.randomUUID().slice(0, 6)}`
      : baseSlug;
  }

  /** A single active app, returned only if the caller may view it (else null). */
  static async findByIdForCaller(params: {
    id: string;
    organizationId: string;
    userId?: string;
    isAppAdmin: boolean;
  }): Promise<App | null> {
    const app = await AppModel.findByIdInOrg(params.id, params.organizationId);
    if (!app) return null;
    const allowed = await AppAccessModel.userHasAppAccess({
      organizationId: params.organizationId,
      userId: params.userId,
      app,
      isAppAdmin: params.isAppAdmin,
    });
    return allowed ? app : null;
  }

  /**
   * Create the app row and its immutable version 1. Returns the raw row (no
   * scope/environmentId — those are set on the backing catalog by
   * `createAppBacking`, which the caller runs immediately after). Names are
   * unique per author (apps_org_author_name_uidx), so a duplicate throws a
   * unique-constraint error from this insert, which the caller maps to 409.
   */
  static async create(
    params: { app: InsertApp; payload: VersionPayload },
    tx?: Transaction,
  ): Promise<AppRow> {
    const run = async (tx: Transaction) => {
      const [app] = await tx
        .insert(schema.appsTable)
        .values({ ...params.app, latestVersion: 1 })
        .returning();

      await AppVersionModel.insertVersion(tx, {
        appId: app.id,
        version: 1,
        payload: params.payload,
        contentHash: AppVersionModel.computeContentHash(params.payload),
        spec: app.spec,
      });
      return app;
    };

    return tx ? await run(tx) : await withDbTransaction(run);
  }

  /**
   * Link an app to its backing MCP server. The optional `tx` scopes only this
   * app-row update; the backing catalog/server/tool are created separately (no
   * shared transaction), and the no-unbacked invariant is upheld by the caller
   * deleting the app on backing failure.
   */
  static async setMcpServerId(
    id: string,
    mcpServerId: string,
    tx?: Transaction,
  ): Promise<void> {
    await (tx ?? db)
      .update(schema.appsTable)
      .set({ mcpServerId })
      .where(eq(schema.appsTable.id, id));
  }

  /**
   * Flip an app's enabled/disabled state — the whole enable/disable lifecycle.
   * A pure boolean on the app row: it never touches assignments or the backing
   * catalog, so disable→re-enable is non-destructive (a since-hidden launch
   * tool reappears wherever it was assigned). Returns the updated app, or null if
   * the app is gone/soft-deleted.
   *
   * Deliberately setting the state also settles any creation-time grace
   * (`creationGraceSessionKey`) — see {@link setLocked} for the rule both
   * setters share.
   */
  static async setEnabled(id: string, enabled: boolean): Promise<App | null> {
    const [row] = await db
      .update(schema.appsTable)
      .set({ enabled, creationGraceSessionKey: settledGrace({ enabled }) })
      .where(and(eq(schema.appsTable.id, id), notDeleted(schema.appsTable)))
      .returning({ id: schema.appsTable.id });
    return row ? await AppModel.findById(id) : null;
  }

  /**
   * Flip an app's locked state. A pure boolean on the app row, like
   * `setEnabled`: locked refuses every agent-driven mutation until unlocked,
   * while viewing and running stay unaffected.
   *
   * Setting the lock deliberately also settles any creation-time grace
   * (`creationGraceSessionKey`): a lock someone asked for holds against the
   * session that created the app too, and an app left both unlocked and
   * enabled carries no exception into whatever lock comes next. See
   * {@link settledGrace} for the one case a relaxation keeps.
   */
  static async setLocked(id: string, locked: boolean): Promise<App | null> {
    const [row] = await db
      .update(schema.appsTable)
      .set({ locked, creationGraceSessionKey: settledGrace({ locked }) })
      .where(and(eq(schema.appsTable.id, id), notDeleted(schema.appsTable)))
      .returning({ id: schema.appsTable.id });
    return row ? await AppModel.findById(id) : null;
  }

  /**
   * Let one authoring session keep building an app its creation locked or
   * disabled, for creation paths that only learn the session after the app row
   * exists (the Apps page seeds the app's chat conversation once the app is
   * created). Creation paths that know it upfront pass
   * `creationGraceSessionKey` to {@link create} instead.
   */
  static async setCreationGraceSessionKey(
    id: string,
    sessionKey: string,
  ): Promise<void> {
    await db
      .update(schema.appsTable)
      .set({ creationGraceSessionKey: sessionKey })
      .where(and(eq(schema.appsTable.id, id), notDeleted(schema.appsTable)));
  }

  /**
   * Update an app atomically. `patch` updates catalog columns; `teamIds`
   * (when supplied) replaces the team set; `version` (when supplied) forks a new
   * immutable version iff its canonical payload differs from the head, bumping
   * `latest_version`. A version snapshot is taken as given — the caller assembles
   * the full envelope (html + csp + permissions) it wants pinned.
   *
   * `expectedLatestVersion` is an optimistic-concurrency guard: when supplied,
   * the head is read under the row lock and a mismatch throws `ApiError(409)`
   * without writing anything. Versions are immutable, so a payload the caller
   * built from `expectedLatestVersion` is identical to the locked head whenever
   * the guard passes — this catches a concurrent fork the caller did not see.
   */
  static async update(params: {
    id: string;
    patch?: Partial<
      Pick<
        App,
        | "name"
        | "slug"
        | "description"
        | "scope"
        | "spec"
        | "environmentId"
        | "icon"
        | "openInFullscreen"
      >
    >;
    version?: VersionPayload;
    teamIds?: string[];
    /**
     * Individually-named grants, routed to the backing catalog like `teamIds`.
     * Undefined leaves them untouched; an empty array revokes every grant.
     */
    userIds?: string[];
    expectedLatestVersion?: number;
  }): Promise<App | null> {
    const patch = params.patch ?? {};
    // App-row columns only; scope/environmentId/icon are owned by the backing catalog.
    const appRowPatch: Partial<
      Pick<
        AppRow,
        "name" | "slug" | "description" | "spec" | "openInFullscreen"
      >
    > = {};
    if (patch.name !== undefined) appRowPatch.name = patch.name;
    if (patch.slug !== undefined) appRowPatch.slug = patch.slug;
    if (patch.description !== undefined)
      appRowPatch.description = patch.description;
    if (patch.spec !== undefined) appRowPatch.spec = patch.spec;
    if (patch.openInFullscreen !== undefined)
      appRowPatch.openInFullscreen = patch.openInFullscreen;

    const ok = await withDbTransaction(async (tx) => {
      let app: AppRow | undefined;
      if (Object.keys(appRowPatch).length > 0) {
        [app] = await tx
          .update(schema.appsTable)
          .set(appRowPatch)
          .where(
            and(
              eq(schema.appsTable.id, params.id),
              notDeleted(schema.appsTable),
            ),
          )
          .returning();
      } else {
        // Lock the row so a concurrent version-only update can't read the same
        // head and fork a duplicate (appId, version).
        [app] = await tx
          .select()
          .from(schema.appsTable)
          .where(
            and(
              eq(schema.appsTable.id, params.id),
              notDeleted(schema.appsTable),
            ),
          )
          .for("update");
      }
      if (!app) return false;

      if (
        params.expectedLatestVersion !== undefined &&
        app.latestVersion !== params.expectedLatestVersion
      ) {
        throw new ApiError(
          409,
          `App ${params.id} has moved to version ${app.latestVersion}; the edit was based on version ${params.expectedLatestVersion}. Call read_app and retry.`,
        );
      }

      // Route visibility/environment/teams to the backing catalog (single source
      // of truth, FR-30). Resolved by schema join to avoid importing McpServerModel.
      const routesToCatalog =
        patch.scope !== undefined ||
        patch.environmentId !== undefined ||
        patch.name !== undefined ||
        patch.icon !== undefined ||
        params.teamIds !== undefined ||
        params.userIds !== undefined;
      if (app.mcpServerId && routesToCatalog) {
        const [server] = await tx
          .select({ catalogId: schema.mcpServersTable.catalogId })
          .from(schema.mcpServersTable)
          .where(eq(schema.mcpServersTable.id, app.mcpServerId));
        if (server) {
          if (patch.scope !== undefined) {
            await tx
              .update(schema.mcpServersTable)
              .set({ scope: patch.scope })
              .where(eq(schema.mcpServersTable.id, app.mcpServerId));
          }
          const catalogSet: Record<string, unknown> = {};
          if (patch.scope !== undefined) catalogSet.scope = patch.scope;
          if (patch.environmentId !== undefined)
            catalogSet.environmentId = patch.environmentId;
          // Mirror the name so the catalog's per-scope name-uniqueness index tracks it.
          if (patch.name !== undefined) catalogSet.name = patch.name;
          // The icon has no app-row column at all — the catalog's is the app's.
          if (patch.icon !== undefined) catalogSet.icon = patch.icon;
          if (Object.keys(catalogSet).length > 0) {
            try {
              await tx
                .update(schema.internalMcpCatalogTable)
                .set(catalogSet)
                .where(eq(schema.internalMcpCatalogTable.id, server.catalogId));
            } catch (error) {
              if (isUniqueConstraintError(error)) {
                throw new ApiError(
                  409,
                  "An app with this name already exists in this scope.",
                );
              }
              throw error;
            }
          }
          if (params.teamIds !== undefined) {
            await McpCatalogTeamModel.syncCatalogTeams(
              server.catalogId,
              params.teamIds,
              tx,
            );
          }
          if (params.userIds !== undefined) {
            await McpCatalogUserModel.syncCatalogUsers(
              server.catalogId,
              params.userIds,
              tx,
            );
          }
        }
      }

      if (params.version) {
        const contentHash = AppVersionModel.computeContentHash(params.version);
        const head = await AppVersionModel.findByAppAndVersion(
          params.id,
          app.latestVersion,
          tx,
        );
        if (!head || head.contentHash !== contentHash) {
          const nextVersion = app.latestVersion + 1;
          await AppVersionModel.insertVersion(tx, {
            appId: params.id,
            version: nextVersion,
            payload: params.version,
            contentHash,
            spec: app.spec,
          });
          await tx
            .update(schema.appsTable)
            .set({ latestVersion: nextVersion })
            .where(eq(schema.appsTable.id, params.id));
        }
      }

      return true;
    });

    return ok ? await AppModel.findById(params.id) : null;
  }

  /** Soft-delete an app (frees its name for re-use via the partial unique indexes). */
  static async delete(id: string, tx?: Transaction): Promise<boolean> {
    const count = await softDelete(
      tx ?? db,
      schema.appsTable,
      eq(schema.appsTable.id, id),
    );
    return count > 0;
  }

  /**
   * Hard-remove a just-created app and its version rows. Used only to roll back
   * a create whose backing failed: a soft-delete would leave a ghost app row and
   * — because `app_versions.app_id` is ON DELETE SET NULL — orphaned version
   * bytes. The app never became visible, so there is nothing to preserve.
   */
  static async purge(id: string): Promise<void> {
    await withDbTransaction(async (tx) => {
      await tx
        .delete(schema.appVersionsTable)
        .where(eq(schema.appVersionsTable.appId, id));
      await tx.delete(schema.appsTable).where(eq(schema.appsTable.id, id));
    });
  }

  /** Audit lookup: the raw row scoped to an org, including soft-deleted. */
  /**
   * Ids, names, visibility and deletion state for a bulk route's audit record,
   * used on both sides of the write. Deliberately much narrower than
   * {@link findByIdForAudit}: a batch snapshot has to stay cheap for hundreds
   * of rows, and carries only what a bulk route can actually change.
   *
   * Soft-deleted rows are included so a bulk delete's "after" side still names
   * what it removed rather than going empty.
   */
  static async findVisibilityForBulkAudit(params: {
    ids: string[];
    organizationId: string;
  }): Promise<
    Array<{ id: string; name: string; scope: string; deleted: boolean }>
  > {
    const { ids, organizationId } = params;
    if (ids.length === 0) {
      return [];
    }
    const rows = await appWithCatalogQuery()
      .where(
        and(
          eq(schema.appsTable.organizationId, organizationId),
          inArray(schema.appsTable.id, ids),
        ),
      )
      // Sorted so an unchanged batch snapshots identically on both sides and
      // the audit diff stays empty; row order is unspecified.
      .orderBy(schema.appsTable.id);

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      scope: row.scope,
      deleted: row.deletedAt !== null,
    }));
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    // Use the catalog-joined query so the snapshot includes the app's
    // visibility (scope) and environmentId, which live on the backing catalog
    // (FR-30) — a visibility-only edit would otherwise show no diff.
    const [row] = await appWithCatalogQuery()
      .where(
        and(
          eq(schema.appsTable.id, id),
          eq(schema.appsTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!row) return null;

    // Tool assignments live in appToolsTable (audited:false, "parent carries the
    // signal"), so include them here — otherwise assigning/removing a tool via
    // /api/apps/:appId/tools/:toolId → app.updated would show no diff.
    // Labels live in appLabelsTable (audited:false, "parent carries the
    // signal") for the same reason, so a label-only edit still shows a diff.
    const [tools, labels] = await Promise.all([
      AppToolModel.getToolsForApp(id),
      AppLabelModel.getLabelsForApp(id),
    ]);
    return {
      ...row,
      icon: auditIcon(row.icon),
      tools: tools.map((t) => t.name).sort(),
      labels: labels.map((label) => `${label.key}:${label.value}`).sort(),
    };
  }
}

/**
 * The icon as an audit snapshot carries it.
 *
 * An emoji is a handful of bytes and reads meaningfully in a diff, so it goes
 * verbatim. An uploaded image is a base64 data URL up to the icon cap, and
 * embedding one would put ~1.4 MB of unreadable text into BOTH sides of every
 * app audit event — every rename, re-scope and tool assignment, not just icon
 * edits — for no diagnostic gain. Those collapse to a digest, which still
 * changes when the image does, so an icon swap is auditable without the
 * payload. `InternalMcpCatalogModel.findByIdForAudit` omits the same column
 * outright; a digest keeps the diff non-empty instead.
 */
function auditIcon(icon: string | null): string | null {
  if (icon === null || !icon.startsWith("data:")) return icon;
  return `image:${createHash("sha256").update(icon).digest("hex").slice(0, 16)}`;
}

export default AppModel;
