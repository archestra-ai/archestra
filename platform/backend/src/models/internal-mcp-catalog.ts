import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
} from "drizzle-orm";
import db, { schema } from "@/database";
import { secretManager } from "@/secrets-manager";
import {
  ENTERPRISE_MANAGED_CLIENT_SECRET_OVERRIDE_SECRET_KEY,
  type InsertInternalMcpCatalog,
  type InternalMcpCatalog,
  type ListInternalMcpCatalog,
  type PresetFieldValues,
  type UpdateInternalMcpCatalog,
  type UserConfigFieldDefault,
} from "@/types";
import McpCatalogLabelModel from "./mcp-catalog-label";
import McpCatalogTeamModel from "./mcp-catalog-team";
import McpServerModel from "./mcp-server";
import SecretModel from "./secret";

class InternalMcpCatalogModel {
  static async create(
    catalogItem: InsertInternalMcpCatalog,
    context?: { organizationId: string; authorId?: string },
  ): Promise<InternalMcpCatalog> {
    const { labels, teams, ...dbValues } = catalogItem;

    // Child catalog items ("presets") store the composed name
    // `${parent.name}-${childName}`; root items store name as submitted.
    if (dbValues.parentCatalogItemId) {
      if (!dbValues.childName) {
        throw new Error(
          "childName is required when parentCatalogItemId is set",
        );
      }
      const [parent] = await db
        .select({ name: schema.internalMcpCatalogTable.name })
        .from(schema.internalMcpCatalogTable)
        .where(
          eq(schema.internalMcpCatalogTable.id, dbValues.parentCatalogItemId),
        );
      if (!parent) {
        throw new Error(
          `Parent catalog item ${dbValues.parentCatalogItemId} not found`,
        );
      }
      dbValues.name = `${parent.name}-${dbValues.childName}`;
    } else {
      // Root rows never carry a childName.
      dbValues.childName = null;
    }

    const insertValues = {
      ...dbValues,
      ...(context?.organizationId
        ? { organizationId: context.organizationId }
        : {}),
      ...(context?.authorId ? { authorId: context.authorId } : {}),
    };

    const [createdItem] = await db
      .insert(schema.internalMcpCatalogTable)
      .values(insertValues)
      .returning();

    if (labels && labels.length > 0) {
      await McpCatalogLabelModel.syncCatalogLabels(
        createdItem.id,
        labels.map((l) => ({ key: l.key, value: l.value })),
      );
    }

    if (teams && teams.length > 0) {
      await McpCatalogTeamModel.syncCatalogTeams(createdItem.id, teams);
    }

    const itemLabels = await McpCatalogLabelModel.getLabelsForCatalogItem(
      createdItem.id,
    );
    const itemTeams = await McpCatalogTeamModel.getTeamDetailsForCatalog(
      createdItem.id,
    );

    const result: InternalMcpCatalog = {
      ...createdItem,
      labels: itemLabels,
      teams: itemTeams,
    };
    await InternalMcpCatalogModel.populateAuthorNames([result]);
    return result;
  }

  static async findAll(options?: {
    expandSecrets?: boolean;
    userId?: string;
    isAdmin?: boolean;
    organizationId?: string;
    includeChildren?: boolean;
  }): Promise<ListInternalMcpCatalog[]> {
    const {
      expandSecrets = true,
      userId,
      isAdmin,
      organizationId,
      includeChildren = false,
    } = options ?? {};

    let dbItems: Array<typeof schema.internalMcpCatalogTable.$inferSelect>;

    const parentOnlyCondition = includeChildren
      ? undefined
      : isNull(schema.internalMcpCatalogTable.parentCatalogItemId);

    if (userId && !isAdmin && !organizationId) {
      return [];
    }

    if (userId && organizationId) {
      const accessibleIds =
        await McpCatalogTeamModel.getUserAccessibleCatalogIds(
          userId,
          !!isAdmin,
          organizationId,
        );
      if (accessibleIds.length === 0) return [];
      const where = parentOnlyCondition
        ? and(
            inArray(schema.internalMcpCatalogTable.id, accessibleIds),
            parentOnlyCondition,
          )
        : inArray(schema.internalMcpCatalogTable.id, accessibleIds);
      dbItems = await db
        .select()
        .from(schema.internalMcpCatalogTable)
        .where(where)
        .orderBy(desc(schema.internalMcpCatalogTable.createdAt));
    } else {
      const baseQuery = db.select().from(schema.internalMcpCatalogTable);
      dbItems = await (parentOnlyCondition
        ? baseQuery.where(parentOnlyCondition)
        : baseQuery
      ).orderBy(desc(schema.internalMcpCatalogTable.createdAt));
    }

    const catalogItems =
      await InternalMcpCatalogModel.attachListMetadata(dbItems);

    if (expandSecrets) {
      await InternalMcpCatalogModel.expandSecrets(catalogItems);
    }

    await InternalMcpCatalogModel.populateAuthorNames(catalogItems);

    return catalogItems;
  }

  static async searchByQuery(
    query: string,
    options?: {
      expandSecrets?: boolean;
      userId?: string;
      isAdmin?: boolean;
      organizationId?: string;
      includeChildren?: boolean;
    },
  ): Promise<ListInternalMcpCatalog[]> {
    const {
      expandSecrets = true,
      userId,
      isAdmin,
      organizationId,
      includeChildren = false,
    } = options ?? {};

    let dbItems: Array<typeof schema.internalMcpCatalogTable.$inferSelect>;

    const baseSearchCondition = or(
      ilike(schema.internalMcpCatalogTable.name, `%${query}%`),
      ilike(schema.internalMcpCatalogTable.description, `%${query}%`),
    );

    const searchCondition = includeChildren
      ? baseSearchCondition
      : and(
          baseSearchCondition,
          isNull(schema.internalMcpCatalogTable.parentCatalogItemId),
        );

    if (userId && !isAdmin && !organizationId) {
      return [];
    }

    if (userId && organizationId) {
      const accessibleIds =
        await McpCatalogTeamModel.getUserAccessibleCatalogIds(
          userId,
          !!isAdmin,
          organizationId,
        );
      if (accessibleIds.length === 0) return [];
      dbItems = await db
        .select()
        .from(schema.internalMcpCatalogTable)
        .where(
          and(
            inArray(schema.internalMcpCatalogTable.id, accessibleIds),
            searchCondition,
          ),
        );
    } else {
      dbItems = await db
        .select()
        .from(schema.internalMcpCatalogTable)
        .where(searchCondition);
    }

    const catalogItems =
      await InternalMcpCatalogModel.attachListMetadata(dbItems);

    if (expandSecrets) {
      await InternalMcpCatalogModel.expandSecrets(catalogItems);
    }

    await InternalMcpCatalogModel.populateAuthorNames(catalogItems);

    return catalogItems;
  }

  /**
   * Return the singular catalog shape. Do not add toolCount here: it is list
   * metadata used by registry/card UIs and would require an otherwise-unused
   * COUNT(*) on runtime paths that fetch one catalog item by id.
   */
  static async findById(
    id: string,
    options?: {
      expandSecrets?: boolean;
      userId?: string;
      isAdmin?: boolean;
      organizationId?: string;
    },
  ): Promise<InternalMcpCatalog | null> {
    const {
      expandSecrets = true,
      userId,
      isAdmin,
      organizationId,
    } = options ?? {};

    if (userId && !isAdmin && !organizationId) {
      return null;
    }

    if (userId && organizationId) {
      const hasAccess = await McpCatalogTeamModel.userHasCatalogAccess(
        userId,
        id,
        !!isAdmin,
        organizationId,
      );
      if (!hasAccess) return null;
    }

    const [dbItem] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, id));

    if (!dbItem) {
      return null;
    }

    const labels = await McpCatalogLabelModel.getLabelsForCatalogItem(id);
    const teams = await McpCatalogTeamModel.getTeamDetailsForCatalog(id);
    const catalogItem: InternalMcpCatalog = {
      ...dbItem,
      labels,
      teams,
    };

    if (expandSecrets) {
      await InternalMcpCatalogModel.expandSecrets([catalogItem]);
    }

    await InternalMcpCatalogModel.populateAuthorNames([catalogItem]);

    return catalogItem;
  }

  /**
   * Find catalog item by ID with all secrets resolved to actual values.
   * Use this for runtime flows (OAuth, MCP server startup).
   */
  static async findByIdWithResolvedSecrets(
    id: string,
  ): Promise<InternalMcpCatalog | null> {
    const [dbItem] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, id));

    if (!dbItem) {
      return null;
    }

    const labels = await McpCatalogLabelModel.getLabelsForCatalogItem(id);
    const teams = await McpCatalogTeamModel.getTeamDetailsForCatalog(id);
    const catalogItem: InternalMcpCatalog = {
      ...dbItem,
      labels,
      teams,
    };

    await InternalMcpCatalogModel.expandSecretsAndAlwaysResolveValues([
      catalogItem,
    ]);

    return catalogItem;
  }

  /**
   * Batch fetch multiple catalog items by IDs.
   * Returns a Map of catalog ID to catalog item.
   */
  static async getByIds(
    ids: string[],
  ): Promise<Map<string, ListInternalMcpCatalog>> {
    if (ids.length === 0) {
      return new Map();
    }

    const dbItems = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(inArray(schema.internalMcpCatalogTable.id, ids));

    const catalogItems =
      await InternalMcpCatalogModel.attachListMetadata(dbItems);

    const result = new Map<string, ListInternalMcpCatalog>();
    for (const item of catalogItems) {
      result.set(item.id, item);
    }

    return result;
  }

  static async findByName(
    name: string,
    options?: { organizationId?: string },
  ): Promise<InternalMcpCatalog | null> {
    const whereCondition = options?.organizationId
      ? and(
          eq(schema.internalMcpCatalogTable.name, name),
          eq(
            schema.internalMcpCatalogTable.organizationId,
            options.organizationId,
          ),
        )
      : eq(schema.internalMcpCatalogTable.name, name);

    const [dbItem] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(whereCondition);

    if (!dbItem) {
      return null;
    }

    const labels = await McpCatalogLabelModel.getLabelsForCatalogItem(
      dbItem.id,
    );
    const teams = await McpCatalogTeamModel.getTeamDetailsForCatalog(dbItem.id);
    return { ...dbItem, labels, teams };
  }

  static async update(
    id: string,
    catalogItem: Partial<UpdateInternalMcpCatalog>,
  ): Promise<InternalMcpCatalog | null> {
    const { labels, teams, ...dbValues } = catalogItem;

    // Name immutability: matches the existing UI-enforced posture and avoids
    // cascading rename to k8s deployment names and pre-slugified tool rows.
    if (dbValues.name !== undefined || dbValues.childName !== undefined) {
      const [existing] = await db
        .select({
          name: schema.internalMcpCatalogTable.name,
          childName: schema.internalMcpCatalogTable.childName,
        })
        .from(schema.internalMcpCatalogTable)
        .where(eq(schema.internalMcpCatalogTable.id, id));
      if (existing) {
        if (dbValues.name !== undefined && dbValues.name !== existing.name) {
          throw new Error("Catalog item name cannot be changed after creation");
        }
        if (
          dbValues.childName !== undefined &&
          dbValues.childName !== existing.childName
        ) {
          throw new Error("Preset childName cannot be changed after creation");
        }
      }
      delete dbValues.name;
      delete dbValues.childName;
    }

    let dbItem: typeof schema.internalMcpCatalogTable.$inferSelect | undefined;

    if (Object.keys(dbValues).length > 0) {
      [dbItem] = await db
        .update(schema.internalMcpCatalogTable)
        .set(dbValues)
        .where(eq(schema.internalMcpCatalogTable.id, id))
        .returning();
    } else {
      [dbItem] = await db
        .select()
        .from(schema.internalMcpCatalogTable)
        .where(eq(schema.internalMcpCatalogTable.id, id));
    }

    if (!dbItem) {
      return null;
    }

    if (labels !== undefined) {
      await McpCatalogLabelModel.syncCatalogLabels(
        id,
        labels.map((l) => ({ key: l.key, value: l.value })),
      );
    }

    if (teams !== undefined) {
      await McpCatalogTeamModel.syncCatalogTeams(id, teams);
    }

    const itemLabels = await McpCatalogLabelModel.getLabelsForCatalogItem(id);
    const itemTeams = await McpCatalogTeamModel.getTeamDetailsForCatalog(id);
    const result: InternalMcpCatalog = {
      ...dbItem,
      labels: itemLabels,
      teams: itemTeams,
    };
    await InternalMcpCatalogModel.populateAuthorNames([result]);
    return result;
  }

  /**
   * List child catalog items ("presets") for a given parent.
   *
   * Mirrors the catalog list endpoint: secrets are NOT expanded, so the
   * preset secret bag's plaintext values never reach the wire. Callers that
   * need to know whether secret-typed preset fields are filled use the
   * `presetSecretId != null` heuristic (same pattern as the install dialog's
   * preset-fallback-fields).
   */
  static async findChildren(parentId: string): Promise<InternalMcpCatalog[]> {
    const dbItems = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.parentCatalogItemId, parentId))
      .orderBy(asc(schema.internalMcpCatalogTable.createdAt));

    return InternalMcpCatalogModel.attachListMetadata(dbItems);
  }

  /**
   * Validate a `presetFieldValues` payload against a parent's userConfig and
   * localConfig.environment field-scope flags. Only fields flagged
   * `promptOnPreset: true` are allowed; throws an Error listing offenders
   * when any other key is present.
   */
  static validateFieldValuesAgainstCatalog(
    parent: InternalMcpCatalog,
    fieldValues: PresetFieldValues | undefined,
  ): void {
    if (!fieldValues) return;
    const presetKeys = new Set<string>();
    for (const [key, field] of Object.entries(parent.userConfig ?? {})) {
      if (field.promptOnPreset) presetKeys.add(key);
    }
    for (const env of parent.localConfig?.environment ?? []) {
      if (env.promptOnPreset) presetKeys.add(env.key);
    }

    const offenders = Object.keys(fieldValues).filter(
      (key) => !presetKeys.has(key),
    );
    if (offenders.length > 0) {
      throw new Error(
        `Fields not configured for preset overrides: ${offenders.join(", ")}`,
      );
    }
  }

  static async delete(id: string): Promise<boolean> {
    // First, find all servers associated with this catalog item
    const servers = await McpServerModel.findByCatalogId(id);

    // Delete each server (which will cascade to tools)
    for (const server of servers) {
      await McpServerModel.delete(server.id);
    }

    // Then delete the catalog entry itself
    const deletedRows = await db
      .delete(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, id))
      .returning({ id: schema.internalMcpCatalogTable.id });

    return deletedRows.length > 0;
  }

  // ===== Private methods =====

  /**
   * Expands secrets and adds them to the catalog items, mutating the items.
   * For BYOS secrets (isByosVault=true), returns vault references / paths as-is.
   * For non-BYOS secrets, resolves actual values via secretManager().
   */
  private static async expandSecrets(
    catalogItems: InternalMcpCatalog[],
  ): Promise<void> {
    // Collect all unique secret IDs
    const secretIds = new Set<string>();
    for (const item of catalogItems) {
      if (item.clientSecretId) secretIds.add(item.clientSecretId);
      if (item.localConfigSecretId) secretIds.add(item.localConfigSecretId);
      if (item.presetSecretId) secretIds.add(item.presetSecretId);
    }

    if (secretIds.size === 0) return;

    // Fetch raw secret records e.g. vault paths, not resolved to actual value)
    const unresolvedSecretPromises = Array.from(secretIds).map((id) =>
      SecretModel.findById(id).then((secret) => [id, secret] as const),
    );
    const unresolvedSecretEntries = await Promise.all(unresolvedSecretPromises);
    const unresolvedSecretMap = new Map(
      unresolvedSecretEntries.filter(
        (entry): entry is [string, NonNullable<(typeof entry)[1]>] =>
          entry[1] !== null,
      ),
    );

    // For non-BYOS secrets, resolve them using secretManager
    const nonByosSecretIds = Array.from(secretIds).filter(
      (id) => !unresolvedSecretMap.get(id)?.isByosVault,
    );
    const resolvedSecretPromises = nonByosSecretIds.map((id) =>
      secretManager()
        .getSecret(id)
        .then((secret) => [id, secret] as const),
    );
    const resolvedSecretEntries = await Promise.all(resolvedSecretPromises);
    const resolvedSecretMap = new Map(
      resolvedSecretEntries.filter(
        (entry): entry is [string, NonNullable<(typeof entry)[1]>] =>
          entry[1] !== null,
      ),
    );

    // Enrich each catalog item
    for (const catalogItem of catalogItems) {
      // Enrich OAuth client_secret
      if (catalogItem.clientSecretId && catalogItem.oauthConfig) {
        const unresolvedSecret = unresolvedSecretMap.get(
          catalogItem.clientSecretId,
        );
        // For BYOS: use raw vault reference, for non-BYOS: use resolved value
        const secret = unresolvedSecret?.isByosVault
          ? unresolvedSecret
          : resolvedSecretMap.get(catalogItem.clientSecretId);
        const value = secret?.secret.client_secret;
        if (value) {
          catalogItem.oauthConfig.client_secret = String(value);
        }
      }

      if (catalogItem.clientSecretId && catalogItem.enterpriseManagedConfig) {
        const unresolvedSecret = unresolvedSecretMap.get(
          catalogItem.clientSecretId,
        );
        const secret = unresolvedSecret?.isByosVault
          ? unresolvedSecret
          : resolvedSecretMap.get(catalogItem.clientSecretId);
        const value =
          secret?.secret[ENTERPRISE_MANAGED_CLIENT_SECRET_OVERRIDE_SECRET_KEY];
        if (value) {
          catalogItem.enterpriseManagedConfig.clientSecretOverride =
            String(value);
        }
      }

      // Enrich local config secret env vars
      if (
        catalogItem.localConfigSecretId &&
        catalogItem.localConfig?.environment
      ) {
        const unresolvedSecret = unresolvedSecretMap.get(
          catalogItem.localConfigSecretId,
        );
        // For BYOS: use raw vault reference, for non-BYOS: use resolved value
        const secret = unresolvedSecret?.isByosVault
          ? unresolvedSecret
          : resolvedSecretMap.get(catalogItem.localConfigSecretId);
        if (secret) {
          for (const envVar of catalogItem.localConfig.environment) {
            const value = secret.secret[envVar.key];
            if (envVar.type === "secret" && value) {
              envVar.value = String(value);
            }
          }
        }
      }

      // Enrich preset secret values (merge into presetFieldValues)
      if (catalogItem.presetSecretId) {
        const unresolvedSecret = unresolvedSecretMap.get(
          catalogItem.presetSecretId,
        );
        const secret = unresolvedSecret?.isByosVault
          ? unresolvedSecret
          : resolvedSecretMap.get(catalogItem.presetSecretId);
        if (secret) {
          catalogItem.presetFieldValues = {
            ...catalogItem.presetFieldValues,
            ...(secret.secret as Record<string, UserConfigFieldDefault>),
          };
        }
      }
    }
  }

  /**
   * Always resolves all secrets to their actual values.
   * Use this for runtime flows (OAuth, MCP server startup) that need real secret values.
   */
  private static async expandSecretsAndAlwaysResolveValues(
    catalogItems: InternalMcpCatalog[],
  ): Promise<void> {
    const secretIds = new Set<string>();
    for (const item of catalogItems) {
      if (item.clientSecretId) secretIds.add(item.clientSecretId);
      if (item.localConfigSecretId) secretIds.add(item.localConfigSecretId);
      if (item.presetSecretId) secretIds.add(item.presetSecretId);
    }

    if (secretIds.size === 0) return;

    // Always resolve using secretManager (resolves BYOS vault references to actual values)
    const secretPromises = Array.from(secretIds).map((id) =>
      secretManager()
        .getSecret(id)
        .then((secret) => [id, secret] as const),
    );
    const secretEntries = await Promise.all(secretPromises);
    const secretMap = new Map(
      secretEntries.filter(
        (entry): entry is [string, NonNullable<(typeof entry)[1]>] =>
          entry[1] !== null,
      ),
    );

    for (const catalogItem of catalogItems) {
      if (catalogItem.clientSecretId && catalogItem.oauthConfig) {
        const secret = secretMap.get(catalogItem.clientSecretId);
        const value = secret?.secret.client_secret;
        if (value) {
          catalogItem.oauthConfig.client_secret = String(value);
        }
      }

      if (catalogItem.clientSecretId && catalogItem.enterpriseManagedConfig) {
        const secret = secretMap.get(catalogItem.clientSecretId);
        const value =
          secret?.secret[ENTERPRISE_MANAGED_CLIENT_SECRET_OVERRIDE_SECRET_KEY];
        if (value) {
          catalogItem.enterpriseManagedConfig.clientSecretOverride =
            String(value);
        }
      }

      if (
        catalogItem.localConfigSecretId &&
        catalogItem.localConfig?.environment
      ) {
        const secret = secretMap.get(catalogItem.localConfigSecretId);
        if (secret) {
          for (const envVar of catalogItem.localConfig.environment) {
            const value = secret.secret[envVar.key];
            if (envVar.type === "secret" && value) {
              envVar.value = String(value);
            }
          }
        }
      }

      // Preset secret values
      if (catalogItem.presetSecretId) {
        const secret = secretMap.get(catalogItem.presetSecretId);
        if (secret) {
          catalogItem.presetFieldValues = {
            ...catalogItem.presetFieldValues,
            ...(secret.secret as Record<string, UserConfigFieldDefault>),
          };
        }
      }
    }
  }

  /**
   * Bulk-load list metadata for an array of DB rows and attach it.
   */
  private static async attachListMetadata(
    dbItems: Array<typeof schema.internalMcpCatalogTable.$inferSelect>,
  ): Promise<ListInternalMcpCatalog[]> {
    if (dbItems.length === 0) {
      return [];
    }

    const ids = dbItems.map((item) => item.id);
    const [labelsMap, teamsMap, toolCountMap] = await Promise.all([
      McpCatalogLabelModel.getLabelsForCatalogItems(ids),
      McpCatalogTeamModel.getTeamDetailsForCatalogs(ids),
      InternalMcpCatalogModel.getToolCounts(ids),
    ]);

    return dbItems.map((item) => ({
      ...item,
      labels: labelsMap.get(item.id) || [],
      teams: teamsMap.get(item.id) || [],
      toolCount: toolCountMap.get(item.id) ?? 0,
    }));
  }

  private static async getToolCounts(
    catalogIds: string[],
  ): Promise<Map<string, number>> {
    if (catalogIds.length === 0) {
      return new Map();
    }

    const rows = await db
      .select({
        catalogId: schema.toolsTable.catalogId,
        toolCount: count(schema.toolsTable.id),
      })
      .from(schema.toolsTable)
      .where(inArray(schema.toolsTable.catalogId, catalogIds))
      .groupBy(schema.toolsTable.catalogId);

    return new Map(
      rows
        .filter(
          (row): row is { catalogId: string; toolCount: number } =>
            row.catalogId !== null,
        )
        .map((row) => [row.catalogId, row.toolCount]),
    );
  }

  /**
   * Populate authorName for catalog items that have an authorId.
   */
  private static async populateAuthorNames(
    catalogItems: InternalMcpCatalog[],
  ): Promise<void> {
    const authorIds = new Set<string>();
    for (const item of catalogItems) {
      if (item.authorId) authorIds.add(item.authorId);
    }

    if (authorIds.size === 0) return;

    const users = await db
      .select({ id: schema.usersTable.id, name: schema.usersTable.name })
      .from(schema.usersTable)
      .where(inArray(schema.usersTable.id, Array.from(authorIds)));

    const nameMap = new Map(users.map((u) => [u.id, u.name]));

    for (const item of catalogItems) {
      item.authorName = item.authorId
        ? (nameMap.get(item.authorId) ?? null)
        : null;
    }
  }
}

export default InternalMcpCatalogModel;
