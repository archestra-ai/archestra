import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { packager } from '@electron/packager';
import { desktopIdentity, releasePolicy } from './release-policy.mjs';

const { values } = parseArgs({ options: { win32: { type: 'boolean' }, x64: { type: 'boolean' }, development: { type: 'boolean' }, 'browser-handoff': { type: 'boolean' }, 'app-name': { type: 'string' } } });
const directory = dirname(fileURLToPath(import.meta.url));
const platform = values.win32 ? 'win32' : 'darwin';
const arch = values.x64 || platform === 'win32' ? 'x64' : 'arm64';
const identity = desktopIdentity(values['app-name'] ?? process.env.ARCHESTRA_DESKTOP_APP_NAME ?? 'Archestra', platform, arch);
const policy = releasePolicy({ platform, hostPlatform: process.platform, development: values.development, identity: process.env.ARCHESTRA_DESKTOP_MAC_SIGNING_IDENTITY, notaryProfile: process.env.ARCHESTRA_DESKTOP_MAC_NOTARY_PROFILE, certificateSha1: process.env.ARCHESTRA_DESKTOP_WINDOWS_CERTIFICATE_SHA1, timestampServer: process.env.ARCHESTRA_DESKTOP_WINDOWS_TIMESTAMP_SERVER });
const command = (file, args, options = {}) => {
  const result = spawnSync(file, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${file} failed: ${(result.stderr || result.stdout || result.error?.message || 'unknown error').trim()}`);
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
};
const powershell = (script, environment = {}) => command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ...environment } });
if (policy.release && platform === 'darwin') {
  const identities = command('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  if (!identities.includes(`"${policy.osxSign.identity}"`)) throw new Error('The configured Developer ID Application identity is not valid or available in this build keychain.');
}
if (policy.release && platform === 'win32') {
  powershell("$ErrorActionPreference='Stop'; $cert=Get-Item -LiteralPath ('Cert:\\CurrentUser\\My\\'+$env:ARCHESTRA_DESKTOP_WINDOWS_CERTIFICATE_SHA1); if (!$cert.HasPrivateKey -or $cert.NotAfter -le (Get-Date)) { throw 'A current Authenticode certificate with its signing key is required.' }");
}
const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
// Developer packages are isolated from the operator's normal download directory.
const browserHandoff = policy.release || values['browser-handoff'] === true;
const output = join(directory, 'dist', policy.release ? 'release' : 'development');
const staging = join(output, 'app');
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
const requireBackend = createRequire(join(directory, '../backend/package.json'));
await requireBackend('esbuild').build({ entryPoints: [join(directory, 'main.mjs')], outfile: join(staging, 'main.mjs'), bundle: true, packages: 'bundle', platform: 'node', target: 'node22', format: 'esm', external: ['electron'], banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
await writeFile(join(staging, 'package.json'), JSON.stringify({ name: 'local-device-desktop', productName: identity.productName, version: metadata.version, main: 'main.mjs', type: 'module', archestraDesktop: { appName: identity.appName, productName: identity.productName, protocol: identity.protocol, browserHandoff, development: !policy.release } }));
for (const filename of ['preload.cjs', 'renderer.js']) await copyFile(join(directory, filename), join(staging, filename));
const escapeHtml = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
await writeFile(join(staging, 'index.html'), (await readFile(join(directory, 'index.html'), 'utf8')).replaceAll('__DESKTOP_PRODUCT_NAME__', escapeHtml(identity.productName)));
const apps = await packager({ dir: staging, out: join(output, 'packages'), overwrite: true, name: identity.productName, appBundleId: identity.appBundleId, appVersion: metadata.version, executableName: identity.productName, electronVersion: '45.0.0', platform, arch, asar: true, prune: false, ...(policy.release && platform === 'darwin' ? { osxSign: policy.osxSign, osxNotarize: policy.osxNotarize, } : {}), ...(browserHandoff && platform === 'darwin' ? { protocols: [{ name: 'Personal device enrollment', schemes: [identity.protocol] }] } : {}), ...(policy.release && platform === 'win32' ? { windowsSign: policy.windowsSign } : {}) });
const application = platform === 'darwin' ? join(apps[0], `${identity.productName}.app`) : apps[0];
function verifyMac(path, trusted) {
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', path]);
  if (!trusted) return;
  const signature = command('/usr/bin/codesign', ['--display', '--verbose=4', path]);
  if (!signature.includes(`Authority=${policy.osxSign.identity}`) || !signature.includes('(runtime)') || !signature.includes('Timestamp=')) throw new Error('The macOS app does not have the expected Developer ID, hardened runtime and secure signing timestamp.');
  command('/usr/bin/xcrun', ['stapler', 'validate', '-v', path]);
  const assessment = command('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', path]);
  if (!assessment.includes('source=Notarized Developer ID')) throw new Error('Gatekeeper did not verify this app as a notarized Developer ID release.');
}
function verifyWindows(path) {
  powershell("$ErrorActionPreference='Stop'; $files=Get-ChildItem -LiteralPath $env:ARCHESTRA_DESKTOP_VERIFY_DIRECTORY -Recurse -File | Where-Object { $_.Extension -in '.exe','.dll','.node' }; if (!$files) { throw 'No desktop executables found.' }; foreach($file in $files) { $sig=Get-AuthenticodeSignature -LiteralPath $file.FullName; if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Thumbprint -ne $env:ARCHESTRA_DESKTOP_WINDOWS_CERTIFICATE_SHA1 -or !$sig.TimeStamperCertificate) { throw 'Desktop executable failed publisher, timestamp or Authenticode verification.' } }", { ARCHESTRA_DESKTOP_VERIFY_DIRECTORY: path });
}
if (platform === 'darwin') {
  if (!policy.release) {
    // This repairs the modified Electron bundle's integrity only. It is NOT Gatekeeper trust.
    command('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', application]);
  }
  verifyMac(application, policy.release);
} else if (policy.release) verifyWindows(application);
const artifactDirectory = policy.release ? join(directory, 'dist', 'artifacts') : join(output, 'artifacts');
await mkdir(artifactDirectory, { recursive: true });
const pendingDirectory = await mkdtemp(join(artifactDirectory, '.pending-'));
const archive = join(pendingDirectory, identity.filename);
try {
  if (platform === 'darwin') command('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', application, archive]);
  else if (process.platform === 'win32') powershell("$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:ARCHESTRA_DESKTOP_ARCHIVE_SOURCE,$env:ARCHESTRA_DESKTOP_ARCHIVE_TARGET,[IO.Compression.CompressionLevel]::Optimal,$false)", { ARCHESTRA_DESKTOP_ARCHIVE_SOURCE: application, ARCHESTRA_DESKTOP_ARCHIVE_TARGET: archive });
  else command('python3', ['-c', 'import pathlib,sys,zipfile; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED); [z.write(f,f.relative_to(p)) for f in p.rglob("*") if f.is_file()]; z.close()', application, archive]);
  if (platform === 'darwin') {
    const roundtrip = await mkdtemp(join(tmpdir(), 'desktop-release-verification-'));
    try { command('/usr/bin/ditto', ['-x', '-k', archive, roundtrip]); verifyMac(join(roundtrip, `${identity.productName}.app`), policy.release); }
    finally { await rm(roundtrip, { recursive: true, force: true }); }
  }
  const bytes = await readFile(archive);
  const manifest = { version: metadata.version, platform, arch, appName: identity.appName, productName: identity.productName, protocol: identity.protocol, filename: identity.filename, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), signed: policy.release, ...(!policy.release ? { development: true, ...(platform === 'darwin' ? { verification: { mac: { adHocIntegrity: true, developerId: false, notarized: false } } } : {}) } : {}), ...(policy.release ? { verification: platform === 'darwin' ? { mac: { developerId: true, notarized: true } } : { windows: { authenticode: true } } } : {}) };
  // Manifest appears last, only after native verification and archive validation succeed.
  await rename(archive, join(artifactDirectory, identity.filename));
  await writeFile(join(pendingDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await rename(join(pendingDirectory, 'manifest.json'), join(artifactDirectory, `${platform}-${arch}.json`));
  console.log(JSON.stringify({ ...manifest, path: resolve(artifactDirectory, identity.filename) }, null, 2));
} finally { await rm(pendingDirectory, { recursive: true, force: true }); }
