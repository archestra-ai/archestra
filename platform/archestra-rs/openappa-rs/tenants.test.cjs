// Several organizations served by one process's runtime: each dispatch reads its
// own organization's policy and credentials, whatever another dispatches meanwhile.
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('../../backend/node_modules/pg');
const native = require('./index.cjs');
const { databaseUrl } = require('./test-database.cjs');

const JEV_KEY = 'APPA_PROVIDER_JEV_API_KEY';
const JEV_ANSWER = {
  answers: {
    delta_audience: { probabilities: { self: 0.05, internal: 0.4, public: 0.55 } },
    delta_trust: { probabilities: { suspicious: 0.1, trusted: 0.9 } },
    requires_audience: { probabilities: { public: 0.8, internal: 0.1, none: 0.1 } },
    requires_trusted: { noul: 0.7 },
  },
};

/** A local endpoint that records the bearer of every request and answers `body`. */
async function endpoint(t, body) {
  const authorizations = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      authorizations.push(request.headers.authorization ?? null);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, authorizations };
}

const scope = (organization_id) => ({ organization_id, caller_id: 'user:test', session_id: randomUUID() });
const hook = async (session, event, policy) =>
  JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), policy));
const call = (session, id, tool, policy) =>
  hook(session, { event: 'tool_call', operation_id: `call:${id}`, tool, arguments: {} }, policy);

test('a dispatch consults its own organization\'s externals while another organization dispatches', { skip: !databaseUrl, timeout: 30000 }, async (t) => {
  await native.initializeOpenappa(databaseUrl, 4);
  const annotation = { version: 1, answer: { delta: {}, requires: { history: [], attention: [] }, emits: [] } };
  const a = await endpoint(t, annotation);
  const b = await endpoint(t, annotation);
  const policy = (url) => ({
    content: `[policy]
version = 2
[[policy.annotator]]
name = "classifier"
[[policy.tool]]
name = "annotated_read"
annotator = "classifier"
[externals.annotators.classifier]
url = "${url}/annotate"
`,
    credentials: {},
  });
  const orgA = scope(`tenant-a-${randomUUID()}`);
  const orgB = scope(`tenant-b-${randomUUID()}`);
  assert.equal((await hook(orgA, { event: 'session_start' }, policy(a.url))).decision, 'ack');

  // Holding the root's ledger lock parks A's call after it read its policy and
  // before its hook runs; B then dispatches under its own policy in between.
  const ledger = new Client({ connectionString: databaseUrl });
  await ledger.connect();
  t.after(() => ledger.end());
  const root = `archestra:${createHash('sha256').update(`${orgA.organization_id}\n${orgA.session_id}`).digest('hex')}`;
  await ledger.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [root]);
  const parkedCall = call(orgA, 'a-1', 'annotated_read', policy(a.url));
  for (;;) {
    const { rows } = await ledger.query(`SELECT EXISTS (
      SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
        AND classid = ((hashtextextended($1, 0) >> 32) & 4294967295)::oid
        AND objid = (hashtextextended($1, 0) & 4294967295)::oid) AS parked`, [root]);
    if (rows[0].parked) break;
    await delay(10);
  }
  assert.equal((await call(orgB, 'b-1', 'annotated_read', policy(b.url))).decision, 'allow_call');
  assert.equal(b.authorizations.length, 1);
  await ledger.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [root]);
  assert.equal((await parkedCall).decision, 'allow_call');
  assert.equal(a.authorizations.length, 1, 'A\'s consult reached A\'s annotator');
  assert.equal(b.authorizations.length, 1, 'and never B\'s');

  // Concurrent dispatches of both organizations each reach their own annotator.
  const sessionsA = [scope(orgA.organization_id), scope(orgA.organization_id), scope(orgA.organization_id)];
  const sessionsB = [scope(orgB.organization_id), scope(orgB.organization_id), scope(orgB.organization_id)];
  const decisions = await Promise.all([
    ...sessionsA.map((session, index) => call(session, `a-${index}`, 'annotated_read', policy(a.url))),
    ...sessionsB.map((session, index) => call(session, `b-${index}`, 'annotated_read', policy(b.url))),
  ]);
  assert.ok(decisions.every((decision) => decision.decision === 'allow_call'), JSON.stringify(decisions));
  assert.equal(a.authorizations.length, 1 + sessionsA.length);
  assert.equal(b.authorizations.length, 1 + sessionsB.length);
});

test('the jev battery sends each organization\'s own key, and a rotated key the next dispatch', { skip: !databaseUrl, timeout: 30000 }, async (t) => {
  await native.initializeOpenappa(databaseUrl, 4);
  const jev = await endpoint(t, JEV_ANSWER);
  // The operator's endpoint override, read from this process's environment.
  process.env.APPA_PROVIDER_JEV_API_URL = `${jev.url}/v1/systemone`;
  t.after(() => { delete process.env.APPA_PROVIDER_JEV_API_URL; });

  const battery = (await native.listBundledOpenappaBatteries()).find((candidate) => candidate.name === 'jev');
  assert.ok(battery, 'the jev battery is bundled');
  const composed = await native.composeOpenappaPolicy({
    root: `include = ["batteries/jev/appa.toml"]
[credentials]
${JEV_KEY} = "jev_key"
[policy]
version = 2
[[policy.tool]]
name = "fetch"
description = "Fetches one URL and returns its body."
annotator = "jev.tool-call"
`,
    batteries: [{ entry: 'batteries/jev/appa.toml', name: 'jev', policy: battery.policy }],
  });
  assert.deepEqual(composed.errors, []);
  const declarations = await native.parseOpenappaDeclarations(composed.content);
  // What the backend resolves per dispatch: the jev key and nothing else.
  assert.deepEqual(declarations.runtimeCredentials, [JEV_KEY]);
  const policy = (key) => ({ content: composed.content, credentials: { [JEV_KEY]: key } });

  const consulted = async (organization, id, key) => {
    const before = jev.authorizations.length;
    await call(scope(organization), id, 'fetch', policy(key));
    const seen = jev.authorizations.slice(before);
    assert.ok(seen.length > 0, 'the consult reached the jev endpoint');
    return [...new Set(seen)];
  };
  const orgA = `jev-a-${randomUUID()}`;
  const orgB = `jev-b-${randomUUID()}`;
  assert.deepEqual(await consulted(orgA, 'a-1', 'org-a-key'), ['Bearer org-a-key']);
  assert.deepEqual(await consulted(orgB, 'b-1', 'org-b-key'), ['Bearer org-b-key']);
  assert.deepEqual(await consulted(orgA, 'a-2', 'org-a-key'), ['Bearer org-a-key']);
  assert.deepEqual(await consulted(orgA, 'a-3', 'org-a-rotated'), ['Bearer org-a-rotated']);
  assert.deepEqual(await consulted(orgB, 'b-2', 'org-b-key'), ['Bearer org-b-key']);
});

test('a session keeps the root its row records, as one started before roots named their organization does', { skip: !databaseUrl, timeout: 30000 }, async (t) => {
  await native.initializeOpenappa(databaseUrl, 4);
  const policy = { content: '[policy]\nversion = 2\n[[policy.tool]]\nname = "read"\ndelta = {}\n', credentials: {} };
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  t.after(() => client.end());
  const sha256 = (text) => createHash('sha256').update(text).digest('hex');
  const events = async (root) => Number((await client.query('SELECT count(*) AS n FROM openappa_events WHERE root = $1', [root])).rows[0].n);

  const organization_id = `recorded-root-${randomUUID()}`;
  const opened = scope(organization_id);
  assert.equal((await hook(opened, { event: 'session_start' }, policy)).decision, 'ack');
  const { rows: [{ root: recorded }] } = await client.query('SELECT root FROM openappa_sessions WHERE session_id = $1', [opened.session_id]);
  assert.equal(recorded, `archestra:${sha256(`${organization_id}\n${opened.session_id}`)}`);

  // A row whose root no longer follows the id formula, as a session that started
  // before this change has.
  const earlier = scope(organization_id);
  await client.query(
    'INSERT INTO openappa_sessions (actor, root, organization_id, caller_id, session_id, start_decision) SELECT $1, root, organization_id, caller_id, $2, start_decision FROM openappa_sessions WHERE session_id = $3',
    [`archestra:${sha256(earlier.session_id)}`, earlier.session_id, opened.session_id],
  );
  const before = await events(recorded);
  assert.equal((await call(earlier, 'recorded-1', 'read', policy)).decision, 'allow_call');
  assert.ok(await events(recorded) > before, 'the call continued the recorded root');
  assert.equal(await events(`archestra:${sha256(`${organization_id}\n${earlier.session_id}`)}`), 0, 'no new root opened');
});

test('two organizations concurrently start sessions under one client session id, each with its own root and state', { skip: !databaseUrl, timeout: 30000 }, async (t) => {
  await native.initializeOpenappa(databaseUrl, 4);
  const policy = { content: '[policy]\nversion = 2\n[[policy.tool]]\nname = "read"\ndelta = {}\n', credentials: {} };
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  t.after(() => client.end());
  const sha256 = (text) => createHash('sha256').update(text).digest('hex');

  const session_id = randomUUID();
  const orgA = { organization_id: `shared-id-a-${randomUUID()}`, caller_id: 'user:test', session_id };
  const orgB = { ...orgA, organization_id: `shared-id-b-${randomUUID()}` };
  const started = await Promise.all([orgA, orgB].map((session) => hook(session, { event: 'session_start' }, policy)));
  assert.deepEqual(started.map(({ decision }) => decision), ['ack', 'ack']);
  const calls = await Promise.all([call(orgA, 'a-only', 'read', policy), call(orgB, 'b-only', 'read', policy)]);
  assert.deepEqual(calls.map(({ decision }) => decision), ['allow_call', 'allow_call']);

  const { rows } = await client.query(
    'SELECT organization_id, actor, root FROM openappa_sessions WHERE session_id = $1 ORDER BY organization_id',
    [session_id],
  );
  assert.deepEqual(rows, [orgA, orgB].map(({ organization_id }) => ({
    organization_id,
    actor: `archestra:${sha256(session_id)}`,
    root: `archestra:${sha256(`${organization_id}\n${session_id}`)}`,
  })));

  // B holds no record of the call A released, so its result for that id is withheld.
  const result = await hook(orgB, { event: 'tool_result', tool_call_id: 'a-only', output: 'from b', outcome: 'success' }, policy);
  assert.equal(result.decision, 'block', JSON.stringify(result));

  // A child resolves its parent only in its own organization.
  const orgC = { ...orgA, organization_id: `shared-id-c-${randomUUID()}`, session_id: randomUUID(), parent_id: session_id };
  await assert.rejects(hook(orgC, { event: 'session_start' }, policy), /parent session has not started/);
  // A fork resolves the session it forks only in its own organization.
  const forkC = { ...orgA, organization_id: orgC.organization_id, session_id: randomUUID(), fork_of: session_id };
  await assert.rejects(hook(forkC, { event: 'session_start' }, policy), /the session this one forks has not started/);
});
