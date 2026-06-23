import { and, count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import { softDelete } from "@/database/soft-delete";
import { ApiError } from "@/types";
import type { App, InsertApp } from "@/types/app";
import { isUniqueConstraintError } from "@/utils/db";
import AppTeamModel from "./app-team";
import AppVersionModel, { type VersionPayload } from "./app-version";

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
 * (accessibility + batch team loaders) lives in `AppTeamModel`.
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
    let query = db
      .select()
      .from(schema.appsTable)
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
    const [result] = await db
      .select()
      .from(schema.appsTable)
      .where(and(eq(schema.appsTable.id, id), notDeleted(schema.appsTable)));
    return result ?? null;
  }

  /** A single active app scoped to an org. */
  static async findByIdInOrg(
    id: string,
    organizationId: string,
  ): Promise<App | null> {
    const [result] = await db
      .select()
      .from(schema.appsTable)
      .where(
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
    const allowed = await AppTeamModel.userHasAppAccess({
      organizationId: params.organizationId,
      userId: params.userId,
      app,
      isAppAdmin: params.isAppAdmin,
    });
    return allowed ? app : null;
  }

  /**
   * Create an app, its team assignments, and its immutable version 1 in one
   * transaction. Returns `null` on a name conflict within the app's visibility
   * namespace (`ON CONFLICT DO NOTHING` against the partial unique indexes, so
   * it is race-free).
   */
  static async create(
    params: { app: InsertApp; payload: VersionPayload; teamIds?: string[] },
    tx?: Transaction,
  ): Promise<App | null> {
    const run = async (tx: Transaction) => {
      const [app] = await tx
        .insert(schema.appsTable)
        .values({ ...params.app, latestVersion: 1 })
        .onConflictDoNothing()
        .returning();
      if (!app) return null;

      if (params.teamIds && params.teamIds.length > 0) {
        await tx
          .insert(schema.appTeamTable)
          .values(params.teamIds.map((teamId) => ({ appId: app.id, teamId })));
      }

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
      >
    >;
    version?: VersionPayload;
    teamIds?: string[];
    expectedLatestVersion?: number;
  }): Promise<App | null> {
    return await withDbTransaction(async (tx) => {
      let app: App | undefined;
      if (params.patch && Object.keys(params.patch).length > 0) {
        try {
          [app] = await tx
            .update(schema.appsTable)
            .set(params.patch)
            .where(
              and(
                eq(schema.appsTable.id, params.id),
                notDeleted(schema.appsTable),
              ),
            )
            .returning();
        } catch (error) {
          // A rename into an existing name trips the partial unique index;
          // surface it as a clean 409 instead of an opaque DB fault.
          if (isUniqueConstraintError(error)) {
            throw new ApiError(
              409,
              "An app with this name already exists in this scope.",
            );
          }
          throw error;
        }
      } else {
        // Lock the row so a concurrent version-only update can't read the same
        // head and fork a duplicate (appId, version). The patch branch above
        // already row-locks via UPDATE.
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
      if (!app) return null;

      if (
        params.expectedLatestVersion !== undefined &&
        app.latestVersion !== params.expectedLatestVersion
      ) {
        throw new ApiError(
          409,
          `App ${params.id} has moved to version ${app.latestVersion}; the edit was based on version ${params.expectedLatestVersion}. Call read_app and retry.`,
        );
      }

      if (params.teamIds !== undefined) {
        await tx
          .delete(schema.appTeamTable)
          .where(eq(schema.appTeamTable.appId, params.id));
        if (params.teamIds.length > 0) {
          await tx
            .insert(schema.appTeamTable)
            .values(
              params.teamIds.map((teamId) => ({ appId: params.id, teamId })),
            );
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
            // Snapshot the head spec (already reflects any spec set in this
            // same update's patch) so the pinned html records what built it.
            spec: app.spec,
          });
          const [bumped] = await tx
            .update(schema.appsTable)
            .set({ latestVersion: nextVersion })
            .where(eq(schema.appsTable.id, params.id))
            .returning();
          return bumped ?? app;
        }
      }

      return app;
    });
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
