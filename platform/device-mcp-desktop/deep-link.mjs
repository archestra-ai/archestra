import { DEVICE_PROTOCOL } from './release-policy.mjs';

/** OS handoff proofs are validated in main, never sent to the renderer or logged. */
export function parseDeviceEnrollmentUrl(value) {
  const invalid = () => { throw new Error('This device connection link is invalid. Return to Devices and try again.'); };
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4096 || /[\u0000-\u0020\u007f]/.test(value)) invalid();
  let link;
  try { link = new URL(value); } catch { invalid(); }
  if (link.protocol !== `${DEVICE_PROTOCOL}:` || link.hostname !== 'enroll' || link.pathname !== '' || link.port || link.username || link.password || link.hash) invalid();
  const keys = [...link.searchParams.keys()];
  if (keys.length !== 3 || new Set(keys).size !== 3 || keys.some(key => !['version', 'url', 'code'].includes(key)) || link.searchParams.get('version') !== '1') invalid();
  const code = link.searchParams.get('code');
  const url = link.searchParams.get('url');
  if (!code || !/^[A-Za-z0-9_-]{40,128}$/.test(code) || !url || url.length > 2048 || /[\u0000-\u0020\u007f]/.test(url)) invalid();
  let origin;
  try { origin = new URL(url); } catch { invalid(); }
  if (origin.username || origin.password || origin.search || origin.hash || !['', '/'].includes(origin.pathname) || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) invalid();
  return { version: 2, purpose: 'local-device', url: origin.origin, code };
}
