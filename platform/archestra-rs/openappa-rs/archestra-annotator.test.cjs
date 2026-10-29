// The `builtin = "archestra"` annotator: the runtime posts its rendered prompt to the
// endpoint the host publishes, with the host's bearer, and applies the answer.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { test } = require('node:test');
const native = require('./index.cjs');
const { databaseUrl } = require('./test-database.cjs');

const TOKEN = 'bridge-token-for-test';
const NEUTRAL = { delta: {}, requires: { history: [], attention: [] }, emits: [] };

/** A local endpoint that records each request and answers with `status` and `answer`. */
async function serve(t, status, answer) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ authorization: request.headers.authorization ?? null, body: JSON.parse(body) });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/annotate`, requests };
}

/** The archestra annotator's endpoint, published where the addon reads it, beside the `noop` catch-all's. */
async function endpoint(t, status, answer) {
  const archestra = await serve(t, status, answer);
  const noop = await serve(t, 200, { version: 1, answer: NEUTRAL });
  process.env.APPA_ARCHESTRA_ANNOTATOR_URL = archestra.url;
  process.env.APPA_ARCHESTRA_BRIDGE_TOKEN = TOKEN;
  return { requests: archestra.requests, policy: policyFor(noop.url) };
}

const policyFor = (noopUrl) => ({
  content: `[policy]
version = 2

[[policy.annotator]]
name = "archestra.run-command"
builtin = "archestra"
ranks = ["suspicious", "trusted"]
marks = []
effects = []

[[policy.tool]]
name = "archestra__run_command"
annotator = "archestra.run-command"

[[policy.annotator]]
name = "noop"

[[policy.tool]]
name = "*"
annotator = "noop"

[externals.annotators.noop]
url = "${noopUrl}"
`,
  credentials: {},
});

// Each test opens its own organization, so its deployment compiles against the endpoint it published.
const scope = () => ({ organization_id: `archestra-annotator-${randomUUID()}`, caller_id: 'user:test', session_id: randomUUID() });
const hook = async (policy, session, event) =>
  JSON.parse(await native.dispatchHook(JSON.stringify({ ...session, ...event }), policy));
const call = (policy, session, id, tool, args) =>
  hook(policy, session, { event: 'tool_call', operation_id: `call:${id}`, tool, arguments: args });

test('a tool with no rule never reaches the annotator endpoint', { skip: !databaseUrl, timeout: 30000 }, async (t) => {
  await native.initializeOpenappa(databaseUrl, 4);
  const { requests, policy } = await endpoint(t, 200, NEUTRAL);
  const session = scope();

  assert.equal((await call(policy, session, 'search', 'archestra__search_tools', { query: 'files' })).decision, 'allow_call');
  assert.equal(requests.length, 0);
});

test('run_command is labeled by the host endpoint with the rendered prompt and the bridge bearer', { skip: !databaseUrl, timeout: 30000 }, async (t) => {
  await native.initializeOpenappa(databaseUrl, 4);
  const { requests, policy } = await endpoint(t, 200, { ...NEUTRAL, delta: { audience: ['self'] } });
  const session = scope();

  const decision = await call(policy, session, 'secrets', 'archestra__run_command', {
    command: 'cat ~/.aws/credentials AKIAABCDEFGHIJKLMNOP',
  });
  // The answered audience would narrow the session, so the call waits on an offer to accept it.
  assert.equal(decision.decision, 'deny_call', JSON.stringify(decision));
  assert.match(decision.feedback, /allowed readers would narrow/);
  assert.equal(decision.offers.length, 1);

  assert.equal(requests.length, 1);
  const [{ authorization, body }] = requests;
  assert.equal(authorization, `Bearer ${TOKEN}`);
  assert.match(body.system, /Annotator/);
  assert.equal(typeof body.schema, 'object');
  assert.match(body.input, /cat ~\/\.aws\/credentials/);
  assert.doesNotMatch(body.input, /AKIAABCDEFGHIJKLMNOP/, 'secrets are redacted before they leave');
});

test('an annotator endpoint that fails refuses run_command', { skip: !databaseUrl, timeout: 60000 }, async (t) => {
  await native.initializeOpenappa(databaseUrl, 4);
  const { requests, policy } = await endpoint(t, 500, { error: 'boom' });
  const session = scope();

  const outcome = await call(policy, session, 'ls', 'archestra__run_command', { command: 'ls' }).catch((error) => ({ decision: 'error', error }));
  assert.notEqual(outcome.decision, 'allow_call');
  assert.ok(requests.length >= 1, 'the runtime tried the endpoint');
});
