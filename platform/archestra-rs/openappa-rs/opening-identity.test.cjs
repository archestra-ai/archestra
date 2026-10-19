/**
 * Roots an earlier OpenAPPA engine opened are refused once, under a code the
 * host classifies, and the organization's next conversation follows its line.
 *
 * Each fixture holds the rows one engine wrote for a root it opened, with one
 * released call: v1 by OpenAPPA 0.32 (policy identity v1), v2 by OpenAPPA 0.34
 * (policy identity v2), and `pinned` by the last pin before policy revisions
 * (`fixtures/record-pinned-family.cjs` records it). Every such root is a legacy
 * family: it opened pinned to its opening policy, and no view serves that
 * policy any more.
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
// A later revision, which the organization's next conversation follows.
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
  test(`refuses a root ${openedBy} opened, and the next conversation follows`, { skip: !databaseUrl, timeout: 60000 }, async () => {
    const fixture = require(`./fixtures/opening-identity-${version}.json`);
    await restored(fixture);
    await native.initializeOpenappa(databaseUrl, 4);
    const session = {
      organization_id: fixture.organization_id,
      caller_id: fixture.caller_id,
      session_id: fixture.session_id,
    };
    const dispatch = (event) => native.dispatchHook(JSON.stringify({ ...session, ...event }), hosted(revised));
    const events = await eventCount(fixture.root);

    await assert.rejects(dispatch({ event: 'tool_call', operation_id: 'call:r2', tool: 'read', arguments: {} }), {
      code: 'legacy_family',
    });
    // Not retryable: the same call is refused again, and nothing was appended either time.
    await assert.rejects(dispatch({ event: 'tool_call', operation_id: 'call:r2', tool: 'read', arguments: {} }), {
      code: 'legacy_family',
    });
    await assert.rejects(native.listPeerMessages(JSON.stringify(session), hosted(revised)), { code: 'legacy_family' });
    assert.equal(await eventCount(fixture.root), events);

    const fresh = { ...session, session_id: randomUUID() };
    const hook = async (event) =>
      JSON.parse(await native.dispatchHook(JSON.stringify({ ...fresh, ...event }), hosted(revised)));
    assert.equal((await hook({ event: 'session_start' })).decision, 'ack');
    assert.equal(
      (await hook({ event: 'tool_call', operation_id: 'call:a1', tool: 'archive', arguments: {} })).decision,
      'allow_call',
    );
    const status = await native.getOpenappaStatus(fresh.organization_id, fresh.session_id, hosted(revised));
    assert.equal(typeof status.policyRevision, 'number');
  });
}

test('refuses a root whose stored batch no longer decodes, under a code the host classifies', { skip: !databaseUrl, timeout: 60000 }, async () => {
  await native.initializeOpenappa(databaseUrl, 4);
  const session = { organization_id: `undecodable-${randomUUID()}`, caller_id: 'user:owner', session_id: randomUUID() };
  const dispatch = async (event) =>
    JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), hosted(opening)));
  assert.equal((await dispatch({ event: 'session_start' })).decision, 'ack');
  assert.equal((await dispatch({ event: 'tool_call', operation_id: 'call:r1', tool: 'read', arguments: {} })).decision, 'allow_call');
  const pg = new Client({ connectionString: databaseUrl });
  await pg.connect();
  try {
    const { root } = (
      await pg.query('SELECT root FROM openappa_sessions WHERE organization_id = $1 AND session_id = $2', [
        session.organization_id,
        session.session_id,
      ])
    ).rows[0];
    // A batch in an encoding this engine no longer reads, as an earlier engine could leave it.
    await pg.query(
      'INSERT INTO openappa_events (root, seq, payload) SELECT root, max(seq) + 1, $2 FROM openappa_events WHERE root = $1 GROUP BY root',
      [root, Buffer.from('[{"Return":null}]')],
    );
  } finally {
    await pg.end();
  }

  await assert.rejects(
    native.dispatchHook(
      JSON.stringify({ ...session, event: 'tool_call', operation_id: 'call:undecodable', tool: 'read', arguments: {} }),
      hosted(opening),
    ),
    { code: 'untrusted_log' },
  );
});

/** Restore `fixture`'s rows in one transaction, so a failed insert leaves no half-restored root behind. */
async function restored(fixture) {
  const pg = new Client({ connectionString: databaseUrl });
  await pg.connect();
  try {
    await pg.query('BEGIN');
    await restore(pg, fixture);
    await pg.query('COMMIT');
  } catch (error) {
    await pg.query('ROLLBACK');
    throw error;
  } finally {
    await pg.end();
  }
}

async function eventCount(root) {
  const pg = new Client({ connectionString: databaseUrl });
  await pg.connect();
  try {
    return (await pg.query('SELECT count(*)::int AS n FROM openappa_events WHERE root = $1', [root])).rows[0].n;
  } finally {
    await pg.end();
  }
}
