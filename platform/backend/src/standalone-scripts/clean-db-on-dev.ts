import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import config from "@/config";
import db, { initializeDatabase } from "@/database";
import logger from "@/logging";

/**
 * Completely clears the database by:
 * 1. Dropping all tables
 * 2. Dropping the drizzle migrations table
 * This is a destructive operation and should only be used in development
 */
export const clearDb = async (): Promise<void> => {
  // Safety check: only allow in non-production environments
  if (config.production) {
    throw new Error(
      "❌ Cannot clear database in production environment. This operation is only allowed in development.",
    );
  }

  logger.info("⚠️  Completely clearing database (dropping all tables)...");

  // Get all tables in all schemas (public and drizzle)
  const query = sql<string>`SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema IN ('public', 'drizzle')
        AND table_type = 'BASE TABLE';
    `;

  const result = await db.execute(query);
  const tables = result.rows as Array<{
    table_schema: string;
    table_name: string;
  }>;

  logger.info(`📋 Found ${tables.length} tables to drop`);

  // Drop all tables with CASCADE to handle dependencies
  for (const table of tables) {
    const fullTableName = `"${table.table_schema}"."${table.table_name}"`;
    logger.info(`  🗑️  Dropping table: ${fullTableName}`);
    const dropQuery = sql.raw(`DROP TABLE IF EXISTS ${fullTableName} CASCADE;`);
    await db.execute(dropQuery);
  }

  // Also explicitly drop __drizzle_migrations from public schema if it exists
  logger.info(
    "  🗑️  Dropping __drizzle_migrations from public schema (if exists)",
  );
  await db.execute(
    sql.raw("DROP TABLE IF EXISTS public.__drizzle_migrations CASCADE;"),
  );

  // Drop all enum types in public schema
  logger.info("🗑️  Dropping all enum types in public schema...");
  const enumQuery = sql<string>`SELECT typname
      FROM pg_type
      WHERE typtype = 'e'
        AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');
    `;

  const enumResult = await db.execute(enumQuery);
  const enums = enumResult.rows as Array<{ typname: string }>;

  logger.info(`📋 Found ${enums.length} enum types to drop`);

  for (const enumType of enums) {
    logger.info(`  🗑️  Dropping enum type: ${enumType.typname}`);
    const dropEnumQuery = sql.raw(
      `DROP TYPE IF EXISTS "public"."${enumType.typname}" CASCADE;`,
    );
    await db.execute(dropEnumQuery);
  }

  /**
   * Drop functions the migrations own, too.
   *
   * Without this the clean is silently incomplete: a migration that does a bare
   * `CREATE FUNCTION` (not `CREATE OR REPLACE`) fails on the re-run, and because
   * the CREATE TABLE statements before it have already committed, the migration
   * aborts without recording itself. Every later attempt then dies on
   * "relation ... already exists" — pointing at a table that is not the problem,
   * and surviving `tilt down` and a full Docker prune because the data lives in
   * a Kubernetes volume.
   *
   * Extension-owned functions (pgvector, pg_trgm) are excluded via `depend`:
   * dropping those would break the extension.
   */
  logger.info("🗑️  Dropping all functions in public schema...");
  const functionQuery = sql<string>`SELECT p.oid::regprocedure AS signature
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
          WHERE d.objid = p.oid AND d.deptype = 'e'
        );
    `;

  const functionResult = await db.execute(functionQuery);
  const functions = functionResult.rows as Array<{ signature: string }>;

  logger.info(`📋 Found ${functions.length} functions to drop`);

  for (const routine of functions) {
    logger.info(`  🗑️  Dropping function: ${routine.signature}`);
    await db.execute(
      sql.raw(`DROP FUNCTION IF EXISTS ${routine.signature} CASCADE;`),
    );
  }

  logger.info(
    "✅ Database completely cleared (all tables, enums and functions dropped)!",
  );
  logger.info("💡 Run 'pnpm db:migrate' to recreate tables from migrations");
};

/**
 * CLI entry point for clearing the database
 */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  initializeDatabase()
    .then(() => clearDb())
    .then(() => {
      logger.info("\n✅ Done!");
      process.exit(0);
    })
    .catch((error) => {
      logger.error({ err: error }, "\n❌ Error clearing database:");
      process.exit(1);
    });
}
