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

test('a dispatch lease recovers work its owner did not finish', { skip: !databaseUrl, timeout: 180000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'openappa-lease-'));
  // A holdable HTTP consult stand-in: while `hold` is set the request stays
  // open, so the dispatch sits between its claim and its finish. Serves the
  // annotator's annotation and the sanitizer's fixed answer alike.
  const consults = { annotator: 0, sanitizer: 0 };
  const standIn = (kind, body) => {
    const gate = { hold: false, fail: false, held: [], arrived: () => {} };
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        consults[kind] += 1;
        const reply = () => {
          response.writeHead(gate.fail ? 503 : 200, { 'content-type': 'application/json' });
          response.end(gate.fail ? '{"unavailable":true}' : body);
        };
        if (!gate.hold) return reply();
        gate.held.push(reply);
        gate.arrived();
      });
    });
    return { gate, server };
  };
  const annotator = standIn('annotator', annotation);
  const sanitizer = standIn('sanitizer', '{"version":1,"answer":{"body":"approved scrubbed output"}}');
  await new Promise((resolve) => annotator.server.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => sanitizer.server.listen(0, '127.0.0.1', resolve));
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
[[policy.tool]]
name = "read_untrusted"
delta = { trust = "suspicious" }
[[policy.tool]]
name = "write_public"
delta = {}
requires = { trust = "trusted" }
[[policy.tool]]
name = "leak"
effects = ["leak"]
delta = { audience = ["insider"], trust = "suspicious" }
[[policy.tool]]
name = "agent__worker"
delta = {}
[[policy.sanitizer]]
name = "scrub"
on = ["tool_output"]
[policy.sanitizer.permits]
audience = { from = ["insider"], to = ["public"] }
[[policy.sanitizer]]
name = "attest-schema"
on = ["tool_output"]
[policy.sanitizer.permits]
trust = { from = "suspicious", to = "trusted" }
[policy.deployment]
confined_results = ["leak"]
context_control = true
[externals]
timeout_ms = 30000
max_body_bytes = 65536
[externals.annotators.gatekeeper]
url = "http://127.0.0.1:${annotator.server.address().port}/"
[externals.sanitizers.scrub]
url = "http://127.0.0.1:${sanitizer.server.address().port}/"
`);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const pods = new Set();

  // One backend process handling one request. `ledgerName` names its ledger
  // connections so a test can end exactly those. Every spawned pod is
  // registered so the fixture can reap it on a failed or cancelled test.
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
    pods.add(child);
    child.on('exit', () => pods.delete(child));
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
  const toolResult = (session, id, output) => ({
    ...session, event: 'tool_result', tool_call_id: id, output, outcome: 'success',
  });
  const offerInput = (session, event) => ({
    organization_id: session.organization_id,
    caller_id: session.caller_id,
    trajectory: { v: 1, session_id: session.session_id, ...(session.parent_id ? { parent_id: session.parent_id } : {}) },
    execution_mode: 'tracked',
    original_arguments: JSON.stringify(event.arguments),
    presentation: { control_tool: 'archestra__execute_remedy_plan', supports_delegation: false },
    ...event,
  });
  const remedy = (session, event) => run({ operation: 'by_offer', input: offerInput(session, event) });
  const prepareLeak = async (session) => {
    const held = await run(toolCall(session, 'read:held', 'leak'));
    assert.equal(held.decision, 'deny_call', JSON.stringify(held));
    const initialOffers = new Set(held.offers.map((offer) => offer.offer_id));
    const installed = await remedy(session, {
      tool_call_id: 'install-scrub', arguments: { offer_id: held.offers.at(-1).offer_id },
    });
    assert.notEqual(installed.result?.isError, true, JSON.stringify(installed));
    const released = await run(toolCall(session, 'read', 'leak'));
    assert.equal(released.decision, 'allow_call', JSON.stringify(released));
    return initialOffers;
  };
  const receipts = async (session) => (await client.query(
    'SELECT operation_id, status FROM openappa_operations WHERE organization_id = $1 AND session_id = $2 ORDER BY operation_id',
    [session.organization_id, session.session_id],
  )).rows.map((row) => `${row.operation_id}=${row.status}`);
  const resultReceipts = async (session) => (await client.query(
    'SELECT tool_call_id, status FROM openappa_processed_results WHERE organization_id = $1 AND session_id = $2 ORDER BY tool_call_id',
    [session.organization_id, session.session_id],
  )).rows.map((row) => `${row.tool_call_id}=${row.status}`);
  const lease = async (session) => (await client.query(
    `SELECT l.owner, l.attempt FROM openappa_dispatch_leases l JOIN openappa_sessions s ON s.root = l.root
     WHERE s.organization_id = $1 AND s.session_id = $2`,
    [session.organization_id, session.session_id],
  )).rows[0];
  const eventCount = async (session) => Number((await client.query(
    'SELECT count(*) AS n FROM openappa_events WHERE root = (SELECT root FROM openappa_sessions WHERE organization_id = $1 AND session_id = $2)',
    [session.organization_id, session.session_id],
  )).rows[0].n);
  // Starts a dispatch that waits on a consult, and returns once it waits. If
  // the pod never gets there (early failure or a stuck dispatch), it is ended
  // and the gate released rather than awaited without a bound.
  const waitingOnConsult = async (gate, request, ledgerName) => {
    gate.hold = true;
    const waiting = pod(request, ledgerName);
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 30000);
      timer.unref();
      gate.arrived = () => {
        clearTimeout(timer);
        resolve('consulted');
      };
      waiting.done.then((ended) => {
        clearTimeout(timer);
        resolve(ended);
      });
    });
    if (outcome !== 'consulted') {
      answerConsults(gate);
      waiting.child.kill('SIGKILL');
      await waiting.done;
      throw new Error(outcome === 'timeout'
        ? 'the pod did not reach the consult within 30s'
        : `the pod ended before it consulted: ${JSON.stringify(outcome)}`);
    }
    return waiting;
  };
  const answerConsults = (gate) => {
    gate.hold = false;
    for (const reply of gate.held.splice(0)) reply();
  };
  // A rollout: the pod stops while its dispatch waits on the annotator.
  const stoppedMidConsult = async (request, signal = 'SIGKILL') => {
    const stopped = await waitingOnConsult(annotator.gate, request);
    stopped.child.kill(signal);
    await stopped.done;
    answerConsults(annotator.gate);
  };
  // Fails the completion of one operation or result receipt once, so the
  // dispatch errors after the runtime committed the work. Only the trigger
  // and function this call created are dropped afterwards.
  const failCompletion = async (table, column, id, fn) => {
    const name = `openappa_lease_fail_${table}`;
    await client.query(`CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected receipt failure'; END $$`);
    await client.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    await client.query(`CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} FOR EACH ROW WHEN (NEW.${column} = '${id}') EXECUTE FUNCTION ${name}()`);
    try {
      await fn();
    } finally {
      await client.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
      await client.query(`DROP FUNCTION IF EXISTS ${name}()`);
    }
  };

  t.after(async () => {
    // Answer consults still held so a pod can end, then end any pod still
    // running: a cancelled assertion must not strand a fixture child.
    answerConsults(annotator.gate);
    answerConsults(sanitizer.gate);
    const running = [...pods];
    for (const child of running) child.kill('SIGKILL');
    await Promise.all(running.map((child) => new Promise((resolve) => child.once('exit', resolve))));
    // close() waits for open keep-alive and held connections; force them shut.
    annotator.server.closeAllConnections();
    sanitizer.server.closeAllConnections();
    annotator.server.close();
    sanitizer.server.close();
    await client.end();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const signal of ['SIGTERM', 'SIGKILL']) {
    await t.test(`a pod stopped by ${signal} mid-consult does not close its session`, async () => {
      const session = scope();
      await stoppedMidConsult(toolCall(session, 'one', 'annotated_read'), signal);
      assert.deepEqual(await receipts(session), ['call:one=pending']);

      const consultsBefore = consults.annotator;
      const retried = await run(toolCall(session, 'one', 'annotated_read'));
      assert.equal(retried.decision, 'allow_call', JSON.stringify(retried));
      assert.equal(consults.annotator, consultsBefore + 1, 'the released operation ran again');
      assert.deepEqual(await receipts(session), ['call:one=complete']);
      assert.equal(await lease(session), undefined, 'a finished dispatch keeps no lease');

      assert.equal((await run(toolCall(session, 'two', 'read_plain'))).decision, 'allow_call');
    });
  }

  await t.test('a different request proceeds while the stopped one waits for its resubmission', async () => {
    const session = scope();
    await stoppedMidConsult(toolCall(session, 'one', 'annotated_read'));

    const other = await run(toolCall(session, 'two', 'read_plain'));
    assert.equal(other.decision, 'allow_call', JSON.stringify(other));
    assert.deepEqual(await receipts(session), ['call:one=pending', 'call:two=complete']);
    // The call that never finished is submitted again later, as a first run.
    assert.equal((await run(toolCall(session, 'one', 'annotated_read'))).decision, 'allow_call');
    assert.deepEqual(await receipts(session), ['call:one=complete', 'call:two=complete']);
  });

  await t.test('a second pod waits for a working owner and does not take its work', async () => {
    const session = scope();
    const working = await waitingOnConsult(annotator.gate, toolCall(session, 'one', 'annotated_read'));
    const second = pod(toolCall(session, 'two', 'read_plain'));
    const early = await Promise.race([second.done, sleep(1500).then(() => 'still waiting')]);
    assert.equal(early, 'still waiting');
    assert.deepEqual(await receipts(session), ['call:one=pending']);

    answerConsults(annotator.gate);
    assert.equal((await working.done).decision, 'allow_call');
    assert.equal((await second.done).decision, 'allow_call');
    assert.deepEqual(await receipts(session), ['call:one=complete', 'call:two=complete']);
  });

  await t.test('a family recovers no matter how many stops precede the healthy run', async () => {
    const session = scope();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const stopped = await waitingOnConsult(annotator.gate, toolCall(session, 'one', 'annotated_read'));
      assert.equal((await lease(session)).attempt, attempt);
      stopped.child.kill('SIGKILL');
      await stopped.done;
      answerConsults(annotator.gate);
    }
    const consultsBefore = consults.annotator;
    const recovered = await run(toolCall(session, 'one', 'annotated_read'));
    assert.equal(recovered.decision, 'allow_call', JSON.stringify(recovered));
    assert.equal(consults.annotator, consultsBefore + 1, 'the recovered operation ran once more');
    assert.deepEqual(await receipts(session), ['call:one=complete']);
    assert.equal(await lease(session), undefined);
    assert.equal((await run(toolCall(session, 'two', 'read_plain'))).decision, 'allow_call');
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
    await failCompletion('openappa_operations', 'operation_id', address.operation_id, async () => {
      const failed = await run(address);
      assert.match(failed.error ?? JSON.stringify(failed), /PostgreSQL|database|db error/);
    });
    assert.deepEqual(await receipts(session), ['call:start=complete']);
    assert.equal(await lease(session), undefined);
    assert.equal((await run(address)).decision, 'ack');
    assert.equal((await run(toolCall(session, 'next', 'read_plain'))).decision, 'allow_call');
  });

  await t.test('a stop after the result committed replays it exactly, and a contradiction stays closed', async () => {
    const session = scope();
    assert.equal((await run(toolCall(session, 'one', 'read_plain'))).decision, 'allow_call');
    const result = toolResult(session, 'one', 'committed output');
    await failCompletion('openappa_processed_results', 'tool_call_id', 'one', async () => {
      const failed = await run(result);
      assert.match(failed.error ?? JSON.stringify(failed), /PostgreSQL|database|db error/);
    });
    assert.deepEqual(await resultReceipts(session), ['one=pending']);

    // The retry of the same result completes from the committed record; it
    // appends nothing and consults nothing.
    const committedEvents = await eventCount(session);
    const recovered = await run(result);
    assert.equal(recovered.decision, 'ack', JSON.stringify(recovered));
    assert.equal(recovered.approved_output, 'committed output');
    assert.deepEqual(await resultReceipts(session), ['one=complete']);
    assert.equal(await eventCount(session), committedEvents, 'recovery replays the commit, it does not re-record it');
    assert.deepEqual(await run(result), recovered, 'a later retry replays the receipt');
    assert.equal((await run(toolCall(session, 'two', 'read_plain'))).decision, 'allow_call');

    // The same call id carrying a different outcome is not the interrupted
    // operation: it fails closed on the receipt it finds complete.
    const contradicted = scope();
    assert.equal((await run(toolCall(contradicted, 'one', 'read_plain'))).decision, 'allow_call');
    await failCompletion('openappa_processed_results', 'tool_call_id', 'one', async () => {
      await run(toolResult(contradicted, 'one', 'first output'));
    });
    const changed = await run(toolResult(contradicted, 'one', 'a different output'));
    assert.equal(changed.decision, 'block', JSON.stringify(changed));
    assert.match(changed.approved_output, /withheld/);
  });

  await t.test('a pod stopped inside a sanitizer checkpoint resumes the same withholding', async () => {
    const session = scope();
    const initialOffers = await prepareLeak(session);
    const beforeReceipts = await resultReceipts(session);
    const result = toolResult(session, 'read', 'raw sensitive payload');
    // The engine commits the observed success before the sanitizer answers;
    // the pod stops inside that window.
    const stopped = await waitingOnConsult(sanitizer.gate, result);
    stopped.child.kill('SIGKILL');
    await stopped.done;
    answerConsults(sanitizer.gate);
    assert.deepEqual(await resultReceipts(session), [...beforeReceipts, 'read=pending'].sort());

    const sanitizations = consults.sanitizer;
    const recovered = await run(result);
    assert.equal(recovered.output_source, 'runtime', JSON.stringify(recovered));
    assert.ok(!recovered.approved_output.includes('raw sensitive payload'));
    assert.equal(consults.sanitizer, sanitizations + 1, 'the unanswered consult runs once more');
    assert.ok((recovered.offers ?? []).length > 0, 'the withheld result stages its remedies again');
    assert.deepEqual(await resultReceipts(session), [...beforeReceipts, 'read=complete'].sort());
    assert.deepEqual(await run(result), recovered, 'the completed receipt replays byte-identically');

    const staged = recovered.offers.find((offer) => !initialOffers.has(offer.offer_id));
    assert.ok(staged, 'the recovery publishes the new staged-result offer');
    const accepted = await remedy(session, { tool_call_id: 'accept-staged', arguments: { offer_id: staged.offer_id } });
    assert.equal(accepted.approved_output, 'approved scrubbed output', JSON.stringify(accepted));
    assert.equal(consults.sanitizer, sanitizations + 1, 'accepting staged material does not rerun the sanitizer');
  });

  await t.test('a remedy interrupted between its two receipts is repaired by its saved decision', async () => {
    const session = scope();
    const initialOffers = await prepareLeak(session);
    const blocked = await run(toolResult(session, 'read', 'raw sensitive payload'));
    assert.equal(blocked.output_source, 'runtime', JSON.stringify(blocked));
    const offer = (blocked.offers ?? []).find((candidate) => !initialOffers.has(candidate.offer_id));
    assert.ok(offer, 'the withheld result staged a remedy');
    const operationsBefore = await receipts(session);
    const resultsBefore = await resultReceipts(session);

    const event = { tool_call_id: 'accept-staged', arguments: { offer_id: offer.offer_id } };
    await failCompletion('openappa_processed_results', 'tool_call_id', 'accept-staged', async () => {
      const failed = await remedy(session, event);
      assert.match(failed.error ?? JSON.stringify(failed), /PostgreSQL|database|db error/);
    });
    // The operation receipt completed; the tracked result receipt did not.
    assert.deepEqual((await receipts(session)).sort(), [...operationsBefore, 'remedy:accept-staged=complete'].sort());
    assert.deepEqual((await resultReceipts(session)).sort(), [...resultsBefore, 'accept-staged=pending'].sort());

    const sanitizations = consults.sanitizer;
    const recovered = await remedy(session, event);
    assert.equal(recovered.approved_output, 'approved scrubbed output', JSON.stringify(recovered));
    assert.notEqual(recovered.result?.isError, true);
    assert.equal(consults.sanitizer, sanitizations, 'the saved remedy is not executed again');
    assert.deepEqual((await resultReceipts(session)).sort(), [...resultsBefore, 'accept-staged=complete'].sort());
    // The tracked result the client reports afterwards replays the remedy.
    const reported = await run({ ...session, event: 'tool_result', tool_call_id: 'accept-staged', output: 'anything', outcome: 'success' });
    assert.equal(reported.approved_output, 'approved scrubbed output', JSON.stringify(reported));
  });

  await t.test('a blocked call interrupted after its denial replays the same offers', async () => {
    const session = scope();
    assert.equal((await run(toolCall(session, 'start', 'read_plain'))).decision, 'allow_call');
    // A trust-dropping call is held with offers. Its denial commits, then the
    // pod errors before the receipt completes.
    const denied = toolCall(session, 'publish', 'read_untrusted');
    await failCompletion('openappa_operations', 'operation_id', 'call:publish', async () => {
      const failed = await run(denied);
      assert.match(failed.error ?? JSON.stringify(failed), /PostgreSQL|database|db error/);
    });
    assert.deepEqual(await receipts(session), ['call:publish=pending', 'call:start=complete']);

    const committedEvents = await eventCount(session);
    const recovered = await run(denied);
    assert.equal(recovered.decision, 'deny_call', JSON.stringify(recovered));
    assert.ok((recovered.offers ?? []).length > 0, 'the replayed denial names its recorded offers');
    assert.deepEqual(await receipts(session), ['call:publish=complete', 'call:start=complete']);
    assert.equal(await eventCount(session), committedEvents, 'the denial is not recorded twice');
    assert.deepEqual(await run(denied), recovered, 'the completed denial replays byte-identically');
    // The replayed offers are the recorded ones: one of them still redeems.
    const accepted = await remedy(session, { tool_call_id: 'publish-accept', arguments: { offer_id: recovered.offers[0].offer_id, label: {} } });
    assert.notEqual(accepted.result?.isError, true, JSON.stringify(accepted));
  });

  // A result or cancel dispatch never claimed the call's own receipt: its
  // failure must leave that receipt for the call's resubmission or a later
  // report's recovery, not release it into a terminal unreleased answer.
  for (const [kind, report, expectRecovered, settledReceipts] of [
    [
      'result',
      (session) => toolResult(session, 'kept', 'kept output'),
      (recovered) => {
        assert.equal(recovered.decision, 'ack', JSON.stringify(recovered));
        assert.equal(recovered.approved_output, 'kept output');
      },
      ['call:kept=complete'],
    ],
    [
      'cancel',
      (session) => ({ ...session, event: 'cancel_call', tool_call_id: 'kept' }),
      (recovered) => {
        assert.equal(recovered.decision, 'deny_call', JSON.stringify(recovered));
        assert.match(recovered.approved_output, /not executed/);
      },
      ['call:kept=complete', 'cancel:kept=complete'],
    ],
  ]) {
    await t.test(`a failed ${kind} recovery keeps the call's pending receipt`, async () => {
      const session = scope();
      // The call's decision commits, then its receipt completion fails: the
      // pending receipt belongs to that dispatch, not to any later one.
      await failCompletion('openappa_operations', 'operation_id', 'call:kept', async () => {
        const failed = await run(toolCall(session, 'kept', 'read_plain'));
        assert.match(failed.error ?? JSON.stringify(failed), /PostgreSQL|database|db error/);
      });
      assert.deepEqual(await receipts(session), ['call:kept=pending']);
      const committedEvents = await eventCount(session);

      // The report's recovery completes the recovered call's receipt; fail
      // exactly there, before the report itself is recorded.
      await failCompletion('openappa_operations', 'operation_id', 'call:kept', async () => {
        const failed = await run(report(session));
        assert.match(failed.error ?? JSON.stringify(failed), /PostgreSQL|database|db error/);
      });
      assert.deepEqual(await receipts(session), ['call:kept=pending'], 'a failed recovery releases no receipt it did not claim');
      assert.deepEqual(await resultReceipts(session), [], 'its own uncommitted receipt is released');
      assert.equal(await eventCount(session), committedEvents, 'the failed recovery recorded nothing');

      const recovered = await run(report(session));
      expectRecovered(recovered);
      assert.deepEqual(await receipts(session), settledReceipts);
      assert.deepEqual(await resultReceipts(session), ['kept=complete']);
      const settledEvents = await eventCount(session);
      assert.deepEqual(await run(report(session)), recovered, 'the completed receipt replays byte-identically');
      assert.equal(await eventCount(session), settledEvents, 'the replay records nothing again');
    });
  }

  await t.test('two pods recovering one operation produce one execution and one answer', async () => {
    const session = scope();
    await stoppedMidConsult(toolCall(session, 'one', 'annotated_read'));
    assert.deepEqual(await receipts(session), ['call:one=pending']);

    const consultsBefore = consults.annotator;
    const [first, second] = await Promise.all([
      run(toolCall(session, 'one', 'annotated_read')),
      run(toolCall(session, 'one', 'annotated_read')),
    ]);
    assert.equal(first.decision, 'allow_call', JSON.stringify(first));
    assert.deepEqual(second, first, 'both pods answer identically');
    assert.equal(consults.annotator, consultsBefore + 1, 'the operation ran exactly once');
    assert.deepEqual(await receipts(session), ['call:one=complete']);
    assert.deepEqual(await resultReceipts(session), []);
  });

  await t.test('an unavailable annotator is not cached as a permanent refusal', async () => {
    const session = scope();
    const request = toolCall(session, 'one', 'annotated_read');
    annotator.gate.fail = true;
    let failed;
    try {
      failed = await run(request);
    } finally {
      annotator.gate.fail = false;
    }
    assert.match(failed.error, /processing interrupted|annotator/, JSON.stringify(failed));
    assert.deepEqual(await receipts(session), [], 'an operational fault did not complete a verdict');
    const recovered = await run(request);
    assert.equal(recovered.decision, 'allow_call', JSON.stringify(recovered));
    assert.deepEqual(await receipts(session), ['call:one=complete']);
    assert.deepEqual(await run(request), recovered);
  });

  await t.test('a spawn call and its result recover across a stopped pod', async () => {
    const session = scope();
    const child = { ...session, session_id: `${session.session_id}:agent:s1`, parent_id: session.session_id };
    const spawnCall = (id) => ({
      ...session, event: 'tool_call', operation_id: `call:${id}`, tool: 'agent__worker',
      arguments: { message: 'count the days' }, spawn: true,
      presentation: { control_tool: 'archestra__execute_remedy_plan', supports_delegation: true },
    });
    // A spawn runs only once its return is declared through the probe's remedy.
    const probe = await run(spawnCall('s1:declare'));
    assert.equal(probe.decision, 'deny_call', JSON.stringify(probe));
    const asSpoken = (probe.offers ?? []).find((offer) => offer.returns === 'as_spoken');
    assert.ok(asSpoken, 'the held spawn offers an as-spoken return');
    const declared = await remedy(session, {
      tool_call_id: 's1:return',
      arguments: { offer_id: asSpoken.offer_id, label: {} },
      presentation: { control_tool: 'archestra__execute_remedy_plan', supports_delegation: true },
    });
    assert.notEqual(declared.result?.isError, true, JSON.stringify(declared));

    // The real spawn is interrupted after its fork and binding committed.
    await failCompletion('openappa_operations', 'operation_id', 'call:s1', async () => {
      const failed = await run(spawnCall('s1'));
      assert.match(failed.error ?? JSON.stringify(failed), /PostgreSQL|database|db error/);
    });
    assert.deepEqual(await receipts(session), [
      'call:s1=pending', 'call:s1:declare=complete', 'remedy:s1:return=complete',
    ]);

    const recovered = await run(spawnCall('s1'));
    assert.equal(recovered.decision, 'allow_call', JSON.stringify(recovered));
    assert.ok(recovered.spawn_binding, 'the replayed spawn carries its fork binding');
    assert.deepEqual(await receipts(session), [
      'call:s1=complete', 'call:s1:declare=complete', 'remedy:s1:return=complete',
    ]);

    // The child starts against the replayed binding and returns as spoken.
    const started = await run({ ...child, event: 'session_start', spawn_call_id: 's1' });
    assert.ok(['ack', 'context'].includes(started.decision), JSON.stringify(started));
    const ended = await run({ ...child, event: 'child_end', operation_id: `turn:${randomUUID()}`, spawn_call_id: 's1', output: 'worker done' });
    assert.equal(ended.decision, 'ack', JSON.stringify(ended));

    // The spawn's result is interrupted after the runtime recorded it.
    const spawnResult = { ...session, event: 'tool_result', tool_call_id: 's1', spawned_id: child.session_id, output: 'worker done', outcome: 'success' };
    await failCompletion('openappa_processed_results', 'tool_call_id', 's1', async () => {
      const failed = await run(spawnResult);
      assert.match(failed.error ?? JSON.stringify(failed), /PostgreSQL|database|db error/);
    });
    assert.deepEqual(await resultReceipts(session), ['s1=pending', 's1:return=complete']);
    const recoveredResult = await run(spawnResult);
    assert.equal(recoveredResult.decision, 'ack', JSON.stringify(recoveredResult));
    assert.equal(recoveredResult.approved_output, 'worker done');
    assert.deepEqual(await resultReceipts(session), ['s1=complete', 's1:return=complete']);
    assert.deepEqual(await run(spawnResult), recoveredResult, 'the spawn result replays byte-identically');
  });

  await t.test('a cancellation interrupted before its receipt completes replays the withholding', async () => {
    const session = scope();
    assert.equal((await run(toolCall(session, 'cancelled', 'read_plain'))).decision, 'allow_call');
    const cancel = { ...session, event: 'cancel_call', tool_call_id: 'cancelled' };
    await failCompletion('openappa_processed_results', 'tool_call_id', 'cancelled', async () => {
      const failed = await run(cancel);
      assert.match(failed.error ?? JSON.stringify(failed), /PostgreSQL|database|db error/);
    });
    assert.deepEqual(await resultReceipts(session), ['cancelled=pending']);

    const recovered = await run(cancel);
    assert.equal(recovered.decision, 'deny_call', JSON.stringify(recovered));
    assert.match(recovered.approved_output, /not executed/);
    assert.deepEqual(await resultReceipts(session), ['cancelled=complete']);
    assert.deepEqual(await receipts(session), ['call:cancelled=complete', 'cancel:cancelled=complete']);
    // The cancelled call is not re-run under its id, and a late report of it
    // gets the withholding, not the bytes.
    assert.deepEqual(await run(toolCall(session, 'cancelled', 'read_plain')), recovered);
    const late = await run(toolResult(session, 'cancelled', 'FORGED'));
    assert.equal(late.approved_output, recovered.approved_output);
    assert.equal((await run(toolCall(session, 'next', 'read_plain'))).decision, 'allow_call');
  });

  await t.test('a late consult answer cannot write through a lost connection before the lease probe', async () => {
    const session = scope();
    const request = toolCall(session, 'one', 'annotated_read');
    const ledgerName = `openappa-lease-late-${randomUUID()}`;
    const stopped = await waitingOnConsult(annotator.gate, request, ledgerName);
    const ended = await client.query('SELECT pg_terminate_backend(pid) AS ended FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()', [ledgerName]);
    assert.ok(ended.rows.some((row) => row.ended), 'the old dispatch lost its database connection');
    annotator.gate.hold = false;
    const taken = await run(request);
    assert.equal(taken.decision, 'allow_call', JSON.stringify(taken));
    const committed = await eventCount(session);
    answerConsults(annotator.gate);
    const late = await stopped.done;
    assert.ok(late.error, `the stale dispatch must not finish successfully: ${JSON.stringify(late)}`);
    assert.equal(await eventCount(session), committed, 'no stale decision or effects were appended');
    assert.deepEqual(await run(request), taken, 'the current owner retains the only published answer');
  });

  await t.test('a pod that wakes up after losing its lease stands down and the session goes on', async () => {
    const session = scope();
    const ledgerName = `openappa-lease-stale-${randomUUID()}`;
    const stale = await waitingOnConsult(annotator.gate, toolCall(session, 'one', 'annotated_read'), ledgerName);
    // The pod freezes, and the database ends its connections, as a network
    // partition or a failover would.
    stale.child.kill('SIGSTOP');
    const ended = await client.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1',
      [ledgerName],
    );
    assert.ok(ended.rowCount > 0);

    // Keep the old HTTP request held, but let newly arriving consults answer.
    annotator.gate.hold = false;
    // Another pod takes the session over and finishes the same call.
    const taken = await run(toolCall(session, 'one', 'annotated_read'));
    assert.equal(taken.decision, 'allow_call', JSON.stringify(taken));
    assert.deepEqual(await receipts(session), ['call:one=complete']);

    // The frozen pod wakes up while its own consult is still unanswered.
    stale.child.kill('SIGCONT');
    assert.match((await stale.done).error, /lost its lease on this operation; retry the request/);
    annotator.gate.held.splice(0);

    assert.deepEqual(await receipts(session), ['call:one=complete']);
    // The retry the stale pod asked for is answered from the saved decision.
    assert.deepEqual(await run(toolCall(session, 'one', 'annotated_read')), taken);
    assert.equal((await run(toolCall(session, 'two', 'read_plain'))).decision, 'allow_call');
  });
});
