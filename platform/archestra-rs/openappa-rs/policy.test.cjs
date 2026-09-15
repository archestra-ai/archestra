const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const native = require('./index.cjs');
const allow = '[policy]\nversion = 2\n[[policy.tool]]\nname = "read"\ndelta = {}\n';
const deny = '[policy]\nversion = 2\n[[policy.tool]]\nname = "different"\ndelta = {}\n';

test('validates policy semantics and refuses container access', async () => {
  assert.deepEqual(await native.validateOpenappaPolicy(allow), []);
  for (const invalid of ['[policy]\nversion = 999', 'include = ["/secret"]\n' + allow, allow + '[externals.annotators.x]\ncommand = ["sh"]']) {
    assert.ok((await native.validateOpenappaPolicy(invalid)).length > 0);
  }
});

test('saved text changes enforcement for new sessions and preserves existing sessions', { skip: !process.env.OPENAPPA_TEST_DATABASE_URL }, async () => {
  await native.initializeOpenappa(process.env.OPENAPPA_TEST_DATABASE_URL, allow);
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
