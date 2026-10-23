import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { after, before, test } from 'node:test';

let child;
let origin;
before(async () => {
  child = spawn(process.execPath, [new URL('./externals-fixture.mjs', import.meta.url).pathname], {
    env: { ...process.env, APPA_FIXTURE_PORT: '0', APPA_FIXTURE_AUTHORITY_MODE: 'deny' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [line] = await once(child.stdout, 'data');
  origin = String(line).trim().split(' ').at(-1);
});
after(() => child?.kill());
async function post(path, body) {
  const response = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
test('explicit deny default and invalid mode cannot accidentally authorize', async () => {
  assert.deepEqual(await post('/authority', { version: 1, kind: 'authority' }), { status: 200, body: { version: 1, answer: { ruling: 'deny' } } });
  assert.equal((await post('/mode', { mode: 'not-a-mode' })).status, 400);
  assert.equal((await post('/authority', {})).body.answer.ruling, 'deny');
});
test('input sanitizer rewrites valid JSON arguments and output sanitizer withholds raw markers', async () => {
  const body = JSON.stringify({ path: '/tmp/appa-pi-qa/public.txt', content: 'LAB-SECRET-PI-QA-1001' });
  const result = await post('/sanitizer/redact', { version: 1, kind: 'sanitizer', artifact: { body } });
  assert.deepEqual(JSON.parse(result.body.answer.body), { path: '/tmp/appa-pi-qa/public.txt', content: '[redacted by the redactor]' });
  const output = await post('/sanitizer/summarize', { version: 1, kind: 'sanitizer', artifact: { body: 'PARITY_UNTRUSTED_RAW_1002' } });
  assert.equal(output.status, 200);
  assert.ok(output.body.answer.body.includes('summarized'));
  assert.ok(!output.body.answer.body.includes('PARITY_UNTRUSTED_RAW_1002'));
});
test('synthetic external authority modes remain distinct from human consent', async () => {
  await post('/mode', { mode: 'approve' });
  assert.equal((await post('/authority', {})).body.answer.ruling, 'approve');
  await post('/mode', { mode: 'no_answer' });
  assert.equal((await post('/authority', {})).status, 503);
  await post('/mode', { mode: 'timeout' });
  await assert.rejects(fetch(origin + '/authority', { method: 'POST', body: '{}', signal: AbortSignal.timeout(80) }), { name: 'TimeoutError' });
  await post('/mode', { mode: 'deny' });
});
