import { sql } from "drizzle-orm";
import db, { type Transaction } from "@/database";

class CacheEntryModel {
  /** Lock even an absent scope, so deletion cannot let a stale writer recreate it. */
  static async withLock<T>(
    scope: string,
    callback: (entries: CacheEntryModel) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`cache-entry:${scope}`}, 0))`,
      );
      return callback(new CacheEntryModel(tx));
    });
  }

  constructor(private readonly tx: Transaction) {}

  async get(key: string): Promise<string | undefined> {
    const result = await this.tx.execute<{ value: string }>(
      sql`SELECT value FROM keyv_cache WHERE key = ${key}`,
    );
    return result.rows[0]?.value;
  }

  async set(key: string, value: string): Promise<void> {
    await this.tx.execute(sql`
      INSERT INTO keyv_cache (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `);
  }

  async take(keys: string[]): Promise<Array<{ key: string; value: string }>> {
    if (keys.length === 0) return [];
    const result = await this.tx.execute<{ key: string; value: string }>(sql`
      DELETE FROM keyv_cache
      WHERE key IN (${sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `,
      )})
      RETURNING key, value
    `);
    return result.rows;
  }
}

export default CacheEntryModel;
