import ipaddr from "ipaddr.js";
import type { NetworkPolicy } from "@/types";
import { networkPolicyDomains } from "./network-policy-domains";

// === Public API ===

/**
 * Decide whether a single host (the hostname of a remote MCP server's URL) is
 * permitted by an effective network egress policy.
 *
 * This is the application-level analogue of what the K8s NetworkPolicy enforces
 * at the kernel for self-hosted pods. It only governs the one hop Archestra
 * controls for a remote server: the backend's outbound connection to the
 * server URL. It cannot constrain what the remote server itself reaches.
 *
 * - `null` policy (built-in default) or `unrestricted` mode → always allowed.
 * - `off` mode → never allowed (no internet egress).
 * - `restricted` mode → an IP-literal host must fall within an allowed CIDR; a
 *   domain host must match an allowed domain (preset + custom, wildcard aware).
 */
export function isHostAllowedByNetworkPolicy(params: {
  host: string;
  policy: NetworkPolicy | null;
}): boolean {
  const { host, policy } = params;

  if (!policy || policy.egressMode === "unrestricted") return true;
  if (policy.egressMode === "off") return false;

  const normalizedHost = stripTrailingDot(host.trim().toLowerCase());
  if (!normalizedHost) return false;

  const ipLiteral = stripBrackets(normalizedHost);
  if (ipaddr.isValid(ipLiteral)) {
    return ipMatchesAnyCidr(ipLiteral, policy.allowedCidrs);
  }

  return domainMatchesAny(normalizedHost, networkPolicyDomains(policy));
}

// === Internal helpers ===

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function stripTrailingDot(host: string): string {
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

function ipMatchesAnyCidr(ip: string, cidrs: string[]): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return false;
  }
  return cidrs.some((cidr) => {
    let range: [ipaddr.IPv4 | ipaddr.IPv6, number];
    try {
      range = ipaddr.parseCIDR(cidr);
    } catch {
      return false;
    }
    // `match` throws when the address kinds differ (IPv4 vs IPv6), so guard.
    if (addr.kind() !== range[0].kind()) return false;
    return addr.match(range);
  });
}

function domainMatchesAny(host: string, allowed: string[]): boolean {
  return allowed.some((entry) => {
    if (entry.startsWith("*.")) {
      // `*.example.com` matches any subdomain (api.example.com, a.b.example.com)
      // but not the apex itself.
      const suffix = entry.slice(1); // ".example.com"
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === entry;
  });
}
