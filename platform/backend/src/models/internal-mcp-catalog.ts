import { desc, eq, ilike, inArray, or } from "drizzle-orm";
import db, { schema } from "@/database";
import { secretManager } from "@/secrets-manager";
import type {
  InsertInternalMcpCatalog,
  InternalMcpCatalog,
  UpdateInternalMcpCatalog,
} from "@/types";
import McpCatalogLabelModel from "./mcp-catalog-label";
import McpServerModel from "./mcp-server";
import SecretModel from "./secret";

class InternalMcpCatalogModel {
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

  static async create(
    catalogItem: InsertInternalMcpCatalog,
  ): Promise<InternalMcpCatalog> {
    const { labels, ...dbValues } = catalogItem;

    const [createdItem] = await db
      .insert(schema.internalMcpCatalogTable)
      .values(dbValues)
      .returning();

    if (labels && labels.length > 0) {
      await McpCatalogLabelModel.syncCatalogLabels(
        createdItem.id,
        labels.map((l) => ({ key: l.key, value: l.value })),
      );
    }

    const itemLabels = await McpCatalogLabelModel.getLabelsForCatalogItem(
      createdItem.id,
    );

    return { ...createdItem, labels: itemLabels };
  }

  static async findAll(options?: {
    expandSecrets?: boolean;
  }): Promise<InternalMcpCatalog[]> {
    const { expandSecrets = true } = options ?? {};

    const dbItems = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .orderBy(desc(schema.internalMcpCatalogTable.createdAt));

    const catalogItems = await InternalMcpCatalogModel.attachLabels(dbItems);

    if (expandSecrets) {
      await InternalMcpCatalogModel.expandSecrets(catalogItems);
    }

    return catalogItems;
  }

  static async searchByQuery(
    query: string,
    options?: { expandSecrets?: boolean },
  ): Promise<InternalMcpCatalog[]> {
    const { expandSecrets = true } = options ?? {};

    const dbItems = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(
        or(
          ilike(schema.internalMcpCatalogTable.name, `%${query}%`),
          ilike(schema.internalMcpCatalogTable.description, `%${query}%`),
        ),
      );

    const catalogItems = await InternalMcpCatalogModel.attachLabels(dbItems);

    if (expandSecrets) {
      await InternalMcpCatalogModel.expandSecrets(catalogItems);
    }

    return catalogItems;
  }

  static async findById(
    id: string,
    options?: { expandSecrets?: boolean },
  ): Promise<InternalMcpCatalog | null> {
    const { expandSecrets = true } = options ?? {};

    const [dbItem] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, id));

    if (!dbItem) {
      return null;
    }

    const labels = await McpCatalogLabelModel.getLabelsForCatalogItem(id);
    const catalogItem: InternalMcpCatalog = { ...dbItem, labels };

    if (expandSecrets) {
      await InternalMcpCatalogModel.expandSecrets([catalogItem]);
    }

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
    const catalogItem: InternalMcpCatalog = { ...dbItem, labels };

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

    const catalogItems = await InternalMcpCatalogModel.attachLabels(dbItems);

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
    return { ...dbItem, labels };
  }

  static async update(
    id: string,
    catalogItem: Partial<UpdateInternalMcpCatalog>,
  ): Promise<InternalMcpCatalog | null> {
    const { labels, ...dbValues } = catalogItem;

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

    const itemLabels = await McpCatalogLabelModel.getLabelsForCatalogItem(id);
    return { ...dbItem, labels: itemLabels };
  }

  /**
   * Bulk-load labels for an array of DB rows and attach them.
   */
  private static async attachLabels(
    dbItems: Array<typeof schema.internalMcpCatalogTable.$inferSelect>,
  ): Promise<InternalMcpCatalog[]> {
    if (dbItems.length === 0) {
      return [];
    }

    const labelsMap = await McpCatalogLabelModel.getLabelsForCatalogItems(
      dbItems.map((item) => item.id),
    );

    return dbItems.map((item) => ({
      ...item,
      labels: labelsMap.get(item.id) || [],
    }));
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
}

export default InternalMcpCatalogModel;
