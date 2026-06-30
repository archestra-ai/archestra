import { OFFLINE_ACCESS_OAUTH_SCOPE } from "@archestra/shared";
import { and, eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { CimdUpsertData } from "@/types";

class OAuthClientModel {
  /**
   * Find a client by OAuth client_id.
   */
  static async findByClientId(clientId: string) {
    const [client] = await db
      .select()
      .from(schema.oauthClientsTable)
      .where(eq(schema.oauthClientsTable.clientId, clientId))
      .limit(1);
    return client ?? null;
  }

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
   * Append a redirect URI to a client's redirect_uris if not already present.
   * Used by the loopback port relaxation logic (RFC 8252 Section 7.3).
   */
  static async addRedirectUri(
    clientId: string,
    redirectUri: string,
  ): Promise<void> {
    await db
      .update(schema.oauthClientsTable)
      .set({
        redirectUris: sql`array_append(${schema.oauthClientsTable.redirectUris}, ${redirectUri})`,
      })
      .where(
        and(
          eq(schema.oauthClientsTable.clientId, clientId),
          sql`NOT (${schema.oauthClientsTable.redirectUris} @> ARRAY[${redirectUri}]::text[])`,
        ),
      );
  }

  /**
   * Register `offline_access` on a client that asks for it at authorize but
   * registered only a narrower scope (e.g. Claude Desktop registers "mcp" yet
   * requests offline_access to obtain a refresh token). The OAuth provider
   * validates authorize-time scopes against the client's *stored* scopes, so a
   * refresh-capable client missing offline_access fails with `invalid_scope`.
   *
   * Idempotent and atomic: only updates clients that registered the
   * `refresh_token` grant and don't already carry the scope. Self-heals clients
   * registered before offline_access was added at DCR time.
   */
  static async ensureOfflineAccessScope(clientId: string): Promise<void> {
    await db
      .update(schema.oauthClientsTable)
      .set({
        scopes: sql`array_append(coalesce(${schema.oauthClientsTable.scopes}, ARRAY[]::text[]), ${OFFLINE_ACCESS_OAUTH_SCOPE})`,
      })
      .where(
        and(
          eq(schema.oauthClientsTable.clientId, clientId),
          sql`coalesce(${schema.oauthClientsTable.grantTypes}, ARRAY[]::text[]) @> ARRAY['refresh_token']::text[]`,
          sql`NOT (coalesce(${schema.oauthClientsTable.scopes}, ARRAY[]::text[]) @> ARRAY[${OFFLINE_ACCESS_OAUTH_SCOPE}]::text[])`,
        ),
      );
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
      // Persist scopes so the OAuth provider's authorize-time scope check has a
      // non-null set to validate against. A null scopes column lets the provider
      // fall back to its full configured scope list — but `ensureOfflineAccessScope`
      // later turns that null into a partial array (e.g. ['offline_access']),
      // which then rejects the `mcp` scope. Storing scopes here keeps `mcp` in the
      // client's set.
      scopes: data.scopes,
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
