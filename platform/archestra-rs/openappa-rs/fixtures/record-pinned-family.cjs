/**
 * Records the rows the previous OpenAPPA pin writes for one conversation, as
 * `opening-identity-pinned.json`. That conversation is a legacy family: it
 * opened pinned to its opening policy before policy revisions existed, and
 * this build refuses it with `legacy_family`.
 *
 * Build the binding at the previous pin, then run this against a scratch
 * database migrated with `pnpm --dir backend db:migrate`:
 *
 *   git worktree add /tmp/previous <commit that pins the previous OpenAPPA>
 *   (cd /tmp/previous/platform/archestra-rs && cargo build --profile release-fast -p openappa_rs)
 *   ARCHESTRA_OPENAPPA_TEST_DATABASE_URL=postgresql://… \
 *     node fixtures/record-pinned-family.cjs \
 *       /tmp/previous/platform/archestra-rs/target/release-fast/libopenappa_rs.so <pin>
 *
 * The conversation proposes one call under the opening policy of
 * `opening-identity.test.cjs` and reports its result.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('../../../backend/node_modules/pg');

const [binary, pin] = process.argv.slice(2);
const databaseUrl = process.env.ARCHESTRA_OPENAPPA_TEST_DATABASE_URL;
if (!binary || !pin || !databaseUrl) {
  console.error('usage: ARCHESTRA_OPENAPPA_TEST_DATABASE_URL=… node record-pinned-family.cjs <binding .so> <pin>');
  process.exit(2);
}

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
const session = {
  organization_id: 'opening-identity-pinned',
  caller_id: 'user:owner',
  session_id: 'opening-identity-pinned-session',
};
// Tables keyed by root or organization; the policy file is looked up by the opening's key.
const TABLES = ['openappa_events', 'openappa_roots', 'openappa_sessions', 'openappa_operations', 'openappa_processed_results'];

(async () => {
  const native = require(path.resolve(binary));
  await native.initializeOpenappa(databaseUrl, 2);
  const dispatch = async (event) =>
    JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), { content: opening, credentials: {} }));
  for (const [event, expected] of [
    [{ event: 'session_start' }, 'ack'],
    [{ event: 'tool_call', operation_id: 'call:r1', tool: 'read', arguments: {} }, 'allow_call'],
    [{ event: 'tool_result', tool_call_id: 'r1', output: 'ok', outcome: 'success' }, 'ack'],
  ]) {
    const { decision } = await dispatch(event);
    if (decision !== expected) throw new Error(`${event.event}: ${decision}, expected ${expected}`);
  }

  const pg = new Client({ connectionString: databaseUrl });
  await pg.connect();
  try {
    const { root } = (
      await pg.query('SELECT root FROM openappa_sessions WHERE organization_id = $1 AND session_id = $2', [
        session.organization_id,
        session.session_id,
      ])
    ).rows[0];
    const tables = {};
    for (const table of TABLES) {
      const keyed = (
        await pg.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name IN ('root', 'organization_id')",
          [table],
        )
      ).rows.map((row) => row.column_name);
      const where = keyed.includes('root') ? 'root = $1' : 'organization_id = $2';
      const { rows } = await pg.query(
        `SELECT * FROM ${table} WHERE ${where} AND $1::text IS NOT NULL AND $2::text IS NOT NULL ORDER BY ${table === 'openappa_events' ? 'seq' : '1'}`,
        [root, session.organization_id],
      );
      tables[table] = rows.map(encode);
    }
    const first = JSON.parse(Buffer.from(tables.openappa_events[0].payload.bytea, 'hex'));
    const key = (Array.isArray(first) ? first : first.facts)[0].TrajectoryOpened.policy_file_key;
    tables.openappa_policy_files = (await pg.query('SELECT * FROM openappa_policy_files WHERE hash = $1', [key])).rows.map(encode);
    const fixture = { written_by: pin, ...session, root, tables };
    fs.writeFileSync(path.join(__dirname, 'opening-identity-pinned.json'), `${JSON.stringify(fixture, null, 2)}\n`);
  } finally {
    await pg.end();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

/** A row as the fixture stores it: bytea as hex, JSON columns marked, timestamps as ISO text. */
function encode(row) {
  return Object.fromEntries(
    Object.entries(row).map(([column, value]) => {
      if (Buffer.isBuffer(value)) return [column, { bytea: value.toString('hex') }];
      if (value instanceof Date) return [column, value.toISOString()];
      if (value !== null && typeof value === 'object') return [column, { json: value }];
      return [column, value];
    }),
  );
}
