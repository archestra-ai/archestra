import { and, eq, isNull } from "drizzle-orm";
import db, { schema } from "@/database";

class OAuthRefreshTokenModel {
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
