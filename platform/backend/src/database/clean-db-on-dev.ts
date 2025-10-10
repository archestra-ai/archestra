import { sql } from "drizzle-orm";
import db from ".";

/**
 * Completely clears the database by:
 * 1. Dropping all tables
 * 2. Dropping the drizzle migrations table
 * This is a destructive operation and should only be used in development
 */
export const clearDb = async (): Promise<void> => {
  // Safety check: only allow in non-production environments
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "❌ Cannot clear database in production environment. This operation is only allowed in development.",
    );
  }

  console.log("⚠️  Completely clearing database (dropping all tables)...");

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

  console.log(`📋 Found ${tables.length} tables to drop`);

  // Drop all tables with CASCADE to handle dependencies
  for (const table of tables) {
    const fullTableName = `"${table.table_schema}"."${table.table_name}"`;
    console.log(`  🗑️  Dropping table: ${fullTableName}`);
    const dropQuery = sql.raw(`DROP TABLE IF EXISTS ${fullTableName} CASCADE;`);
    await db.execute(dropQuery);
  }

  // Also explicitly drop __drizzle_migrations from public schema if it exists
  console.log(
    "  🗑️  Dropping __drizzle_migrations from public schema (if exists)",
  );
  await db.execute(
    sql.raw("DROP TABLE IF EXISTS public.__drizzle_migrations CASCADE;"),
  );

  console.log("✅ Database completely cleared (all tables dropped)!");
  console.log("💡 Run 'pnpm db:migrate' to recreate tables from migrations");
};

/**
 * CLI entry point for clearing the database
 */
if (require.main === module) {
  clearDb()
    .then(() => {
      console.log("\n✅ Done!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("\n❌ Error clearing database:", error);
      process.exit(1);
    });
}
