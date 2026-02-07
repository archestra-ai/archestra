import { eq } from "drizzle-orm";
import db, { schema } from "@/database";

class OAuthAccessTokenModel {
  /**
   * Find an access token by its hashed value.
   * better-auth stores tokens as SHA-256 base64url hashes.
   */
  static async getByTokenHash(tokenHash: string) {
    const [accessToken] = await db
      .select()
      .from(schema.oauthAccessTokensTable)
      .where(eq(schema.oauthAccessTokensTable.token, tokenHash))
      .limit(1);
    return accessToken;
  }
}

export default OAuthAccessTokenModel;
