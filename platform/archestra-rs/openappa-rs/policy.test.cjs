const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { Client } = require('../../backend/node_modules/pg');
const native = require('./index.cjs');
const { databaseUrl } = require('./test-database.cjs');
const allow = '[policy]\nversion = 2\n[[policy.tool]]\nname = "read"\ndelta = {}\n';
const deny = '[policy]\nversion = 2\n[[policy.tool]]\nname = "different"\ndelta = {}\n';
// A dispatch carries its organization's policy and the credential values it reads.
const hosted = (content) => ({ content, credentials: {} });

test('validates policy semantics and refuses container access', async () => {
  assert.deepEqual(await native.validateOpenappaPolicy(allow), []);
  for (const invalid of ['[policy]\nversion = 999', 'include = ["/secret"]\n' + allow, allow + '[externals.annotators.x]\ncommand = ["sh"]']) {
    assert.ok((await native.validateOpenappaPolicy(invalid)).length > 0);
  }
});

test('validates host-composed helper bindings without admitting them in authored roots', async () => {
  const entry = 'batteries/old/appa.toml';
  const composed = await native.composeOpenappaPolicy({
    root: `include = ["${entry}"]\n[policy]\nversion = 2\n`,
    batteries: [{
      entry,
      name: 'old',
      policy: `[policy]
version = 2
[[policy.annotator]]
name = "old.judge"
ranks = ["suspicious", "trusted"]
[[policy.tool]]
name = "mcp/old/read"
annotator = "old.judge"
[externals.annotators."old.judge"]
command = ["python3", "judge.py"]
`,
      helpers: {
        urlBase: 'http://127.0.0.1:9/api/openappa/helpers/install-1',
        tokenEnv: 'APPA_ARCHESTRA_BRIDGE_TOKEN',
      },
    }],
  });
  assert.deepEqual(composed.errors, []);
  assert.ok(composed.content.includes('APPA_ARCHESTRA_BRIDGE_TOKEN'));
  assert.deepEqual(await native.validateHostedOpenappaPolicy(composed.content), []);
  assert.match((await native.validateOpenappaPolicy(composed.content)).join('\n'), /APPA_ARCHESTRA_/);
  const authored = await native.composeOpenappaPolicy({ root: composed.content, batteries: [] });
  assert.equal(authored.content, undefined);
  assert.match(authored.errors.join('\n'), /APPA_ARCHESTRA_/);
  assert.deepEqual(await native.validateHostedOpenappaPolicy(
    composed.content.replaceAll('APPA_ARCHESTRA_BRIDGE_TOKEN', 'APPA_ARCHESTRA_UNSET_HOSTED_POLICY_TEST_TOKEN'),
  ), []);
});

test('hosted validation still rejects invalid semantics and command bindings', async () => {
  for (const invalid of [
    '[policy]\nversion = 999',
    'include = ["batteries/unknown/appa.toml"]\n' + allow,
    '[policy]\nversion = 2\n[[policy.annotator]]\nname = "old.judge"\nbuiltin = "no-such-builtin"\n',
    allow + '[externals.annotators.x]\ncommand = ["sh"]',
  ]) {
    assert.ok((await native.validateHostedOpenappaPolicy(invalid)).length > 0);
  }
});

test('derives external client local tools into governed Archestra host identities', { skip: !databaseUrl }, async () => {
  const policy = `[policy]
version = 2
[[policy.tool]]
name = "host/archestra/exec_command"
delta = {}
[[policy.tool]]
name = "host/archestra/read_file"
delta = {}
[[policy.tool]]
name = "host/archestra/Bash"
delta = {}
`;
  await native.initializeOpenappa(databaseUrl, 2);
  const session = { organization_id: 'native-tool-identities', caller_id: 'user:test', session_id: randomUUID() };
  const hook = async event => JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), hosted(policy)));
  assert.equal((await hook({ event: 'session_start' })).decision, 'ack');
  for (const tool of ['exec_command', 'read_file', 'Bash']) {
    assert.equal(
      (await hook({ event: 'tool_call', operation_id: `call:${tool}`, tool, arguments: {} })).decision,
      'allow_call',
      `${tool} must be governed through its host/archestra identity`,
    );
    await hook({ event: 'tool_result', tool_call_id: tool, output: 'completed', outcome: 'success' });
  }
  await assert.rejects(
    () => hook({ event: 'tool_call', operation_id: 'call:unknown_local', tool: 'unknown_local', arguments: {} }),
    /not declared in this policy/,
    'an unknown local tool must stay governed',
  );
});

// Each test serves policies no other test in this process publishes: an
// earlier revision's compiled engine is cached by its file and revision alone.
const own = (policy, tag) => `${policy}[[policy.tool]]\nname = "only-${tag}"\ndelta = {}\n`;
const callRead = (n) => ({ event: 'tool_call', operation_id: `call:read-${n}`, tool: 'read', arguments: {} });
const POLICY_MOVED = { code: 'policy_moved', message: 'OpenAPPA published a newer policy revision for this organization; retry the request' };
const rootOf = (session) => `archestra:${createHash('sha256').update(`${session.organization_id}\n${session.session_id}`).digest('hex')}`;

test('a saved policy decides the next call of an open session and of a new one', { skip: !databaseUrl }, async () => {
  await native.initializeOpenappa(databaseUrl, 2);
  const organization = `policy-test-${randomUUID()}`;
  const [before, after] = [own(allow, 'saved'), own(deny, 'saved')];
  const scope = () => ({ organization_id: organization, caller_id: 'user:test', session_id: randomUUID() });
  const hook = async (session, event, policy) => JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), hosted(policy)));
  const open = scope();
  assert.equal((await hook(open, { event: 'session_start' }, before)).decision, 'ack');
  assert.equal((await hook(open, callRead(1), before)).decision, 'allow_call');

  await assert.rejects(() => hook(open, callRead(2), after), /not declared in this policy/, 'the open session follows the saved policy');
  const status = await native.getOpenappaStatus(organization, open.session_id, hosted(after));
  assert.equal(status.policyRevision, 2, 'the session reports the revision its next call is decided under');
  const fresh = scope();
  assert.equal((await hook(fresh, { event: 'session_start' }, after)).decision, 'ack');
  await assert.rejects(() => hook(fresh, callRead(1), after), /not declared in this policy/);
  // A refused policy leaves the organization's last working deployment serving.
  await assert.rejects(hook(scope(), { event: 'session_start' }, '[policy]\nversion = 999'));
  await assert.rejects(() => hook(open, callRead(3), after), /not declared in this policy/);
});

test('snapshot mode freezes following families, pins new ones, and resumes only following families', { skip: !databaseUrl }, async (t) => {
  await native.initializeOpenappa(databaseUrl, 2);
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  t.after(() => db.end());
  const organization = `snapshot-policy-test-${randomUUID()}`;
  const before = own(allow, 'snapshot-before');
  const after = own(deny, 'snapshot-after');
  const scope = () => ({ organization_id: organization, caller_id: 'user:test', session_id: randomUUID() });
  const dispatch = async (session, event, content, snapshot) => JSON.parse(await native.dispatchHook(
    JSON.stringify({ ...session, ...event }), { ...hosted(content), snapshot },
  ));
  const head = async () => (await db.query(
    'SELECT head FROM openappa_deployments WHERE name = $1', [organization],
  )).rows.map(row => Number(row.head));
  const status = (session, content, snapshot) => native.getOpenappaStatus(
    organization, session.session_id, { ...hosted(content), snapshot },
  );
  const following = scope();
  assert.equal((await dispatch(following, { event: 'session_start' }, before, false)).decision, 'ack');
  assert.deepEqual(await head(), [1]);
  assert.equal((await dispatch(following, callRead(1), after, true)).decision, 'allow_call');
  assert.equal((await status(following, after, true)).policyRevision, 1);
  assert.deepEqual(JSON.parse(await native.listPeerMessages(JSON.stringify(following), { ...hosted(after), snapshot: true })).notices, []);
  assert.deepEqual(await head(), [1]);

  const pinned = scope();
  assert.equal((await dispatch(pinned, { event: 'session_start' }, after, true)).decision, 'ack');
  await assert.rejects(() => dispatch(pinned, callRead(1), after, true), /not declared in this policy/);
  assert.equal((await status(pinned, after, true)).policyRevision ?? null, null);
  assert.deepEqual(JSON.parse(await native.listPeerMessages(JSON.stringify(pinned), { ...hosted(before), snapshot: true })).notices, []);
  assert.equal((await dispatch(pinned, { ...callRead(1), operation_id: 'call:pinned-different', tool: 'different' }, after, true)).decision, 'allow_call');
  assert.deepEqual(await head(), [1]);

  await assert.rejects(() => dispatch(following, callRead(2), after, false), /not declared in this policy/);
  assert.equal((await status(following, after, false)).policyRevision, 2);
  assert.deepEqual(await head(), [2]);
  assert.equal((await dispatch(following, callRead(3), before, false)).decision, 'allow_call');
  await assert.rejects(() => dispatch(pinned, callRead(2), before, false), /not declared in this policy/);
  assert.equal((await status(pinned, before, false)).policyRevision ?? null, null);
  assert.deepEqual(await head(), [3]);
  assert.equal((await status(following, after, true)).policyRevision, 3);
  assert.equal((await dispatch(following, callRead(4), after, true)).decision, 'allow_call');
  assert.deepEqual(await head(), [3]);
  const pinnedRows = await db.query('SELECT payload FROM openappa_events WHERE root = $1 AND seq > 0', [rootOf(pinned)]);
  assert.ok(pinnedRows.rowCount > 0);
  assert.ok(pinnedRows.rows.every(row => !row.payload.toString('utf8').includes('"BasisAdvanced"')));
});

test('frozen following status observes another process publication without appending', { skip: !databaseUrl }, async (t) => {
  await native.initializeOpenappa(databaseUrl, 2);
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  t.after(() => db.end());
  const organization = `frozen-status-${randomUUID()}`;
  const session = { organization_id: organization, caller_id: 'user:test', session_id: randomUUID() };
  const before = own(allow, organization);
  const after = own(deny, organization);
  const frozen = { ...hosted(after), snapshot: true };
  const hook = async (event, policy) => JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), policy));
  assert.equal((await hook({ event: 'session_start' }, hosted(before))).decision, 'ack');
  assert.equal((await native.getOpenappaStatus(organization, session.session_id, frozen)).policyRevision, 1);
  assert.deepEqual(inAnotherProcess([{ session: { ...session, session_id: randomUUID() }, event: { event: 'session_start' }, policy: after }]), ['ack']);
  const events = async () => Number((await db.query('SELECT count(*) AS count FROM openappa_events WHERE root=$1', [rootOf(session)])).rows[0].count);
  const beforeStatus = await events();
  assert.equal((await native.getOpenappaStatus(organization, session.session_id, frozen)).policyRevision, 2, 'status refreshes the frozen view before the next dispatch');
  assert.equal(await events(), beforeStatus, 'status appends no trajectory event');
  assert.deepEqual((await db.query('SELECT revision FROM openappa_policy_revisions WHERE deployment=$1 ORDER BY revision', [organization])).rows.map(row => Number(row.revision)), [1, 2], 'status appends no policy revision');
  await assert.rejects(() => hook(callRead(1), frozen), /not declared in this policy/, 'the next event uses the same stricter policy the status reported');
});

test('status for a session that never started publishes no policy revision', { skip: !databaseUrl }, async (t) => {
  await native.initializeOpenappa(databaseUrl, 2);
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  t.after(() => db.end());
  for (const hasHead of [false, true]) {
    const organization = `unstarted-status-${randomUUID()}`;
    const session = { organization_id: organization, caller_id: 'user:test', session_id: randomUUID() };
    const before = own(allow, organization);
    const after = own(deny, organization);
    if (hasHead) {
      assert.equal(JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, event: 'session_start' }), hosted(before))).decision, 'ack');
    }
    const revisions = async () => (await db.query('SELECT head FROM openappa_deployments WHERE name=$1', [organization])).rows.map(row => Number(row.head));
    const expected = hasHead ? [1] : [];
    for (const snapshot of [true, false]) {
      const missing = randomUUID();
      assert.equal(await native.getOpenappaStatus(organization, missing, { ...hosted(after), snapshot }) ?? null, null);
      assert.deepEqual(await revisions(), expected, 'an absent session does not prepare or publish its carried policy');
    }
  }
});

test('snapshot mode opens a pinned family without creating a deployment head', { skip: !databaseUrl }, async (t) => {
  await native.initializeOpenappa(databaseUrl, 2);
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  t.after(() => db.end());
  const session = { organization_id: `snapshot-first-${randomUUID()}`, caller_id: 'user:test', session_id: randomUUID() };
  const policy = { ...hosted(own(allow, 'snapshot-first')), snapshot: true };
  const dispatch = async event => JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), policy));
  assert.equal((await dispatch({ event: 'session_start' })).decision, 'ack');
  assert.equal((await dispatch(callRead(1))).decision, 'allow_call');
  assert.equal((await native.getOpenappaStatus(session.organization_id, session.session_id, policy)).policyRevision ?? null, null);
  assert.equal((await db.query('SELECT head FROM openappa_deployments WHERE name = $1', [session.organization_id])).rowCount, 0);
});

test('a fork follows its parent line: its next call decides under the latest saved policy', { skip: !databaseUrl }, async () => {
  await native.initializeOpenappa(databaseUrl, 2);
  const organization = `fork-policy-test-${randomUUID()}`;
  const [before, after] = [own(allow, 'fork'), own(deny, 'fork')];
  const scope = () => ({ organization_id: organization, caller_id: 'user:test', session_id: randomUUID() });
  const hook = async (session, event, policy) => JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), hosted(policy)));

  const parent = scope();
  assert.equal((await hook(parent, { event: 'session_start' }, before)).decision, 'ack');
  assert.equal((await hook(parent, callRead(1), before)).decision, 'allow_call');
  const fork = { ...scope(), fork_of: parent.session_id };
  await assert.rejects(() => hook(fork, callRead(1), after), /not declared in this policy/);
  // Saving the earlier text again is the line's next revision; the fork follows it too.
  assert.equal((await hook(fork, callRead(2), before)).decision, 'allow_call');
});

test('a dispatch carrying a policy recomposed since it was read publishes nothing and decides at the head on retry', { skip: !databaseUrl }, async (t) => {
  await native.initializeOpenappa(databaseUrl, 2);
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  const organization = `stale-policy-test-${randomUUID()}`;
  t.after(async () => {
    await db.query('DELETE FROM organization WHERE id = $1', [organization]);
    await db.end();
  });
  const [before, after] = [own(allow, 'stale'), own(deny, 'stale')];
  // The organization's stored composition is the one saved after the stale read.
  await db.query('INSERT INTO organization (id, name, slug, created_at) VALUES ($1, $1, $1, now())', [organization]);
  await db.query(
    `INSERT INTO openappa_effective_policies (organization_id, content, content_hash, root_revision, install_fingerprint, compiled_at)
     VALUES ($1, $2, 'saved', 1, 'test', now())`,
    [organization, after],
  );
  const read = (content, compositionHash) => ({ content, credentials: {}, compositionHash });
  const scope = () => ({ organization_id: organization, caller_id: 'user:test', session_id: randomUUID() });
  const hook = async (session, event, policy) => JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), policy));

  const fresh = scope();
  assert.equal((await hook(fresh, { event: 'session_start' }, read(after, 'saved'))).decision, 'ack');
  const stale = scope();
  await assert.rejects(() => hook(stale, { event: 'session_start' }, read(before, 'before-the-save')), POLICY_MOVED);
  const revisions = await db.query('SELECT revision FROM openappa_policy_revisions WHERE deployment = $1', [organization]);
  assert.deepEqual(revisions.rows.map((row) => Number(row.revision)), [1], 'the text from before the save is never published over the head');
  assert.equal((await db.query('SELECT 1 FROM openappa_events WHERE root = $1', [rootOf(stale)])).rowCount, 0, 'nothing was appended');

  // The host's retry reads the stored composition again.
  assert.equal((await hook(stale, { event: 'session_start' }, read(after, 'saved'))).decision, 'ack');
  await assert.rejects(() => hook(stale, callRead(1), read(after, 'saved')), /not declared in this policy/);
});

for (const hasHead of [true, false]) {
  for (const hasComposition of [true, false]) {
    test(`a stale publisher cannot replace a stricter policy (${hasHead ? 'existing' : 'initial'} head, ${hasComposition ? 'stored' : 'direct'} policy)`, { skip: !databaseUrl }, async (t) => {
      await native.initializeOpenappa(databaseUrl, 2);
      const db = new Client({ connectionString: databaseUrl });
      const gate = new Client({ connectionString: databaseUrl });
      await db.connect();
      await gate.connect();
      const suffix = randomUUID().replaceAll('-', '');
      const organization = `publication-race-${suffix}`;
      const marker = `retired_${suffix}`;
      const trigger = `publication_gate_${suffix}`;
      const lock = Number.parseInt(suffix.slice(0, 7), 16);
      const scope = () => ({ organization_id: organization, caller_id: 'user:test', session_id: randomUUID() });
      const stale = own(allow, marker);
      const current = own(deny, `current_${suffix}`);
      const carried = (content, compositionHash) => ({ ...hosted(content), ...(hasComposition ? { compositionHash } : {}) });
      const hook = async (session, policy) => JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, event: 'session_start' }), policy));
      const readHead = async () => (await db.query(
        'SELECT d.head, p.bytes FROM openappa_deployments d JOIN openappa_policy_revisions r ON r.deployment=d.name AND r.revision=d.head JOIN openappa_policy_files p ON p.hash=r.hash WHERE d.name=$1',
        [organization],
      )).rows[0];
      let child;
      let completed;
      let locked = false;
      t.after(async () => {
        if (locked) await gate.query('SELECT pg_advisory_unlock($1)', [lock]);
        if (child && child.exitCode === null) child.kill('SIGKILL');
        if (completed) await completed.catch(() => {});
        await db.query(`DROP TRIGGER IF EXISTS ${trigger} ON openappa_policy_files`);
        await db.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
        await db.query('DELETE FROM organization WHERE id=$1', [organization]);
        await gate.end();
        await db.end();
      });
      await db.query('INSERT INTO organization(id, name, slug, created_at) VALUES ($1,$1,$1,now())', [organization]);
      if (hasHead) assert.equal((await hook(scope(), hosted(own(allow, `baseline_${suffix}`)))).decision, 'ack');
      await db.query(
        "INSERT INTO openappa_effective_policies(organization_id, content, content_hash, root_revision, install_fingerprint, compiled_at) VALUES ($1,$2,'stale',1,'test',now())",
        [organization, stale],
      );
      await gate.query('SELECT pg_advisory_lock($1)', [lock]);
      locked = true;
      await db.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF position(convert_to('${marker}','UTF8') in NEW.bytes)>0 THEN PERFORM pg_advisory_lock(${lock}); PERFORM pg_advisory_unlock(${lock}); END IF; RETURN NEW; END $$`);
      await db.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON openappa_policy_files FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
      const staleSession = scope();
      child = spawn(process.execPath, ['-e', `
        const native = require('./index.cjs');
        (async () => {
          const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
          await native.initializeOpenappa(input.url, 2);
          try {
            console.log(JSON.stringify({ decision: JSON.parse(await native.dispatchHook(JSON.stringify(input.session), input.policy)).decision }));
          } catch (error) {
            console.log(JSON.stringify({ error: { code: error.code, message: error.message } }));
          }
        })().catch(() => { process.exitCode = 1; });
      `], { cwd: __dirname, stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 });
      let output = '';
      let stderr = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      completed = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(new Error(`publisher exited ${code}: ${stderr}`)));
      });
      completed.catch(() => {});
      child.stdin.end(JSON.stringify({ url: databaseUrl, session: { ...staleSession, event: 'session_start' }, policy: carried(stale, 'stale') }));
      const deadline = Date.now() + 10000;
      let paused = false;
      while (Date.now() < deadline) {
        paused = (await db.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$1::oid AND NOT granted", [lock])).rowCount > 0;
        if (paused) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(paused, 'stale publisher reached storage after validating its composition');
      await db.query("UPDATE openappa_effective_policies SET content=$2,content_hash='current',root_revision=2,compiled_at=now() WHERE organization_id=$1", [organization, current]);
      assert.equal((await hook(scope(), carried(current, 'current'))).decision, 'ack');
      const strictHead = await readHead();
      const expectedHead = hasHead ? 2 : 1;
      assert.equal(Number(strictHead.head), expectedHead);
      await gate.query('SELECT pg_advisory_unlock($1)', [lock]);
      locked = false;
      await completed;
      assert.deepEqual(JSON.parse(output.trim()).error, POLICY_MOVED);
      const final = await readHead();
      assert.equal(Number(final.head), expectedHead, 'stale bytes append no revision');
      assert.deepEqual(final.bytes, strictHead.bytes, 'the stricter policy is not rolled back');
      assert.equal(final.bytes.includes(Buffer.from(marker)), false);
      assert.equal(Number((await db.query('SELECT count(*) AS count FROM openappa_policy_revisions WHERE deployment=$1', [organization])).rows[0].count), expectedHead);
      assert.equal((await db.query('SELECT 1 FROM openappa_events WHERE root=$1', [rootOf(staleSession)])).rowCount, 0, 'refused publication opens no family');
      assert.equal((await hook(staleSession, carried(current, 'current'))).decision, 'ack', 'a host reread succeeds normally');
      assert.deepEqual(inAnotherProcess([{ session: scope(), event: { event: 'session_start' }, policy: current }]), ['ack']);
      assert.equal(Number((await readHead()).head), expectedHead, 'another process serving the same bytes appends no revision');
    });
  }
}

/**
 * Runs `dispatches` in a process of its own, as another backend replica over the
 * same database would, and returns each decision or error message.
 */
function inAnotherProcess(dispatches) {
  const child = spawnSync(process.execPath, ['-e', `
    const native = require('./index.cjs');
    (async () => {
      const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
      await native.initializeOpenappa(input.url, 2);
      const answers = [];
      for (const { session, event, policy } of input.dispatches) {
        try {
          answers.push(JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), { content: policy, credentials: {} })).decision);
        } catch (error) {
          answers.push(error.message);
        }
      }
      process.stdout.write(JSON.stringify(answers));
    })().catch((error) => { console.error(error.message); process.exitCode = 1; });
  `], { cwd: __dirname, input: JSON.stringify({ url: databaseUrl, dispatches }), encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('a frozen process observes a concurrent live publish without rolling back the head', { skip: !databaseUrl }, async (t) => {
  await native.initializeOpenappa(databaseUrl, 2);
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  t.after(() => db.end());
  const organization = `frozen-pods-${randomUUID()}`;
  const [before, after] = [own(allow, 'frozen-pods'), own(deny, 'frozen-pods')];
  const scope = () => ({ organization_id: organization, caller_id: 'user:test', session_id: randomUUID() });
  const dispatch = async (session, event, content, snapshot) => JSON.parse(await native.dispatchHook(
    JSON.stringify({ ...session, ...event }), { ...hosted(content), snapshot },
  ));
  const head = async () => Number((await db.query('SELECT head FROM openappa_deployments WHERE name = $1', [organization])).rows[0].head);
  const following = scope();
  assert.equal((await dispatch(following, { event: 'session_start' }, before, false)).decision, 'ack');
  assert.equal((await dispatch(following, callRead(1), after, true)).decision, 'allow_call');
  assert.equal(await head(), 1);
  assert.deepEqual(inAnotherProcess([{ session: scope(), event: { event: 'session_start' }, policy: after }]), ['ack']);
  assert.equal(await head(), 2);
  await assert.rejects(() => dispatch(following, callRead(2), before, true), /not declared in this policy/);
  assert.equal(await head(), 2);
  const pinned = scope();
  assert.equal((await dispatch(pinned, { event: 'session_start' }, before, true)).decision, 'ack');
  assert.equal((await dispatch(pinned, callRead(1), after, true)).decision, 'allow_call');
  assert.equal((await native.getOpenappaStatus(organization, pinned.session_id, { ...hosted(after), snapshot: true })).policyRevision ?? null, null);
  assert.deepEqual((await db.query('SELECT revision FROM openappa_policy_revisions WHERE deployment = $1 ORDER BY revision', [organization])).rows.map(row => Number(row.revision)), [1, 2]);
});

test('a process pinned behind a head another process published re-pins it within the same call', { skip: !databaseUrl, timeout: 60000 }, async (t) => {
  await native.initializeOpenappa(databaseUrl, 2);
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  t.after(() => db.end());
  const organization = `two-processes-${randomUUID()}`;
  const [first, second] = [own(allow, 'pods'), own(deny, 'pods')];
  const scope = () => ({ organization_id: organization, caller_id: 'user:test', session_id: randomUUID() });
  const hook = async (session, event, policy) => JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), hosted(policy)));
  const head = async () => Number((await db.query('SELECT head FROM openappa_deployments WHERE name = $1', [organization])).rows[0].head);
  const events = async (session) => Number((await db.query('SELECT count(*) AS n FROM openappa_events WHERE root = $1', [rootOf(session)])).rows[0].n);

  const open = scope();
  assert.equal((await hook(open, { event: 'session_start' }, first)).decision, 'ack');
  assert.equal((await hook(open, callRead(1), first)).decision, 'allow_call');
  assert.equal(await head(), 1);

  // The other process publishes another policy, then this one's again: the head
  // names this process's policy at a revision it never pinned.
  const other = scope();
  assert.deepEqual(inAnotherProcess([
    { session: other, event: { event: 'session_start' }, policy: second },
    { session: other, event: { event: 'session_start' }, policy: first },
  ]), ['ack', 'ack']);
  assert.equal(await head(), 3);
  assert.equal((await hook(open, callRead(2), first)).decision, 'allow_call', 'the dispatch re-pinned the head and decided at it');
  assert.equal(await head(), 3, 'pinning the head publishes nothing');

  // The other process publishes a policy this one does not carry: the dispatch
  // appends nothing and asks the host to read the policy again.
  assert.deepEqual(inAnotherProcess([{ session: other, event: callRead(1), policy: second }]), [
    'OpenAPPA processing interrupted: tool host/archestra/read is not declared in this policy and no wildcard covers it; the call is refused before it runs',
  ]);
  assert.equal(await head(), 4);
  const appended = await events(open);
  await assert.rejects(() => hook(open, callRead(3), first), POLICY_MOVED);
  assert.equal(await events(open), appended, 'nothing was appended');
  assert.equal(await head(), 4, 'the text it carried is not published over the head');
  // The host's retry carries the policy it reads again, and decides at the head.
  await assert.rejects(() => hook(open, callRead(3), second), /not declared in this policy/);
  assert.equal(await head(), 4);
});

test('catch-all annotations admit unknown tools without changing trust or overriding explicit rules', { skip: !databaseUrl }, async (t) => {
  const requests = [];
  const server = require('node:http').createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: 1, answer: { delta: {}, requires: { history: [], attention: [] }, emits: [] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const policy = `[policy]
version = 2
[[policy.annotator]]
name = "noop"
[[policy.tool]]
name = "*"
annotator = "noop"
[[policy.tool]]
name = "read_untrusted"
delta = { trust = "suspicious" }
[[policy.tool]]
name = "write_trusted"
delta = {}
requires = { trust = "trusted" }
[externals.annotators.noop]
url = "http://127.0.0.1:${server.address().port}/annotate"
`;
  assert.deepEqual(await native.validateOpenappaPolicy(policy), []);
  await native.initializeOpenappa(databaseUrl, 2);
  const scope = { organization_id: 'catch-all-test', caller_id: 'user:test', session_id: randomUUID() };
  const hook = async event => JSON.parse(await native.dispatchHook(JSON.stringify({ ...scope, ...event }), hosted(policy)));
  assert.equal((await hook({ event: 'session_start' })).decision, 'ack');
  const call = async (name, id) => hook({ event: 'tool_call', operation_id: `call:${id}`, tool: name, arguments: {} });
  const result = async id => hook({ event: 'tool_result', operation_id: `result:${id}`, tool_call_id: id, output: 'result', outcome: 'success' });
  assert.equal((await call('unknown_before', 'unknown-before')).decision, 'allow_call');
  await result('unknown-before');
  const read = await call('read_untrusted', 'read');
  assert.equal(read.decision, 'deny_call');
  await hook({ event: 'remedy', operation_id: 'remedy:accept-suspicious', arguments: { offer_id: read.offers[0].offer_id } });
  assert.equal((await call('read_untrusted', 'read-accepted')).decision, 'allow_call');
  await result('read-accepted');
  assert.equal((await call('unknown_after', 'unknown-after')).decision, 'allow_call');
  await result('unknown-after');
  assert.notEqual((await call('write_trusted', 'write')).decision, 'allow_call');
  // Externals see the canonical identity the runtime judges, not the host's spelling.
  assert.deepEqual(requests.map(request => request.artifact.args.name), ['host/archestra/unknown_before', 'host/archestra/unknown_after']);
});

test('an explicit policy result cap takes precedence over the host default', { skip: !databaseUrl }, async () => {
  const proxyLimit = 70 * 1024 * 1024;
  const priorLimit = process.env.APPA_ARCHESTRA_MAX_BODY_BYTES;
  try {
    await native.initializeOpenappa(databaseUrl, 2);
    const text = 'x'.repeat(100_000);
    const withheld = '[appa] the result was not carried; nothing was admitted';
    const report = async (policyText, output) => {
      const session = { organization_id: `native-body-cap-${randomUUID()}`, caller_id: 'user:test', session_id: randomUUID() };
      const hook = async event => JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), hosted(policyText)));
      assert.equal((await hook({ event: 'tool_call', operation_id: 'call:1', tool: 'read', arguments: {} })).decision, 'allow_call');
      return hook({ event: 'tool_result', tool_call_id: '1', output, outcome: 'success' });
    };
    const carried = async (policyText, output) => {
      const kept = await report(policyText, output);
      assert.equal(kept.decision, 'ack');
      assert.equal(kept.approved_output, output);
    };
    process.env.APPA_ARCHESTRA_MAX_BODY_BYTES = String(proxyLimit);
    // Without an explicit cap, results use the published proxy limit. A policy can
    // also choose a cap above that default without changing the proxy request limit.
    for (const stated of ['', 'max_body_bytes = 999999999999\n']) {
      const policyText = stated ? `${allow}[externals]\ntimeout_ms = 2000\n${stated}` : allow;
      await carried(policyText, text);
      await carried(policyText, 'x'.repeat(5 * 1024 * 1024));
    }
    for (const limit of [4096, 65536]) {
      const policyText = `${allow}[externals]\nmax_body_bytes = ${limit}\n`;
      await carried(policyText, 'x'.repeat(limit));
      const dropped = await report(policyText, 'x'.repeat(limit + 1));
      assert.equal(dropped.decision, 'replace_output');
      assert.equal(dropped.approved_output, withheld);
    }
    // A policy keeps its stated limit even without a published host default.
    delete process.env.APPA_ARCHESTRA_MAX_BODY_BYTES;
    const stated = `${allow}[externals]\ntimeout_ms = 2000\nmax_body_bytes = 65536\n`;
    const dropped = await report(stated, text);
    assert.equal(dropped.decision, 'replace_output');
    assert.equal(dropped.approved_output, withheld);
    await carried(allow, 'x'.repeat(1000));
  } finally {
    if (priorLimit === undefined) delete process.env.APPA_ARCHESTRA_MAX_BODY_BYTES;
    else process.env.APPA_ARCHESTRA_MAX_BODY_BYTES = priorLimit;
  }
});

test('a long kept result is stored once, and a row that holds the text twice still replays', { skip: !databaseUrl }, async () => {
  const proxyLimit = String(70 * 1024 * 1024);
  const prior = process.env.APPA_ARCHESTRA_MAX_BODY_BYTES;
  process.env.APPA_ARCHESTRA_MAX_BODY_BYTES = proxyLimit;
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await native.initializeOpenappa(databaseUrl, 2);
    const session = { organization_id: `native-stored-once-${randomUUID()}`, caller_id: 'user:test', session_id: randomUUID() };
    const hook = async event => JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), hosted(allow)));
    const column = async (id) => (await client.query(
      'SELECT approved_output, decision FROM openappa_processed_results WHERE organization_id=$1 AND session_id=$2 AND tool_call_id=$3',
      [session.organization_id, session.session_id, id],
    )).rows[0];
    const text = 'long result '.repeat(2000);
    const short = 'short result';
    for (const [id, output] of [['long', text], ['short', short]]) {
      assert.equal((await hook({ event: 'tool_call', operation_id: `call:${id}`, tool: 'read', arguments: {} })).decision, 'allow_call');
      const first = await hook({ event: 'tool_result', tool_call_id: id, output, outcome: 'success' });
      assert.equal(first.approved_output, output);
    }
    const long = await column('long');
    // The decision keeps the text; the column holds its digest.
    assert.equal(long.decision.approved_output, text);
    assert.equal(long.approved_output, `sha256:${createHash('sha256').update(text).digest('hex')}`);
    assert.equal((await column('short')).approved_output, short);
    // A replay answers from the decision.
    const replay = await hook({ event: 'tool_result', tool_call_id: 'long', output: text, outcome: 'success' });
    assert.equal(replay.approved_output, text);
    // A row written before the column held a digest keeps the text in both places and replays the same.
    await client.query(
      'UPDATE openappa_processed_results SET approved_output=$4 WHERE organization_id=$1 AND session_id=$2 AND tool_call_id=$3',
      [session.organization_id, session.session_id, 'long', text],
    );
    const legacy = await hook({ event: 'tool_result', tool_call_id: 'long', output: text, outcome: 'success' });
    assert.deepEqual(legacy, replay);
  } finally {
    await client.end();
    if (prior === undefined) delete process.env.APPA_ARCHESTRA_MAX_BODY_BYTES;
    else process.env.APPA_ARCHESTRA_MAX_BODY_BYTES = prior;
  }
});
