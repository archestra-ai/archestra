import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import db from "@/database";
import { expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0260_repair-conversation-attachments-table.sql"),
  "utf-8",
);

test("creates conversation_attachments when the original attachment migration was skipped", async () => {
  await db.execute(sql.raw('DROP TABLE IF EXISTS "conversation_attachments"'));
  await db.execute(sql.raw('DROP TABLE IF EXISTS "chat_attachments"'));

  await runMigrationSql();
  await runMigrationSql();

  const result = await db.execute<{ table_exists: boolean }>(sql`
    SELECT to_regclass('public.conversation_attachments') IS NOT NULL AS table_exists
  `);

  expect(result.rows[0]?.table_exists).toBe(true);
});

async function runMigrationSql() {
  for (const statement of migrationSql
    .split("--> statement-breakpoint")
    .map((chunk) => chunk.trim())
    .filter(Boolean)) {
    await db.execute(sql.raw(statement));
  }
}
