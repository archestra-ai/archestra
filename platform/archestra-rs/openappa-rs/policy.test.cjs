const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('../../backend/node_modules/pg');
const native = require('./index.cjs');
const { databaseUrl } = require('./test-database.cjs');
const allow = '[policy]\nversion = 2\n[[policy.tool]]\nname = "read"\ndelta = {}\n';
const deny = '[policy]\nversion = 2\n[[policy.tool]]\nname = "different"\ndelta = {}\n';

test('validates policy semantics and refuses container access', async () => {
  assert.deepEqual(await native.validateOpenappaPolicy(allow), []);
  for (const invalid of ['[policy]\nversion = 999', 'include = ["/secret"]\n' + allow, allow + '[externals.annotators.x]\ncommand = ["sh"]']) {
    assert.ok((await native.validateOpenappaPolicy(invalid)).length > 0);
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
  await native.initializeOpenappa(databaseUrl, 2, policy);
  const session = { organization_id: 'native-tool-identities', caller_id: 'user:test', session_id: randomUUID() };
  const hook = async event => JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), policy));
  assert.equal((await hook({ event: 'session_start' })).decision, 'ack');
  for (const tool of ['exec_command', 'read_file', 'Bash']) {
    assert.equal(
      (await hook({ event: 'tool_call', operation_id: `call:${tool}`, tool, arguments: {} })).decision,
      'allow_call',
      `${tool} must be governed through its host/archestra identity`,
    );
    await hook({ event: 'tool_result', tool_call_id: tool, output: 'completed', outcome: 'success' });
  }
  assert.notEqual(
    (await hook({ event: 'tool_call', operation_id: 'call:unknown_local', tool: 'unknown_local', arguments: {} })).decision,
    'allow_call',
    'an unknown local tool must stay governed',
  );
});

test('saved text changes enforcement for new sessions and preserves existing sessions', { skip: !databaseUrl }, async () => {
  await native.initializeOpenappa(databaseUrl, 2, allow);
  const scope = () => ({ organization_id: 'policy-test', caller_id: 'user:test', session_id: randomUUID() });
  const hook = async (session, event, policy) => JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), policy));
  const old = scope();
  assert.equal((await hook(old, { event: 'session_start' }, allow)).decision, 'ack');
  const fresh = scope();
  assert.equal((await hook(fresh, { event: 'session_start' }, deny)).decision, 'ack');
  const call = { event: 'tool_call', operation_id: 'call:read', tool: 'read', arguments: {} };
  assert.notEqual((await hook(fresh, call, deny)).decision, 'allow_call');
  assert.equal((await hook(old, call, deny)).decision, 'allow_call');
  // A refused candidate never replaces the last working deployment.
  await assert.rejects(hook(scope(), { event: 'session_start' }, '[policy]\nversion = 999'));
  const next = scope();
  assert.equal((await hook(next, { event: 'session_start' }, deny)).decision, 'ack');
  assert.notEqual((await hook(next, call, deny)).decision, 'allow_call');
});

test('a fork keeps its parent policy revision when its dispatch carries newer text', { skip: !databaseUrl }, async () => {
  await native.initializeOpenappa(databaseUrl, 2, allow);
  const scope = () => ({ organization_id: 'fork-policy-test', caller_id: 'user:test', session_id: randomUUID() });
  const hook = async (session, event, policy) => JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), policy));
  const call = { event: 'tool_call', operation_id: 'call:read', tool: 'read', arguments: {} };

  const parent = scope();
  assert.equal((await hook(parent, { event: 'session_start' }, allow)).decision, 'ack');
  assert.equal((await hook(parent, call, allow)).decision, 'allow_call');
  const fork = { ...scope(), fork_of: parent.session_id };
  assert.equal((await hook(fork, call, deny)).decision, 'allow_call');
});

test('a new session opens under the text its dispatch carried while a stale sibling reloads', { skip: !databaseUrl, timeout: 30000 }, async (t) => {
  // A pool of one would serialize fresh and stale on the same connection,
  // masking the race: this needs both to hold a connection at once.
  await native.initializeOpenappa(databaseUrl, 2, allow);
  // Holding a root's ledger advisory lock parks its dispatch on its own
  // pooled connection after the reload and before the session opens.
  const ledger = new Client({ connectionString: databaseUrl });
  await ledger.connect();
  t.after(() => ledger.end());
  const scope = () => ({ organization_id: 'policy-race-test', caller_id: 'user:test', session_id: randomUUID() });
  const hook = async (session, event, policy) => JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), policy));
  const root = (session) => `archestra:${createHash('sha256').update(session.session_id).digest('hex')}`;
  const hold = (session) => ledger.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [root(session)]);
  const release = (session) => ledger.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [root(session)]);
  const parked = async (session) => {
    for (;;) {
      const { rows } = await ledger.query(`SELECT EXISTS (
        SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
          AND classid = ((hashtextextended($1, 0) >> 32) & 4294967295)::oid
          AND objid = (hashtextextended($1, 0) & 4294967295)::oid) AS parked`, [root(session)]);
      if (rows[0].parked) return;
      await delay(10);
    }
  };
  const opened = async (session) => (await ledger.query('SELECT EXISTS (SELECT 1 FROM openappa_events WHERE root = $1) AS opened', [root(session)])).rows[0].opened;
  const call = { event: 'tool_call', operation_id: 'call:read', tool: 'read', arguments: {} };

  // Serving the text from before the save.
  assert.equal((await hook(scope(), { event: 'session_start' }, allow)).decision, 'ack');
  const fresh = scope();
  const stale = scope();
  await hold(fresh);
  await hold(stale);
  // The fresh session read the saved text and reloads to it.
  const freshStart = hook(fresh, { event: 'session_start' }, deny);
  await parked(fresh);
  // A request that read the text just before the save reloads back to it.
  const staleStart = hook(stale, { event: 'session_start' }, allow);
  await delay(250);
  await release(fresh);
  // The stale dispatch reaches its ledger lock only after its reload, and the
  // fresh session cannot open while that lock query holds the connection.
  await parked(stale);
  assert.equal(await opened(fresh), false, 'the stale reload landed before the fresh session opened');
  await release(stale);
  assert.equal((await freshStart).decision, 'ack');
  assert.equal((await staleStart).decision, 'ack');

  assert.notEqual((await hook(fresh, call, deny)).decision, 'allow_call');
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
  await native.initializeOpenappa(databaseUrl, 2, policy);
  const scope = { organization_id: 'catch-all-test', caller_id: 'user:test', session_id: randomUUID() };
  const hook = async event => JSON.parse(await native.dispatchHook(JSON.stringify({ ...scope, ...event }), policy));
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
