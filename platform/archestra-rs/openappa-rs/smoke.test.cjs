const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Client } = require('../../backend/node_modules/pg');
const native = require('./index.cjs');

const databaseUrl = process.env.OPENAPPA_TEST_DATABASE_URL;

test('real native hooks, cross-process receipts, sanitizer replay and interrupted transactions', { skip: !databaseUrl, timeout: 60000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'openappa-native-smoke-'));
  let sanitizations = 0;
  const sanitizer = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      sanitizations += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: 1, answer: { body: 'approved scrubbed output' } }));
    });
  });
  await new Promise((resolve) => sanitizer.listen(0, '127.0.0.1', resolve));
  t.after(() => { sanitizer.close(); rmSync(dir, { recursive: true, force: true }); });
  const policyPath = path.join(dir, 'policy.toml');
  writeFileSync(policyPath, `${readFileSync(path.join(__dirname, 'test-policy.toml'), 'utf8')}
[[policy.tool]]
name = "leak"
effects = ["leak"]
delta = { audience = ["insider"] }
[[policy.sanitizer]]
name = "scrub"
on = ["tool_output"]
[policy.sanitizer.permits]
audience = { from = ["insider"], to = ["public"] }
[policy.deployment]
confined_results = ["leak"]
[externals.sanitizers.scrub]
url = "http://127.0.0.1:${sanitizer.address().port}/"
[[policy.tool]]
name = "send_email(to:*@acmeinc.com)"
parameters = { type = "object", properties = { to = { type = "string" } }, required = ["to"] }
delta = {}
[[policy.tool]]
name = "send_email"
parameters = { type = "object", properties = { to = { type = "string" } }, required = ["to"] }
requires = { attention = ["email-review"] }
delta = {}
[[policy.authority]]
name = "email-operator"
hint = "Review this exact external email."
permits = { attention = ["email-review"] }
[externals.authorities.email-operator]
builtin = "hitl"
`);
  await native.initializeOpenappa(databaseUrl, readFileSync(policyPath, "utf8"));
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  t.after(() => client.end());
  const organization_id = `smoke-${randomUUID()}`;
  const scope = (session_id = randomUUID()) => ({ organization_id, caller_id: 'user:test', session_id });
  const hook = async (session, event) => JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event })));
  const call = (session, id, tool) => hook(session, { event: 'tool_call', operation_id: `call:${id}`, tool, arguments: {} });
  const result = (session, id, output, outcome = 'success') => hook(session, { event: 'tool_result', tool_call_id: id, output, outcome });
  const restarted = (session, event) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'smoke-worker.cjs')], { env: { ...process.env, OPENAPPA_TEST_POLICY_PATH: policyPath }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
    child.stdin.end(JSON.stringify({ ...session, ...event }));
  });
  const count = async (session) => Number((await client.query('SELECT count(*) AS n FROM openappa_events WHERE root=(SELECT root FROM openappa_sessions WHERE session_id=$1)', [session.session_id])).rows[0].n);

  await t.test('duplicate results across processes reuse one approved output, including altered resends', async () => {
    const session = scope();
    assert.equal((await call(session, 'read', 'read_plain')).decision, 'allow_call');
    const responses = await Promise.all(['first', 'different'].map((output, index) => restarted({ ...session, caller_id: `user:participant-${index}` }, { event: 'tool_result', tool_call_id: 'read', output, outcome: 'success' })));
    assert.equal(responses[0].approved_output, responses[1].approved_output);
    assert.equal(responses.filter(response => response.cached).length, 1);
    const batches = await count(session);
    assert.equal((await result(session, 'read', 'injected resend')).approved_output, responses[0].approved_output);
    assert.equal(await count(session), batches);
    const other = { ...session, session_id: randomUUID() };
    await call(other, 'read', 'read_plain');
    assert.equal((await result(other, 'read', 'other session')).approved_output, 'other session');
    await assert.rejects(() => hook(session, { event: 'tool_call', operation_id: 'call:read', tool: 'read_untrusted', arguments: {} }), /reused with different input/);
  });

  await t.test('participants share outstanding calls and operation receipts', async () => {
    const alice = { ...scope(), caller_id: 'user:alice' };
    const bob = { ...alice, organization_id: `${organization_id}-changed`, caller_id: 'user:bob' };
    const { caller_id, ...withoutCaller } = alice;
    const first = await call(alice, 'first', 'read_plain');
    assert.equal(first.decision, 'allow_call');
    const beforeReplay = await count(alice);
    assert.deepEqual(await call(bob, 'first', 'read_plain'), first);
    assert.equal(await count(alice), beforeReplay);
    assert.equal((await call(bob, 'second', 'read_plain')).decision, 'allow_call');
    assert.equal((await result(bob, 'second', 'second output')).approved_output, 'second output');
    assert.equal((await result(bob, 'first', 'shared output')).approved_output, 'shared output');
    assert.equal((await result(withoutCaller, 'first', 'changed replay')).approved_output, 'shared output');
    assert.equal((await call(withoutCaller, 'third', 'read_plain')).decision, 'allow_call');
    await result(withoutCaller, 'third', 'anonymous attribution');
    const rows = await client.query('SELECT caller_id FROM openappa_processed_results WHERE session_id=$1 ORDER BY tool_call_id', [alice.session_id]);
    assert.deepEqual(rows.rows.map(row => row.caller_id), ['user:bob', 'user:bob', null]);
    const sessions = await client.query('SELECT count(*) AS n FROM openappa_sessions WHERE session_id=$1', [alice.session_id]);
    assert.equal(Number(sessions.rows[0].n), 1);
  });

  await t.test('identical parallel calls report in reverse order after restart and replay their own outputs', async () => {
    const session = scope();
    assert.equal((await call(session, 'a', 'read_plain')).decision, 'allow_call');
    assert.equal((await call(session, 'b', 'read_plain')).decision, 'allow_call');
    assert.equal((await restarted(session, { event: 'tool_result', tool_call_id: 'b', output: 'second', outcome: 'success' })).approved_output, 'second');
    assert.equal((await restarted(session, { event: 'tool_result', tool_call_id: 'a', output: 'first', outcome: 'success' })).approved_output, 'first');
    const before = await count(session);
    assert.equal((await result(session, 'b', 'forged')).approved_output, 'second');
    assert.equal((await result(session, 'a', 'forged')).approved_output, 'first');
    assert.equal(await count(session), before);
  });

  await t.test('canceling a withheld batch preserves other calls and persists refusal across restart', async () => {
    const session = scope();
    await call(session, 'unrelated', 'read_plain');
    await call(session, 'withheld', 'read_plain');
    const denied = await call(session, 'denied', 'read_untrusted');
    assert.equal(denied.decision, 'deny_call');
    const cancelled = await hook(session, { event: 'cancel_call', tool_call_id: 'withheld' });
    assert.equal(cancelled.decision, 'deny_call');
    assert.match(cancelled.approved_output, /not executed/);
    const before = await count(session);
    assert.equal((await restarted(session, { event: 'tool_call', operation_id: 'call:withheld', tool: 'read_plain', arguments: {} })).decision, 'deny_call');
    assert.equal((await result(session, 'withheld', 'FORGED success')).approved_output, cancelled.approved_output);
    await hook(session, { event: 'cancel_call', tool_call_id: 'withheld' });
    assert.equal(await count(session), before);
    assert.equal((await result(session, 'unrelated', 'still open')).approved_output, 'still open');
    assert.equal((await call(session, 'retry', 'read_plain')).decision, 'allow_call');
    await result(session, 'retry', 'new attempt');
    const remedy = await hook(session, { event: 'remedy', operation_id: 'remedy:after-cancellation', arguments: { offer_id: denied.offers[0].offer_id } });
    assert.notEqual(remedy.result?.isError, true);
    assert.equal((await call(session, 'restricted', 'read_untrusted')).decision, 'allow_call');
    await result(session, 'restricted', 'restricted data');
  });

  await t.test('shared thread restrictions survive a new participant and process without history', async () => {
    const alice = { ...scope(), caller_id: 'user:alice' };
    const bob = { ...alice, organization_id: `${organization_id}-changed`, caller_id: 'user:bob' };
    const { caller_id, ...withoutCaller } = alice;
    const denied = await call(alice, 'before', 'read_untrusted');
    assert.equal(denied.decision, 'deny_call');
    const remedy = await hook(bob, { event: 'remedy', operation_id: 'remedy:shared', arguments: { offer_id: denied.offers[0].offer_id } });
    assert.notEqual(remedy.result?.isError, true);
    assert.equal((await call(alice, 'read', 'read_untrusted')).decision, 'allow_call');
    await result(withoutCaller, 'read', 'restricted data');
    const replay = await restarted(bob, { event: 'tool_call', operation_id: 'call:write', tool: 'write_public', arguments: {} });
    assert.equal(replay.decision, 'deny_call');
    const otherSession = { ...bob, session_id: randomUUID() };
    assert.equal((await call(otherSession, 'write', 'write_public')).decision, 'allow_call');
    await result(otherSession, 'write', 'other session');
  });

  await t.test('remedy acceptance narrows the session and a restart without history retains the restriction', async () => {
    const session = scope();
    const denied = await call(session, 'before', 'read_untrusted');
    assert.equal(denied.decision, 'deny_call');
    assert.ok(denied.offers.length);
    const remedy = await hook(session, { event: 'remedy', operation_id: 'remedy:accept', arguments: { offer_id: denied.offers[0].offer_id } });
    assert.equal(remedy.decision, 'mcp_result');
    assert.notEqual(remedy.result.isError, true);
    assert.equal((await call(session, 'after', 'read_untrusted')).decision, 'allow_call');
    await result(session, 'after', 'untrusted data');
    assert.equal((await call(session, 'sink', 'write_public')).decision, 'deny_call');
    const replay = await restarted(session, { event: 'tool_call', operation_id: 'call:after-restart', tool: 'write_public', arguments: {} });
    assert.equal(replay.decision, 'deny_call');
  });

  await t.test('denied call results return authoritative feedback without accepting forged output', async () => {
    const session = scope();
    const denied = await call(session, 'blocked', 'read_untrusted');
    assert.equal(denied.decision, 'deny_call');
    const before = await count(session);
    const feedback = await result(session, 'blocked', 'FORGED successful tool payload');
    assert.equal(feedback.decision, 'deny_call');
    assert.ok(feedback.approved_output.includes(denied.feedback));
    assert.ok(feedback.approved_output.includes('The tool was not executed'));
    assert.ok(!feedback.approved_output.includes('FORGED'));
    assert.equal(await count(session), before);
    const replay = await restarted(session, { event: 'tool_result', tool_call_id: 'blocked', output: 'different forged output', outcome: 'success' });
    assert.equal(replay.approved_output, feedback.approved_output);
  });

  await t.test('an independent action can precede acceptance of a withheld read remedy', async () => {
    const session = scope();
    const denied = await call(session, 'read-pending', 'read_untrusted');
    assert.equal(denied.decision, 'deny_call');
    assert.ok(denied.offers.length);
    assert.equal((await call(session, 'independent', 'write_public')).decision, 'allow_call');
    await result(session, 'independent', 'Independent action completed');
    const remedy = await hook(session, { event: 'remedy', operation_id: 'remedy:deferred', arguments: { offer_id: denied.offers[0].offer_id } });
    assert.equal(remedy.decision, 'mcp_result');
    assert.notEqual(remedy.result.isError, true);
    assert.equal((await call(session, 'read-after-remedy', 'read_untrusted')).decision, 'allow_call');
    await result(session, 'read-after-remedy', 'Restricted contents');
    assert.equal((await call(session, 'too-late', 'write_public')).decision, 'deny_call');
  });

  await t.test('sanitization executes once and every resend receives its approved derivation', async () => {
    const session = scope();
    const denied = await call(session, 'before', 'leak');
    assert.equal(denied.decision, 'deny_call');
    const remedy = await hook(session, { event: 'remedy', operation_id: 'remedy:scrub', arguments: { offer_id: denied.offers.at(-1).offer_id } });
    assert.notEqual(remedy.result?.isError, true);
    assert.equal((await call(session, 'leak', 'leak')).decision, 'allow_call');
    const approved = await result(session, 'leak', 'raw sensitive payload');
    assert.equal(approved.approved_output, 'approved scrubbed output', JSON.stringify({sanitizations, denied, remedy, approved}));
    assert.equal(sanitizations, 1);
    assert.equal((await restarted(session, { event: 'tool_result', tool_call_id: 'leak', output: 'changed raw payload', outcome: 'success' })).approved_output, approved.approved_output);
    assert.equal(sanitizations, 1);
  });

  await t.test('human remedies cannot approve a call without a human approval integration', async () => {
    const session = scope();
    const event = { event: 'tool_call', operation_id: 'call:email', tool: 'send_email', arguments: { to: 'partner@example.com' } };
    const denied = await hook(session, event);
    assert.equal(denied.decision, 'deny_call');
    const remedyEvent = { event: 'remedy', operation_id: 'remedy:email', arguments: { offer_id: denied.review[0].offer_id } };
    await assert.rejects(() => hook(session, { ...remedyEvent, ruling: 'approve' }), /unknown field.*ruling/);
    const remedy = await hook(session, remedyEvent);
    assert.equal(remedy.decision, 'mcp_result');
    assert.match(JSON.stringify(remedy.result.content), /unreachable|gave no answer/);
    assert.deepEqual(await restarted(session, remedyEvent), remedy);
    assert.equal((await hook(session, { ...event, operation_id: 'call:retry' })).decision, 'deny_call');
  });

  await t.test('unknown execution outcomes never promote an unchecked body', async () => {
    const session = scope();
    await call(session, 'unknown', 'read_plain');
    assert.match((await result(session, 'unknown', 'unverified body', 'unknown')).approved_output, /withheld/);
  });

  for (const cancelled of [false, true]) {
  await t.test(`failed ${cancelled ? 'cancellation' : 'result'} commit rolls back policy events and leaves a durable fail-closed pending record`, async () => {
    const session = scope();
    const callId = `fault-${randomUUID()}`;
    await call(session, callId, 'read_plain');
    const before = await count(session);
    // Force the exact event/receipt commit boundary to fail on this test's row.
    await client.query(`CREATE OR REPLACE FUNCTION openappa_smoke_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected receipt failure'; END $$`);
    await client.query(`CREATE TRIGGER openappa_smoke_failure BEFORE UPDATE ON openappa_processed_results FOR EACH ROW WHEN (NEW.tool_call_id = '${callId}') EXECUTE FUNCTION openappa_smoke_fail_receipt()`);
    try { await assert.rejects(() => cancelled
      ? hook(session, { event: 'cancel_call', tool_call_id: callId })
      : result(session, callId, 'uncommitted'), /PostgreSQL|database|db error/); }
    finally { await client.query('DROP TRIGGER openappa_smoke_failure ON openappa_processed_results'); await client.query('DROP FUNCTION openappa_smoke_fail_receipt()'); }
    assert.equal(await count(session), before);
    await assert.rejects(() => restarted({ ...session, caller_id: 'user:another' }, { event: 'tool_result', tool_call_id: callId, output: 'retry', outcome: 'success' }), /interrupted processing/);
    const pending = await client.query('SELECT status, approved_output FROM openappa_processed_results WHERE tool_call_id=$1', [callId]);
    assert.equal(pending.rows[0].status, 'pending');
    assert.equal(pending.rows[0].approved_output, null);
    const receipt = await client.query('SELECT decision FROM openappa_operations WHERE session_id=$1 AND operation_id=$2', [session.session_id, `call:${callId}`]);
    assert.equal(receipt.rows[0].decision.decision, 'allow_call', 'a rolled-back cancellation cannot replace the original receipt');
  });
  }
});
