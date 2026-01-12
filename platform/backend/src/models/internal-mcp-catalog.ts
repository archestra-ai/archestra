import { ARCHESTRA_MCP_CATALOG_ID } from "@shared";
import { desc, eq, ilike, inArray, or } from "drizzle-orm";
import db, { schema } from "@/database";
import { secretManager } from "@/secrets-manager";
import type {
  InsertInternalMcpCatalog,
  InternalMcpCatalog,
  UpdateInternalMcpCatalog,
} from "@/types";
import McpServerModel from "./mcp-server";
import SecretModel from "./secret";

/**
 * Virtual Archestra catalog entry that is not stored in the database.
 * This allows the Archestra MCP server to appear in the UI like other servers
 * without requiring database seeding.
 */
function getVirtualArchestraCatalog(): InternalMcpCatalog {
  const now = new Date();
  return {
    id: ARCHESTRA_MCP_CATALOG_ID,
    name: "Archestra",
    description:
      "Built-in Archestra tools for managing profiles, limits, policies, and MCP servers.",
    instructions: null,
    docsUrl: null,
    serverType: "builtin",
    serverUrl: null,
    version: null,
    repository: null,
    installationCommand: null,
    requiresAuth: false,
    authDescription: null,
    authFields: [], // Use empty array (matches database default)
    userConfig: {}, // Use empty object (matches database default)
    oauthConfig: null,
    localConfig: null,
    clientSecretId: null,
    localConfigSecretId: null,
    createdAt: now,
    updatedAt: now,
  };
}

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
    const [createdItem] = await db
      .insert(schema.internalMcpCatalogTable)
      .values(catalogItem)
      .returning();

    return createdItem;
  }

  static async findAll(options?: {
    expandSecrets?: boolean;
  }): Promise<InternalMcpCatalog[]> {
    const { expandSecrets = true } = options ?? {};

    const catalogItems = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .orderBy(desc(schema.internalMcpCatalogTable.createdAt));

    if (expandSecrets) {
      await InternalMcpCatalogModel.expandSecrets(catalogItems);
    }

    // Filter out the Archestra entry from DB (it's added as virtual below)
    // The DB entry exists only to satisfy FK constraint for tools
    const nonArchestraItems = catalogItems.filter(
      (item) => item.id !== ARCHESTRA_MCP_CATALOG_ID,
    );

    // Include the virtual Archestra catalog entry at the beginning
    return [getVirtualArchestraCatalog(), ...nonArchestraItems];
  }

  static async searchByQuery(
    query: string,
    options?: { expandSecrets?: boolean },
  ): Promise<InternalMcpCatalog[]> {
    const { expandSecrets = true } = options ?? {};

    const catalogItems = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(
        or(
          ilike(schema.internalMcpCatalogTable.name, `%${query}%`),
          ilike(schema.internalMcpCatalogTable.description, `%${query}%`),
        ),
      );

    if (expandSecrets) {
      await InternalMcpCatalogModel.expandSecrets(catalogItems);
    }

    // Filter out Archestra from DB results (it's handled as virtual catalog)
    const nonArchestraItems = catalogItems.filter(
      (item) => item.id !== ARCHESTRA_MCP_CATALOG_ID,
    );

    // Check if Archestra matches the search query
    const archestraCatalog = getVirtualArchestraCatalog();
    const lowerQuery = query.toLowerCase();
    const archestraMatches =
      archestraCatalog.name.toLowerCase().includes(lowerQuery) ||
      (archestraCatalog.description?.toLowerCase().includes(lowerQuery) ??
        false);

    if (archestraMatches) {
      return [archestraCatalog, ...nonArchestraItems];
    }

    return nonArchestraItems;
  }

  static async findById(
    id: string,
    options?: { expandSecrets?: boolean },
  ): Promise<InternalMcpCatalog | null> {
    // Return virtual Archestra catalog if requested
    if (id === ARCHESTRA_MCP_CATALOG_ID) {
      return getVirtualArchestraCatalog();
    }

    const { expandSecrets = true } = options ?? {};

    const [catalogItem] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, id));

    if (!catalogItem) {
      return null;
    }

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
    // Return virtual Archestra catalog if requested (no secrets to resolve)
    if (id === ARCHESTRA_MCP_CATALOG_ID) {
      return getVirtualArchestraCatalog();
    }

    const [catalogItem] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, id));

    if (!catalogItem) {
      return null;
    }

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

    const result = new Map<string, InternalMcpCatalog>();

    // Check if Archestra catalog is requested
    if (ids.includes(ARCHESTRA_MCP_CATALOG_ID)) {
      result.set(ARCHESTRA_MCP_CATALOG_ID, getVirtualArchestraCatalog());
    }

    // Filter out Archestra ID for database query
    const dbIds = ids.filter((id) => id !== ARCHESTRA_MCP_CATALOG_ID);
    if (dbIds.length > 0) {
      const catalogItems = await db
        .select()
        .from(schema.internalMcpCatalogTable)
        .where(inArray(schema.internalMcpCatalogTable.id, dbIds));

      for (const item of catalogItems) {
        result.set(item.id, item);
      }
    }

    return result;
  }

  static async findByName(name: string): Promise<InternalMcpCatalog | null> {
    // Check for virtual Archestra catalog
    const archestraCatalog = getVirtualArchestraCatalog();
    if (name.toLowerCase() === archestraCatalog.name.toLowerCase()) {
      return archestraCatalog;
    }

    const [catalogItem] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.name, name));

    return catalogItem || null;
  }

  static async update(
    id: string,
    catalogItem: Partial<UpdateInternalMcpCatalog>,
  ): Promise<InternalMcpCatalog | null> {
    const [updatedItem] = await db
      .update(schema.internalMcpCatalogTable)
      .set(catalogItem)
      .where(eq(schema.internalMcpCatalogTable.id, id))
      .returning();

    return updatedItem || null;
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
