import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import pg from "pg";

import config from "../config";
import logger from "../logging";
import * as schema from "./schemas";

const { Pool } = pg;

const pool = new Pool({
  connectionString: config.databaseUrl,
});

/**
 * ARCHESTRA_DATABASE_USE_PGLITE
 *
 * If this environment variable is set to true, we use a PGlite in-memory database instead of a network Postgres.
 * This is useful for development when a local Postgres instance is not available.
 */
const usePglite = process.env.ARCHESTRA_DATABASE_USE_PGLITE === "true";

let db: any;
let dbInitializationPromise: Promise<void> = Promise.resolve();

if (usePglite) {
  logger.info("Using PGlite (in-memory) database for development");

  // @ts-ignore
  const client = new PGlite("memory://");

  db = drizzlePglite({
    client,
    schema,
  });

  dbInitializationPromise = (async () => {
    try {
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const migrationsDir = path.resolve(__dirname, "migrations");

      console.log(`[DEBUG] PGlite: loading migrations from ${migrationsDir}`);

      if (!fs.existsSync(migrationsDir)) {
        throw new Error(`Migrations directory not found: ${migrationsDir}`);
      }

      const migrationFiles = fs
        .readdirSync(migrationsDir)
        .filter((file) => file.endsWith(".sql"))
        .sort();

      console.log(`[DEBUG] PGlite: found ${migrationFiles.length} migration files`);

      for (const file of migrationFiles) {
        const fullPath = path.resolve(migrationsDir, file);
        const sql = fs.readFileSync(fullPath, "utf8");
        process.stdout.write(` [${file}]`);

        try {
          // Drizzle migrations use '--> statement-breakpoint' to separate statements
          const statements = sql.split(/--> statement-breakpoint/);
          for (const statement of statements) {
            const trimmed = statement.trim();
            if (trimmed) {
              await client.exec(trimmed);
            }
          }
        } catch (err: any) {
          console.error(`\n[DEBUG] ❌ Error in migration script ${file}:`, err.message);
          throw err;
        }
      }
      process.stdout.write("\n");
      console.log("[DEBUG] ✓ PGlite migrations completed successfully");
    } catch (err: any) {
      console.error("[DEBUG] ❌ Failed to run PGlite migrations:", err.message);
      throw err;
    }
  })();
} else {
  db = drizzlePg({
    client: pool,
    schema,
  });
}

export type Transaction = any; // Simplified for dual-client support
export { dbInitializationPromise };
export default db;
export { schema };
