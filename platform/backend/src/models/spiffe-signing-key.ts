// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { desc } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertSpiffeSigningKey,
  SpiffeSigningKey,
} from "@/types/spiffe-signing-key";

/**
 * Data access for the keys agents' JWT-SVIDs are signed with. Which key signs
 * and which stay published is decided in services/spiffe/issuer.ts.
 */
class SpiffeSigningKeyModel {
  /** The newest keys first, at most `limit` of them. */
  static async findNewest(limit: number): Promise<SpiffeSigningKey[]> {
    return db
      .select()
      .from(schema.spiffeSigningKeysTable)
      .orderBy(desc(schema.spiffeSigningKeysTable.createdAt))
      .limit(limit);
  }

  static async create(key: InsertSpiffeSigningKey): Promise<SpiffeSigningKey> {
    const [row] = await db
      .insert(schema.spiffeSigningKeysTable)
      .values(key)
      .returning();
    return row;
  }
}

export default SpiffeSigningKeyModel;
