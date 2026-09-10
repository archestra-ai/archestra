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
`);
  await native.initializeOpenappa(databaseUrl, policyPath);
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
  const count = async (session) => Number((await client.query('SELECT count(*) AS n FROM openappa_events WHERE root=(SELECT root FROM openappa_sessions WHERE organization_id=$1 AND caller_id=$2 AND session_id=$3)', [session.organization_id, session.caller_id, session.session_id])).rows[0].n);

  await t.test('duplicate results across processes reuse one approved output, including altered resends', async () => {
    const session = scope();
    assert.equal((await call(session, 'read', 'read_plain')).decision, 'allow_call');
    const responses = await Promise.all(['first', 'different'].map(output => restarted(session, { event: 'tool_result', tool_call_id: 'read', output, outcome: 'success' })));
    assert.equal(responses[0].approved_output, responses[1].approved_output);
    assert.equal(responses.filter(response => response.cached).length, 1);
    const batches = await count(session);
    assert.equal((await result(session, 'read', 'injected resend')).approved_output, responses[0].approved_output);
    assert.equal(await count(session), batches);
    const other = { ...session, organization_id: `${organization_id}-other` };
    await call(other, 'read', 'read_plain');
    assert.equal((await result(other, 'read', 'other tenant')).approved_output, 'other tenant');
    await assert.rejects(() => hook(session, { event: 'tool_call', operation_id: 'call:read', tool: 'read_untrusted', arguments: {} }), /reused with different input/);
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

  await t.test('unknown execution outcomes never promote an unchecked body', async () => {
    const session = scope();
    await call(session, 'unknown', 'read_plain');
    assert.match((await result(session, 'unknown', 'unverified body', 'unknown')).approved_output, /withheld/);
  });

  await t.test('failed receipt commit rolls back policy events and leaves a durable fail-closed pending record', async () => {
    const session = scope();
    const callId = `fault-${randomUUID()}`;
    await call(session, callId, 'read_plain');
    const before = await count(session);
    // Force the exact event/receipt commit boundary to fail on this test's row.
    await client.query(`CREATE OR REPLACE FUNCTION openappa_smoke_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected receipt failure'; END $$`);
    await client.query(`CREATE TRIGGER openappa_smoke_failure BEFORE UPDATE ON openappa_processed_results FOR EACH ROW WHEN (NEW.tool_call_id = '${callId}') EXECUTE FUNCTION openappa_smoke_fail_receipt()`);
    try { await assert.rejects(() => result(session, callId, 'uncommitted'), /PostgreSQL|database|db error/); }
    finally { await client.query('DROP TRIGGER openappa_smoke_failure ON openappa_processed_results'); await client.query('DROP FUNCTION openappa_smoke_fail_receipt()'); }
    assert.equal(await count(session), before);
    await assert.rejects(() => restarted(session, { event: 'tool_result', tool_call_id: callId, output: 'retry', outcome: 'success' }), /interrupted processing/);
    const pending = await client.query('SELECT status, approved_output FROM openappa_processed_results WHERE tool_call_id=$1', [callId]);
    assert.equal(pending.rows[0].status, 'pending');
    assert.equal(pending.rows[0].approved_output, null);
  });
});
