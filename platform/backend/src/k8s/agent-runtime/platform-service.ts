import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type * as k8s from "@kubernetes/client-node";
import logger from "@/logging";

/** Resolve only the configured platform destination, without opening a service CIDR. */
export async function resolvePlatformServiceDestination(params: {
  coreApi: k8s.CoreV1Api;
  baseUrl: string;
  platformNamespace: string;
  runtimeNamespace: string;
}): Promise<{ ips: string[]; port: number } | undefined> {
  if (!params.baseUrl) return undefined;
  const url = new URL(params.baseUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (hostname === "localhost") return undefined;
  if (isIP(hostname)) return { ips: [hostname], port };

  const parts = hostname.replace(/\.$/, "").split(".");
  // Short Service names and Kubernetes Service DNS names are resolved through
  // the API. External hostnames retain the existing Environment egress rules.
  const isServiceName =
    parts.length === 1 || parts.length === 2 || parts[2] === "svc";
  if (!isServiceName) return undefined;
  // A two-label external hostname is not necessarily a Service. Only recognize
  // the platform namespace for this abbreviated form.
  if (
    parts.length === 2 &&
    parts[1] !== params.platformNamespace &&
    parts[1] !== params.runtimeNamespace
  )
    return undefined;
  const service = await params.coreApi.readNamespacedService({
    name: parts[0],
    namespace: parts[1] ?? params.runtimeNamespace,
  });
  const ips = service.spec?.clusterIPs?.length
    ? service.spec.clusterIPs
    : [service.spec?.clusterIP ?? ""];
  return { ips: [...new Set(ips.filter((ip) => isIP(ip) !== 0))], port };
}

/**
 * The URL Agent Runtime pods in an environment's own cluster call the platform
 * at, or why there is none. The environment's own URL wins. The install-wide
 * one is usable only when it is not a name of the platform's cluster: a
 * Service name, or the platform's loopback, means something else (or nothing)
 * in another cluster.
 */
export function resolvePlatformUrlForEnvironmentCluster(params: {
  environmentUrl: string | null;
  installUrl: string;
  platformNamespace: string;
}): { url: string } | { problem: string } {
  if (params.environmentUrl) return { url: params.environmentUrl };
  if (!params.installUrl) {
    return {
      problem:
        "Agent Runtime pods in this cluster have no URL to reach the platform at. Set the environment's Agent Runtime platform URL.",
    };
  }
  if (isPlatformClusterLocalUrl(params.installUrl, params.platformNamespace)) {
    return {
      problem: `Agent Runtime pods in this cluster cannot use ${params.installUrl}: that name only works inside the platform's own cluster. Set the environment's Agent Runtime platform URL to an address this cluster can reach.`,
    };
  }
  return { url: params.installUrl };
}

/**
 * The addresses of an external platform URL, as the platform resolves its
 * host name; undefined when the URL holds no host name to resolve.
 *
 * For a run in an environment's own cluster nothing else opens the way to the
 * platform: its pods are not there to select, and the environment's egress
 * policy may allow nothing. The name is taken to resolve to the same
 * addresses from that cluster; where it does not, the environment's network
 * egress policy has to allow the address the cluster sees.
 */
export async function resolveExternalPlatformDestination(
  baseUrl: string,
): Promise<{ ips: string[]; port: number } | undefined> {
  if (!baseUrl) return undefined;
  const url = new URL(baseUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || isIP(hostname)) return undefined;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  let addresses: string[];
  try {
    addresses = (await lookup(hostname, { all: true })).map(
      (entry) => entry.address,
    );
  } catch (error) {
    logger.warn(
      { err: error, hostname },
      "Could not resolve the platform URL of an environment's cluster; its Agent Runtime pods get no egress rule for it",
    );
    return undefined;
  }
  // A loopback answer is this machine's own view of a name such as
  // host.docker.internal, never the address another cluster reaches.
  const ips = [...new Set(addresses)].filter(
    (ip) => ip !== "::1" && !ip.startsWith("127."),
  );
  return ips.length > 0 ? { ips, port } : undefined;
}

// === Internal helpers ===

function isPlatformClusterLocalUrl(
  baseUrl: string,
  platformNamespace: string,
): boolean {
  const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost") return true;
  if (isIP(hostname)) return hostname === "::1" || hostname.startsWith("127.");
  const parts = hostname.replace(/\.$/, "").split(".");
  return (
    parts.length === 1 ||
    parts[2] === "svc" ||
    (parts.length === 2 && parts[1] === platformNamespace)
  );
}
