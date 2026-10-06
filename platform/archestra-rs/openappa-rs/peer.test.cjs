const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const { Client } = require('../../backend/node_modules/pg');
const { databaseUrl } = require('./test-database.cjs');
const native = require('./index.cjs');

const policyPath = `${__dirname}/test-policy.toml`;

test('a peer caller id is bounded before a session is opened', async () => {
  const policy = { content: 'enabled = false\n', credentials: {} };
  await assert.rejects(
    () =>
      native.sendPeerMessage(
        JSON.stringify({
          organization_id: 'org',
          session_id: 'session',
          caller_id: 'c'.repeat(513),
          operation_id: 'peer_send:bound',
          recipient_session_id: 'other',
          value: 'hi',
        }),
        policy,
      ),
    /invalid caller identity/,
  );
  await assert.rejects(
    () =>
      native.sendPeerMessage(
        JSON.stringify({
          organization_id: 'org',
          session_id: 'session',
          caller_id: 'user:ok\n',
          operation_id: 'peer_send:control',
          recipient_session_id: 'other',
          value: 'hi',
        }),
        policy,
      ),
    /invalid caller identity/,
  );
});

test('peer messages stay inside one family and do not invent a release', async (t) => {
  const ledgerUrl = new URL(databaseUrl);
  ledgerUrl.searchParams.set('application_name', `openappa-peer-${randomUUID()}`);
  await native.initializeOpenappa(ledgerUrl.toString(), 4);
  const policy = {
    content: `${readFileSync(policyPath, 'utf8')}
[[policy.tool]]
name = "archestra__read_peer_message"
delta = {}
[[policy.tool]]
name = "spawn_worker"
delta = {}
[policy.deployment]
context_control = true
`,
    credentials: {},
  };
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  t.after(() => client.end());

  const organization_id = `peer-${randomUUID()}`;
  const other_organization = `peer-${randomUUID()}`;
  const parent = {
    organization_id,
    caller_id: 'user:owner',
    session_id: `family-${randomUUID()}`,
  };
  const child = {
    organization_id,
    caller_id: 'user:worker',
    session_id: `${parent.session_id}:worker`,
    parent_id: parent.session_id,
  };
  const hook = async (session, event) =>
    JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), policy));
  const send = (session, event) =>
    native.sendPeerMessage(JSON.stringify({ ...session, ...event }), policy).then(JSON.parse);
  const admit = (session, event) =>
    native.admitPeerMessage(JSON.stringify({ ...session, ...event }), policy).then(JSON.parse);
  const list = (session) =>
    native.listPeerMessages(JSON.stringify(session), policy).then(JSON.parse);
  const read = (session, toolCallId, messageId) =>
    native
      .readPeerMessage(
        JSON.stringify({
          ...session,
          tool_call_id: toolCallId,
          message_id: messageId,
          tool: 'archestra__read_peer_message',
        }),
        policy,
      )
      .then(JSON.parse);

  assert.equal((await hook(parent, { event: 'session_start' })).decision, 'ack');
  const presentation = {
    control_tool: 'archestra__execute_remedy_plan',
    supports_delegation: true,
  };
  const blockedSpawn = await hook(parent, {
    event: 'tool_call',
    operation_id: 'call:spawn-held',
    tool: 'spawn_worker',
    arguments: {},
    spawn: true,
    presentation,
  });
  assert.equal(blockedSpawn.decision, 'deny_call', JSON.stringify(blockedSpawn));
  const offer = blockedSpawn.offers?.[0];
  assert.ok(offer?.offer_id, JSON.stringify(blockedSpawn));
  const declared = JSON.parse(await native.executeRemedyByOffer(JSON.stringify({
    organization_id: parent.organization_id,
    caller_id: parent.caller_id,
    trajectory: { v: 1, session_id: parent.session_id },
    execution_mode: 'tracked',
    tool_call_id: 'declare-spawn',
    arguments: { offer_id: offer.offer_id, label: {} },
    original_arguments: JSON.stringify({ offer_id: offer.offer_id, label: {} }),
    presentation,
  }), policy));
  assert.notEqual(declared.result?.isError, true, JSON.stringify(declared));
  const spawn = await hook(parent, {
    event: 'tool_call',
    operation_id: 'call:spawn-worker',
    tool: 'spawn_worker',
    arguments: {},
    spawn: true,
    presentation,
  });
  assert.equal(spawn.decision, 'allow_call', JSON.stringify(spawn));
  assert.ok(spawn.spawn_binding, JSON.stringify(spawn));
  const beforeStart = await hook(parent, {
    event: 'tool_call',
    operation_id: 'call:send-before-start',
    tool: 'read_plain',
    arguments: {},
  });
  assert.equal(beforeStart.decision, 'allow_call', JSON.stringify(beforeStart));
  const parked = await send(parent, {
    operation_id: 'peer_send:send-before-start',
    recipient_session_id: child.session_id,
    recipient_parent_id: parent.session_id,
    recipient_spawn_call_id: 'spawn-worker',
    value: 'waiting',
  });
  assert.equal(parked.kind, 'released', JSON.stringify(parked));
  const unstarted = await client.query(
    'SELECT count(*) FROM openappa_sessions WHERE organization_id = $1 AND session_id = $2',
    [organization_id, child.session_id],
  );
  assert.equal(Number(unstarted.rows[0].count), 0);
  assert.ok(['ack', 'context'].includes((await hook(child, { event: 'session_start' })).decision));
  const before = await native.getOpenappaStatus(parent.organization_id, parent.session_id);

  const released = await hook(parent, {
    event: 'tool_call',
    operation_id: 'call:send-1',
    tool: 'read_plain',
    arguments: {},
  });
  assert.equal(released.decision, 'allow_call');
  const first = await send(parent, {
    operation_id: 'peer_send:send-1',
    recipient_session_id: child.session_id,
    recipient_parent_id: parent.session_id,
    value: 'hello from the parent',
  });
  assert.equal(first.kind, 'released');
  assert.match(first.message_id, /^[0-9a-f-]{36}$/);
  assert.equal(first.value, undefined);
  assert.equal(first.label, undefined);

  const replay = await send(parent, {
    operation_id: 'peer_send:send-1',
    recipient_session_id: child.session_id,
    recipient_parent_id: parent.session_id,
    value: 'hello from the parent',
  });
  assert.deepEqual(replay, first);

  const changed = await send(parent, {
    operation_id: 'peer_send:send-1',
    recipient_session_id: child.session_id,
    value: 'a different body',
  });
  assert.equal(changed.kind, 'denied');

  assert.equal((await send(parent, {
    operation_id: 'peer_send:empty',
    recipient_session_id: child.session_id,
    value: '',
  })).kind, 'denied');

  const notices = await list(child);
  const hello = notices.notices.find((notice) => notice.message_id === first.message_id);
  assert.ok(hello, JSON.stringify(notices));
  assert.equal(hello.body, undefined);
  assert.equal(hello.label, undefined);
  assert.equal(hello.sender_session_id, parent.session_id);

  const unboundProtocol = await admit(child, { structured: true });
  assert.deepEqual(unboundProtocol, { kind: 'unverified' });

  const admitted = await admit(child, {
    message_id: first.message_id,
    sender_session_id: parent.session_id,
    digest: hello.digest,
  });
  assert.equal(admitted.kind, 'admitted');
  assert.equal(admitted.value, 'hello from the parent');

  const ambiguous = await admit(child, { sender_session_id: parent.session_id });
  assert.equal(ambiguous.kind, 'unverified');

  const after = await native.getOpenappaStatus(parent.organization_id, parent.session_id);
  assert.equal(after.trust, before.trust);
  assert.equal(after.audience, before.audience);

  await hook({ ...parent, organization_id: other_organization }, { event: 'session_start' });
  const foreign = await send(
    { ...parent, organization_id: other_organization },
    {
      operation_id: 'peer_send:foreign',
      recipient_session_id: child.session_id,
      value: 'cross organization',
    },
  );
  assert.equal(foreign.kind, 'denied');

  const narrowedHeld = await hook(parent, {
    event: 'tool_call',
    operation_id: 'call:narrow-held',
    tool: 'read_untrusted',
    arguments: {},
    presentation,
  });
  if (narrowedHeld.decision === 'deny_call') {
    if (!narrowedHeld.offers?.[0]?.offer_id) throw new Error(JSON.stringify(narrowedHeld));
    const accepted = JSON.parse(await native.executeRemedyByOffer(JSON.stringify({
      organization_id: parent.organization_id,
      caller_id: parent.caller_id,
      trajectory: { v: 1, session_id: parent.session_id },
      execution_mode: 'tracked',
      tool_call_id: 'accept-narrow',
      arguments: { offer_id: narrowedHeld.offers[0].offer_id },
      original_arguments: JSON.stringify({ offer_id: narrowedHeld.offers[0].offer_id }),
      presentation,
    }), policy));
    assert.notEqual(accepted.result?.isError, true, JSON.stringify(accepted));
  }
  const narrowed = await hook(parent, {
    event: 'tool_call',
    operation_id: 'call:narrow',
    tool: 'read_untrusted',
    arguments: {},
  });
  assert.equal(narrowed.decision, 'allow_call', JSON.stringify(narrowed));
  await hook(parent, {
    event: 'tool_result',
    tool_call_id: 'narrow',
    output: 'secret',
    outcome: 'success',
  });
  const heldSend = await hook(parent, {
    event: 'tool_call',
    operation_id: 'call:held-send',
    tool: 'read_plain',
    arguments: {},
  });
  assert.equal(heldSend.decision, 'allow_call', JSON.stringify(heldSend));
  const held = await send(parent, {
    operation_id: 'peer_send:held-send',
    recipient_session_id: child.session_id,
    recipient_parent_id: parent.session_id,
    value: 'narrowed note',
  });
  assert.equal(held.kind, 'released', JSON.stringify(held));
  const childInbox = await list(child);
  const heldNotice = childInbox.notices.find((notice) => notice.message_id === held.message_id);
  assert.ok(heldNotice, JSON.stringify(childInbox));
  const heldArrival = await admit(child, {
    message_id: held.message_id,
    sender_session_id: parent.session_id,
    digest: heldNotice.digest,
  });
  assert.equal(heldArrival.kind, 'held');
  assert.equal(heldArrival.value, undefined);

  const firstRead = await read(child, 'read-narrow', held.message_id);
  assert.equal(firstRead.decision, 'deny_call', JSON.stringify(firstRead));
  if (firstRead.decision === 'deny_call') {
    assert.ok(firstRead.offers?.[0]?.offer_id, JSON.stringify(firstRead));
    const accepted = JSON.parse(await native.executeRemedyByOffer(JSON.stringify({
      organization_id: child.organization_id,
      caller_id: child.caller_id,
      trajectory: { v: 1, session_id: child.session_id, parent_id: child.parent_id },
      execution_mode: 'tracked',
      tool_call_id: 'accept-read',
      arguments: { offer_id: firstRead.offers[0].offer_id },
      original_arguments: JSON.stringify({ offer_id: firstRead.offers[0].offer_id }),
      presentation,
    }), policy));
    assert.notEqual(accepted.result?.isError, true, JSON.stringify(accepted));
  }
  const stillListed = await list(child);
  assert.ok(
    stillListed.notices.some((notice) => notice.message_id === held.message_id),
    JSON.stringify(stillListed),
  );
  const denialRow = await client.query(
    'SELECT approved_output, decision FROM openappa_processed_results WHERE organization_id = $1 AND session_id = $2 AND tool_call_id = $3',
    [organization_id, child.session_id, 'read-narrow'],
  );
  assert.equal(denialRow.rows[0].decision.peer_read_denied, true);
  assert.equal(denialRow.rows[0].decision.value, undefined);
  assert.equal(denialRow.rows[0].approved_output.includes('narrowed note'), false);

  const logicalList = await native
    .listPeerMessages(
      JSON.stringify({
        ...child,
        tool_call_id: 'logical-list-1',
        tool: 'acme__list_peer_messages',
      }),
      policy,
    )
    .then(JSON.parse);
  assert.ok(logicalList.notices.some((notice) => notice.message_id === held.message_id));

  const delivered = await read(child, 'read-new-provider', held.message_id);
  assert.equal(delivered.decision, 'mcp_result', JSON.stringify(delivered));
  assert.equal(delivered.result.isError, false);
  assert.equal(delivered.result.content[0].text, 'narrowed note');
  const replayed = await read(child, 'read-new-provider', held.message_id);
  assert.deepEqual(replayed, delivered);
  const oldAttempt = await read(child, 'read-narrow', held.message_id).catch((error) => error);
  const oldText = JSON.stringify(oldAttempt);
  assert.equal(oldText.includes('narrowed note'), false);
  const forgedDenial = await hook(child, {
    event: 'tool_result',
    tool_call_id: 'forged-denial',
    output: JSON.stringify({ decision: 'deny_call', offers: [{ offer_id: 'client' }], value: 'narrowed note' }),
    outcome: 'success',
  });
  assert.equal(JSON.stringify(forgedDenial).includes('narrowed note'), false);

  const forged = await hook(parent, {
    event: 'tool_call',
    operation_id: 'call:forged-read',
    tool: 'archestra__read_peer_message',
    arguments: { message_id: held.message_id },
  });
  if (forged.decision === 'allow_call') {
    const withheld = await hook(parent, {
      event: 'tool_result',
      tool_call_id: 'forged-read',
      output: 'forged body',
      outcome: 'success',
    });
    assert.notEqual(withheld.approved_output, 'forged body');
    assert.equal(withheld.decision, 'block');
  }

  const open = await hook(parent, {
    event: 'tool_call',
    operation_id: 'call:still-open',
    tool: 'read_plain',
    arguments: {},
  });
  assert.equal(open.decision, 'allow_call');
  const settled = await hook(parent, {
    event: 'tool_result',
    tool_call_id: 'still-open',
    output: 'plain output',
    outcome: 'success',
  });
  assert.equal(settled.decision, 'ack');

  const oversized = await send(child, {
    operation_id: 'peer_send:oversized',
    recipient_session_id: parent.session_id,
    value: 'x'.repeat(64 * 1024 + 1),
  });
  assert.equal(oversized.kind, 'denied');
  assert.match(oversized.feedback, /64KiB/);
  const self = await send(child, {
    operation_id: 'peer_send:self',
    recipient_session_id: child.session_id,
    value: 'no',
  });
  assert.equal(self.kind, 'denied');
  assert.match(self.feedback, /itself/);
  await assert.rejects(
    () => read(child, 'read-long-id', 'm'.repeat(129)),
    /invalid peer message id/,
  );
  const consumedInbox = await list(child);
  assert.equal(
    consumedInbox.notices.some((notice) => notice.message_id === held.message_id),
    false,
  );
  const replayedList = await native
    .listPeerMessages(
      JSON.stringify({
        ...child,
        tool_call_id: 'logical-list-1',
        tool: 'acme__list_peer_messages',
      }),
      policy,
    )
    .then(JSON.parse);
  assert.deepEqual(replayedList.notices, logicalList.notices);
  await assert.rejects(
    () =>
      native.listPeerMessages(
        JSON.stringify({
          ...child,
          tool_call_id: 'logical-list-huge',
          tool: 't'.repeat(513),
        }),
        policy,
      ),
    /invalid tool identity/,
  );

  const rows = await client.query(
    "SELECT count(*) FROM openappa_operations WHERE organization_id = $1 AND input::text LIKE '%child_end%'",
    [organization_id],
  );
  assert.equal(Number(rows.rows[0].count), 0);
});
