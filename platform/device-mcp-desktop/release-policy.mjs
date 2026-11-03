import { createHash } from 'node:crypto';

export const DEVICE_PROTOCOL = 'archestra-device';

export function desktopIdentity(appName, platform, arch) {
  if (typeof appName !== 'string' || appName.length < 1 || appName.length > 100 || appName !== appName.trim() || appName !== appName.normalize('NFKC') || /[\p{Cc}\p{Cf}/\\<>:"|?*]/u.test(appName) || /[. ]$/.test(appName)) throw new Error('Desktop app name must be a normalized display name without filesystem or control characters.');
  if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch) || (platform === 'win32' && arch !== 'x64')) throw new Error('Unsupported desktop target.');
  const productName = /desktop$/i.test(appName) ? appName : `${appName} Desktop`;
  const slug = productName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'desktop';
  const brandHash = createHash('sha256').update(appName).digest('hex').slice(0, 10);
  return { appName, productName, protocol: DEVICE_PROTOCOL, appBundleId: `ai.archestra.device.${brandHash}`, filename: `${slug}-${brandHash}-${platform}-${arch}.zip` };
}

/** Production builds require native trust verification; developer output is never a release. */
export function releasePolicy({ platform, hostPlatform, development, identity, notaryProfile, certificateSha1, timestampServer }) {
  if (development) return { release: false, signed: false };
  if (platform === 'darwin') {
    if (hostPlatform !== 'darwin') throw new Error('macOS releases must be signed, notarized and assessed on macOS.');
    if (!identity || !/^Developer ID Application: [^\r\n]+ \([A-Z0-9]{10}\)$/.test(identity)) throw new Error('A valid Developer ID Application identity is required. Unsigned or ad-hoc apps cannot be published.');
    if (!notaryProfile || /[\r\n\0]/.test(notaryProfile)) throw new Error('A notarization Keychain profile is required for macOS releases.');
    return { release: true, signed: true, osxSign: { identity, hardenedRuntime: true, identityValidation: true }, osxNotarize: { keychainProfile: notaryProfile } };
  }
  if (hostPlatform !== 'win32') throw new Error('Windows releases must be signed and Authenticode-verified on Windows.');
  if (!certificateSha1 || !/^[a-f0-9]{40}$/i.test(certificateSha1)) throw new Error('An installed Authenticode signing certificate thumbprint is required.');
  let timestamp;
  try { timestamp = new URL(timestampServer); } catch { throw new Error('An HTTPS signing timestamp server is required.'); }
  if (timestamp.protocol !== 'https:' || timestamp.username || timestamp.password || timestamp.hash) throw new Error('An HTTPS signing timestamp server is required.');
  return { release: true, signed: true, windowsSign: { automaticallySelectCertificate: false, hashes: ['sha256'], timestampServer, signWithParams: ['/sha1', certificateSha1] } };
}
