import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  or,
} from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import { softDelete } from "@/database/soft-delete";
import { ApiError } from "@/types";
import type { App, InsertApp } from "@/types/app";
import { isUniqueConstraintError } from "@/utils/db";
import AppAccessModel from "./app-access";
import AppVersionModel, { type VersionPayload } from "./app-version";
import McpCatalogTeamModel from "./mcp-catalog-team";

/** Raw `apps` row (no `scope`/`environmentId` — those live on the backing catalog). */
type AppRow = typeof schema.appsTable.$inferSelect;

// An app's visibility (`scope`) and `environmentId` are owned by its backing
// catalog (FR-30). Reads JOIN apps→mcp_server→internal_mcp_catalog and surface
// them as derived fields so the `App` type stays whole for the rest of the code.
const appWithCatalogColumns = {
  ...getTableColumns(schema.appsTable),
  scope: schema.internalMcpCatalogTable.scope,
  environmentId: schema.internalMcpCatalogTable.environmentId,
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

function buildOrgFilters(params: {
  organizationId: string;
  search?: string;
  accessibleAppIds?: string[];
}) {
  const normalizedSearch = params.search?.trim();
  return [
    eq(schema.appsTable.organizationId, params.organizationId),
    notDeleted(schema.appsTable),
    ...(params.accessibleAppIds !== undefined
      ? [inArray(schema.appsTable.id, params.accessibleAppIds)]
      : []),
    ...(normalizedSearch
      ? [
          or(
            ilike(schema.appsTable.name, `%${normalizedSearch}%`),
            ilike(schema.appsTable.description, `%${normalizedSearch}%`),
          ),
        ]
      : []),
  ];
}

/**
 * Scope-aware CRUD for apps, mirroring `SkillModel`/`AgentModel`. Create and
 * update fork an immutable `app_versions` snapshot in the same transaction
 * (with content-hash no-op suppression) and keep `apps.latest_version` pointing
 * at the head. Team assignments are written here transactionally; the read side
 * (accessibility + batch team loaders) lives in `AppAccessModel`.
 */
class AppModel {
  /** Active apps in an org, newest first; `accessibleAppIds` applies scope filtering. */
  static async findByOrganization(params: {
    organizationId: string;
    limit?: number;
    offset?: number;
    search?: string;
    accessibleAppIds?: string[];
  }): Promise<App[]> {
    let query = appWithCatalogQuery()
      .where(and(...buildOrgFilters(params)))
      .orderBy(desc(schema.appsTable.createdAt))
      .$dynamic();

    if (params.limit !== undefined) query = query.limit(params.limit);
    if (params.offset !== undefined) query = query.offset(params.offset);
    return await query;
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
    return result ?? null;
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

  /** A single active app by its backing mcp_server id (the catalog→app link). */
  static async findByMcpServerId(mcpServerId: string): Promise<App | null> {
    const [result] = await appWithCatalogQuery().where(
      and(
        eq(schema.appsTable.mcpServerId, mcpServerId),
        notDeleted(schema.appsTable),
      ),
    );
    return result ?? null;
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
    return result ?? null;
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
        | "description"
        | "scope"
        | "templateId"
        | "spec"
        | "environmentId"
        | "mcpServerId"
      >
    >;
    version?: VersionPayload;
    teamIds?: string[];
    expectedLatestVersion?: number;
  }): Promise<App | null> {
    const patch = params.patch ?? {};
    // App-row columns only; scope/environmentId are owned by the backing catalog.
    const appRowPatch: Partial<
      Pick<
        AppRow,
        "name" | "description" | "templateId" | "spec" | "mcpServerId"
      >
    > = {};
    if (patch.name !== undefined) appRowPatch.name = patch.name;
    if (patch.description !== undefined)
      appRowPatch.description = patch.description;
    if (patch.templateId !== undefined)
      appRowPatch.templateId = patch.templateId;
    if (patch.spec !== undefined) appRowPatch.spec = patch.spec;
    if (patch.mcpServerId !== undefined)
      appRowPatch.mcpServerId = patch.mcpServerId;

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
        params.teamIds !== undefined;
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
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await db
      .select()
      .from(schema.appsTable)
      .where(
        and(
          eq(schema.appsTable.id, id),
          eq(schema.appsTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    return row ?? null;
  }
}

export default AppModel;
