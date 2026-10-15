/**
 * Roots an earlier OpenAPPA engine opened keep deciding after an engine bump.
 *
 * Each fixture holds the rows one engine wrote for a root it opened, with one
 * released call: v1 by OpenAPPA 0.32 (policy identity v1), v2 by OpenAPPA 0.34
 * (policy identity v2). The opening record names the policy by the identity
 * the opening engine computed. A bump whose engine no longer recognizes that
 * identity fails here, instead of failing every open conversation of a
 * deployment the next time Guardrails enforcement is on.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Client } = require('../../backend/node_modules/pg');
const native = require('./index.cjs');
const { databaseUrl } = require('./test-database.cjs');

// The policy every fixture root opened under.
const opening = `[policy]
version = 2

[[policy.tool]]
name = "read"
delta = {}

[[policy.tool]]
name = "fetch_untrusted"
delta = { trust = "suspicious" }

[[policy.tool]]
name = "publish"
delta = {}
requires = { trust = "trusted" }
`;
// A later revision: a root that opened under `opening` decides under its own stored file.
const revised = `${opening}
[[policy.tool]]
name = "archive"
delta = {}
`;
const hosted = (content) => ({ content, credentials: {} });

/** Put the fixture's rows back as the engine wrote them, dropping what a previous run added. */
async function restore(pg, fixture) {
  for (const table of Object.keys(fixture.tables)) {
    if (table === 'openappa_policy_files') continue;
    const columns = (
      await pg.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name IN ('root', 'organization_id')",
        [table],
      )
    ).rows.map((row) => row.column_name);
    const where = columns.map((column) => (column === 'root' ? 'root = $1' : 'organization_id = $2'));
    await pg.query(`DELETE FROM ${table} WHERE (${where.join(' OR ')}) AND $1::text IS NOT NULL AND $2::text IS NOT NULL`, [
      fixture.root,
      fixture.organization_id,
    ]);
  }
  for (const [table, rows] of Object.entries(fixture.tables)) {
    for (const row of rows) {
      const columns = Object.keys(row);
      const values = columns.map((column) => {
        const value = row[column];
        if (value && typeof value === 'object' && 'bytea' in value) return Buffer.from(value.bytea, 'hex');
        if (value && typeof value === 'object' && 'json' in value) return JSON.stringify(value.json);
        return value;
      });
      await pg.query(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')}) ON CONFLICT DO NOTHING`,
        values,
      );
    }
  }
}

for (const version of ['v1', 'v2']) {
  test(`continues a root the ${version} policy identity opened`, { skip: !databaseUrl, timeout: 60000 }, async () => {
    const fixture = require(`./fixtures/opening-identity-${version}.json`);
    const pg = new Client({ connectionString: databaseUrl });
    await pg.connect();
    try {
      // One transaction, so a failed insert leaves no half-restored root behind.
      await pg.query('BEGIN');
      await restore(pg, fixture);
      await pg.query('COMMIT');
    } catch (error) {
      await pg.query('ROLLBACK');
      throw error;
    } finally {
      await pg.end();
    }
    await native.initializeOpenappa(databaseUrl, 4);
    const session = {
      organization_id: fixture.organization_id,
      caller_id: fixture.caller_id,
      session_id: fixture.session_id,
    };
    const dispatch = async (event, content) =>
      JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), hosted(content)));

    // Served policy unchanged: the deployment's own engine decides.
    const read = await dispatch({ event: 'tool_call', operation_id: 'call:r2', tool: 'read', arguments: {} }, opening);
    assert.equal(read.decision, 'allow_call');
    const result = await dispatch({ event: 'tool_result', tool_call_id: 'r2', output: 'ok', outcome: 'success' }, opening);
    assert.equal(result.decision, 'ack');
    // Served policy revised: the root decides under its stored opening policy.
    const later = await dispatch({ event: 'tool_call', operation_id: 'call:r3', tool: 'publish', arguments: {} }, revised);
    assert.equal(later.decision, 'allow_call');
  });
}
