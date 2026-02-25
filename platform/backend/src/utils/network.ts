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
