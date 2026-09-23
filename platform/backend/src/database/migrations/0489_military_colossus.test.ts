import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0489_military_colossus.sql"),
  "utf-8",
);

/**
 * Replays the data statements only. The DDL already exists in the shared test
 * schema (migrations run once when the PGlite snapshot is built), so replaying
 * it would fail. Each data statement is written to be idempotent, which the
 * tests below also pin by running the replay twice.
 */
async function runDataMigration() {
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => {
      const body = statement
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim();
      return /^(UPDATE|INSERT|DELETE)\b/.test(body);
    });
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}

describe("0489 connector sync switch", () => {
  test("turns the switch on exactly for auto-sync connectors", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const autoSync = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
    });
    const orgWide = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "org-wide",
    });
    // Rows written before the column existed carry the default.
    await db
      .update(schema.knowledgeBaseConnectorsTable)
      .set({ syncPermissionsFromSource: false })
      .where(eq(schema.knowledgeBaseConnectorsTable.id, autoSync.id));

    await runDataMigration();
    await runDataMigration();

    const rows = await db
      .select({
        id: schema.knowledgeBaseConnectorsTable.id,
        sync: schema.knowledgeBaseConnectorsTable.syncPermissionsFromSource,
      })
      .from(schema.knowledgeBaseConnectorsTable)
      .where(eq(schema.knowledgeBaseConnectorsTable.organizationId, org.id));
    const byId = new Map(rows.map((row) => [row.id, row.sync]));
    expect(byId.get(autoSync.id)).toBe(true);
    expect(byId.get(orgWide.id)).toBe(false);
  });
});
