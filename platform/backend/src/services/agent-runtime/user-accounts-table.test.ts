import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, expect, test } from "vitest";
import db from "@/database";
import {
  AGENT_RUNTIME_USER_ACCOUNT_CHOSEN_PARTS_SQL,
  AGENT_RUNTIME_USER_ACCOUNTS_SQL,
  AGENT_RUNTIME_USER_ACCOUNTS_STATEMENTS,
} from "@/database/agent-runtime-user-accounts-sql";
import startupMigrationsTable from "@/database/schemas/startup-migration";
import AgentRuntimeUserAccountModel from "@/models/agent-runtime-user-account";
import { ensureAgentRuntimeUserAccountsTable } from "./user-accounts-table";

// Tests run in any order, and resets keep the schema: each one ends with the
// table back in place.
afterEach(async () => {
  AgentRuntimeUserAccountModel.tableAvailable = true;
  for (const statement of AGENT_RUNTIME_USER_ACCOUNTS_STATEMENTS) {
    await db.execute(sql.raw(statement));
  }
});

test("runs the statements of migrations 0659 and 0660 on main, byte for byte", () => {
  // Version 1.5 runs those migrations on a database this branch upgraded.
  // They create nothing there only while both create the same table.
  const digest = (text: string) =>
    createHash("sha256").update(text).digest("hex");
  expect(digest(AGENT_RUNTIME_USER_ACCOUNTS_SQL)).toBe(
    "5ad91a55652d7e4bfab0e7cabe1906635ac8d8e698e571289f81b27848e7a4ce",
  );
  expect(digest(AGENT_RUNTIME_USER_ACCOUNT_CHOSEN_PARTS_SQL)).toBe(
    "c3f42088f2c5c419f9f08ed74f305449aafe9cdb095e5dd84815b56ea12db5bc",
  );
});

test("creates the table once, on a database that lacks it", async () => {
  await db.execute(sql`DROP TABLE IF EXISTS "agent_runtime_user_accounts"`);

  await ensureAgentRuntimeUserAccountsTable();
  await ensureAgentRuntimeUserAccountsTable();

  expect(await tableExists()).toBe(true);
  expect(
    (await db.select().from(startupMigrationsTable)).map((row) => row.id),
  ).toEqual(["agent-runtime-user-accounts-table-v1"]);
  expect(AgentRuntimeUserAccountModel.tableAvailable).toBe(true);
});

test("a database user that cannot create the table leaves everyone without a choice, and startup goes on", async () => {
  await db.execute(sql`DROP TABLE IF EXISTS "agent_runtime_user_accounts"`);
  await db.execute(sql`
    DO $$ BEGIN
      CREATE ROLE "without_ddl";
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
  await db.execute(sql`GRANT USAGE ON SCHEMA public TO "without_ddl"`);
  await db.execute(
    sql`GRANT SELECT, INSERT ON "startup_migrations" TO "without_ddl"`,
  );

  await db.execute(sql`SET ROLE "without_ddl"`);
  try {
    await ensureAgentRuntimeUserAccountsTable();
  } finally {
    await db.execute(sql`RESET ROLE`);
  }

  expect(await tableExists()).toBe(false);
  expect(await db.select().from(startupMigrationsTable)).toEqual([]);
  expect(AgentRuntimeUserAccountModel.tableAvailable).toBe(false);
  expect(
    await AgentRuntimeUserAccountModel.find({
      agentId: randomUUID(),
      userId: "person",
    }),
  ).toBeNull();
});

async function tableExists(): Promise<boolean> {
  const result = await db.execute<{ exists: boolean }>(
    sql`SELECT to_regclass('public.agent_runtime_user_accounts') IS NOT NULL AS exists`,
  );
  return result.rows[0]?.exists ?? false;
}
