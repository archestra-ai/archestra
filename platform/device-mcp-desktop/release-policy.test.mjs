import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { desktopIdentity, releasePolicy } from './release-policy.mjs';
import { parseDeviceEnrollmentUrl } from './deep-link.mjs';

const link = fields => `archestra-device://enroll?${new URLSearchParams({ version: '1', url: 'https://deployment.example', code: 'a'.repeat(43), ...fields })}`;
test('handoff contains an origin and one-time proof only', () => {
  assert.deepEqual(parseDeviceEnrollmentUrl(link({})), { version: 2, purpose: 'local-device', url: 'https://deployment.example', code: 'a'.repeat(43) });
  assert.equal(parseDeviceEnrollmentUrl(link({ url: 'http://localhost:13500' })).url, 'http://localhost:13500');
});
test('rejects ambiguous, injected and insecure handoffs', () => {
  for (const value of [link({}) + '&code=' + 'b'.repeat(43), link({}) + '#fragment', link({ command: 'shell' }), link({ url: 'https://user:secret@deployment.example' }), link({ url: 'http://remote.example' }), link({ url: 'https://deployment.example/tools' }), link({ url: 'https://deployment.example?credential=secret' }), link({ version: '2' }), link({ code: 'short' }), link({}).replace('//enroll?', '//enroll/path?'), link({}).replace('//enroll?', '//someone@enroll?'), link({}).replace('//enroll?', '//enroll:100?'), link({}) + ' '.repeat(4096), link({}).replace('enroll', 'en\nroll'), 'https://enroll/?version=1']) assert.throws(() => parseDeviceEnrollmentUrl(value));
});
test('brand determines display, executable and collision-resistant archive identity', () => {
  const brand = desktopIdentity('Acme AI', 'darwin', 'arm64');
  assert.equal(brand.productName, 'Acme AI Desktop');
  assert.match(brand.filename, /^acme-ai-desktop-[a-f0-9]{10}-darwin-arm64\.zip$/);
  assert.notEqual(desktopIdentity('Café', 'darwin', 'arm64').filename, desktopIdentity('Cafe', 'darwin', 'arm64').filename);
  assert.notEqual(desktopIdentity('Acme', 'darwin', 'arm64').filename, desktopIdentity('Аcme', 'darwin', 'arm64').filename);
  assert.equal(desktopIdentity('Acme Desktop', 'win32', 'x64').productName, 'Acme Desktop');
});
test('rejects path injection and ambiguous desktop names', () => {
  for (const name of ['../Acme', 'Acme/Other', 'Acme\\Other', 'Acme:Other', 'Acme\nOther', 'Acme\u202eOther', ' Acme', 'Acme.', 'Ａcme', '']) assert.throws(() => desktopIdentity(name, 'darwin', 'arm64'));
});
test('release fails closed without native signing and notarization prerequisites', () => {
  assert.throws(() => releasePolicy({ platform: 'darwin', hostPlatform: 'darwin' }), /Developer ID/);
  assert.throws(() => releasePolicy({ platform: 'darwin', hostPlatform: 'darwin', identity: '-' }), /Developer ID/);
  assert.throws(() => releasePolicy({ platform: 'darwin', hostPlatform: 'darwin', identity: 'Developer ID Application: Example (ABCDEFGHIJ)' }), /notarization/);
  assert.throws(() => releasePolicy({ platform: 'win32', hostPlatform: 'darwin', certificateSha1: 'a'.repeat(40), timestampServer: 'https://timestamp.example' }), /verified on Windows/);
  assert.throws(() => releasePolicy({ platform: 'win32', hostPlatform: 'win32', certificateSha1: 'a'.repeat(40), timestampServer: 'http://timestamp.example' }), /HTTPS/);
  assert.deepEqual(releasePolicy({ platform: 'darwin', hostPlatform: 'darwin', development: true }), { release: false, signed: false });
});
