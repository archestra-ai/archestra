import { sql } from "drizzle-orm";
import db, { type Transaction } from "@/database";

class CacheEntryModel {
  /** Lock even an absent scope, so deletion cannot let a stale writer recreate it. */
  static async withLock<T>(
    scope: string,
    callback: (entries: CacheEntryModel) => Promise<T>,
  ): Promise<T> {
    return CacheEntryModel.withLocks([scope], callback);
  }

  static async withLocks<T>(
    scopes: string[],
    callback: (entries: CacheEntryModel, tx: Transaction) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      for (const scope of [...new Set(scopes)].sort()) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`cache-entry:${scope}`}, 0))`,
        );
      }
      return callback(new CacheEntryModel(tx), tx);
    });
  }

  constructor(private readonly tx: Transaction) {}

  async now(): Promise<number> {
    const result = await this.tx.execute<{ now: string }>(
      sql`SELECT extract(epoch FROM clock_timestamp()) * 1000 AS now`,
    );
    return Number(result.rows[0].now);
  }

  async get(key: string): Promise<string | undefined> {
    const result = await this.tx.execute<{ value: string }>(
      sql`SELECT value FROM keyv_cache WHERE key = ${key}`,
    );
    return result.rows[0]?.value;
  }

  /** One statement, so an empty poll does not read each key on its own. */
  static async getMany(
    keys: string[],
  ): Promise<Array<{ key: string; value: string }>> {
    if (keys.length === 0) return [];
    const result = await db.execute<{ key: string; value: string }>(sql`
      SELECT key, value FROM keyv_cache
      WHERE key IN (${sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `,
      )})
    `);
    return result.rows;
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
