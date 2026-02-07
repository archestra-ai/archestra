import { pathToFileURL } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import db, { initializeDatabase } from "@/database";
import logger from "@/logging";

/**
 * Run database migrations using the application's database initialization.
 *
 * This script uses initializeDatabase() which supports:
 * - Reading DATABASE_URL from environment variables
 * - Reading DATABASE_URL from Vault (when READONLY_VAULT is enabled)
 *
 * This ensures migrations use the same database connection logic as the application,
 * including Vault integration for secrets management.
 */
export async function runMigrations(): Promise<void> {
  logger.info("Running database migrations...");

  await migrate(db, {
    migrationsFolder: "./src/database/migrations",
  });

  logger.info("Database migrations completed successfully");
}

/**
 * CLI entry point for running migrations
 */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  initializeDatabase()
    .then(() => runMigrations())
    .then(() => {
      logger.info("✅ Migrations complete!");
      process.exit(0);
    })
    .catch((error) => {
      logger.error({ err: error }, "❌ Migration failed:");
      process.exit(1);
    });
}
