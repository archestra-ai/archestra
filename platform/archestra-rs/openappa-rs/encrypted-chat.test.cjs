const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { Client } = require('../../backend/node_modules/pg');
const native = require('./index.cjs');
const { databaseUrl } = require('./test-database.cjs');
const NEUTRAL = { delta: {}, requires: { history: [], attention: [] }, emits: [] };

const policy = { content: `[policy]
version = 2
[[policy.tool]]
name = "read"
delta = { trust = "suspicious" }
[[policy.tool]]
name = "send"
delta = {}
requires = { trust = "trusted" }
`, credentials: {} };
const scope = () => ({ organization_id: `encrypted-test-${randomUUID()}`, caller_id: 'user:test', session_id: randomUUID() });
const encryption = (session) => ({ key: randomBytes(32), scope: JSON.stringify([session.organization_id, session.session_id]) });
const hook = async (session, event, key, served = policy) => JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), served, key));

test('encrypted trajectories enforce, replay, survive a new process, and contain no plaintext content', { skip: !databaseUrl, timeout: 60000 }, async (t) => {
  await native.initializeOpenappa(databaseUrl, 4);
  const session = scope();
  const setup = new Client({ connectionString: databaseUrl }); await setup.connect();
  await setup.query('INSERT INTO organization (id,name,slug,created_at) VALUES ($1,$1,$1,now())', [session.organization_id]);
  await setup.end();
  const key = encryption(session);
  const marker = `private-content-${randomUUID()}`;
  assert.equal((await hook(session, { event: 'session_start' }, key)).decision, 'ack');
  const call = { event: 'tool_call', operation_id: 'call:read', tool_call_id: 'read', tool: 'read', arguments: { marker } };
  const denied = await hook(session, call, key);
  assert.equal(denied.decision, 'deny_call');
  assert.equal(denied.offers.length, 1);
  assert.deepEqual(await hook(session, call, key), denied, 'encrypted operation receipt replays exactly');
  await hook(session, { event: 'remedy', operation_id: 'accept', arguments: { offer_id: denied.offers[0].offer_id } }, key);
  assert.equal((await hook(session, { ...call, operation_id: 'call:retry', tool_call_id: 'retry' }, key)).decision, 'allow_call');
  const result = { event: 'tool_result', tool_call_id: 'retry', output: marker, outcome: 'success' };
  const approved = await hook(session, result, key);
  assert.equal(approved.decision, 'ack');
  assert.deepEqual(await hook(session, result, key), approved, 'encrypted processed output replays exactly');
  assert.equal((await hook(session, { event: 'tool_call', operation_id: 'call:send', tool: 'send', arguments: { marker } }, key)).decision, 'deny_call');
  assert.equal((await native.getOpenappaStatus(session.organization_id, session.session_id, key)).trust, 'suspicious');
  await assert.rejects(native.getOpenappaStatus(session.organization_id, session.session_id), /requires its conversation key/);
  await assert.rejects(native.getOpenappaStatus(session.organization_id, session.session_id, { ...key, key: randomBytes(32) }), /authentication failed/);
  await assert.rejects(hook(session, { ...call, operation_id: 'call:keyless', tool_call_id: 'keyless' }), /requires its conversation key/);
  const child = spawnSync(process.execPath, ['-e', `
    const n=require('./index.cjs');
    (async()=>{const x=JSON.parse(require('fs').readFileSync(0,'utf8')); await n.initializeOpenappa(x.url,2); const status=await n.getOpenappaStatus(x.session.organization_id,x.session.session_id,{key:Buffer.from(x.key,'base64'),scope:x.scope}); process.stdout.write(JSON.stringify(status));})().catch(e=>{console.error(e.message);process.exitCode=1});
  `], { cwd: __dirname, input: JSON.stringify({ url: databaseUrl, session, key: key.key.toString('base64'), scope: key.scope }), encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).trust, 'suspicious');

  const pg = new Client({ connectionString: databaseUrl }); await pg.connect(); t.after(() => pg.end());
  assert.equal((await pg.query("SELECT count(*)::int AS n FROM openappa_operations WHERE organization_id=$1 AND session_id=$2 AND operation_id='call:keyless'", [session.organization_id, session.session_id])).rows[0].n, 0, 'a keyless dispatch must not write a plaintext pending receipt before it fails');
  const receipts = await pg.query('SELECT input,decision FROM openappa_operations WHERE organization_id=$1 AND session_id=$2', [session.organization_id, session.session_id]);
  assert.ok(receipts.rows.length >= 4);
  for (const row of receipts.rows) {
    assert.ok(row.input.__appa_encrypted);
    assert.ok(row.decision.__appa_encrypted);
    assert.ok(!JSON.stringify(row).includes(marker));
  }
  const outputs = await pg.query('SELECT approved_output,decision FROM openappa_processed_results WHERE organization_id=$1 AND session_id=$2', [session.organization_id, session.session_id]);
  assert.equal(outputs.rows.length, 1);
  assert.match(outputs.rows[0].approved_output, /^appa-storage-v1:/);
  assert.ok(outputs.rows[0].decision.__appa_encrypted);
  const starts = await pg.query('SELECT root,start_decision FROM openappa_sessions WHERE organization_id=$1 AND session_id=$2', [session.organization_id, session.session_id]);
  assert.ok(starts.rows[0].start_decision.__appa_encrypted);
  const opening = await pg.query('SELECT policy_file_key FROM openappa_root_openings WHERE root=$1 AND organization_id=$2', [starts.rows[0].root, session.organization_id]);
  assert.equal(opening.rows.length, 1, 'encrypted roots retain their policy identity for annotator liveness without decrypting their opening event');
  assert.match(opening.rows[0].policy_file_key, /^[0-9a-f]{64}$/);
  const events = await pg.query('SELECT payload FROM openappa_events WHERE root=$1 ORDER BY seq', [starts.rows[0].root]);
  assert.ok(events.rows.length > 1);
  for (const row of events.rows) assert.ok(row.payload.subarray(0,17).includes(Buffer.from('appa-storage-v1')) && !row.payload.includes(Buffer.from(marker)));
  // Tampering must fail even after a previously successful status read: a new
  // encrypted view must never reuse an unkeyed/decrypted process cache.
  const saved = events.rows[0].payload; const tampered = Buffer.from(saved); tampered[tampered.length-1] ^= 1;
  await pg.query('UPDATE openappa_events SET payload=$2 WHERE root=$1 AND seq=0', [starts.rows[0].root, tampered]);
  await assert.rejects(native.getOpenappaStatus(session.organization_id, session.session_id, key), /authentication failed/);
  await pg.query('UPDATE openappa_events SET payload=$2 WHERE root=$1 AND seq=0', [starts.rows[0].root, saved]);
});

test('concurrent encrypted annotations carry only their own transient context and encrypt consult audit content', { skip: !databaseUrl, timeout: 60000 }, async (t) => {
  const requests = [];
  const server = createServer((req,res) => {
    let body=''; req.on('data', c => body+=c); req.on('end', () => { requests.push({ context:req.headers['x-archestra-openappa-context'], body }); res.setHeader('content-type','application/json'); res.end(JSON.stringify(NEUTRAL)); });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); t.after(()=>new Promise(r=>server.close(r)));
  process.env.APPA_ARCHESTRA_ANNOTATOR_URL=`http://127.0.0.1:${server.address().port}/annotate`;
  process.env.APPA_ARCHESTRA_BRIDGE_TOKEN='encrypted-test-bridge';
  const annotated = { content: `[policy]\nversion = 2\n[[policy.annotator]]\nname = "judge"\nbuiltin = "archestra"\n[[policy.tool]]\nname = "read"\nannotator = "judge"\n`, credentials:{} };
  await native.initializeOpenappa(databaseUrl,4);
  const sessions = [scope(),scope()];
  const setup = new Client({ connectionString: databaseUrl }); await setup.connect();
  for (const session of sessions) await setup.query('INSERT INTO organization (id,name,slug,created_at) VALUES ($1,$1,$1,now())', [session.organization_id]);
  await setup.end();
  const keys = sessions.map((s,i)=>({...encryption(s),annotatorContext:`context-${i}`}));
  await Promise.all(sessions.map((s,i)=>hook(s,{event:'tool_call', operation_id:'call:read',tool:'read',arguments:{marker:`private-annotation-${i}`}},keys[i],annotated).then(d=>assert.equal(d.decision,'allow_call'))));
  assert.equal(requests.length,2);
  for(let i=0;i<2;i++) assert.match(requests.find(r=>r.context===`context-${i}`).body,new RegExp(`private-annotation-${i}`));
  const pg = new Client({ connectionString:databaseUrl }); await pg.connect(); t.after(()=>pg.end());
  for (const session of sessions) {
    const rows=await pg.query('SELECT request,answer,raw_response,diagnostics FROM openappa_external_consults WHERE organization_id=$1 AND session_id=$2',[session.organization_id,session.session_id]);
    assert.equal(rows.rows.length,1);
    assert.ok(rows.rows[0].request.__appa_encrypted); assert.ok(rows.rows[0].answer.__appa_encrypted);
    assert.ok(!JSON.stringify(rows.rows[0]).includes('private-annotation'));
    assert.ok(rows.rows[0].raw_response.includes(Buffer.from('appa-storage-v1')));
  }
});
