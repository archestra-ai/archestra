import { and, desc, eq, ilike, inArray, or } from "drizzle-orm";
import db, { schema } from "@/database";
import { secretManager } from "@/secrets-manager";
import type {
  InsertInternalMcpCatalog,
  InternalMcpCatalog,
  UpdateInternalMcpCatalog,
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
  }): Promise<InternalMcpCatalog[]> {
    const { expandSecrets = true, userId, isAdmin } = options ?? {};

    let dbItems: Array<typeof schema.internalMcpCatalogTable.$inferSelect>;

    if (userId && !isAdmin) {
      const accessibleIds =
        await McpCatalogTeamModel.getUserAccessibleCatalogIds(userId, false);
      if (accessibleIds.length === 0) return [];
      dbItems = await db
        .select()
        .from(schema.internalMcpCatalogTable)
        .where(inArray(schema.internalMcpCatalogTable.id, accessibleIds))
        .orderBy(desc(schema.internalMcpCatalogTable.createdAt));
    } else {
      dbItems = await db
        .select()
        .from(schema.internalMcpCatalogTable)
        .orderBy(desc(schema.internalMcpCatalogTable.createdAt));
    }

    const catalogItems =
      await InternalMcpCatalogModel.attachLabelsAndTeams(dbItems);

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
    },
  ): Promise<InternalMcpCatalog[]> {
    const { expandSecrets = true, userId, isAdmin } = options ?? {};

    let dbItems: Array<typeof schema.internalMcpCatalogTable.$inferSelect>;

    const searchCondition = or(
      ilike(schema.internalMcpCatalogTable.name, `%${query}%`),
      ilike(schema.internalMcpCatalogTable.description, `%${query}%`),
    );

    if (userId && !isAdmin) {
      const accessibleIds =
        await McpCatalogTeamModel.getUserAccessibleCatalogIds(userId, false);
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
      await InternalMcpCatalogModel.attachLabelsAndTeams(dbItems);

    if (expandSecrets) {
      await InternalMcpCatalogModel.expandSecrets(catalogItems);
    }

    await InternalMcpCatalogModel.populateAuthorNames(catalogItems);

    return catalogItems;
  }

  static async findById(
    id: string,
    options?: {
      expandSecrets?: boolean;
      userId?: string;
      isAdmin?: boolean;
    },
  ): Promise<InternalMcpCatalog | null> {
    const { expandSecrets = true, userId, isAdmin } = options ?? {};

    if (userId && !isAdmin) {
      const hasAccess = await McpCatalogTeamModel.userHasCatalogAccess(
        userId,
        id,
        false,
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
    const catalogItem: InternalMcpCatalog = { ...dbItem, labels, teams };

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
    const catalogItem: InternalMcpCatalog = { ...dbItem, labels, teams };

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
  ): Promise<Map<string, InternalMcpCatalog>> {
    if (ids.length === 0) {
      return new Map();
    }

    const dbItems = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(inArray(schema.internalMcpCatalogTable.id, ids));

    const catalogItems =
      await InternalMcpCatalogModel.attachLabelsAndTeams(dbItems);

    const result = new Map<string, InternalMcpCatalog>();
    for (const item of catalogItems) {
      result.set(item.id, item);
    }

    return result;
  }

  static async findByName(name: string): Promise<InternalMcpCatalog | null> {
    const [dbItem] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.name, name));

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

  static async delete(id: string): Promise<boolean> {
    // First, find all servers associated with this catalog item
    const servers = await McpServerModel.findByCatalogId(id);

    // Delete each server (which will cascade to tools)
    for (const server of servers) {
      await McpServerModel.delete(server.id);
    }

    // Then delete the catalog entry itself
    const result = await db
      .delete(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, id));

    return result.rowCount !== null && result.rowCount > 0;
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
    }
  }

  /**
   * Bulk-load labels and teams for an array of DB rows and attach them.
   */
  private static async attachLabelsAndTeams(
    dbItems: Array<typeof schema.internalMcpCatalogTable.$inferSelect>,
  ): Promise<InternalMcpCatalog[]> {
    if (dbItems.length === 0) {
      return [];
    }

    const ids = dbItems.map((item) => item.id);
    const [labelsMap, teamsMap] = await Promise.all([
      McpCatalogLabelModel.getLabelsForCatalogItems(ids),
      McpCatalogTeamModel.getTeamDetailsForCatalogs(ids),
    ]);

    return dbItems.map((item) => ({
      ...item,
      labels: labelsMap.get(item.id) || [],
      teams: teamsMap.get(item.id) || [],
    }));
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
