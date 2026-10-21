import { sql } from "drizzle-orm";
import db from "@/database";

/**
 * Test-only replacement for the external PostgreSQL adapter. Keyv serialization
 * and the production cache's atomic SQL operations use the same real test DB.
 */
export class TestKeyvPostgresStore {
  opts = {};

  on() {
    return this;
  }

  async get(key: string) {
    await ensureTable();
    const result = await db.execute<{ value: string }>(
      sql`SELECT value FROM keyv_cache WHERE key = ${key}`,
    );
    return result.rows[0]?.value;
  }

  async set(key: string, value: string) {
    await ensureTable();
    await db.execute(sql`
      INSERT INTO keyv_cache (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `);
  }

  async delete(key: string) {
    await ensureTable();
    const result = await db.execute(
      sql`DELETE FROM keyv_cache WHERE key = ${key} RETURNING key`,
    );
    return result.rows.length > 0;
  }

  async clear() {
    await ensureTable();
    await db.execute(sql`DELETE FROM keyv_cache`);
  }

  disconnect() {
    return Promise.resolve();
  }
}

async function ensureTable() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS keyv_cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}
