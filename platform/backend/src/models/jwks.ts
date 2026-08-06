import { desc } from "drizzle-orm";
import db, { schema } from "@/database";

type Jwk = typeof schema.jwksTable.$inferSelect;

class JwksModel {
  /**
   * The JWKS key better-auth's JWT plugin would sign with next, or null when
   * no key exists yet.
   *
   * Mirrors the plugin's own selection rule — its `getJwksAdapter` reads every
   * row and takes the greatest `createdAt` — so the guard inspects exactly the
   * key that signing will use.
   */
  static async getLatest(): Promise<Jwk | null> {
    const [row] = await db
      .select()
      .from(schema.jwksTable)
      .orderBy(desc(schema.jwksTable.createdAt))
      .limit(1);
    return row ?? null;
  }
}

export default JwksModel;
