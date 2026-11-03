import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { Client } from "pg";

// Run only against an isolated, disposable database, never an application DB.
const connectionString = process.env.ARCHESTRA_APPEND_TEST_DATABASE_URL;
assert.ok(connectionString, "An isolated append test database is required");
const migrations = new URL("../src/database/migrations/", import.meta.url);
const journal = JSON.parse(
  await readFile(new URL("meta/_journal.json", migrations), "utf8"),
);
const definitions = [];
for (const entry of journal.entries) {
  const sql = await readFile(new URL(`${entry.tag}.sql`, migrations), "utf8");
  const definition = sql.match(
    /CREATE OR REPLACE FUNCTION interaction_user_activity_append\(payload jsonb\)[\s\S]*?\$\$;/,
  );
  if (definition) definitions.push(definition[0]);
}
assert.ok(definitions.length >= 2, "Both upgrade definitions must exist");
const previous = definitions.at(-2);
const current = definitions.at(-1);
const profileId = "00000000-0000-4000-8000-000000000001";

test("append upgrade preserves encoded values, defaults, replay and accounting", async (t) => {
  const db = new Client({ connectionString });
  await db.connect();
  t.after(async () => {
    try { await db.query("ROLLBACK"); } finally { await db.end(); }
  });
  await db.query("BEGIN");
  // Only the columns used by the production function are needed. The activity
  // tables, constraints and triggers come from the actual historical migration.
  await db.query(`
    CREATE TABLE organization (id text PRIMARY KEY);
    CREATE TABLE "user" (id text PRIMARY KEY);
    CREATE TABLE agents (id uuid PRIMARY KEY, organization_id text);
    CREATE TABLE apps (id uuid PRIMARY KEY, organization_id text);
    CREATE TABLE knowledge_base_connectors (id uuid PRIMARY KEY, organization_id text);
    CREATE TABLE interactions (
      id uuid PRIMARY KEY, profile_id uuid, app_id uuid, connector_id uuid,
      request jsonb, response jsonb, type text,
      input_tokens integer, output_tokens integer, model text,
      baseline_cost numeric(13,10), cost numeric(13,10), processed_request jsonb,
      user_id text, session_id text, session_source text, baseline_model text,
      source text, auth_method text, cache_read_tokens integer, cache_write_tokens integer,
      cache_cost numeric(13,10), cache_savings numeric(13,10), cache_write_1h_tokens integer,
      environment_id uuid, input_tokens_estimated boolean DEFAULT false,
      billing_mode text DEFAULT 'metered', duration_ms integer, session_preview jsonb,
      attribution_labels jsonb, virtual_key_id uuid, passthrough_virtual_key_id uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(
    await readFile(new URL("0566_interaction_user_activity.sql", migrations), "utf8"),
  );
  await db.query(previous);
  await db.query("INSERT INTO organization VALUES ('example-org')");
  await db.query("INSERT INTO agents VALUES ($1, 'example-org')", [profileId]);
  await db.query("INSERT INTO \"user\" VALUES ('example-user')");
  const values = {
    id: randomUUID(),
    profile_id: profileId,
    user_id: "example-user",
    request: JSON.stringify({ content: "quoted ' \\ λ", nested: [null, true] }),
    response: JSON.stringify({ content: "synthetic response" }),
    type: "openai:chatCompletions",
    cost: "123.1234567890",
    processed_request: "null",
    session_preview: null,
  };
  async function append(payload) {
    return (await db.query(
      "SELECT * FROM interaction_user_activity_append($1::jsonb)",
      [JSON.stringify(payload)],
    )).rows[0];
  }
  const before = await append(values);
  await db.query(current);
  assert.deepEqual(await append(values), before, "upgrade preserves existing retries");
  for (const ready of [false, true]) {
    await db.query("UPDATE interaction_user_activity_state SET enabled=true, ready=$1", [ready]);
    await db.query(`INSERT INTO interaction_user_activity_users VALUES ('example-user', 1)
      ON CONFLICT (user_id) DO UPDATE SET generation=1`);
    const payload = { ...values, id: randomUUID() };
    const inserted = await append(payload);
    assert.deepEqual(inserted, { ...before, id: payload.id });
    assert.equal(inserted.cost, "123.1234567890");
    const nulls = (await db.query(`SELECT processed_request = 'null'::jsonb AS json_null,
      session_preview IS NULL AS sql_null FROM interactions WHERE id=$1`, [payload.id])).rows[0];
    assert.deepEqual(nulls, { json_null: true, sql_null: true });
    assert.deepEqual(await append(payload), inserted);
  }
  assert.deepEqual((await db.query("SELECT activity_count::text FROM interaction_user_activity")).rows,
    [{ activity_count: "2" }]);
  assert.deepEqual((await db.query("SELECT balance::text FROM interaction_user_activity_deltas")).rows,
    [{ balance: "2" }]);
  // A failed call is isolated so its aborted transaction cannot hide later assertions.
  for (const payload of [
    { ...values, user_id: null },
    { ...values, id: randomUUID(), unknown_column: "invalid" },
    { ...values, id: randomUUID(), cost: { invalid: true } },
  ]) {
    await db.query("SAVEPOINT invalid_append");
    await assert.rejects(append(payload));
    await db.query("ROLLBACK TO SAVEPOINT invalid_append");
  }

  await db.query("UPDATE interaction_user_activity_state SET enabled=false");
  // Report actual server timings without a flaky speed threshold. Both versions
  // use the same connection, table and encoded payload shapes. Explicit created_at
  // ensures this exercises the generic path even if cached shapes evolve.
  for (const bytes of [64 * 1024, 1024 * 1024]) {
    const encoded = Array.from({ length: 12 }, () => JSON.stringify({
      ...values, id: randomUUID(), created_at: "2025-01-01T00:00:00Z",
      request: JSON.stringify({ content: "quoted ' \\ λ ".repeat(Math.ceil(bytes / 16)) }),
    }));
    const results = {};
    for (const [name, definition] of [["before", previous], ["after", current]]) {
      await db.query(definition);
      const elapsed = [];
      for (const payload of encoded) {
        const start = performance.now();
        const row = (await db.query("SELECT id FROM interaction_user_activity_append($1::jsonb)", [payload])).rows[0];
        elapsed.push(performance.now() - start);
        await db.query("DELETE FROM interactions WHERE id=$1", [row.id]);
      }
      elapsed.sort((a, b) => a - b);
      results[name] = elapsed[Math.floor(elapsed.length / 2)].toFixed(2);
    }
    t.diagnostic(`generic append ~${bytes} bytes median ms: ${JSON.stringify(results)}`);
  }
});
