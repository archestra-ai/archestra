import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";

// The table, its foreign keys and its indexes: what a release/1.4 database
// creates with these same statements in a one-time startup upgrade.
const statements = fs
  .readFileSync(
    new URL("./0659_agent_runtime_user_accounts.sql", import.meta.url),
    "utf8",
  )
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

test("only creates the new table: what agents and runtimes store keeps its meaning", () => {
  for (const statement of statements) {
    expect(statement.replace(/^--.*$/gm, "").trim()).toMatch(
      /^(CREATE TABLE IF NOT EXISTS "agent_runtime_user_accounts" |DO \$\$ BEGIN\s+IF to_regclass\('public\.(agent_runtime_user_accounts_\w+_idx)'\) IS NULL THEN\s+CREATE INDEX "\2" ON "agent_runtime_user_accounts" |DO \$\$ BEGIN\s+IF NOT EXISTS \(\s+SELECT 1 FROM pg_constraint\s+WHERE conrelid = 'public\.agent_runtime_user_accounts'::regclass\s+AND conname = '\w+'\s+\) THEN\s+ALTER TABLE "agent_runtime_user_accounts" ADD CONSTRAINT )/,
    );
  }
});

test("creates the table where it is missing, and changes nothing where a release/1.4 database already created it, under another database user", async () => {
  /** The tables the foreign keys reference, with their key types. */
  const referenced = `
    CREATE TABLE "agents" ("id" uuid PRIMARY KEY);
    CREATE TABLE "user" ("id" text PRIMARY KEY);
    CREATE TABLE "chat_api_keys" ("id" uuid PRIMARY KEY);
    CREATE TABLE "models" ("id" uuid PRIMARY KEY);
  `;
  /** Every constraint, index and column of the table, as the database defines them. */
  const shape = (database: PGlite) =>
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
      database.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'agent_runtime_user_accounts'
        ORDER BY column_name
      `),
    ]).then((results) => results.map((result) => result.rows));
  const fresh = new PGlite();
  const upgraded = new PGlite();
  try {
    await fresh.exec(referenced);
    for (const statement of statements) await fresh.exec(statement);

    // A release/1.4 database: the application's database user created the
    // table at startup, and a person chose their account before the upgrade.
    // The migration then runs as a database user that does not own the table.
    await upgraded.exec(referenced);
    await upgraded.exec(`
      CREATE ROLE "application";
      CREATE ROLE "migration";
      GRANT CREATE, USAGE ON SCHEMA public TO "application", "migration";
      GRANT REFERENCES ON "agents", "user", "chat_api_keys", "models" TO "application";
    `);
    await upgraded.exec(`SET ROLE "application"`);
    for (const statement of statements) await upgraded.exec(statement);
    await upgraded.exec(`RESET ROLE`);
    await upgraded.exec(`
      INSERT INTO "agents" VALUES ('00000000-0000-4000-8000-0000000000c1');
      INSERT INTO "user" VALUES ('person');
      INSERT INTO "agent_runtime_user_accounts" ("agent_id", "user_id", "authentication")
      VALUES ('00000000-0000-4000-8000-0000000000c1', 'person', 'subscription');
    `);
    await upgraded.exec(`SET ROLE "migration"`);
    for (const statement of statements) await upgraded.exec(statement);
    await upgraded.exec(`RESET ROLE`);

    expect(await shape(upgraded)).toEqual(await shape(fresh));
    const [constraints, indexes] = await shape(fresh);
    // The key, the check and four foreign keys; the key's index and three.
    expect(constraints).toHaveLength(6);
    expect(indexes).toHaveLength(4);
    expect(
      (
        await upgraded.query(
          'SELECT "user_id", "authentication" FROM "agent_runtime_user_accounts"',
        )
      ).rows,
    ).toEqual([{ user_id: "person", authentication: "subscription" }]);
  } finally {
    await fresh.close();
    await upgraded.close();
  }
});
