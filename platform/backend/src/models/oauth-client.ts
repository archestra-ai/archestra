import { eq } from "drizzle-orm";
import db, { schema } from "@/database";

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
}

export default OAuthClientModel;
