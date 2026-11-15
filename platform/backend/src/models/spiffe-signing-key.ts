// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { desc, sql } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
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

  /**
   * Adds `key` unless the newest key, read under a lock replicas share, still
   * does: replicas deciding at once add one key, not one each. Returns
   * whether it added it.
   */
  static async createIfNeeded(params: {
    needsKey: (newest: SpiffeSigningKey | undefined) => boolean;
    key: InsertSpiffeSigningKey;
  }): Promise<boolean> {
    return withDbTransaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${MINT_LOCK}, 0))`,
      );
      const [newest] = await tx
        .select()
        .from(schema.spiffeSigningKeysTable)
        .orderBy(desc(schema.spiffeSigningKeysTable.createdAt))
        .limit(1);
      if (!params.needsKey(newest)) return false;
      await tx.insert(schema.spiffeSigningKeysTable).values(params.key);
      return true;
    });
  }
}

export default SpiffeSigningKeyModel;

const MINT_LOCK = "spiffe-signing-key-mint";
