import type { PaginationQuery } from "@archestra/shared";
import { and, asc, count, desc, eq, max } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import type {
  PluginFileEncoding,
  PluginFileMode,
  PluginVersion,
  PluginVersionFile,
} from "@/types/plugin";

/** A plugin file as a version keeps it. */
interface VersionFileInput {
  path: string;
  content: string;
  encoding: PluginFileEncoding;
  mode: PluginFileMode;
  digest: string;
}

/**
 * A plugin's history: one immutable snapshot of its files per write that
 * changed them. `PluginModel` writes a version in the transaction of the
 * write itself; everything here reads, or writes on its behalf.
 */
class PluginVersionModel {
  /**
   * Record the plugin's files as its next version, in the caller's
   * transaction. The caller has just written the plugin row in that
   * transaction, which holds the row's lock until it commits, so two writers
   * to one plugin cannot read the same latest number.
   */
  static async append(
    tx: Transaction,
    params: {
      pluginId: string;
      contentHash: string;
      files: VersionFileInput[];
      /** The commit the files came from; only a Git import or update has one. */
      sourceCommit?: string | null;
      /** When the files were written, where that is not now. */
      createdAt?: Date;
    },
  ): Promise<PluginVersion> {
    const [latest] = await tx
      .select({ version: max(schema.pluginVersionsTable.version) })
      .from(schema.pluginVersionsTable)
      .where(eq(schema.pluginVersionsTable.pluginId, params.pluginId));
    const [version] = await tx
      .insert(schema.pluginVersionsTable)
      .values({
        pluginId: params.pluginId,
        version: (latest?.version ?? 0) + 1,
        contentHash: params.contentHash,
        sourceCommit: params.sourceCommit ?? null,
        ...(params.createdAt && { createdAt: params.createdAt }),
      })
      .returning();
    if (!version) {
      throw new Error("failed to insert plugin version");
    }
    if (params.files.length > 0) {
      await tx.insert(schema.pluginVersionFilesTable).values(
        params.files.map((file) => ({
          versionId: version.id,
          path: file.path,
          content: file.content,
          encoding: file.encoding,
          mode: file.mode,
          digest: file.digest,
        })),
      );
    }
    return version;
  }

  /**
   * Whether the plugin has a history yet. A plugin created before versions
   * were kept has none until the first write that changes its files.
   */
  static async hasAny(tx: Transaction, pluginId: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: schema.pluginVersionsTable.id })
      .from(schema.pluginVersionsTable)
      .where(eq(schema.pluginVersionsTable.pluginId, pluginId))
      .limit(1);
    return row !== undefined;
  }

  /**
   * A plugin's versions, newest first, without their files, so a long
   * history stays cheap to list. Paginated: a synced plugin adds a version
   * per upstream change.
   *
   * `plugin_versions` carries no organization of its own, so the read joins
   * `plugins` and filters on the caller's organization: a plugin id alone
   * must never reach another tenant's history.
   */
  static async listForPlugin(params: {
    pluginId: string;
    organizationId: string;
    pagination: PaginationQuery;
  }): Promise<PaginatedResult<PluginVersion>> {
    const scope = and(
      eq(schema.pluginVersionsTable.pluginId, params.pluginId),
      eq(schema.pluginsTable.organizationId, params.organizationId),
    );
    const [rows, [totals]] = await Promise.all([
      db
        .select(versionColumns)
        .from(schema.pluginVersionsTable)
        .innerJoin(
          schema.pluginsTable,
          eq(schema.pluginVersionsTable.pluginId, schema.pluginsTable.id),
        )
        .where(scope)
        .orderBy(desc(schema.pluginVersionsTable.version))
        .limit(params.pagination.limit)
        .offset(params.pagination.offset),
      db
        .select({ total: count() })
        .from(schema.pluginVersionsTable)
        .innerJoin(
          schema.pluginsTable,
          eq(schema.pluginVersionsTable.pluginId, schema.pluginsTable.id),
        )
        .where(scope),
    ]);
    return createPaginatedResult(rows, totals?.total ?? 0, params.pagination);
  }

  /** One version of a plugin with its files, fenced to the organization. */
  static async findByPluginAndVersion(params: {
    pluginId: string;
    organizationId: string;
    version: number;
  }): Promise<(PluginVersion & { files: PluginVersionFile[] }) | null> {
    const [version] = await db
      .select(versionColumns)
      .from(schema.pluginVersionsTable)
      .innerJoin(
        schema.pluginsTable,
        eq(schema.pluginVersionsTable.pluginId, schema.pluginsTable.id),
      )
      .where(
        and(
          eq(schema.pluginVersionsTable.pluginId, params.pluginId),
          eq(schema.pluginVersionsTable.version, params.version),
          eq(schema.pluginsTable.organizationId, params.organizationId),
        ),
      )
      .limit(1);
    if (!version) return null;
    const files = await db
      .select()
      .from(schema.pluginVersionFilesTable)
      .where(eq(schema.pluginVersionFilesTable.versionId, version.id))
      .orderBy(asc(schema.pluginVersionFilesTable.path));
    return { ...version, files };
  }
}

export default PluginVersionModel;

const versionColumns = {
  id: schema.pluginVersionsTable.id,
  pluginId: schema.pluginVersionsTable.pluginId,
  version: schema.pluginVersionsTable.version,
  contentHash: schema.pluginVersionsTable.contentHash,
  sourceCommit: schema.pluginVersionsTable.sourceCommit,
  createdAt: schema.pluginVersionsTable.createdAt,
};
