import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import db from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0198_first_hammerhead.sql"),
  "utf-8",
);

async function createScratchTables() {
  await db.execute(
    sql.raw(`DROP TABLE IF EXISTS "agent_tools_0198_test" CASCADE;`),
  );
  await db.execute(
    sql.raw(`DROP TABLE IF EXISTS "mcp_server_0198_test" CASCADE;`),
  );
  await db.execute(
    sql.raw(`DROP TABLE IF EXISTS "internal_mcp_catalog_0198_test" CASCADE;`),
  );

  await db.execute(
    sql.raw(`
    CREATE TABLE "internal_mcp_catalog_0198_test" (
      "id" uuid PRIMARY KEY
    );
  `),
  );

  await db.execute(
    sql.raw(`
    CREATE TABLE "mcp_server_0198_test" (
      "id" uuid PRIMARY KEY
    );
  `),
  );

  await db.execute(
    sql.raw(`
    CREATE TABLE "agent_tools_0198_test" (
      "id" uuid PRIMARY KEY,
      "agent_id" uuid NOT NULL,
      "tool_id" uuid NOT NULL,
      "credential_source_mcp_server_id" uuid,
      "execution_source_mcp_server_id" uuid,
      "use_dynamic_team_credential" boolean NOT NULL DEFAULT false
    );
  `),
  );
}

async function runMigrationOnScratchTables() {
  const rewrittenSql = migrationSql
    .replaceAll('"agent_tools"', '"agent_tools_0198_test"')
    .replaceAll('"internal_mcp_catalog"', '"internal_mcp_catalog_0198_test"')
    .replaceAll('"mcp_server"', '"mcp_server_0198_test"');

  const statements = rewrittenSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}

describe("0198 migration: simplify agent tool server binding", () => {
  test("backfills mcp_server_id and dynamic resolution mode before dropping legacy columns", async () => {
    await createScratchTables();

    await db.execute(
      sql.raw(`
      INSERT INTO "mcp_server_0198_test" ("id")
      VALUES
        ('00000000-0000-0000-0000-000000000198'),
        ('00000000-0000-0000-0000-000000000199');
    `),
    );

    await db.execute(
      sql.raw(`
      INSERT INTO "agent_tools_0198_test" (
        "id",
        "agent_id",
        "tool_id",
        "credential_source_mcp_server_id",
        "execution_source_mcp_server_id",
        "use_dynamic_team_credential"
      ) VALUES
        (
          '10000000-0000-0000-0000-000000000198',
          '20000000-0000-0000-0000-000000000198',
          '30000000-0000-0000-0000-000000000198',
          '00000000-0000-0000-0000-000000000198',
          NULL,
          false
        ),
        (
          '10000000-0000-0000-0000-000000000199',
          '20000000-0000-0000-0000-000000000199',
          '30000000-0000-0000-0000-000000000199',
          '00000000-0000-0000-0000-000000000198',
          '00000000-0000-0000-0000-000000000199',
          true
        );
    `),
    );

    await runMigrationOnScratchTables();

    const rows = await db.execute(
      sql.raw(`
      SELECT
        "id",
        "mcp_server_id",
        "credential_resolution_mode"
      FROM "agent_tools_0198_test"
      ORDER BY "id" ASC;
    `),
    );

    expect(rows.rows).toEqual([
      {
        id: "10000000-0000-0000-0000-000000000198",
        mcp_server_id: "00000000-0000-0000-0000-000000000198",
        credential_resolution_mode: "static",
      },
      {
        id: "10000000-0000-0000-0000-000000000199",
        mcp_server_id: "00000000-0000-0000-0000-000000000199",
        credential_resolution_mode: "dynamic",
      },
    ]);
  });

  test("adds enterprise_managed_config to internal_mcp_catalog", async () => {
    await createScratchTables();
    await runMigrationOnScratchTables();

    const columns = await db.execute(
      sql.raw(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'internal_mcp_catalog_0198_test'
      ORDER BY column_name ASC;
    `),
    );

    expect(columns.rows).toContainEqual({
      column_name: "enterprise_managed_config",
    });
  });

  test("preserves null static server binding when neither legacy source column was set", async () => {
    await createScratchTables();

    await db.execute(
      sql.raw(`
      INSERT INTO "agent_tools_0198_test" (
        "id",
        "agent_id",
        "tool_id",
        "credential_source_mcp_server_id",
        "execution_source_mcp_server_id",
        "use_dynamic_team_credential"
      ) VALUES (
        '10000000-0000-0000-0000-000000000200',
        '20000000-0000-0000-0000-000000000200',
        '30000000-0000-0000-0000-000000000200',
        NULL,
        NULL,
        false
      );
    `),
    );

    await runMigrationOnScratchTables();

    const rows = await db.execute(
      sql.raw(`
      SELECT
        "id",
        "mcp_server_id",
        "credential_resolution_mode"
      FROM "agent_tools_0198_test"
      WHERE "id" = '10000000-0000-0000-0000-000000000200';
    `),
    );

    expect(rows.rows).toEqual([
      {
        id: "10000000-0000-0000-0000-000000000200",
        mcp_server_id: null,
        credential_resolution_mode: "static",
      },
    ]);
  });
});
