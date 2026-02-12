import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { CimdUpsertData } from "@/types";

class OAuthClientModel {
  /**
   * Get the client name by OAuth client_id (the public-facing identifier).
   * Returns null if client not found or has no name.
   */
  static async getNameByClientId(clientId: string): Promise<string | null> {
    const [client] = await db
      .select({ name: schema.oauthClientsTable.name })
      .from(schema.oauthClientsTable)
      .where(eq(schema.oauthClientsTable.clientId, clientId))
      .limit(1);
    return client?.name ?? null;
  }

  /**
   * Check if a client exists by client_id.
   */
  static async existsByClientId(clientId: string): Promise<boolean> {
    const [client] = await db
      .select({ id: schema.oauthClientsTable.id })
      .from(schema.oauthClientsTable)
      .where(eq(schema.oauthClientsTable.clientId, clientId))
      .limit(1);
    return !!client;
  }

  /**
   * Atomically insert or update an OAuth client from a CIMD document.
   * Uses onConflictDoUpdate on the unique clientId column to avoid
   * race conditions between concurrent requests.
   */
  static async upsertFromCimd(data: CimdUpsertData): Promise<void> {
    const updateFields = {
      name: data.name,
      redirectUris: data.redirectUris,
      grantTypes: data.grantTypes,
      responseTypes: data.responseTypes,
      tokenEndpointAuthMethod: data.tokenEndpointAuthMethod,
      public: data.isPublic,
      metadata: data.metadata,
      contacts: data.contacts,
      uri: data.uri,
      policy: data.policy,
      tos: data.tos,
      softwareId: data.softwareId,
      softwareVersion: data.softwareVersion,
    };

    await db
      .insert(schema.oauthClientsTable)
      .values({
        id: data.id,
        clientId: data.clientId,
        ...updateFields,
      })
      .onConflictDoUpdate({
        target: schema.oauthClientsTable.clientId,
        set: updateFields,
      });
  }
}

export default OAuthClientModel;
