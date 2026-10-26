import { isIPv4, isIPv6 } from "node:net";
import type * as k8s from "@kubernetes/client-node";
import { LRUCacheManager } from "@/in-memory-lru-cache";
import logger from "@/logging";

// === Public API ===

/** Kubernetes' own spelling, as in a Service's `spec.ipFamilies`. */
export type ClusterIpFamily = "IPv4" | "IPv6";

/**
 * Resolves which IP families pods in a namespace are given (IPv4, IPv6, or
 * both on a dual-stack cluster).
 *
 * The unrestricted egress floor needs this because some enforcers mishandle an
 * ipBlock of a family the cluster does not serve: the AWS network policy agent
 * on an IPv4-only cluster drops the `::/0` parent rule but keeps its IPv6
 * `except` entries, the eBPF map update fails, and the selected pods lose all
 * public egress.
 */
class ClusterIpFamilyResolver {
  private cache = new LRUCacheManager<ClusterIpFamily[]>({
    maxSize: 100,
    defaultTtl: 5 * 60 * 1000,
  });

  /**
   * Returns the IP families of running pods in `namespace`, falling back to
   * the families of the cluster DNS IPs when no pod has an address yet. An
   * empty array means the families could not be determined. Determined results
   * are cached per namespace for a few minutes.
   */
  async getIpFamilies(params: {
    coreApi: k8s.CoreV1Api;
    namespace: string;
    clusterDnsIps: string[];
  }): Promise<ClusterIpFamily[]> {
    const cached = this.cache.get(params.namespace);
    if (cached) {
      return cached;
    }

    const fromPods = await this.listPodIpFamilies(
      params.coreApi,
      params.namespace,
    );
    // A Service (the DNS one included) is single-stack by default even on a
    // dual-stack cluster, so its address only names the primary family. Pod
    // addresses are authoritative; the DNS IPs only cover an empty namespace.
    const families =
      fromPods.length > 0 ? fromPods : ipFamiliesOf(params.clusterDnsIps);
    if (families.length > 0) {
      this.cache.set(params.namespace, families);
    }
    return families;
  }

  // === Private helpers ===

  private async listPodIpFamilies(
    coreApi: k8s.CoreV1Api,
    namespace: string,
  ): Promise<ClusterIpFamily[]> {
    try {
      const pods = await coreApi.listNamespacedPod({
        namespace,
        fieldSelector: "status.phase=Running",
        limit: POD_SAMPLE_LIMIT,
      });
      return ipFamiliesOf(
        (pods.items ?? [])
          // Host-network pods report the node's addresses, not the pod network's.
          .filter((pod) => pod.spec?.hostNetwork !== true)
          .flatMap((pod) =>
            pod.status?.podIPs?.length
              ? pod.status.podIPs.map((podIp) => podIp.ip)
              : pod.status?.podIP
                ? [pod.status.podIP]
                : [],
          ),
      );
    } catch (error) {
      logger.debug(
        { err: error, namespace },
        "Failed to list pods while resolving the cluster IP families",
      );
      return [];
    }
  }
}

export const clusterIpFamilyResolver = new ClusterIpFamilyResolver();

// === Internal helpers ===

const POD_SAMPLE_LIMIT = 20;

function ipFamiliesOf(ips: string[]): ClusterIpFamily[] {
  const families: ClusterIpFamily[] = [];
  if (ips.some((ip) => isIPv4(ip))) families.push("IPv4");
  if (ips.some((ip) => isIPv6(ip))) families.push("IPv6");
  return families;
}
