import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import type * as k8s from "@kubernetes/client-node";
import logger from "@/logging";

// === Public API ===

/**
 * Resolves the cluster DNS service ClusterIP(s) (kube-dns/CoreDNS).
 *
 * FQDN-based policies such as the EKS Auto Mode ApplicationNetworkPolicy only
 * support ipBlock and domainNames egress peers, so the managed policy must
 * allowlist the cluster DNS ClusterIP explicitly for pods to resolve anything
 * at all. Without that DNS bootstrap rule the policy silently blocks all
 * lookups and every domain rule becomes unreachable.
 */
class ClusterDnsResolver {
  private cache = new WeakMap<
    k8s.CoreV1Api,
    { expiresAt: number; value: string[] }
  >();

  /**
   * Returns the cluster DNS ClusterIP(s), or an empty array when they cannot
   * be determined. Results are cached per API client for a few minutes.
   */
  async getClusterDnsIps(coreApi: k8s.CoreV1Api): Promise<string[]> {
    const cached = this.cache.get(coreApi);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const ips = await this.resolveClusterDnsIps(coreApi);
    this.cache.set(coreApi, {
      value: ips,
      expiresAt: Date.now() + CLUSTER_DNS_CACHE_TTL_MS,
    });
    return ips;
  }

  /** @internal exported for tests */
  clearCache(): void {
    this.cache = new WeakMap();
  }

  // === Private helpers ===

  private async resolveClusterDnsIps(
    coreApi: k8s.CoreV1Api,
  ): Promise<string[]> {
    const fromNamedService = await this.readDnsServiceByName(coreApi);
    if (fromNamedService.length > 0) {
      return fromNamedService;
    }

    const fromLabelledServices = await this.listDnsServicesByLabel(coreApi);
    if (fromLabelledServices.length > 0) {
      return fromLabelledServices;
    }

    const fromResolvConf = await this.readResolvConfNameservers();
    if (fromResolvConf.length > 0) {
      return fromResolvConf;
    }

    logger.warn(
      "Could not determine the cluster DNS service IP (kube-dns service lookup and resolv.conf both failed)",
    );
    return [];
  }

  /** The conventional `kube-dns` Service in `kube-system` (also used by CoreDNS). */
  private async readDnsServiceByName(
    coreApi: k8s.CoreV1Api,
  ): Promise<string[]> {
    try {
      const service = await coreApi.readNamespacedService({
        name: "kube-dns",
        namespace: "kube-system",
      });
      return serviceClusterIps(service);
    } catch (error) {
      logger.debug(
        { err: error },
        "Failed to read kube-system/kube-dns service while resolving cluster DNS IP",
      );
      return [];
    }
  }

  /** Fallback for clusters where the DNS Service has a different name. */
  private async listDnsServicesByLabel(
    coreApi: k8s.CoreV1Api,
  ): Promise<string[]> {
    try {
      const services = await coreApi.listNamespacedService({
        namespace: "kube-system",
        labelSelector: "k8s-app=kube-dns",
      });
      return (services.items ?? []).flatMap(serviceClusterIps);
    } catch (error) {
      logger.debug(
        { err: error },
        "Failed to list kube-system DNS services while resolving cluster DNS IP",
      );
      return [];
    }
  }

  /**
   * When the platform itself runs inside the cluster, its resolv.conf
   * nameserver is the cluster DNS ClusterIP (or a node-local DNS cache IP,
   * which is equally correct for the pods we manage).
   */
  private async readResolvConfNameservers(): Promise<string[]> {
    if (!process.env.KUBERNETES_SERVICE_HOST) {
      return [];
    }

    try {
      const contents = await readFile("/etc/resolv.conf", "utf8");
      return parseResolvConfNameservers(contents);
    } catch (error) {
      logger.debug(
        { err: error },
        "Failed to read /etc/resolv.conf while resolving cluster DNS IP",
      );
      return [];
    }
  }
}

export const clusterDnsResolver = new ClusterDnsResolver();

/** @internal exported for tests */
export function parseResolvConfNameservers(contents: string): string[] {
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("nameserver"))
    .map((line) => line.split(/\s+/)[1] ?? "")
    .filter((ip) => isIP(ip) !== 0);
}

// === Internal helpers ===

const CLUSTER_DNS_CACHE_TTL_MS = 5 * 60 * 1000;

function serviceClusterIps(service: k8s.V1Service): string[] {
  const ips = service.spec?.clusterIPs?.length
    ? service.spec.clusterIPs
    : service.spec?.clusterIP
      ? [service.spec.clusterIP]
      : [];
  return ips.filter((ip) => isIP(ip) !== 0);
}
