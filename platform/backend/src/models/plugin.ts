import { createHash, randomUUID } from "node:crypto";
import { urlSlugify } from "@archestra/shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  like,
  or,
  sql,
} from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import {
  type ClientType,
  type CreatePlugin,
  PLUGIN_DELIVERY_MAX_COUNT,
  type Plugin,
  type PluginFile,
  type PluginFileInput,
  type PluginListItem,
  type PluginWithFiles,
  type UpdatePlugin,
} from "@/types";
import PluginTeamModel from "./plugin-team";
import PluginUserModel from "./plugin-user";

class PluginModel {
  static async findByOrganization(params: {
    organizationId: string;
    accessiblePluginIds?: string[];
  }): Promise<PluginListItem[]> {
    if (params.accessiblePluginIds?.length === 0) return [];
    const plugins = await db
      .select()
      .from(schema.pluginsTable)
      .where(
        and(
          eq(schema.pluginsTable.organizationId, params.organizationId),
          params.accessiblePluginIds
            ? inArray(schema.pluginsTable.id, params.accessiblePluginIds)
            : undefined,
          notDeleted(schema.pluginsTable),
        ),
      )
      .orderBy(desc(schema.pluginsTable.updatedAt));

    if (plugins.length === 0) return [];
    const counts = await db
      .select({
        pluginId: schema.pluginFilesTable.pluginId,
        fileCount: count(),
      })
      .from(schema.pluginFilesTable)
      .where(
        inArray(
          schema.pluginFilesTable.pluginId,
          plugins.map((plugin) => plugin.id),
        ),
      )
      .groupBy(schema.pluginFilesTable.pluginId);
    const countById = new Map(
      counts.map(({ pluginId, fileCount }) => [pluginId, fileCount]),
    );
    const visible = await attachVisibility(plugins);
    return visible.map((plugin) => ({
      ...plugin,
      fileCount: countById.get(plugin.id) ?? 0,
    }));
  }

  static async findById(params: {
    id: string;
    organizationId: string;
  }): Promise<PluginWithFiles | null> {
    const plugin = await PluginModel.findRow(params);
    if (!plugin) return null;
    const [visible] = await attachVisibility([plugin]);
    const files = await PluginModel.findFiles(plugin.id);
    return { ...visible, files };
  }

  static async findApprovedByIds(params: {
    ids: string[];
    organizationId: string;
  }): Promise<PluginWithFiles[]> {
    if (params.ids.length === 0) return [];
    const plugins = await db
      .select()
      .from(schema.pluginsTable)
      .where(
        and(
          eq(schema.pluginsTable.organizationId, params.organizationId),
          inArray(schema.pluginsTable.id, params.ids),
          eq(schema.pluginsTable.enabled, true),
          eq(
            schema.pluginsTable.approvedContentHash,
            schema.pluginsTable.contentHash,
          ),
          notDeleted(schema.pluginsTable),
        ),
      );
    return attachFilesAndVisibilityInIdOrder(plugins, params.ids);
  }

  static async findDeliverableForClient(params: {
    organizationId: string;
    clientType: ClientType;
  }): Promise<PluginWithFiles[]> {
    const plugins = await db
      .select()
      .from(schema.pluginsTable)
      .where(
        and(
          eq(schema.pluginsTable.organizationId, params.organizationId),
          eq(schema.pluginsTable.clientType, params.clientType),
          eq(schema.pluginsTable.enabled, true),
          eq(
            schema.pluginsTable.approvedContentHash,
            schema.pluginsTable.contentHash,
          ),
          notDeleted(schema.pluginsTable),
        ),
      )
      .orderBy(asc(schema.pluginsTable.pluginSlug))
      .limit(PLUGIN_DELIVERY_MAX_COUNT + 1);

    return attachFilesAndVisibilityInIdOrder(
      plugins,
      plugins.map((plugin) => plugin.id),
    );
  }

  static async findDeliverableMetadataForClient(params: {
    organizationId: string;
    clientType: ClientType;
    platform: "posix" | "windows";
  }): Promise<Pick<Plugin, "id" | "supportedPlatforms">[]> {
    return db
      .select({
        id: schema.pluginsTable.id,
        supportedPlatforms: schema.pluginsTable.supportedPlatforms,
      })
      .from(schema.pluginsTable)
      .where(
        and(
          eq(schema.pluginsTable.organizationId, params.organizationId),
          eq(schema.pluginsTable.clientType, params.clientType),
          sql`${params.platform} = any(${schema.pluginsTable.supportedPlatforms})`,
          eq(schema.pluginsTable.enabled, true),
          eq(
            schema.pluginsTable.approvedContentHash,
            schema.pluginsTable.contentHash,
          ),
          notDeleted(schema.pluginsTable),
        ),
      )
      .orderBy(asc(schema.pluginsTable.pluginSlug));
  }

  static async getDeliverableStatsForClient(params: {
    organizationId: string;
    clientType: ClientType;
    platform: "posix" | "windows";
  }): Promise<{ pluginCount: number; totalBytes: number }> {
    const [stats] = await db
      .select({
        pluginCount: sql<number>`count(distinct ${schema.pluginsTable.id})::int`,
        totalBytes: sql<number>`coalesce(sum(case
          when ${schema.pluginFilesTable.encoding} = 'base64'
            then octet_length(decode(${schema.pluginFilesTable.content}, 'base64'))
          else octet_length(${schema.pluginFilesTable.content})
        end), 0)::int`,
      })
      .from(schema.pluginsTable)
      .leftJoin(
        schema.pluginFilesTable,
        eq(schema.pluginFilesTable.pluginId, schema.pluginsTable.id),
      )
      .where(
        and(
          eq(schema.pluginsTable.organizationId, params.organizationId),
          eq(schema.pluginsTable.clientType, params.clientType),
          sql`${params.platform} = any(${schema.pluginsTable.supportedPlatforms})`,
          eq(schema.pluginsTable.enabled, true),
          eq(
            schema.pluginsTable.approvedContentHash,
            schema.pluginsTable.contentHash,
          ),
          notDeleted(schema.pluginsTable),
        ),
      );
    return {
      pluginCount: stats?.pluginCount ?? 0,
      totalBytes: stats?.totalBytes ?? 0,
    };
  }

  static async getApprovedDeliveryStats(params: {
    ids: string[];
    organizationId: string;
  }): Promise<{ pluginCount: number; totalBytes: number }> {
    if (params.ids.length === 0) return { pluginCount: 0, totalBytes: 0 };
    const [stats] = await db
      .select({
        pluginCount: sql<number>`count(distinct ${schema.pluginsTable.id})::int`,
        totalBytes: sql<number>`coalesce(sum(case
          when ${schema.pluginFilesTable.encoding} = 'base64'
            then octet_length(decode(${schema.pluginFilesTable.content}, 'base64'))
          else octet_length(${schema.pluginFilesTable.content})
        end), 0)::int`,
      })
      .from(schema.pluginsTable)
      .leftJoin(
        schema.pluginFilesTable,
        eq(schema.pluginFilesTable.pluginId, schema.pluginsTable.id),
      )
      .where(
        and(
          eq(schema.pluginsTable.organizationId, params.organizationId),
          inArray(schema.pluginsTable.id, params.ids),
          eq(schema.pluginsTable.enabled, true),
          eq(
            schema.pluginsTable.approvedContentHash,
            schema.pluginsTable.contentHash,
          ),
          notDeleted(schema.pluginsTable),
        ),
      );
    return {
      pluginCount: stats?.pluginCount ?? 0,
      totalBytes: stats?.totalBytes ?? 0,
    };
  }

  static async findBySourceId(params: {
    organizationId: string;
    sourceId: string;
  }): Promise<PluginWithFiles | null> {
    const [plugin] = await db
      .select()
      .from(schema.pluginsTable)
      .where(
        and(
          eq(schema.pluginsTable.organizationId, params.organizationId),
          eq(schema.pluginsTable.sourceId, params.sourceId),
          notDeleted(schema.pluginsTable),
        ),
      )
      .limit(1);
    if (!plugin) return null;
    const [visible] = await attachVisibility([plugin]);
    return { ...visible, files: await PluginModel.findFiles(plugin.id) };
  }

  static async findByMarketplaceIdentity(params: {
    organizationId: string;
    marketplaceRepo: string;
    marketplacePath: string;
    marketplacePluginName: string;
  }): Promise<Plugin | null> {
    const [plugin] = await db
      .select()
      .from(schema.pluginsTable)
      .where(
        and(
          eq(schema.pluginsTable.organizationId, params.organizationId),
          sql`lower(${schema.pluginsTable.sourceMarketplaceRepo}) = lower(${params.marketplaceRepo})`,
          eq(schema.pluginsTable.sourceMarketplacePath, params.marketplacePath),
          sql`lower(${schema.pluginsTable.sourceMarketplacePluginName}) = lower(${params.marketplacePluginName})`,
        ),
      )
      .limit(1);
    return plugin ?? null;
  }

  static async normalizeDefaultGithubImport(params: {
    id: string;
    organizationId: string;
    sourceRef: string;
    syncInterval: "15m" | "1h" | "1d";
  }): Promise<Plugin | null> {
    const [plugin] = await db
      .update(schema.pluginsTable)
      .set({
        sourceId: null,
        sourceRef: params.sourceRef,
        githubSyncRef: params.sourceRef,
        githubSyncInterval: params.syncInterval,
        lastSyncedAt: new Date(),
      })
      .where(
        and(
          eq(schema.pluginsTable.id, params.id),
          eq(schema.pluginsTable.organizationId, params.organizationId),
          notDeleted(schema.pluginsTable),
        ),
      )
      .returning();
    return plugin ?? null;
  }

  static async create(params: {
    organizationId: string;
    userId: string;
    input: CreatePlugin;
    /** Optional stable source identity for platform-owned imports. */
    pluginSlug?: string;
    sourceId?: string;
    source?: {
      repo: string;
      ref: string | null;
      sha: string;
      subdir: string;
      exclude: string[];
      marketplaceRepo?: string | null;
      marketplacePath?: string | null;
      marketplacePluginName?: string | null;
      syncInterval?: "15m" | "1h" | "1d" | null;
      syncRef?: string | null;
      githubAppConfigId?: string | null;
      githubPatId?: string | null;
    };
  }): Promise<PluginWithFiles | null> {
    const created = await withDbTransaction(async (tx) => {
      const id = randomUUID();
      const pluginSlug =
        params.pluginSlug ?? derivePluginSlug(params.input.displayName, id);
      const contentHash = computeContentHash(params.input.files);
      const now = new Date();
      const [plugin] = await tx
        .insert(schema.pluginsTable)
        .values({
          id,
          organizationId: params.organizationId,
          authorId: params.userId,
          scope: params.input.scope ?? (params.sourceId ? "org" : "personal"),
          clientType: params.input.clientType,
          supportedPlatforms: params.input.supportedPlatforms ?? ["posix"],
          pluginSlug,
          displayName: params.input.displayName,
          description: params.input.description,
          contentHash,
          sourceKind: params.source ? "github" : "manual",
          sourceRepo: params.source?.repo,
          sourceRef: params.source?.ref,
          sourceSha: params.source?.sha,
          sourceSubdir: params.source?.subdir,
          sourceExclude: params.source?.exclude,
          sourceMarketplaceRepo: params.source?.marketplaceRepo,
          sourceMarketplacePath: params.source?.marketplacePath,
          sourceMarketplacePluginName: params.source?.marketplacePluginName,
          githubSyncInterval: params.source?.syncInterval,
          githubSyncRef: params.source?.syncRef,
          githubAppConfigId: params.source?.githubAppConfigId,
          githubPatId: params.source?.githubPatId,
          lastSyncedAt: params.source?.syncInterval ? now : null,
          sourceId: params.sourceId,
          approvedContentHash: contentHash,
          approvedAt: now,
          approvedBy: params.userId,
        })
        .onConflictDoNothing()
        .returning();
      if (!plugin) return null;

      const files = await insertFiles(tx, plugin.id, params.input.files);
      await PluginTeamModel.syncPluginTeams(
        plugin.id,
        plugin.scope === "team" ? (params.input.teamIds ?? []) : [],
        tx,
      );
      await PluginUserModel.syncPluginUsers(
        plugin.id,
        plugin.scope === "personal" ? (params.input.userIds ?? []) : [],
        tx,
      );
      return { ...plugin, files };
    });
    if (!created) return null;
    return PluginModel.findById({
      id: created.id,
      organizationId: params.organizationId,
    });
  }

  static async update(params: {
    id: string;
    organizationId: string;
    userId: string;
    input: UpdatePlugin;
    /** Set only by the explicit GitHub-update approval route. */
    sourceSha?: string;
    sourceRef?: string | null;
    /** Full provenance refresh used by managed marketplace reconciliation. */
    source?: {
      repo: string;
      ref: string | null;
      sha: string;
      subdir: string;
      exclude: string[];
      marketplaceRepo: string;
      marketplacePath: string;
      marketplacePluginName: string;
    };
    /**
     * Compare-and-set guard for content edits: when set, the update only
     * lands while the plugin's current content hash still matches — a
     * concurrent write since the caller read the files fails the update.
     */
    expectedContentHash?: string;
  }): Promise<PluginWithFiles | null> {
    const updated = await withDbTransaction(async (tx) => {
      const existing = await findRowWithTransaction(tx, {
        id: params.id,
        organizationId: params.organizationId,
      });
      if (!existing) return null;
      const scope = params.input.scope ?? existing.scope;

      const fileUpdate = params.input.files;
      const contentHash = fileUpdate
        ? computeContentHash(fileUpdate)
        : existing.contentHash;
      const approval = fileUpdate
        ? {
            contentHash,
            approvedContentHash: contentHash,
            approvedAt: new Date(),
            approvedBy: params.userId,
          }
        : {};
      const sourceUpdate = params.source
        ? {
            sourceKind: "github" as const,
            sourceRepo: params.source.repo,
            sourceRef: params.source.ref,
            sourceSha: params.source.sha,
            sourceSubdir: params.source.subdir,
            sourceExclude: params.source.exclude,
            sourceMarketplaceRepo: params.source.marketplaceRepo,
            sourceMarketplacePath: params.source.marketplacePath,
            sourceMarketplacePluginName: params.source.marketplacePluginName,
          }
        : { sourceSha: params.sourceSha, sourceRef: params.sourceRef };
      const githubSource = params.input.githubSource;
      const githubRepoChanged = githubSource
        ? githubSource.repoUrl.toLowerCase() !==
          existing.sourceRepo?.toLowerCase()
        : false;
      const githubRefChanged = githubSource
        ? githubSource.ref !== existing.githubSyncRef
        : false;
      const githubTrackingChanged = githubRepoChanged || githubRefChanged;
      const githubAuthentication = githubSource?.authentication;
      const githubAuthenticationChanged = githubAuthentication
        ? githubAuthentication.githubAppConfigId !==
            existing.githubAppConfigId ||
          githubAuthentication.githubPatId !== existing.githubPatId
        : false;
      const clearGithubCandidate =
        githubTrackingChanged || githubSource?.syncInterval === null;
      const githubSourceUpdate = githubSource
        ? {
            sourceRepo: githubSource.repoUrl,
            sourceRef: githubSource.ref,
            githubSyncRef: githubSource.ref,
            githubSyncInterval: githubSource.syncInterval,
            ...(githubAuthentication
              ? {
                  githubAppConfigId: githubAuthentication.githubAppConfigId,
                  githubPatId: githubAuthentication.githubPatId,
                }
              : {}),
            ...(githubTrackingChanged || githubAuthenticationChanged
              ? { lastSyncedAt: null }
              : {}),
            ...(githubAuthenticationChanged ? { lastSyncError: null } : {}),
            ...(clearGithubCandidate
              ? {
                  pendingSourceSha: null,
                  pendingContentHash: null,
                  pendingDetectedAt: null,
                  lastSyncError: null,
                }
              : {}),
          }
        : {};
      const [plugin] = await tx
        .update(schema.pluginsTable)
        .set({
          displayName: params.input.displayName,
          description: params.input.description,
          enabled: params.input.enabled,
          supportedPlatforms: params.input.supportedPlatforms,
          scope,
          syncGeneration: sql`${schema.pluginsTable.syncGeneration} + 1`,
          ...sourceUpdate,
          ...githubSourceUpdate,
          ...(params.sourceSha || params.source
            ? {
                pendingSourceSha: null,
                pendingContentHash: null,
                pendingDetectedAt: null,
                lastSyncedAt: new Date(),
                lastSyncError: null,
              }
            : {}),
          ...approval,
        })
        .where(
          and(
            eq(schema.pluginsTable.id, params.id),
            eq(schema.pluginsTable.organizationId, params.organizationId),
            params.expectedContentHash !== undefined
              ? eq(schema.pluginsTable.contentHash, params.expectedContentHash)
              : undefined,
            notDeleted(schema.pluginsTable),
          ),
        )
        .returning();
      if (!plugin) return null;

      if (fileUpdate) {
        await tx
          .delete(schema.pluginFilesTable)
          .where(eq(schema.pluginFilesTable.pluginId, plugin.id));
        await insertFiles(tx, plugin.id, fileUpdate);
      }
      if (
        params.input.scope !== undefined ||
        params.input.teamIds !== undefined ||
        params.input.userIds !== undefined
      ) {
        await PluginTeamModel.syncPluginTeams(
          plugin.id,
          scope === "team" ? (params.input.teamIds ?? []) : [],
          tx,
        );
        await PluginUserModel.syncPluginUsers(
          plugin.id,
          scope === "personal" ? (params.input.userIds ?? []) : [],
          tx,
        );
      }
      const files = await findFilesWithTransaction(tx, plugin.id);
      return { ...plugin, files };
    });
    if (!updated) return null;
    return PluginModel.findById({
      id: updated.id,
      organizationId: params.organizationId,
    });
  }

  static async delete(params: {
    id: string;
    organizationId: string;
  }): Promise<Plugin | null> {
    const [plugin] = await db
      .update(schema.pluginsTable)
      .set({
        deletedAt: new Date(),
        enabled: false,
        githubSyncInterval: null,
        githubAppConfigId: null,
        githubPatId: null,
        pendingSourceSha: null,
        pendingContentHash: null,
        pendingDetectedAt: null,
        syncGeneration: sql`${schema.pluginsTable.syncGeneration} + 1`,
      })
      .where(
        and(
          eq(schema.pluginsTable.id, params.id),
          eq(schema.pluginsTable.organizationId, params.organizationId),
          notDeleted(schema.pluginsTable),
        ),
      )
      .returning();
    return plugin ?? null;
  }

  static async applyGithubUpdate(params: {
    id: string;
    organizationId: string;
    userId: string;
    expectedPendingSha: string;
    files: PluginFileInput[];
  }): Promise<PluginWithFiles | null> {
    const applied = await withDbTransaction(async (tx) => {
      const contentHash = computeContentHash(params.files);
      const [plugin] = await tx
        .update(schema.pluginsTable)
        .set({
          contentHash,
          approvedContentHash: contentHash,
          approvedAt: new Date(),
          approvedBy: params.userId,
          sourceSha: params.expectedPendingSha,
          pendingSourceSha: null,
          pendingContentHash: null,
          pendingDetectedAt: null,
          lastSyncedAt: new Date(),
          lastSyncError: null,
          syncGeneration: sql`${schema.pluginsTable.syncGeneration} + 1`,
        })
        .where(
          and(
            eq(schema.pluginsTable.id, params.id),
            eq(schema.pluginsTable.organizationId, params.organizationId),
            eq(schema.pluginsTable.pendingSourceSha, params.expectedPendingSha),
            notDeleted(schema.pluginsTable),
          ),
        )
        .returning({ id: schema.pluginsTable.id });
      if (!plugin) return null;
      await tx
        .delete(schema.pluginFilesTable)
        .where(eq(schema.pluginFilesTable.pluginId, params.id));
      await insertFiles(tx, params.id, params.files);
      return plugin;
    });
    if (!applied) return null;
    return PluginModel.findById({
      id: params.id,
      organizationId: params.organizationId,
    });
  }

  static async findDueGithubSyncs(): Promise<Plugin[]> {
    return db
      .select()
      .from(schema.pluginsTable)
      .where(
        and(
          isNotNull(schema.pluginsTable.githubSyncInterval),
          notDeleted(schema.pluginsTable),
          sql`(${schema.pluginsTable.lastSyncedAt} IS NULL OR ${schema.pluginsTable.lastSyncedAt} <= now() - CASE ${schema.pluginsTable.githubSyncInterval}
            WHEN '15m' THEN interval '15 minutes'
            WHEN '1h' THEN interval '1 hour'
            ELSE interval '1 day'
          END)`,
        ),
      );
  }

  /**
   * Plugins visible to the caller that carry at least one SKILL.md file,
   * with only the manifest bytes and the file paths loaded — the list
   * projection never pays for the full payload.
   */
  static async findSkillManifestCandidates(params: {
    organizationId: string;
    accessiblePluginIds?: string[];
    orgScopeOnly?: boolean;
  }): Promise<
    Array<{
      plugin: Plugin;
      manifests: Array<Pick<PluginFile, "path" | "content" | "encoding">>;
      filePaths: string[];
    }>
  > {
    if (params.accessiblePluginIds?.length === 0) return [];
    const plugins = await db
      .select()
      .from(schema.pluginsTable)
      .where(
        and(
          eq(schema.pluginsTable.organizationId, params.organizationId),
          params.accessiblePluginIds
            ? inArray(schema.pluginsTable.id, params.accessiblePluginIds)
            : undefined,
          params.orgScopeOnly
            ? eq(schema.pluginsTable.scope, "org")
            : undefined,
          notDeleted(schema.pluginsTable),
        ),
      )
      .orderBy(asc(schema.pluginsTable.displayName));
    if (plugins.length === 0) return [];
    const pluginIds = plugins.map((plugin) => plugin.id);
    const [manifests, paths] = await Promise.all([
      db
        .select({
          pluginId: schema.pluginFilesTable.pluginId,
          path: schema.pluginFilesTable.path,
          content: schema.pluginFilesTable.content,
          encoding: schema.pluginFilesTable.encoding,
        })
        .from(schema.pluginFilesTable)
        .where(
          and(
            inArray(schema.pluginFilesTable.pluginId, pluginIds),
            or(
              eq(schema.pluginFilesTable.path, "SKILL.md"),
              like(schema.pluginFilesTable.path, "%/SKILL.md"),
            ),
          ),
        )
        .orderBy(asc(schema.pluginFilesTable.path)),
      db
        .select({
          pluginId: schema.pluginFilesTable.pluginId,
          path: schema.pluginFilesTable.path,
        })
        .from(schema.pluginFilesTable)
        .where(inArray(schema.pluginFilesTable.pluginId, pluginIds))
        .orderBy(asc(schema.pluginFilesTable.path)),
    ]);
    const manifestsByPlugin = new Map<string, typeof manifests>();
    for (const manifest of manifests) {
      const list = manifestsByPlugin.get(manifest.pluginId) ?? [];
      list.push(manifest);
      manifestsByPlugin.set(manifest.pluginId, list);
    }
    const pathsByPlugin = new Map<string, string[]>();
    for (const file of paths) {
      const list = pathsByPlugin.get(file.pluginId) ?? [];
      list.push(file.path);
      pathsByPlugin.set(file.pluginId, list);
    }
    return plugins.flatMap((plugin) => {
      const candidates = manifestsByPlugin.get(plugin.id);
      if (!candidates || candidates.length === 0) return [];
      return [
        {
          plugin,
          manifests: candidates.map(({ path, content, encoding }) => ({
            path,
            content,
            encoding,
          })),
          filePaths: pathsByPlugin.get(plugin.id) ?? [],
        },
      ];
    });
  }

  static async findByIdForSync(id: string): Promise<Plugin | null> {
    const [plugin] = await db
      .select()
      .from(schema.pluginsTable)
      .where(
        and(eq(schema.pluginsTable.id, id), notDeleted(schema.pluginsTable)),
      )
      .limit(1);
    return plugin ?? null;
  }

  static async markGithubSyncResult(params: {
    id: string;
    expectedSyncGeneration: number;
    expectedPendingSourceSha: string | null;
    sourceSha?: string;
    files?: PluginFileInput[];
    error: string | null;
  }): Promise<boolean> {
    const candidateHash =
      params.sourceSha === undefined
        ? null
        : computeContentHash(params.files ?? []);
    const [updated] = await db
      .update(schema.pluginsTable)
      .set({
        lastSyncedAt: new Date(),
        lastSyncError: params.error,
        ...(params.error === null && params.sourceSha !== undefined
          ? {
              pendingSourceSha: sql`case when ${params.sourceSha} is distinct from ${schema.pluginsTable.sourceSha} then ${params.sourceSha} else null end`,
              pendingContentHash: sql`case when ${params.sourceSha} is distinct from ${schema.pluginsTable.sourceSha} then ${candidateHash} else null end`,
              pendingDetectedAt: sql`case when ${params.sourceSha} is distinct from ${schema.pluginsTable.sourceSha} then now() else null end`,
            }
          : {}),
      })
      .where(
        and(
          eq(schema.pluginsTable.id, params.id),
          eq(schema.pluginsTable.syncGeneration, params.expectedSyncGeneration),
          sql`${schema.pluginsTable.pendingSourceSha} is not distinct from ${params.expectedPendingSourceSha}`,
        ),
      )
      .returning({ id: schema.pluginsTable.id });
    return updated !== undefined;
  }

  static async setGithubSync(params: {
    id: string;
    interval: "15m" | "1h" | "1d" | null;
  }): Promise<Plugin | null> {
    const [plugin] = await db
      .update(schema.pluginsTable)
      .set({
        ...(params.interval
          ? {
              githubSyncInterval: params.interval,
              githubSyncRef: sql`coalesce(${schema.pluginsTable.githubSyncRef}, ${schema.pluginsTable.sourceRef})`,
            }
          : {
              githubSyncInterval: null,
              lastSyncError: null,
              pendingSourceSha: null,
              pendingContentHash: null,
              pendingDetectedAt: null,
            }),
        syncGeneration: sql`${schema.pluginsTable.syncGeneration} + 1`,
      })
      .where(
        and(
          eq(schema.pluginsTable.id, params.id),
          notDeleted(schema.pluginsTable),
        ),
      )
      .returning();
    return plugin ?? null;
  }

  static async countSyncedReferencingGithubPat(id: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.pluginsTable)
      .where(
        and(
          eq(schema.pluginsTable.githubPatId, id),
          notDeleted(schema.pluginsTable),
        ),
      );
    return result?.count ?? 0;
  }

  static async countSyncedReferencingGithubAppConfig(
    id: string,
  ): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.pluginsTable)
      .where(
        and(
          eq(schema.pluginsTable.githubAppConfigId, id),
          notDeleted(schema.pluginsTable),
        ),
      );
    return result?.count ?? 0;
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [plugin] = await db
      .select()
      .from(schema.pluginsTable)
      .where(
        and(
          eq(schema.pluginsTable.id, id),
          eq(schema.pluginsTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!plugin) return null;
    const files = await PluginModel.findFiles(plugin.id);
    const [teamsByPlugin, usersByPlugin] = await Promise.all([
      PluginTeamModel.getTeamDetailsForPlugins([plugin.id]),
      PluginUserModel.getUserDetailsForPlugins([plugin.id]),
    ]);
    return {
      ...plugin,
      teams: teamsByPlugin.get(plugin.id) ?? [],
      users: usersByPlugin.get(plugin.id) ?? [],
      files: files.map(({ path, encoding, mode, digest }) => ({
        path,
        encoding,
        mode,
        digest,
      })),
    };
  }

  private static async findRow(params: {
    id: string;
    organizationId: string;
  }): Promise<Plugin | null> {
    return findRowWithTransaction(db, params);
  }

  private static async findFiles(pluginId: string): Promise<PluginFile[]> {
    return findFilesWithTransaction(db, pluginId);
  }
}

export default PluginModel;

// === Internal helpers ===

function derivePluginSlug(displayName: string, id: string): string {
  const base =
    urlSlugify(displayName).slice(0, 39).replace(/-+$/g, "") || "plugin";
  return `${base}-${id.replaceAll("-", "").slice(0, 8)}`;
}

function computeContentHash(files: PluginFileInput[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.mode);
    hash.update("\0");
    hash.update(file.encoding);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function computeFileDigest(file: PluginFileInput): string {
  const bytes =
    file.encoding === "base64"
      ? Buffer.from(file.content, "base64")
      : Buffer.from(file.content, "utf8");
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function insertFiles(
  tx: Transaction,
  pluginId: string,
  files: PluginFileInput[],
): Promise<PluginFile[]> {
  return await tx
    .insert(schema.pluginFilesTable)
    .values(
      files.map((file) => ({
        ...file,
        pluginId,
        digest: computeFileDigest(file),
      })),
    )
    .returning();
}

async function attachFilesAndVisibilityInIdOrder(
  plugins: Plugin[],
  orderedIds: string[],
): Promise<PluginWithFiles[]> {
  if (plugins.length === 0) return [];
  const pluginIds = plugins.map((plugin) => plugin.id);
  const files = await db
    .select()
    .from(schema.pluginFilesTable)
    .where(inArray(schema.pluginFilesTable.pluginId, pluginIds))
    .orderBy(
      asc(schema.pluginFilesTable.pluginId),
      asc(schema.pluginFilesTable.path),
    );
  const filesByPlugin = new Map<string, PluginFile[]>();
  for (const file of files) {
    const list = filesByPlugin.get(file.pluginId) ?? [];
    list.push(file);
    filesByPlugin.set(file.pluginId, list);
  }
  const visible = await attachVisibility(plugins);
  const pluginById = new Map(visible.map((plugin) => [plugin.id, plugin]));
  return orderedIds.flatMap((id) => {
    const plugin = pluginById.get(id);
    return plugin ? [{ ...plugin, files: filesByPlugin.get(id) ?? [] }] : [];
  });
}

async function attachVisibility(plugins: Plugin[]) {
  const ids = plugins.map((plugin) => plugin.id);
  const [teamsByPlugin, usersByPlugin] = await Promise.all([
    PluginTeamModel.getTeamDetailsForPlugins(ids),
    PluginUserModel.getUserDetailsForPlugins(ids),
  ]);
  return plugins.map((plugin) => ({
    ...plugin,
    teams: teamsByPlugin.get(plugin.id) ?? [],
    users: usersByPlugin.get(plugin.id) ?? [],
  }));
}

async function findRowWithTransaction(
  tx: Pick<typeof db, "select">,
  params: { id: string; organizationId: string },
): Promise<Plugin | null> {
  const [plugin] = await tx
    .select()
    .from(schema.pluginsTable)
    .where(
      and(
        eq(schema.pluginsTable.id, params.id),
        eq(schema.pluginsTable.organizationId, params.organizationId),
        notDeleted(schema.pluginsTable),
      ),
    )
    .limit(1);
  return plugin ?? null;
}

async function findFilesWithTransaction(
  tx: Pick<typeof db, "select">,
  pluginId: string,
): Promise<PluginFile[]> {
  return await tx
    .select()
    .from(schema.pluginFilesTable)
    .where(eq(schema.pluginFilesTable.pluginId, pluginId))
    .orderBy(asc(schema.pluginFilesTable.path));
}
