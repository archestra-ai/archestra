/**
 * The runtime contract Archestra's in-process subagents rely on: a delegation
 * call's return is declared on the caller's behalf through a probe of the same
 * call under its own operation, the child hears its contract at its start,
 * and its return crosses only through the declared route.
 */
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
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
  const { declared, call } = await startSpawn(run, { ...schema, additionalProperties: false });
  assert.equal(declared.result.isError, true, 'the delegation tool describes this dialect to the model');
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

test('a child returning as spoken may not read untrusted data', { skip: !databaseUrl }, async () => {
  await native.initializeOpenappa(databaseUrl, 2);
  const run = family();
  await startSpawn(run);
  await run.hook(run.child, { event: 'session_start', spawn_call_id: 's1' });
  const read = await run.hook(run.child, run.call('r1', 'read_inbox'));
  assert.equal(read.decision, 'deny_call');
  assert.deepEqual(read.offers ?? [], [], 'no remedy lets its free text carry untrusted data to the parent');
});
