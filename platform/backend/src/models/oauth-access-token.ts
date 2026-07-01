import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import db, { schema } from "@/database";

class OAuthAccessTokenModel {
  static hashTokenForLookup(oauthAccessToken: string): string {
    // codeql[js/insufficient-password-hash] This hashes a high-entropy OAuth bearer token for lookup, not a user password.
    return createHash("sha256").update(oauthAccessToken).digest("base64url");
  }

  /**
   * Create an OAuth access token row.
   */
  static async create(params: {
    tokenHash: string;
    clientId: string;
    userId: string;
    expiresAt: Date;
    scopes: string[];
    referenceId?: string | null;
  }) {
    const [accessToken] = await db
      .insert(schema.oauthAccessTokensTable)
      .values({
        id: crypto.randomUUID(),
        token: params.tokenHash,
        clientId: params.clientId,
        userId: params.userId,
        expiresAt: params.expiresAt,
        scopes: params.scopes,
        referenceId: params.referenceId ?? null,
        createdAt: new Date(),
      })
      .returning();

    return accessToken;
  }

  static async createClientCredentialsToken(params: {
    tokenHash: string;
    clientId: string;
    expiresAt: Date;
    scopes: string[];
    referenceId?: string | null;
  }) {
    const [accessToken] = await db
      .insert(schema.oauthAccessTokensTable)
      .values({
        id: crypto.randomUUID(),
        token: params.tokenHash,
        clientId: params.clientId,
        expiresAt: params.expiresAt,
        scopes: params.scopes,
        referenceId: params.referenceId ?? null,
        createdAt: new Date(),
      })
      .returning();

    return accessToken;
  }

  /**
   * Find an access token by its hashed value.
   * better-auth stores tokens as SHA-256 base64url hashes.
   *
   * LEFT JOINs with oauth_refresh_token to include revocation status.
   * When a refresh token is revoked, all associated access tokens should
   * be considered invalid (defense-in-depth — better-auth's revocation
   * endpoint also deletes access tokens, but this guards against edge cases).
   */
  static async getByTokenHash(tokenHash: string) {
    const [result] = await db
      .select({
        id: schema.oauthAccessTokensTable.id,
        token: schema.oauthAccessTokensTable.token,
        clientId: schema.oauthAccessTokensTable.clientId,
        sessionId: schema.oauthAccessTokensTable.sessionId,
        userId: schema.oauthAccessTokensTable.userId,
        referenceId: schema.oauthAccessTokensTable.referenceId,
        refreshId: schema.oauthAccessTokensTable.refreshId,
        expiresAt: schema.oauthAccessTokensTable.expiresAt,
        createdAt: schema.oauthAccessTokensTable.createdAt,
        scopes: schema.oauthAccessTokensTable.scopes,
        refreshTokenRevoked: schema.oauthRefreshTokensTable.revoked,
      })
      .from(schema.oauthAccessTokensTable)
      .leftJoin(
        schema.oauthRefreshTokensTable,
        eq(
          schema.oauthAccessTokensTable.refreshId,
          schema.oauthRefreshTokensTable.id,
        ),
      )
      .where(eq(schema.oauthAccessTokensTable.token, tokenHash))
      .limit(1);
    return result;
  }

  /**
   * Update the persisted expiry for a hashed access token.
   */
  static async updateExpiresAtByTokenHash(params: {
    tokenHash: string;
    expiresAt: Date;
  }) {
    const [accessToken] = await db
      .update(schema.oauthAccessTokensTable)
      .set({ expiresAt: params.expiresAt })
      .where(eq(schema.oauthAccessTokensTable.token, params.tokenHash))
      .returning();

    return accessToken ?? null;
  }

  /**
   * Bind a freshly minted token to a resource audience, only while it is still
   * unbound. better-auth issues opaque tokens with a null `referenceId`; the
   * shareable-App connector mint stamps the audience here. The `IS NULL` guard
   * makes this a one-shot write so it can never clobber a binding another issuer
   * (e.g. the enterprise-managed `mcp-resource:` path) already set. Returns the
   * updated row, or null when the token was absent or already bound.
   */
  static async bindReferenceIdByTokenHashWhenUnbound(params: {
    tokenHash: string;
    referenceId: string;
  }) {
    const [accessToken] = await db
      .update(schema.oauthAccessTokensTable)
      .set({ referenceId: params.referenceId })
      .where(
        and(
          eq(schema.oauthAccessTokensTable.token, params.tokenHash),
          isNull(schema.oauthAccessTokensTable.referenceId),
        ),
      )
      .returning();

    return accessToken ?? null;
  }
}

export default OAuthAccessTokenModel;
