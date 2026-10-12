// Dispatch leases on the real native runtime and a real PostgreSQL ledger.
// Each "pod" is a separate backend process, so a test can stop one mid-dispatch.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { test } = require('node:test');
const { Client } = require('../../backend/node_modules/pg');
const { databaseUrl } = require('./test-database.cjs');

const annotation = '{"version":1,"answer":{"delta":{},"requires":{"history":[],"attention":[]},"emits":[]}}';

test('a dispatch lease recovers work its owner did not finish', { skip: !databaseUrl, timeout: 120000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'openappa-lease-'));
  // The annotator stands in for a slow external consult. While `hold` is set it
  // keeps the request open, so the dispatch sits between its claim and its finish.
  let hold = false;
  let held = [];
  let consults = 0;
  let consultArrived = () => {};
  const annotator = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      consults += 1;
      const reply = () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(annotation);
      };
      if (!hold) return reply();
      held.push(reply);
      consultArrived();
    });
  });
  await new Promise((resolve) => annotator.listen(0, '127.0.0.1', resolve));
  const policyPath = path.join(dir, 'policy.toml');
  writeFileSync(policyPath, `[policy]
version = 2
[[policy.tool]]
name = "read_plain"
delta = {}
[[policy.annotator]]
name = "gatekeeper"
[[policy.tool]]
name = "annotated_read"
annotator = "gatekeeper"
[externals]
timeout_ms = 30000
max_body_bytes = 65536
[externals.annotators.gatekeeper]
url = "http://127.0.0.1:${annotator.address().port}/"
`);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  t.after(() => { annotator.close(); client.end(); rmSync(dir, { recursive: true, force: true }); });

  // One backend process handling one request. `ledgerName` names its ledger
  // connections so a test can end exactly those.
  const pod = (request, ledgerName) => {
    const url = new URL(databaseUrl);
    if (ledgerName) url.searchParams.set('application_name', ledgerName);
    const child = spawn(process.execPath, [path.join(__dirname, 'smoke-worker.cjs')], {
      env: {
        ...process.env,
        ARCHESTRA_OPENAPPA_TEST_DATABASE_URL: url.toString(),
        OPENAPPA_TEST_POLICY_PATH: policyPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const done = new Promise((resolve) => {
      child.on('exit', (code) => resolve(code === 0 ? JSON.parse(stdout) : { error: stderr }));
    });
    child.stdin.end(JSON.stringify(request));
    return { child, done };
  };
  const run = (request) => pod(request).done;
  const scope = () => ({ organization_id: `lease-${randomUUID()}`, caller_id: 'user:owner', session_id: randomUUID() });
  const toolCall = (session, id, tool) => ({
    ...session, event: 'tool_call', operation_id: `call:${id}`, tool, arguments: { a: 1 },
  });
  const receipts = async (session) => (await client.query(
    'SELECT operation_id, status FROM openappa_operations WHERE organization_id = $1 AND session_id = $2 ORDER BY operation_id',
    [session.organization_id, session.session_id],
  )).rows.map((row) => `${row.operation_id}=${row.status}`);
  const lease = async (session) => (await client.query(
    `SELECT l.owner, l.attempt FROM openappa_dispatch_leases l JOIN openappa_sessions s ON s.root = l.root
     WHERE s.organization_id = $1 AND s.session_id = $2`,
    [session.organization_id, session.session_id],
  )).rows[0];
  // Starts a dispatch that waits on the annotator, and returns once it waits.
  const waitingOnConsult = async (request, ledgerName) => {
    hold = true;
    const arrived = new Promise((resolve) => { consultArrived = resolve; });
    const waiting = pod(request, ledgerName);
    const ended = waiting.done.then((outcome) => {
      throw new Error(`the pod ended before it consulted: ${JSON.stringify(outcome)}`);
    });
    await Promise.race([arrived, ended]);
    ended.catch(() => {});
    return waiting;
  };
  const answerConsults = () => {
    hold = false;
    for (const reply of held.splice(0)) reply();
  };
  // A rollout: the pod stops while its dispatch waits on the consult.
  const stoppedMidConsult = async (request, signal = 'SIGKILL') => {
    const stopped = await waitingOnConsult(request);
    stopped.child.kill(signal);
    await stopped.done;
    answerConsults();
  };

  for (const signal of ['SIGTERM', 'SIGKILL']) {
    await t.test(`a pod stopped by ${signal} mid-consult does not close its session`, async () => {
      const session = scope();
      await stoppedMidConsult(toolCall(session, 'one', 'annotated_read'), signal);
      assert.deepEqual(await receipts(session), ['call:one=pending']);

      const consultsBefore = consults;
      const retried = await run(toolCall(session, 'one', 'annotated_read'));
      assert.equal(retried.decision, 'allow_call', JSON.stringify(retried));
      assert.equal(consults, consultsBefore + 1, 'the released operation ran again');
      assert.deepEqual(await receipts(session), ['call:one=complete']);
      assert.equal(await lease(session), undefined, 'a finished dispatch keeps no lease');

      const child = { ...session, session_id: `${session.session_id}:agent:s1`, parent_id: session.session_id };
      assert.doesNotMatch(JSON.stringify(await run(toolCall(child, 'sub', 'read_plain'))), /interrupted processing/);
      assert.equal((await run(toolCall(session, 'two', 'read_plain'))).decision, 'allow_call');
    });
  }

  await t.test('a different request releases the stopped work', async () => {
    const session = scope();
    await stoppedMidConsult(toolCall(session, 'one', 'annotated_read'));

    const other = await run(toolCall(session, 'two', 'read_plain'));
    assert.equal(other.decision, 'allow_call', JSON.stringify(other));
    assert.deepEqual(await receipts(session), ['call:two=complete']);
    // The call that never finished is submitted again later, as a first run.
    assert.equal((await run(toolCall(session, 'one', 'annotated_read'))).decision, 'allow_call');
  });

  await t.test('a second pod waits for a working owner and does not take its work', async () => {
    const session = scope();
    const working = await waitingOnConsult(toolCall(session, 'one', 'annotated_read'));
    const second = pod(toolCall(session, 'two', 'read_plain'));
    const early = await Promise.race([second.done, sleep(1500).then(() => 'still waiting')]);
    assert.equal(early, 'still waiting');
    assert.deepEqual(await receipts(session), ['call:one=pending']);

    answerConsults();
    assert.equal((await working.done).decision, 'allow_call');
    assert.equal((await second.done).decision, 'allow_call');
    assert.deepEqual(await receipts(session), ['call:one=complete', 'call:two=complete']);
  });

  await t.test('a family whose pod keeps stopping is not run a fourth time', async () => {
    const session = scope();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const stopped = await waitingOnConsult(toolCall(session, 'one', 'annotated_read'));
      assert.equal((await lease(session)).attempt, attempt);
      stopped.child.kill('SIGKILL');
      await stopped.done;
      answerConsults();
    }
    assert.match((await run(toolCall(session, 'one', 'annotated_read'))).error, /interrupted processing/);
    assert.match((await run(toolCall(session, 'two', 'read_plain'))).error, /interrupted processing/);
  });

  await t.test('a failure before the runtime kept anything releases its receipt at once', async () => {
    const session = scope();
    assert.equal((await run(toolCall(session, 'start', 'read_plain'))).decision, 'allow_call');
    // An address to a child that has not started is acknowledged without an
    // event, so only its receipt completion can fail.
    const address = {
      ...session, event: 'child_address', operation_id: `address:${randomUUID()}`,
      spawned_id: `${session.session_id}:agent:unstarted`, output: 'a message for the child',
    };
    await client.query('CREATE OR REPLACE FUNCTION openappa_lease_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'injected receipt failure\'; END $$');
    await client.query(`CREATE TRIGGER openappa_lease_failure BEFORE UPDATE ON openappa_operations FOR EACH ROW WHEN (NEW.operation_id = '${address.operation_id}') EXECUTE FUNCTION openappa_lease_fail_receipt()`);
    try {
      const failed = await run(address);
      assert.match(failed.error ?? JSON.stringify(failed), /PostgreSQL|database|db error/);
      assert.deepEqual(await receipts(session), ['call:start=complete']);
      assert.equal(await lease(session), undefined);
    } finally {
      await client.query('DROP TRIGGER openappa_lease_failure ON openappa_operations');
      await client.query('DROP FUNCTION openappa_lease_fail_receipt()');
    }
    assert.equal((await run(address)).decision, 'ack');
    assert.equal((await run(toolCall(session, 'next', 'read_plain'))).decision, 'allow_call');
  });

  await t.test('stopped work whose decision reached the event log stays closed', async () => {
    const session = scope();
    assert.equal((await run(toolCall(session, 'one', 'read_plain'))).decision, 'allow_call');
    const result = { ...session, event: 'tool_result', tool_call_id: 'one', output: 'uncommitted', outcome: 'success' };
    await client.query('CREATE OR REPLACE FUNCTION openappa_lease_fail_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'injected receipt failure\'; END $$');
    await client.query(`CREATE TRIGGER openappa_lease_result_failure BEFORE UPDATE ON openappa_processed_results FOR EACH ROW WHEN (NEW.organization_id = '${session.organization_id}') EXECUTE FUNCTION openappa_lease_fail_result()`);
    try {
      const failed = await run(result);
      assert.match(failed.error ?? JSON.stringify(failed), /PostgreSQL|database|db error/);
    } finally {
      await client.query('DROP TRIGGER openappa_lease_result_failure ON openappa_processed_results');
      await client.query('DROP FUNCTION openappa_lease_fail_result()');
    }
    // The runtime recorded the result. Running it again could count it twice.
    assert.match((await run(result)).error, /interrupted processing/);
    assert.match((await run(toolCall(session, 'two', 'read_plain'))).error, /interrupted processing/);
  });

  await t.test('a pod that wakes up after losing its lease stands down and the session goes on', async () => {
    const session = scope();
    const ledgerName = `openappa-lease-stale-${randomUUID()}`;
    const stale = await waitingOnConsult(toolCall(session, 'one', 'annotated_read'), ledgerName);
    // The pod freezes, and the database ends its connections, as a network
    // partition or a failover would.
    stale.child.kill('SIGSTOP');
    const ended = await client.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1',
      [ledgerName],
    );
    assert.ok(ended.rowCount > 0);

    // Another pod takes the session over and finishes the same call.
    hold = false;
    const taken = await run(toolCall(session, 'one', 'annotated_read'));
    assert.equal(taken.decision, 'allow_call', JSON.stringify(taken));
    assert.deepEqual(await receipts(session), ['call:one=complete']);

    // The frozen pod wakes up while its own consult is still unanswered.
    stale.child.kill('SIGCONT');
    assert.match((await stale.done).error, /lost its lease on this operation; retry the request/);
    held.splice(0);

    assert.deepEqual(await receipts(session), ['call:one=complete']);
    // The retry the stale pod asked for is answered from the saved decision.
    assert.deepEqual(await run(toolCall(session, 'one', 'annotated_read')), taken);
    assert.equal((await run(toolCall(session, 'two', 'read_plain'))).decision, 'allow_call');
  });
});
