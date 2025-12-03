import { desc, eq, ilike, inArray, or } from "drizzle-orm";
import db, { schema } from "@/database";
import { secretManager } from "@/secretsmanager";
import type {
  InsertInternalMcpCatalog,
  InternalMcpCatalog,
  UpdateInternalMcpCatalog,
} from "@/types";
import McpServerModel from "./mcp-server";

class InternalMcpCatalogModel {
  /**
   * Enrich catalog item with secrets from secret table.
   * This allows the UI to display secret values in edit forms.
   * Enriches both OAuth client_secret and local config secret env vars.
   */
  private static async enrichWithSecrets(
    catalogItem: InternalMcpCatalog,
  ): Promise<void> {
    // Enrich OAuth client_secret
    if (catalogItem.clientSecretId && catalogItem.oauthConfig) {
      const secret = await secretManager.getSecret(catalogItem.clientSecretId);
      if (secret?.secret.client_secret) {
        catalogItem.oauthConfig.client_secret = String(
          secret.secret.client_secret,
        );
      }
    }

    // Enrich local config secret env vars (both prompted and non-prompted)
    // Frontend will mask these with password inputs
    if (
      catalogItem.localConfigSecretId &&
      catalogItem.localConfig?.environment
    ) {
      const secret = await secretManager.getSecret(
        catalogItem.localConfigSecretId,
      );
      if (secret) {
        for (const envVar of catalogItem.localConfig.environment) {
          if (envVar.type === "secret" && secret.secret[envVar.key]) {
            envVar.value = String(secret.secret[envVar.key]);
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

  static async findAll(): Promise<InternalMcpCatalog[]> {
    const catalogItems = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .orderBy(desc(schema.internalMcpCatalogTable.createdAt));

    // Enrich all catalog items with secret values for edit forms
    await Promise.all(
      catalogItems.map((item) =>
        InternalMcpCatalogModel.enrichWithSecrets(item),
      ),
    );

    return catalogItems;
  }

  static async searchByQuery(query: string): Promise<InternalMcpCatalog[]> {
    const catalogItems = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(
        or(
          ilike(schema.internalMcpCatalogTable.name, `%${query}%`),
          ilike(schema.internalMcpCatalogTable.description, `%${query}%`),
        ),
      );

    // Enrich all catalog items with secret values for edit forms
    await Promise.all(
      catalogItems.map((item) =>
        InternalMcpCatalogModel.enrichWithSecrets(item),
      ),
    );

    return catalogItems;
  }

  static async findById(id: string): Promise<InternalMcpCatalog | null> {
    const [catalogItem] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, id));

    if (!catalogItem) {
      return null;
    }

    // Enrich with secret values for edit forms (OAuth client_secret and env vars)
    await InternalMcpCatalogModel.enrichWithSecrets(catalogItem);

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

    const catalogItems = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(inArray(schema.internalMcpCatalogTable.id, ids));

    return new Map(catalogItems.map((item) => [item.id, item]));
  }

  static async findByName(name: string): Promise<InternalMcpCatalog | null> {
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
