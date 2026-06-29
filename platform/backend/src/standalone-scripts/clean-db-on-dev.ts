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

  logger.info("✅ Database completely cleared (all tables and enums dropped)!");
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
