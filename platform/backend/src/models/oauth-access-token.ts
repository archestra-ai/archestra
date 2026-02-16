import { eq } from "drizzle-orm";
import db, { schema } from "@/database";

class OAuthAccessTokenModel {
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
}

export default OAuthAccessTokenModel;
