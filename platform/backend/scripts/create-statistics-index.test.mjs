import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createStatisticsIndex } from "./create-statistics-index.mjs";

async function withDatabase(run) {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE TABLE interactions (
        created_at timestamp, profile_id uuid, connector_id uuid, app_id uuid,
        user_id text, model varchar, input_tokens integer, output_tokens integer,
        cache_read_tokens integer, cost numeric(13,10), baseline_cost numeric(13,10),
        cache_savings numeric(13,10), billing_mode varchar NOT NULL DEFAULT 'metered'
      );
      CREATE INDEX interactions_created_at_idx ON interactions (created_at);
      INSERT INTO interactions (created_at, user_id, model, cost, billing_mode)
      VALUES (NOW(), 'example-person', 'example-model', 1.25, 'metered'),
             (NOW(), NULL, NULL, 2.50, 'subscription');
    `);
    await run(database);
  } finally {
    await database.close();
  }
}

// PGlite cannot exercise concurrent DDL's multi-session protocol. These tests
// exercise the catalog validation and idempotency on a real PostgreSQL engine;
// run the CLI against PostgreSQL to validate the concurrent build itself.
test("builds once, preserves billing data and other indexes, and accepts later writes", async () => {
  await withDatabase(async (database) => {
    // A connection URL can set both limits to zero. The maintenance routine
    // must enforce its bounds after connecting, including on a valid rerun.
    await database.query("SET lock_timeout = '0'");
    await database.query("SET statement_timeout = '0'");
    const before = (await database.query("SELECT * FROM interactions")).rows;
    assert.equal(
      await createStatisticsIndex(database, { concurrently: false }),
      "created",
    );
    const index = await database.query(
      "SELECT 'interactions_statistics_v2_idx'::regclass::oid AS oid",
    );
    await database.query("SET lock_timeout = '0'");
    await database.query("SET statement_timeout = '0'");
    assert.equal(
      await createStatisticsIndex(database, { concurrently: false }),
      "already_valid",
    );
    assert.deepEqual(
      (
        await database.query(
          "SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout",
        )
      ).rows,
      [{ lock_timeout: "5s", statement_timeout: "30min" }],
    );
    assert.deepEqual(
      (
        await database.query(
          "SELECT 'interactions_statistics_v2_idx'::regclass::oid AS oid",
        )
      ).rows,
      index.rows,
    );
    assert.deepEqual(
      (await database.query("SELECT * FROM interactions")).rows,
      before,
    );
    assert.ok(
      (
        await database.query(
          "SELECT to_regclass('interactions_created_at_idx') AS oid",
        )
      ).rows[0].oid,
    );
    await database.query(
      "INSERT INTO interactions (created_at, cost) VALUES (NOW(), 0.75)",
    );
    assert.equal(
      (await database.query("SELECT SUM(cost)::text AS cost FROM interactions"))
        .rows[0].cost,
      "4.5000000000",
    );
  });
});

test("preserves a conflicting index and releases the maintenance lock after failure", async () => {
  await withDatabase(async (database) => {
    await database.exec(
      "CREATE INDEX interactions_statistics_v2_idx ON interactions (cost)",
    );
    const before = (
      await database.query(
        "SELECT pg_get_indexdef('interactions_statistics_v2_idx'::regclass) AS definition",
      )
    ).rows;
    await assert.rejects(
      createStatisticsIndex(database, { concurrently: false }),
      /Unexpected definition/,
    );
    assert.deepEqual(
      (
        await database.query(
          "SELECT pg_get_indexdef('interactions_statistics_v2_idx'::regclass) AS definition",
        )
      ).rows,
      before,
    );
    // Session advisory locks are reentrant: inspect the catalog so a leaked
    // lock cannot be hidden by a successful retry on this single backend.
    assert.equal(
      (
        await database.query(
          "SELECT COUNT(*)::integer AS count FROM pg_locks WHERE locktype = 'advisory'",
        )
      ).rows[0].count,
      0,
    );
    await database.exec("DROP INDEX interactions_statistics_v2_idx");
    assert.equal(
      await createStatisticsIndex(database, { concurrently: false }),
      "created",
    );
  });
});

test("preserves a same-name relation that is not the intended index", async () => {
  await withDatabase(async (database) => {
    await database.exec(
      "CREATE TABLE interactions_statistics_v2_idx (value text); INSERT INTO interactions_statistics_v2_idx VALUES ('keep')",
    );
    await assert.rejects(
      createStatisticsIndex(database, { concurrently: false }),
      /Unexpected definition/,
    );
    assert.deepEqual(
      (await database.query("SELECT * FROM interactions_statistics_v2_idx"))
        .rows,
      [{ value: "keep" }],
    );
  });
});
