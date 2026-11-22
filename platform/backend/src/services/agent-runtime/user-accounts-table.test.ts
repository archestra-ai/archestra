import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, expect, test } from "vitest";
import db from "@/database";
import { AGENT_RUNTIME_USER_ACCOUNTS_STATEMENTS } from "@/database/agent-runtime-user-accounts-sql";
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
