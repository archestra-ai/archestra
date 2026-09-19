const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
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

test('saved text changes enforcement for new sessions and preserves existing sessions', { skip: !databaseUrl }, async () => {
  await native.initializeOpenappa(databaseUrl, allow);
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
  await native.initializeOpenappa(databaseUrl, policy);
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
