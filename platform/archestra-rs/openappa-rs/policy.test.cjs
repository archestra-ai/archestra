const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('../../backend/node_modules/pg');
const native = require('./index.cjs');
const { databaseUrl } = require('./test-database.cjs');
const allow = '[policy]\nversion = 2\n[[policy.tool]]\nname = "read"\ndelta = {}\n';
const deny = '[policy]\nversion = 2\n[[policy.tool]]\nname = "different"\ndelta = {}\n';
// A dispatch carries its organization's policy and the credential values it reads.
const hosted = (content) => ({ content, credentials: {} });

test('validates policy semantics and refuses container access', async () => {
  assert.deepEqual(await native.validateOpenappaPolicy(allow), []);
  for (const invalid of ['[policy]\nversion = 999', 'include = ["/secret"]\n' + allow, allow + '[externals.annotators.x]\ncommand = ["sh"]']) {
    assert.ok((await native.validateOpenappaPolicy(invalid)).length > 0);
  }
});

test('validates host-composed helper bindings without admitting them in authored roots', async () => {
  const entry = 'batteries/old/appa.toml';
  const composed = await native.composeOpenappaPolicy({
    root: `include = ["${entry}"]\n[policy]\nversion = 2\n`,
    batteries: [{
      entry,
      name: 'old',
      policy: `[policy]
version = 2
[[policy.annotator]]
name = "old.judge"
ranks = ["suspicious", "trusted"]
[[policy.tool]]
name = "mcp/old/read"
annotator = "old.judge"
[externals.annotators."old.judge"]
command = ["python3", "judge.py"]
`,
      helpers: {
        urlBase: 'http://127.0.0.1:9/api/openappa/helpers/install-1',
        tokenEnv: 'APPA_ARCHESTRA_BRIDGE_TOKEN',
      },
    }],
  });
  assert.deepEqual(composed.errors, []);
  assert.ok(composed.content.includes('APPA_ARCHESTRA_BRIDGE_TOKEN'));
  assert.deepEqual(await native.validateHostedOpenappaPolicy(composed.content), []);
  assert.match((await native.validateOpenappaPolicy(composed.content)).join('\n'), /APPA_ARCHESTRA_/);
  const authored = await native.composeOpenappaPolicy({ root: composed.content, batteries: [] });
  assert.equal(authored.content, undefined);
  assert.match(authored.errors.join('\n'), /APPA_ARCHESTRA_/);
  assert.deepEqual(await native.validateHostedOpenappaPolicy(
    composed.content.replaceAll('APPA_ARCHESTRA_BRIDGE_TOKEN', 'APPA_ARCHESTRA_UNSET_HOSTED_POLICY_TEST_TOKEN'),
  ), []);
});

test('hosted validation still rejects invalid semantics and command bindings', async () => {
  for (const invalid of [
    '[policy]\nversion = 999',
    'include = ["batteries/unknown/appa.toml"]\n' + allow,
    '[policy]\nversion = 2\n[[policy.annotator]]\nname = "old.judge"\nbuiltin = "no-such-builtin"\n',
    allow + '[externals.annotators.x]\ncommand = ["sh"]',
  ]) {
    assert.ok((await native.validateHostedOpenappaPolicy(invalid)).length > 0);
  }
});

test('derives external client local tools into governed Archestra host identities', { skip: !databaseUrl }, async () => {
  const policy = `[policy]
version = 2
[[policy.tool]]
name = "host/archestra/exec_command"
delta = {}
[[policy.tool]]
name = "host/archestra/read_file"
delta = {}
[[policy.tool]]
name = "host/archestra/Bash"
delta = {}
`;
  await native.initializeOpenappa(databaseUrl, 2);
  const session = { organization_id: 'native-tool-identities', caller_id: 'user:test', session_id: randomUUID() };
  const hook = async event => JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), hosted(policy)));
  assert.equal((await hook({ event: 'session_start' })).decision, 'ack');
  for (const tool of ['exec_command', 'read_file', 'Bash']) {
    assert.equal(
      (await hook({ event: 'tool_call', operation_id: `call:${tool}`, tool, arguments: {} })).decision,
      'allow_call',
      `${tool} must be governed through its host/archestra identity`,
    );
    await hook({ event: 'tool_result', tool_call_id: tool, output: 'completed', outcome: 'success' });
  }
  await assert.rejects(
    () => hook({ event: 'tool_call', operation_id: 'call:unknown_local', tool: 'unknown_local', arguments: {} }),
    /not declared in this policy/,
    'an unknown local tool must stay governed',
  );
});

test('saved text changes enforcement for new sessions and preserves existing sessions', { skip: !databaseUrl }, async () => {
  await native.initializeOpenappa(databaseUrl, 2);
  const scope = () => ({ organization_id: 'policy-test', caller_id: 'user:test', session_id: randomUUID() });
  const hook = async (session, event, policy) => JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), hosted(policy)));
  const old = scope();
  assert.equal((await hook(old, { event: 'session_start' }, allow)).decision, 'ack');
  const fresh = scope();
  assert.equal((await hook(fresh, { event: 'session_start' }, deny)).decision, 'ack');
  const call = { event: 'tool_call', operation_id: 'call:read', tool: 'read', arguments: {} };
  await assert.rejects(() => hook(fresh, call, deny), /not declared in this policy/);
  assert.equal((await hook(old, call, deny)).decision, 'allow_call');
  // A refused policy leaves the organization's last working deployment serving.
  await assert.rejects(hook(scope(), { event: 'session_start' }, '[policy]\nversion = 999'));
  const next = scope();
  assert.equal((await hook(next, { event: 'session_start' }, deny)).decision, 'ack');
  await assert.rejects(() => hook(next, call, deny), /not declared in this policy/);
});

test('a fork keeps its parent policy revision when its dispatch carries newer text', { skip: !databaseUrl }, async () => {
  await native.initializeOpenappa(databaseUrl, 2);
  const scope = () => ({ organization_id: 'fork-policy-test', caller_id: 'user:test', session_id: randomUUID() });
  const hook = async (session, event, policy) => JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), hosted(policy)));
  const call = { event: 'tool_call', operation_id: 'call:read', tool: 'read', arguments: {} };

  const parent = scope();
  assert.equal((await hook(parent, { event: 'session_start' }, allow)).decision, 'ack');
  assert.equal((await hook(parent, call, allow)).decision, 'allow_call');
  const fork = { ...scope(), fork_of: parent.session_id };
  assert.equal((await hook(fork, call, deny)).decision, 'allow_call');
});

test('a new session opens under the text its dispatch carried while a stale sibling dispatches', { skip: !databaseUrl, timeout: 30000 }, async (t) => {
  // A pool of one would serialize fresh and stale on the same connection,
  // masking the race: this needs both to hold a connection at once.
  await native.initializeOpenappa(databaseUrl, 2);
  // An uncommitted family row parks a new session's dispatch on its own pooled
  // connection after it pinned its deployment and before the session opens: the
  // opening writes that row in the same transaction, and waits for the row to
  // settle.
  const ledger = new Client({ connectionString: databaseUrl });
  await ledger.connect();
  t.after(() => ledger.end());
  const ledgerPid = (await ledger.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  // Watched from a connection of its own: inside the ledger's open transaction
  // the activity view would stay as it was at its first read.
  const monitor = new Client({ connectionString: databaseUrl });
  await monitor.connect();
  t.after(() => monitor.end());
  const scope = () => ({ organization_id: 'policy-race-test', caller_id: 'user:test', session_id: randomUUID() });
  const hook = async (session, event, policy) => JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), hosted(policy)));
  const root = (session) => `archestra:${createHash('sha256').update(`${session.organization_id}\n${session.session_id}`).digest('hex')}`;
  const hold = (session) => ledger.query('INSERT INTO openappa_roots (root) VALUES ($1)', [root(session)]);
  const release = () => ledger.query('ROLLBACK');
  // Waits until `count` dispatches wait on the rows this connection holds.
  const parked = async (count) => {
    for (;;) {
      const { rows } = await monitor.query(
        'SELECT count(*)::int AS parked FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
        [ledgerPid],
      );
      if (rows[0].parked >= count) return;
      await delay(10);
    }
  };
  const opened = async (session) => (await ledger.query('SELECT EXISTS (SELECT 1 FROM openappa_events WHERE root = $1) AS opened', [root(session)])).rows[0].opened;
  const call = { event: 'tool_call', operation_id: 'call:read', tool: 'read', arguments: {} };

  // Serving the text from before the save.
  assert.equal((await hook(scope(), { event: 'session_start' }, allow)).decision, 'ack');
  const fresh = scope();
  const stale = scope();
  await ledger.query('BEGIN');
  await hold(fresh);
  await hold(stale);
  // The fresh session read the saved text.
  const freshStart = hook(fresh, { event: 'session_start' }, deny);
  await parked(1);
  // A request that read the text just before the save carries that text.
  const staleStart = hook(stale, { event: 'session_start' }, allow);
  // Wait until the stale dispatch has pinned its deployment and reached the
  // family row. A fixed delay cannot establish that ordering on a busy CI host.
  await parked(2);
  assert.equal(await opened(fresh), false, 'the stale dispatch pinned its text before the fresh session opened');
  await release();
  assert.equal((await freshStart).decision, 'ack');
  assert.equal((await staleStart).decision, 'ack');

  await assert.rejects(() => hook(fresh, call, deny), /not declared in this policy/);
  assert.equal((await hook(stale, call, allow)).decision, 'allow_call');
});

test('catch-all annotations admit unknown tools without changing trust or overriding explicit rules', { skip: !databaseUrl }, async (t) => {
  const requests = [];
  const server = require('node:http').createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: 1, answer: { delta: {}, requires: { history: [], attention: [] }, emits: [] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const policy = `[policy]
version = 2
[[policy.annotator]]
name = "noop"
[[policy.tool]]
name = "*"
annotator = "noop"
[[policy.tool]]
name = "read_untrusted"
delta = { trust = "suspicious" }
[[policy.tool]]
name = "write_trusted"
delta = {}
requires = { trust = "trusted" }
[externals.annotators.noop]
url = "http://127.0.0.1:${server.address().port}/annotate"
`;
  assert.deepEqual(await native.validateOpenappaPolicy(policy), []);
  await native.initializeOpenappa(databaseUrl, 2);
  const scope = { organization_id: 'catch-all-test', caller_id: 'user:test', session_id: randomUUID() };
  const hook = async event => JSON.parse(await native.dispatchHook(JSON.stringify({ ...scope, ...event }), hosted(policy)));
  assert.equal((await hook({ event: 'session_start' })).decision, 'ack');
  const call = async (name, id) => hook({ event: 'tool_call', operation_id: `call:${id}`, tool: name, arguments: {} });
  const result = async id => hook({ event: 'tool_result', operation_id: `result:${id}`, tool_call_id: id, output: 'result', outcome: 'success' });
  assert.equal((await call('unknown_before', 'unknown-before')).decision, 'allow_call');
  await result('unknown-before');
  const read = await call('read_untrusted', 'read');
  assert.equal(read.decision, 'deny_call');
  await hook({ event: 'remedy', operation_id: 'remedy:accept-suspicious', arguments: { offer_id: read.offers[0].offer_id } });
  assert.equal((await call('read_untrusted', 'read-accepted')).decision, 'allow_call');
  await result('read-accepted');
  assert.equal((await call('unknown_after', 'unknown-after')).decision, 'allow_call');
  await result('unknown-after');
  assert.notEqual((await call('write_trusted', 'write')).decision, 'allow_call');
  // Externals see the canonical identity the runtime judges, not the host's spelling.
  assert.deepEqual(requests.map(request => request.artifact.args.name), ['host/archestra/unknown_before', 'host/archestra/unknown_after']);
});

test('an explicit policy result cap takes precedence over the host default', { skip: !databaseUrl }, async () => {
  const proxyLimit = 70 * 1024 * 1024;
  const priorLimit = process.env.APPA_ARCHESTRA_MAX_BODY_BYTES;
  try {
    await native.initializeOpenappa(databaseUrl, 2);
    const text = 'x'.repeat(100_000);
    const withheld = '[appa] the result was not carried; nothing was admitted';
    const report = async (policyText, output) => {
      const session = { organization_id: `native-body-cap-${randomUUID()}`, caller_id: 'user:test', session_id: randomUUID() };
      const hook = async event => JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), hosted(policyText)));
      assert.equal((await hook({ event: 'tool_call', operation_id: 'call:1', tool: 'read', arguments: {} })).decision, 'allow_call');
      return hook({ event: 'tool_result', tool_call_id: '1', output, outcome: 'success' });
    };
    const carried = async (policyText, output) => {
      const kept = await report(policyText, output);
      assert.equal(kept.decision, 'ack');
      assert.equal(kept.approved_output, output);
    };
    process.env.APPA_ARCHESTRA_MAX_BODY_BYTES = String(proxyLimit);
    // Without an explicit cap, results use the published proxy limit. A policy can
    // also choose a cap above that default without changing the proxy request limit.
    for (const stated of ['', 'max_body_bytes = 999999999999\n']) {
      const policyText = stated ? `${allow}[externals]\ntimeout_ms = 2000\n${stated}` : allow;
      await carried(policyText, text);
      await carried(policyText, 'x'.repeat(5 * 1024 * 1024));
    }
    for (const limit of [4096, 65536]) {
      const policyText = `${allow}[externals]\nmax_body_bytes = ${limit}\n`;
      await carried(policyText, 'x'.repeat(limit));
      const dropped = await report(policyText, 'x'.repeat(limit + 1));
      assert.equal(dropped.decision, 'replace_output');
      assert.equal(dropped.approved_output, withheld);
    }
    // A policy keeps its stated limit even without a published host default.
    delete process.env.APPA_ARCHESTRA_MAX_BODY_BYTES;
    const stated = `${allow}[externals]\ntimeout_ms = 2000\nmax_body_bytes = 65536\n`;
    const dropped = await report(stated, text);
    assert.equal(dropped.decision, 'replace_output');
    assert.equal(dropped.approved_output, withheld);
    await carried(allow, 'x'.repeat(1000));
  } finally {
    if (priorLimit === undefined) delete process.env.APPA_ARCHESTRA_MAX_BODY_BYTES;
    else process.env.APPA_ARCHESTRA_MAX_BODY_BYTES = priorLimit;
  }
});

test('a long kept result is stored once, and a row that holds the text twice still replays', { skip: !databaseUrl }, async () => {
  const proxyLimit = String(70 * 1024 * 1024);
  const prior = process.env.APPA_ARCHESTRA_MAX_BODY_BYTES;
  process.env.APPA_ARCHESTRA_MAX_BODY_BYTES = proxyLimit;
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await native.initializeOpenappa(databaseUrl, 2);
    const session = { organization_id: `native-stored-once-${randomUUID()}`, caller_id: 'user:test', session_id: randomUUID() };
    const hook = async event => JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), hosted(allow)));
    const column = async (id) => (await client.query(
      'SELECT approved_output, decision FROM openappa_processed_results WHERE organization_id=$1 AND session_id=$2 AND tool_call_id=$3',
      [session.organization_id, session.session_id, id],
    )).rows[0];
    const text = 'long result '.repeat(2000);
    const short = 'short result';
    for (const [id, output] of [['long', text], ['short', short]]) {
      assert.equal((await hook({ event: 'tool_call', operation_id: `call:${id}`, tool: 'read', arguments: {} })).decision, 'allow_call');
      const first = await hook({ event: 'tool_result', tool_call_id: id, output, outcome: 'success' });
      assert.equal(first.approved_output, output);
    }
    const long = await column('long');
    // The decision keeps the text; the column holds its digest.
    assert.equal(long.decision.approved_output, text);
    assert.equal(long.approved_output, `sha256:${createHash('sha256').update(text).digest('hex')}`);
    assert.equal((await column('short')).approved_output, short);
    // A replay answers from the decision.
    const replay = await hook({ event: 'tool_result', tool_call_id: 'long', output: text, outcome: 'success' });
    assert.equal(replay.approved_output, text);
    // A row written before the column held a digest keeps the text in both places and replays the same.
    await client.query(
      'UPDATE openappa_processed_results SET approved_output=$4 WHERE organization_id=$1 AND session_id=$2 AND tool_call_id=$3',
      [session.organization_id, session.session_id, 'long', text],
    );
    const legacy = await hook({ event: 'tool_result', tool_call_id: 'long', output: text, outcome: 'success' });
    assert.deepEqual(legacy, replay);
  } finally {
    await client.end();
    if (prior === undefined) delete process.env.APPA_ARCHESTRA_MAX_BODY_BYTES;
    else process.env.APPA_ARCHESTRA_MAX_BODY_BYTES = prior;
  }
});
