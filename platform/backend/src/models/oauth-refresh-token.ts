import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import db, { schema } from "@/database";

class OAuthRefreshTokenModel {
  /**
   * Hash a raw refresh token for lookup. better-auth stores refresh tokens the
   * same way it stores access tokens: SHA-256, base64url, no padding.
   */
  static hashTokenForLookup(refreshToken: string): string {
    // codeql[js/insufficient-password-hash] This hashes a high-entropy OAuth refresh token for lookup, not a user password.
    return createHash("sha256").update(refreshToken).digest("base64url");
  }

  /**
   * Read a refresh token's resource binding. The shareable-App connector mint
   * reads this on a `refresh_token` grant so a refreshed access token inherits
   * the audience even when the client omits the `resource` parameter.
   */
  static async getById(id: string) {
    const [row] = await db
      .select({
        id: schema.oauthRefreshTokensTable.id,
        referenceId: schema.oauthRefreshTokensTable.referenceId,
      })
      .from(schema.oauthRefreshTokensTable)
      .where(eq(schema.oauthRefreshTokensTable.id, id))
      .limit(1);
    return row ?? null;
  }

  /**
   * Find a refresh token by its hashed value.
   */
  static async getByTokenHash(tokenHash: string) {
    const [row] = await db
      .select()
      .from(schema.oauthRefreshTokensTable)
      .where(eq(schema.oauthRefreshTokensTable.token, tokenHash))
      .limit(1);
    return row ?? null;
  }

  /**
   * Create a refresh token row (used by the token-endpoint replay shield when
   * it re-issues a rotated pair inside the reuse grace window).
   */
  static async create(params: {
    tokenHash: string;
    clientId: string;
    userId: string;
    sessionId?: string | null;
    referenceId?: string | null;
    authTime?: Date | null;
    scopes: string[];
    expiresAt: Date;
  }) {
    const [row] = await db
      .insert(schema.oauthRefreshTokensTable)
      .values({
        id: crypto.randomUUID(),
        token: params.tokenHash,
        clientId: params.clientId,
        userId: params.userId,
        sessionId: params.sessionId ?? null,
        referenceId: params.referenceId ?? null,
        authTime: params.authTime ?? null,
        scopes: params.scopes,
        expiresAt: params.expiresAt,
        createdAt: new Date(),
      })
      .returning();
    return row;
  }

  /**
   * List refresh token rows for a (client, user) pair, optionally narrowed to
   * one grant lineage by referenceId or sessionId.
   */
  static async listByClientAndUser(params: {
    clientId: string;
    userId: string;
    referenceId?: string;
    sessionId?: string;
  }) {
    const conditions = [
      eq(schema.oauthRefreshTokensTable.clientId, params.clientId),
      eq(schema.oauthRefreshTokensTable.userId, params.userId),
    ];
    if (params.referenceId !== undefined) {
      conditions.push(
        eq(schema.oauthRefreshTokensTable.referenceId, params.referenceId),
      );
    }
    if (params.sessionId !== undefined) {
      conditions.push(
        eq(schema.oauthRefreshTokensTable.sessionId, params.sessionId),
      );
    }
    return db
      .select({
        id: schema.oauthRefreshTokensTable.id,
      })
      .from(schema.oauthRefreshTokensTable)
      .where(and(...conditions));
  }

  /**
   * Delete refresh token rows by id. Returns the number of rows removed.
   */
  static async deleteByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const rows = await db
      .delete(schema.oauthRefreshTokensTable)
      .where(inArray(schema.oauthRefreshTokensTable.id, ids))
      .returning({ id: schema.oauthRefreshTokensTable.id });
    return rows.length;
  }

  /**
   * Bind a refresh token to a resource audience while it is still unbound, so a
   * later refresh that omits `resource` can carry the binding forward. The
   * `IS NULL` guard keeps this a one-shot write that never overwrites a binding
   * another issuer set.
   */
  static async bindReferenceIdByIdWhenUnbound(params: {
    id: string;
    referenceId: string;
  }) {
    const [row] = await db
      .update(schema.oauthRefreshTokensTable)
      .set({ referenceId: params.referenceId })
      .where(
        and(
          eq(schema.oauthRefreshTokensTable.id, params.id),
          isNull(schema.oauthRefreshTokensTable.referenceId),
        ),
      )
      .returning();
    return row ?? null;
  }
}

export default OAuthRefreshTokenModel;
