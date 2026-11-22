import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";
import {
  AGENT_RUNTIME_USER_ACCOUNTS_SQL,
  AGENT_RUNTIME_USER_ACCOUNTS_STATEMENTS,
} from "./agent-runtime-user-accounts-sql";

test("is migration 0659_agent_runtime_user_accounts of main, byte for byte", () => {
  // Version 1.5 runs that migration on a database this branch upgraded. It
  // creates nothing there only while both create the same table.
  expect(
    createHash("sha256").update(AGENT_RUNTIME_USER_ACCOUNTS_SQL).digest("hex"),
  ).toBe("5ad91a55652d7e4bfab0e7cabe1906635ac8d8e698e571289f81b27848e7a4ce");
});

test("creates the table, and changes nothing when it runs again, under another database user", async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE TABLE "agents" ("id" uuid PRIMARY KEY);
      CREATE TABLE "user" ("id" text PRIMARY KEY);
      CREATE TABLE "chat_api_keys" ("id" uuid PRIMARY KEY);
      CREATE TABLE "models" ("id" uuid PRIMARY KEY);
      CREATE ROLE "application";
      CREATE ROLE "migration";
      GRANT CREATE, USAGE ON SCHEMA public TO "application", "migration";
      GRANT REFERENCES ON "agents", "user", "chat_api_keys", "models" TO "application";
    `);
    // The startup upgrade, as the application's database user.
    await database.exec(`SET ROLE "application"`);
    for (const statement of AGENT_RUNTIME_USER_ACCOUNTS_STATEMENTS) {
      await database.exec(statement);
    }
    await database.exec(`RESET ROLE`);
    await database.exec(`
      INSERT INTO "agents" VALUES ('00000000-0000-4000-8000-0000000000c1');
      INSERT INTO "user" VALUES ('person');
      INSERT INTO "agent_runtime_user_accounts" ("agent_id", "user_id", "authentication")
      VALUES ('00000000-0000-4000-8000-0000000000c1', 'person', 'subscription');
    `);
    const shape = () =>
      Promise.all([
        database.query(`
          SELECT conname, pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
          WHERE conrelid = '"agent_runtime_user_accounts"'::regclass
          ORDER BY conname
        `),
        database.query(`
          SELECT indexname, indexdef FROM pg_indexes
          WHERE tablename = 'agent_runtime_user_accounts'
          ORDER BY indexname
        `),
      ]).then((results) => results.map((result) => result.rows));
    const created = await shape();

    // Version 1.5's migration job, as a user that does not own the table.
    await database.exec(`SET ROLE "migration"`);
    for (const statement of AGENT_RUNTIME_USER_ACCOUNTS_STATEMENTS) {
      await database.exec(statement);
    }
    await database.exec(`RESET ROLE`);

    expect(await shape()).toEqual(created);
    const [constraints, indexes] = created;
    // The key, the check and four foreign keys; the key's index and three.
    expect(constraints).toHaveLength(6);
    expect(indexes).toHaveLength(4);
    expect(
      (
        await database.query(
          'SELECT "user_id", "authentication" FROM "agent_runtime_user_accounts"',
        )
      ).rows,
    ).toEqual([{ user_id: "person", authentication: "subscription" }]);
  } finally {
    await database.close();
  }
});
