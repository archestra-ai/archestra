/**
 * The runtime contract Archestra's in-process subagents rely on: a delegation
 * call's return is declared on the caller's behalf through a probe of the same
 * call under its own operation, the child hears its contract at its start,
 * and its return crosses only through the declared route.
 */
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('../../backend/node_modules/pg');
const { test } = require('node:test');
const native = require('./index.cjs');
const { databaseUrl } = require('./test-database.cjs');

const policy = {
  content: `[policy]
version = 2
[[policy.tool]]
name = "agent__reader"
delta = {}
[[policy.tool]]
name = "read_inbox"
delta = { trust = "suspicious" }
[[policy.tool]]
name = "publish"
delta = {}
requires = { trust = "trusted" }
[[policy.sanitizer]]
name = "attest-schema"
on = ["tool_output"]
[policy.sanitizer.permits]
trust = { from = "suspicious", to = "trusted" }
[policy.deployment]
context_control = true
`,
  credentials: {},
};
const presentation = { control_tool: 'archestra__execute_remedy_plan', supports_delegation: true };
const schema = {
  type: 'object',
  properties: { days: { type: 'integer', minimum: 0, maximum: 365 } },
  required: ['days'],
};

function family() {
  const organization = `subagent-${randomUUID()}`;
  const parent = { organization_id: organization, caller_id: 'user:test', session_id: `user:test|${randomUUID()}` };
  const hook = async (session, event) =>
    JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), policy));
  const remedy = async (session, toolCallId, args) =>
    JSON.parse(
      await native.executeRemedyByOffer(
        JSON.stringify({
          organization_id: organization,
          caller_id: session.caller_id,
          trajectory: {
            v: 1,
            session_id: session.session_id,
            ...(session.parent_id ? { parent_id: session.parent_id } : {}),
          },
          execution_mode: 'tracked',
          tool_call_id: toolCallId,
          arguments: args,
          original_arguments: JSON.stringify(args),
          presentation,
        }),
        policy,
      ),
    );
  const call = (callId, tool, extra = {}) => ({
    event: 'tool_call',
    operation_id: `call:${callId}`,
    tool,
    arguments: {},
    presentation,
    ...extra,
  });
  const spawnCall = (callId) =>
    call(callId, 'agent__reader', { arguments: { message: 'count the days' }, spawn: true });
  const child = { ...parent, session_id: `${parent.session_id}:agent:s1`, parent_id: parent.session_id };
  return { organization, parent, child, hook, remedy, call, spawnCall };
}

/** Declares the spawn's return through a probe, then dispatches the real call. */
async function startSpawn({ parent, hook, remedy, spawnCall }, returnSchema) {
  const probe = await hook(parent, spawnCall('s1:declare'));
  assert.equal(probe.decision, 'deny_call', 'an undeclared spawn is held');
  const offer = probe.offers.find((candidate) =>
    returnSchema ? candidate.returns?.sanitizer === 'attest-schema' : candidate.returns === 'as_spoken',
  );
  assert.ok(offer, 'the held spawn offers the requested return');
  const declared = await remedy(parent, 's1:return', {
    offer_id: offer.offer_id,
    label: {},
    ...(returnSchema ? { return_schema: returnSchema } : {}),
  });
  return { declared, call: await hook(parent, spawnCall('s1')) };
}

async function crossedReturns(run) {
  return native.loadChildReturns(run.organization, run.parent.session_id, {
    childSessionId: run.child.session_id,
    operationPrefix: 'runtime-return:s1:',
  });
}

test('a probe-declared spawn starts its child once, under the real call', { skip: !databaseUrl }, async () => {
  await native.initializeOpenappa(databaseUrl, 2);
  const run = family();
  const { declared, call } = await startSpawn(run, schema);
  assert.equal(declared.result.isError, false);
  assert.equal(call.decision, 'allow_call');
  assert.ok(call.spawn_binding, 'the real call carries the prepared fork');

  const start = await run.hook(run.child, { event: 'session_start', spawn_call_id: 's1' });
  assert.equal(start.decision, 'context', 'the child hears its return contract first');

  const prose = await run.hook(run.child, { event: 'child_return', operation_id: 'runtime-return:s1:r1', output: 'about three days' });
  assert.equal(prose.decision, 'block', 'free text cannot cross an attested return');
  const matching = await run.hook(run.child, { event: 'child_return', operation_id: 'runtime-return:s1:r2', output: '{"days":3}' });
  assert.equal(matching.decision, 'ack');

  const records = await crossedReturns(run);
  assert.deepEqual(records.map((record) => record.value), ['{"days":3}']);
  const result = await run.hook(run.parent, {
    event: 'tool_result',
    tool_call_id: 's1',
    spawned_id: run.child.session_id,
    output: records[0].value,
    outcome: 'success',
  });
  assert.equal(result.decision, 'ack', "the crossed value is the spawn's result");
});

test('an attested return schema admits only bounded leaves', { skip: !databaseUrl }, async () => {
  await native.initializeOpenappa(databaseUrl, 2);
  const run = family();
  await assert.rejects(
    () => startSpawn(run, { ...schema, additionalProperties: false }),
    /return_schema.*does not compile.*return shape/,
    'the delegation tool rejects an unsupported return-shape dialect',
  );
  const call = await run.hook(run.parent, run.spawnCall('s1'));
  assert.equal(call.decision, 'deny_call', 'a refused declaration leaves the spawn held');
});

test("an attested child may read untrusted data and still answer at its parent's trust", { skip: !databaseUrl }, async () => {
  await native.initializeOpenappa(databaseUrl, 2);
  const run = family();
  await startSpawn(run, schema);
  await run.hook(run.child, { event: 'session_start', spawn_call_id: 's1' });
  const held = await run.hook(run.child, run.call('r1', 'read_inbox'));
  assert.equal(held.decision, 'deny_call', 'the child accepts the trust drop first');
  const accepted = await run.remedy(run.child, 'r1:accept', { offer_id: held.offers[0].offer_id, label: {} });
  assert.equal(accepted.result.isError, false);
  assert.equal((await run.hook(run.child, run.call('r2', 'read_inbox'))).decision, 'allow_call');
  await run.hook(run.child, { event: 'tool_result', tool_call_id: 'r2', output: 'lease ends in 3 days', outcome: 'success' });
  const returned = await run.hook(run.child, { event: 'child_return', operation_id: 'runtime-return:s1:r1', output: '{"days":3}' });
  assert.equal(returned.decision, 'ack');

  const [record] = await crossedReturns(run);
  await run.hook(run.parent, {
    event: 'tool_result',
    tool_call_id: 's1',
    spawned_id: run.child.session_id,
    output: record.value,
    outcome: 'success',
  });
  assert.equal((await run.hook(run.parent, run.call('p1', 'publish'))).decision, 'allow_call', 'the parent is still trusted');
});

// The pinned runtime still offers the attestation to a suspicious parent and
// refuses it on execution with no answer. That answer reaches the model as an
// error result, not as a runtime failure that ends the turn.
test('a suspicious parent is not offered an attested return', { skip: !databaseUrl }, async () => {
  await native.initializeOpenappa(databaseUrl, 2);
  const run = family();
  const held = await run.hook(run.parent, run.call('r1', 'read_inbox'));
  await run.remedy(run.parent, 'r1:accept', { offer_id: held.offers[0].offer_id, label: {} });
  assert.equal((await run.hook(run.parent, run.call('r2', 'read_inbox'))).decision, 'allow_call');
  await run.hook(run.parent, { event: 'tool_result', tool_call_id: 'r2', output: 'lease ends in 3 days', outcome: 'success' });

  const probe = await run.hook(run.parent, run.spawnCall('s1:declare'));
  assert.equal(probe.decision, 'deny_call', 'an undeclared spawn is held');
  const returns = probe.offers.map((offer) => offer.returns);
  assert.ok(returns.includes('as_spoken'));
  assert.ok(!returns.some((route) => route?.sanitizer === 'attest-schema'), 'the attestation would be refused');
});

test('a child returning as spoken may not read untrusted data', { skip: !databaseUrl }, async () => {
  await native.initializeOpenappa(databaseUrl, 2);
  const run = family();
  await startSpawn(run);
  await run.hook(run.child, { event: 'session_start', spawn_call_id: 's1' });
  const read = await run.hook(run.child, run.call('r1', 'read_inbox'));
  assert.equal(read.decision, 'deny_call');
  assert.deepEqual(read.offers ?? [], [], 'no remedy lets its free text carry untrusted data to the parent');
});

// A child that answers a follow-up returns again under the same spawn call.
// The LLM proxy approves such a child once, with its newest return, and it
// accepts the return the spawn call kept. It also ends a turn that has no text
// as a turn, not as a child end. The tests below are the reasons.

/** A child that returns as spoken, with each of its turns ended. */
async function returningChild(turns) {
  const run = family();
  await startSpawn(run);
  await run.hook(run.child, { event: 'session_start', spawn_call_id: 's1' });
  const childEnd = (output) =>
    run.hook(run.child, { event: 'child_end', operation_id: `turn:${randomUUID()}`, spawn_call_id: 's1', output });
  const end = async (output) => {
    assert.equal((await childEnd(output)).decision, 'ack', 'each turn crosses its own return');
  };
  for (const output of turns) await end(output);
  const turnEnd = () => run.hook(run.child, { event: 'turn_end', operation_id: `turn:${randomUUID()}` });
  const call = () => run.hook(run.child, run.call(randomUUID(), 'publish'));
  const approve = (output) =>
    run.hook(run.parent, {
      event: 'tool_result',
      tool_call_id: 's1',
      spawned_id: run.child.session_id,
      output,
      outcome: 'success',
    });
  const crossed = async () =>
    (await native.loadChildReturns(run.organization, run.parent.session_id, { childSessionId: run.child.session_id })).map(
      (record) => record.value,
    );
  return { childEnd, end, turnEnd, call, approve, crossed };
}

test('a child end with no value ends the child', { skip: !databaseUrl }, async () => {
  await native.initializeOpenappa(databaseUrl, 2);
  const child = await returningChild([]);
  await child.end(undefined);

  assert.equal((await child.call()).decision, 'deny_call', 'the ended child can call no tool');
  assert.equal((await child.childEnd('answer to a follow-up')).decision, 'block', 'and it can return nothing');
  assert.deepEqual(await child.crossed(), []);
});

test('a child whose turn ended as a turn can still work and return', { skip: !databaseUrl }, async () => {
  await native.initializeOpenappa(databaseUrl, 2);
  const child = await returningChild([]);
  assert.equal((await child.turnEnd()).decision, 'ack');

  assert.equal((await child.call()).decision, 'allow_call');
  await child.end('answer to a follow-up');
  assert.deepEqual(await child.crossed(), ['answer to a follow-up']);
  assert.equal((await child.approve('answer to a follow-up')).decision, 'ack');
});

test('a spawn result is replayed only for the latest return of its child', { skip: !databaseUrl }, async () => {
  await native.initializeOpenappa(databaseUrl, 2);
  const child = await returningChild(['first answer', 'second answer']);
  assert.deepEqual(await child.crossed(), ['second answer', 'first answer'], 'the newest return is first');

  const older = await child.approve('first answer');
  assert.equal(older.decision, 'block', 'an older return is not replayed');
  assert.notEqual(older.approved_output, 'first answer');
});

test('a spawn call keeps the first return that the runtime approved for it', { skip: !databaseUrl }, async () => {
  await native.initializeOpenappa(databaseUrl, 2);
  const child = await returningChild(['first answer']);
  const first = await child.approve('first answer');
  assert.equal(first.decision, 'ack');
  assert.equal(first.approved_output, 'first answer');

  await child.end('second answer');
  assert.deepEqual(await child.crossed(), ['second answer', 'first answer']);
  const second = await child.approve('second answer');
  assert.equal(second.decision, 'ack');
  assert.equal(second.approved_output, 'first answer', 'the later result gets the kept return');
});

// The decision `child_return` comes from a child's event when the value that crossed differs
// from what the child said, and only there: the parent's spawn result answers `ack` with the
// text it was handed. The host echoes the returned value, then reports the parent's result.
test('a rewritten child return answers child_return, crosses through its echo, and the parent result keeps it', { skip: !databaseUrl }, async () => {
  await native.initializeOpenappa(databaseUrl, 2);
  const listSchema = {
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 0, maximum: 365 },
      list: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 365 }, maxItems: 256 },
    },
    required: ['days', 'list'],
  };
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const event of ['child_return', 'child_end']) {
      const run = family();
      const { declared, call } = await startSpawn(run, listSchema);
      assert.equal(declared.result.isError, false);
      assert.equal(call.decision, 'allow_call');
      await run.hook(run.child, { event: 'session_start', spawn_call_id: 's1' });
      const said = `{ "days": 3, "list": [${Array.from({ length: 256 }, (_, i) => 100 + (i % 200)).join(', ')}] }`;
      const extra = event === 'child_end' ? { spawn_call_id: 's1' } : {};
      const staged = await run.hook(run.child, { event, operation_id: 'runtime-return:s1:r1', output: said, ...extra });
      assert.equal(staged.decision, 'child_return', 'the crossed form differs from what was said');
      assert.equal(staged.value, JSON.stringify(JSON.parse(said)));
      const echo = await run.hook(run.child, { event, operation_id: 'runtime-return:s1:r1:echo', output: staged.value, ...extra });
      assert.equal(echo.decision, 'ack', 'the canonical value crosses');
      const records = await crossedReturns(run);
      assert.deepEqual(records.map((record) => record.value), [staged.value]);
      const result = (output) => run.hook(run.parent, { event: 'tool_result', tool_call_id: 's1', spawned_id: run.child.session_id, output, outcome: 'success' });
      const first = await result(staged.value);
      assert.equal(first.decision, 'ack', 'the parent result is never child_return');
      assert.equal(first.approved_output, staged.value);
      // Over 1 KiB, the stored text is in the decision and the column holds its digest.
      const stored = (await client.query(
        'SELECT approved_output, decision FROM openappa_processed_results WHERE organization_id=$1 AND session_id=$2 AND tool_call_id=$3',
        [run.organization, run.parent.session_id, 's1'],
      )).rows[0];
      assert.equal(stored.decision.approved_output, staged.value);
      assert.match(stored.approved_output, /^sha256:[0-9a-f]{64}$/);
      // A replay, and a later return for the same call, come back as the first.
      assert.deepEqual(await result(staged.value), first);
      await run.hook(run.child, { event: 'child_return', operation_id: 'runtime-return:s1:r2', output: '{"days":4,"list":[9]}' });
      const later = await result('{"days":4,"list":[9]}');
      assert.equal(later.approved_output, staged.value, 'the kept return comes from the stored decision');
    }
  } finally {
    await client.end();
  }
});
