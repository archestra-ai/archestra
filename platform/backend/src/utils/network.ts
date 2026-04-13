import { isIPv4 } from "node:net";

/**
 * Check whether an IP address string is a loopback (localhost) address.
 *
 * Covers:
 *  - IPv4 loopback range `127.0.0.0/8`  (any `127.x.x.x`)
 *  - IPv6 loopback `::1`
 *  - IPv4-mapped IPv6 loopback `::ffff:127.x.x.x`
 */
export function isLoopbackAddress(ip: string): boolean {
  if (ip === "::1") return true;

  // Handle IPv4-mapped IPv6 (e.g. "::ffff:127.0.0.1")
  const ipv4Part = ip.startsWith("::ffff:") ? ip.slice(7) : ip;

  return isIPv4(ipv4Part) && ipv4Part.startsWith("127.");
}

/**
 * Check if a redirect URI targets a loopback address.
 * Per RFC 8252 Section 7.3, authorization servers must allow any port
 * for loopback redirect URIs in native app OAuth flows.
 */
export function isLoopbackRedirectUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    const hostname = url.hostname.toLowerCase();
    if (hostname === "localhost") {
      return true;
    }

    return isLoopbackAddress(hostname.replace(/^\[(.*)\]$/, "$1"));
  } catch {
    return false;
  }
}

/**
 * Check if a requested loopback redirect URI matches any registered URI,
 * ignoring the port component. Returns true when scheme, host, and path
 * match but the port differs.
 */
export function loopbackRedirectUriMatchesIgnoringPort(
  requestedUri: string,
  registeredUris: string[],
): boolean {
  if (!isLoopbackRedirectUri(requestedUri)) return false;

  let requestedUrl: URL;
  try {
    requestedUrl = new URL(requestedUri);
  } catch {
    return false;
  }

  return registeredUris.some((registeredUri) => {
    if (!isLoopbackRedirectUri(registeredUri)) return false;

    try {
      const registeredUrl = new URL(registeredUri);
      return (
        requestedUrl.protocol === registeredUrl.protocol &&
        requestedUrl.hostname.toLowerCase() ===
          registeredUrl.hostname.toLowerCase() &&
        requestedUrl.pathname === registeredUrl.pathname
      );
    } catch {
      return false;
    }
  });
}
