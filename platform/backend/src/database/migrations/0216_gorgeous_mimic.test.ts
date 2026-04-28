import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import db from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0216_gorgeous_mimic.sql"),
  "utf-8",
);

async function createScratchMemoryItemTable() {
  await db.execute(sql.raw(`DROP TABLE IF EXISTS "memory_item_0216_test"`));
  await db.execute(
    sql.raw(`
      CREATE TABLE "memory_item_0216_test" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "organization_id" text NOT NULL,
        "scope_type" text NOT NULL,
        "scope_id" text NOT NULL,
        "kind" text NOT NULL,
        "status" text NOT NULL DEFAULT 'candidate',
        "content" text NOT NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      );
    `),
  );
}

async function runMigrationOnScratchTable() {
  const rewrittenSql = migrationSql.replaceAll(
    `"memory_item"`,
    `"memory_item_0216_test"`,
  );

  const statements = rewrittenSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}

describe("0216 migration: memory scoring columns", () => {
  test("adds all retrieval/scoring columns required by memory settings queries", async () => {
    await createScratchMemoryItemTable();
    await runMigrationOnScratchTable();

    const columns = await db.execute(
      sql.raw(`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'memory_item_0216_test'
        AND column_name IN (
          'scores',
          'classifications',
          'scorer_version',
          'last_retrieved_at',
          'retrieval_count'
        )
      ORDER BY column_name ASC;
    `),
    );

    expect(columns.rows).toHaveLength(5);
    expect(columns.rows).toEqual([
      {
        column_name: "classifications",
        is_nullable: "YES",
        column_default: null,
      },
      {
        column_name: "last_retrieved_at",
        is_nullable: "YES",
        column_default: null,
      },
      {
        column_name: "retrieval_count",
        is_nullable: "NO",
        column_default: "0",
      },
      {
        column_name: "scorer_version",
        is_nullable: "YES",
        column_default: null,
      },
      {
        column_name: "scores",
        is_nullable: "YES",
        column_default: null,
      },
    ]);
  });
});
