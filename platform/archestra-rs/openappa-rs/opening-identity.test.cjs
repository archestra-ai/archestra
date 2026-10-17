/**
 * Roots an earlier OpenAPPA engine opened keep deciding after an engine bump.
 *
 * Each fixture holds the rows one engine wrote for a root it opened, with one
 * released call: v1 by OpenAPPA 0.32 (policy identity v1), v2 by OpenAPPA 0.34
 * (policy identity v2), and `pinned` by the last pin before policy revisions
 * (`fixtures/record-pinned-family.cjs` records it). The opening record names
 * the policy by the identity the opening engine computed. A bump whose engine
 * no longer recognizes that identity fails here, instead of failing every open
 * conversation of a deployment the next time Guardrails enforcement is on.
 *
 * Every such root is a pinned family: it keeps its opening policy until it
 * ends, and nothing stamps its batches with a policy revision. A conversation
 * the same organization opens now follows the organization's current revision.
 */
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
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
    // A table keyed by only one of the two columns leaves the other parameter unused, and
    // PostgreSQL refuses a parameter whose type it cannot infer; the casts type both.
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

for (const [version, openedBy] of [
  ['v1', 'the v1 policy identity'],
  ['v2', 'the v2 policy identity'],
  ['pinned', 'the last pin before policy revisions'],
]) {
  test(`continues a root ${openedBy} opened`, { skip: !databaseUrl, timeout: 60000 }, async () => {
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
    // Only the revised policy declares `archive`: this root refuses it, while a
    // conversation the organization opens now follows the revision and runs it.
    await assert.rejects(
      dispatch({ event: 'tool_call', operation_id: 'call:r4', tool: 'archive', arguments: {} }, revised),
      /not declared in this policy/,
    );
    const fresh = { ...session, session_id: randomUUID() };
    const hook = async (event) =>
      JSON.parse(await native.dispatchHook(JSON.stringify({ ...fresh, ...event }), hosted(revised)));
    assert.equal((await hook({ event: 'session_start' })).decision, 'ack');
    assert.equal(
      (await hook({ event: 'tool_call', operation_id: 'call:a1', tool: 'archive', arguments: {} })).decision,
      'allow_call',
    );

    const stamped = async (root) => {
      const pg = new Client({ connectionString: databaseUrl });
      await pg.connect();
      try {
        const { rows } = await pg.query('SELECT payload FROM openappa_events WHERE root = $1 AND seq > 0', [root]);
        return rows.map((row) => row.payload.toString('utf8').includes('"BasisAdvanced"'));
      } finally {
        await pg.end();
      }
    };
    assert.ok(
      (await stamped(fixture.root)).every((stamp) => !stamp),
      'a pinned family takes no policy revision stamp',
    );
    const lookup = new Client({ connectionString: databaseUrl });
    await lookup.connect();
    const freshRoot = (
      await lookup
        .query('SELECT root FROM openappa_sessions WHERE organization_id = $1 AND session_id = $2', [
          fresh.organization_id,
          fresh.session_id,
        ])
        .finally(() => lookup.end())
    ).rows[0].root;
    assert.ok((await stamped(freshRoot)).some((stamp) => stamp), 'a following family stamps its decided batches');
  });
}

test('refuses a root whose stored batch no longer decodes, under a code the host classifies', { skip: !databaseUrl, timeout: 60000 }, async () => {
  const fixture = require('./fixtures/opening-identity-v2.json');
  const pg = new Client({ connectionString: databaseUrl });
  await pg.connect();
  try {
    await pg.query('BEGIN');
    await restore(pg, fixture);
    // A batch in an encoding this engine no longer reads, as an earlier engine could leave it.
    await pg.query(
      'INSERT INTO openappa_events (root, seq, payload) SELECT root, max(seq) + 1, $2 FROM openappa_events WHERE root = $1 GROUP BY root',
      [fixture.root, Buffer.from('[{"Return":null}]')],
    );
    await pg.query('COMMIT');
  } catch (error) {
    await pg.query('ROLLBACK');
    throw error;
  } finally {
    await pg.end();
  }
  await native.initializeOpenappa(databaseUrl, 4);
  const event = {
    organization_id: fixture.organization_id,
    caller_id: fixture.caller_id,
    session_id: fixture.session_id,
    event: 'tool_call',
    operation_id: 'call:undecodable',
    tool: 'read',
    arguments: {},
  };

  await assert.rejects(native.dispatchHook(JSON.stringify(event), hosted(opening)), { code: 'untrusted_log' });
});
