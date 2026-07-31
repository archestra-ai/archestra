import { createHash } from "node:crypto";
import type { PaginationQuery } from "@archestra/shared";
import { and, count, desc, eq, lt } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import logger from "@/logging";
import { LocalConfigSelectSchema } from "@/types";
import type {
  InternalMcpCatalogVersion,
  McpCatalogConfigSnapshot,
} from "@/types/internal-mcp-catalog-version";

type CatalogRow = typeof schema.internalMcpCatalogTable.$inferSelect;

/**
 * Owns immutable catalog config snapshots (`mcp_catalog_versions`).
 * Config-mutating operations fork a new version at their boundary via
 * `forkIfChangedBestEffort` when the write changes the canonical payload (see
 * McpCatalogConfigSnapshotSchema for the exact surface). All catalog config
 * writes funnel through four InternalMcpCatalogModel methods — `create`,
 * `update`, `renameCascade`, and `restore` — so those four are the only fork
 * hooks. A write producing an identical payload leaves the head untouched
 * (content-hash dedup); writes that touch only excluded columns (approval
 * state, reinstall flags, sharing) dedup to a no-op the same way.
 *
 * App-backed rows (`serverType: "app"`) never fork: their catalog row is
 * written by AppModel outside the hooks above, and their content history
 * already lives in `app_versions`.
 */
class InternalMcpCatalogVersionModel {
  /**
   * sha256 over the canonical snapshot. Two writes that produce identical
   * config hash equal, which is how `forkIfChanged` suppresses no-op forks.
   */
  static computeContentHash(snapshot: McpCatalogConfigSnapshot): string {
    return createHash("sha256").update(stableStringify(snapshot)).digest("hex");
  }

  /**
   * Assemble the catalog item's canonical config snapshot from the raw DB row
   * `forkIfChanged` just locked. Deliberately built from that row and never
   * from a caller-supplied catalog object: objects flowing through routes and
   * services may carry `expandSecrets`-materialized plaintext (in
   * localConfig.environment values and oauthConfig.client_secret), while the
   * raw row is guaranteed to hold secret-bundle IDs only.
   */
  static async buildConfigSnapshot(
    tx: Transaction,
    catalog: CatalogRow,
  ): Promise<McpCatalogConfigSnapshot> {
    // Referent id + name pairs keep history legible after a rename; a missing
    // referent (deleted environment, dangling dynamic-connection id) snapshots
    // as null, mirroring agent snapshots.
    const [environmentRows, dynamicConnectionRows] = await Promise.all([
      catalog.environmentId
        ? tx
            .select({
              id: schema.environmentsTable.id,
              name: schema.environmentsTable.name,
            })
            .from(schema.environmentsTable)
            .where(eq(schema.environmentsTable.id, catalog.environmentId))
            .limit(1)
        : Promise.resolve([]),
      catalog.dynamicConnectionMcpServerId
        ? tx
            .select({
              id: schema.mcpServersTable.id,
              name: schema.mcpServersTable.name,
            })
            .from(schema.mcpServersTable)
            .where(
              eq(
                schema.mcpServersTable.id,
                catalog.dynamicConnectionMcpServerId,
              ),
            )
            .limit(1)
        : Promise.resolve([]),
    ]);

    return {
      name: catalog.name,
      serverType: catalog.serverType,
      versionLabel: catalog.version ?? null,
      description: catalog.description ?? null,
      instructions: catalog.instructions ?? null,
      repository: catalog.repository ?? null,
      installationCommand: catalog.installationCommand ?? null,
      icon: catalog.icon ?? null,
      serverUrl: catalog.serverUrl ?? null,
      docsUrl: catalog.docsUrl ?? null,
      requiresAuth: catalog.requiresAuth,
      authDescription: catalog.authDescription ?? null,
      authFields: catalog.authFields ?? null,
      userConfig: catalog.userConfig ?? null,
      oauthConfig: catalog.oauthConfig ?? null,
      enterpriseManagedConfig: catalog.enterpriseManagedConfig ?? null,
      localConfig: canonicalizeLocalConfig(catalog.localConfig),
      deploymentSpecYaml: catalog.deploymentSpecYaml ?? null,
      clientSecretId: catalog.clientSecretId ?? null,
      localConfigSecretId: catalog.localConfigSecretId ?? null,
      environment: environmentRows[0] ?? null,
      dynamicConnectionMcpServer: dynamicConnectionRows[0] ?? null,
    };
  }

  /**
   * Fork a new version iff the catalog item's current config differs from the
   * head snapshot, bumping `internal_mcp_catalog.latest_version` in the same
   * transaction. Call AFTER all config writes of the mutation. It always runs
   * in its own transaction: the fork is a self-contained read-compare-insert,
   * so at worst a crash between the config commit and the fork loses one
   * snapshot, which the next config write captures.
   *
   * Locks the catalog row (FOR UPDATE) so concurrent forks serialize instead
   * of racing on the `(catalog_id, version)` unique index. For the same reason
   * it must never be called from inside a transaction that already holds that
   * lock — the fork's own FOR UPDATE would block on it from another
   * connection. Legacy rows (`latestVersion` 0, predating versioning) fork
   * version 1 on their first config write. Returns null when the catalog item
   * does not exist or is app-backed (`serverType: "app"`, never versioned).
   */
  static async forkIfChanged(
    catalogId: string,
  ): Promise<{ version: number; forked: boolean } | null> {
    return await withDbTransaction(async (tx) => {
      const [catalog] = await tx
        .select()
        .from(schema.internalMcpCatalogTable)
        .where(eq(schema.internalMcpCatalogTable.id, catalogId))
        .for("update");
      if (!catalog) return null;
      if (catalog.serverType === "app") return null;

      const snapshot = await InternalMcpCatalogVersionModel.buildConfigSnapshot(
        tx,
        catalog,
      );
      const contentHash =
        InternalMcpCatalogVersionModel.computeContentHash(snapshot);

      const head =
        catalog.latestVersion > 0
          ? await findVersionRow(tx, catalogId, catalog.latestVersion)
          : null;
      if (head && head.contentHash === contentHash) {
        return { version: catalog.latestVersion, forked: false };
      }

      const nextVersion = catalog.latestVersion + 1;
      await tx.insert(schema.internalMcpCatalogVersionsTable).values({
        catalogId,
        version: nextVersion,
        snapshot,
        contentHash,
      });
      await tx
        .update(schema.internalMcpCatalogTable)
        .set({ latestVersion: nextVersion })
        .where(eq(schema.internalMcpCatalogTable.id, catalogId));
      await pruneOldVersions(tx, catalogId, nextVersion);
      return { version: nextVersion, forked: true };
    });
  }

  /**
   * `forkIfChanged` that never fails the caller's write. A fork is a
   * self-contained read-compare-insert whose only job is to record history,
   * and the config change it snapshots has already committed by the time this
   * runs, so a transient fork error is logged and swallowed — the next config
   * write re-captures the missed state (same tolerance as the crash case
   * documented on `forkIfChanged`). This is the entry point every
   * config-mutation boundary uses. Intentionally takes no `tx`: it always runs
   * in its own transaction, so a swallowed error can never leave a caller's
   * transaction aborted.
   */
  static async forkIfChangedBestEffort(
    catalogId: string,
  ): Promise<{ version: number; forked: boolean } | null> {
    try {
      return await InternalMcpCatalogVersionModel.forkIfChanged(catalogId);
    } catch (error) {
      logger.error(
        { error, catalogId },
        "Catalog version fork failed; skipping (config change already committed)",
      );
      return null;
    }
  }

  /**
   * Resolve a specific `(catalog, version)` pair. Takes a bare catalogId on
   * purpose: `organization_id` is nullable on `internal_mcp_catalog` (the
   * built-in catalog has special org handling), so an org-equality join would
   * 404 legitimate reads. Callers must first resolve the catalog item through
   * `InternalMcpCatalogModel.findById`, which enforces org, team visibility,
   * and soft-delete.
   */
  static async findByCatalogAndVersion(params: {
    catalogId: string;
    version: number;
  }): Promise<InternalMcpCatalogVersion | null> {
    const [row] = await db
      .select()
      .from(schema.internalMcpCatalogVersionsTable)
      .where(
        and(
          eq(
            schema.internalMcpCatalogVersionsTable.catalogId,
            params.catalogId,
          ),
          eq(schema.internalMcpCatalogVersionsTable.version, params.version),
        ),
      );
    return row ?? null;
  }

  /**
   * A catalog item's versions, newest first. Paginated: snapshots embed full
   * config payloads (including whole deployment YAML documents), so an
   * unbounded read of an append-only table would return megabytes for a
   * heavily-edited catalog. Same bare-catalogId contract as
   * `findByCatalogAndVersion` — visibility is the caller's responsibility.
   */
  static async listForCatalog(params: {
    catalogId: string;
    pagination: PaginationQuery;
  }): Promise<PaginatedResult<InternalMcpCatalogVersion>> {
    const scope = eq(
      schema.internalMcpCatalogVersionsTable.catalogId,
      params.catalogId,
    );
    const [rows, [totals]] = await Promise.all([
      db
        .select()
        .from(schema.internalMcpCatalogVersionsTable)
        .where(scope)
        .orderBy(desc(schema.internalMcpCatalogVersionsTable.version))
        .limit(params.pagination.limit)
        .offset(params.pagination.offset),
      db
        .select({ total: count() })
        .from(schema.internalMcpCatalogVersionsTable)
        .where(scope),
    ]);
    return createPaginatedResult(rows, totals?.total ?? 0, params.pagination);
  }
}

export default InternalMcpCatalogVersionModel;

// === Internal helpers ===

/**
 * Versions retained per catalog item. Snapshots embed the item's full config —
 * including any custom deployment YAML — so an item with a large spec pays a
 * complete copy on every unrelated config edit; without a ceiling the table
 * grows with edit count and never shrinks. Trimming the tail is safe for
 * exactly the reason `catalog_id` is ON DELETE CASCADE: nothing pins a
 * catalog version.
 */
const MAX_VERSIONS_PER_CATALOG = 100;

/**
 * One canonical `localConfig` shape regardless of the era the row was written
 * in: parsing through LocalConfigSelectSchema applies the legacy
 * imagePullSecrets normalization, so a later rewrite of the same config in
 * the modern shape hashes identically instead of forking a spurious version.
 * Falls back to the stored value when parsing fails — a snapshot of odd
 * legacy data beats no snapshot.
 */
function canonicalizeLocalConfig(value: CatalogRow["localConfig"]): unknown {
  if (value == null) return null;
  const parsed = LocalConfigSelectSchema.safeParse(value);
  return parsed.success ? parsed.data : value;
}

/**
 * Unscoped `(catalog, version)` lookup for the fork's own head comparison,
 * which runs inside the fork transaction and has already resolved the catalog
 * row. Tenant-facing reads go through `findByCatalogAndVersion`.
 */
async function findVersionRow(
  tx: Transaction,
  catalogId: string,
  version: number,
): Promise<InternalMcpCatalogVersion | null> {
  const [row] = await tx
    .select()
    .from(schema.internalMcpCatalogVersionsTable)
    .where(
      and(
        eq(schema.internalMcpCatalogVersionsTable.catalogId, catalogId),
        eq(schema.internalMcpCatalogVersionsTable.version, version),
      ),
    );
  return row ?? null;
}

/**
 * Drop versions below the retention window. Runs in the fork's transaction,
 * under the catalog's row lock, so it cannot race a concurrent fork.
 */
async function pruneOldVersions(
  tx: Transaction,
  catalogId: string,
  headVersion: number,
): Promise<void> {
  const oldestKept = headVersion - MAX_VERSIONS_PER_CATALOG + 1;
  if (oldestKept <= 1) return;
  await tx
    .delete(schema.internalMcpCatalogVersionsTable)
    .where(
      and(
        eq(schema.internalMcpCatalogVersionsTable.catalogId, catalogId),
        lt(schema.internalMcpCatalogVersionsTable.version, oldestKept),
      ),
    );
}

/**
 * Deterministic JSON for hashing: object keys sorted recursively so two
 * equivalent snapshots serialize identically regardless of key order. Arrays
 * keep their order — the snapshot is scalars plus stored jsonb blobs whose
 * internal array order is author-meaningful (command arguments, env-var
 * definitions).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
