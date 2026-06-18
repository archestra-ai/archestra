import type { NetworkPolicy } from "@/types";
import { ipMatchesAnyCidr, isIpLiteralHost } from "@/utils/network";
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

  if (isIpLiteralHost(normalizedHost)) {
    return ipMatchesAnyCidr(normalizedHost, policy.allowedCidrs);
  }

  return domainMatchesAny(normalizedHost, networkPolicyDomains(policy));
}

// === Internal helpers ===

function stripTrailingDot(host: string): string {
  return host.endsWith(".") ? host.slice(0, -1) : host;
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
