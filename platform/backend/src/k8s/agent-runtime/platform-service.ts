import { isIP } from "node:net";
import type * as k8s from "@kubernetes/client-node";

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
