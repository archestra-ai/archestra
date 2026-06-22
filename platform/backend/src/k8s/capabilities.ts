import type * as k8s from "@kubernetes/client-node";
import logger from "@/logging";
import type { K8sCapabilities } from "@/types";
import { createK8sClients, isK8sNotFoundError, loadKubeConfig } from "./shared";

// === Public API ===

export async function getK8sCapabilities(): Promise<K8sCapabilities> {
  const cached = getValidCacheEntry(globalCapabilitiesCache);
  if (cached) return cached;

  try {
    const { kubeConfig, namespace } = loadKubeConfig();
    const clients = createK8sClients(kubeConfig, namespace);
    const capabilities = await getK8sCapabilitiesFromApi(
      clients.customObjectsApi,
    );
    globalCapabilitiesCache = createCacheEntry(capabilities);
    return capabilities;
  } catch (error) {
    logger.warn({ err: error }, "Failed to inspect Kubernetes capabilities");
    return unavailableCapabilities();
  }
}

export async function getK8sCapabilitiesFromApi(
  customObjectsApi: k8s.CustomObjectsApi,
): Promise<K8sCapabilities> {
  const cached = getValidCacheEntry(apiCapabilitiesCache.get(customObjectsApi));
  if (cached) return cached;

  const [
    ciliumNetworkPolicy,
    gkeFqdnNetworkPolicy,
    awsApplicationNetworkPolicy,
  ] = await Promise.all([
    hasCiliumNetworkPolicyResource(customObjectsApi),
    hasGkeFqdnNetworkPolicyResource(customObjectsApi),
    hasAwsApplicationNetworkPolicyResource(customObjectsApi),
  ]);
  const provider = ciliumNetworkPolicy
    ? "cilium"
    : gkeFqdnNetworkPolicy
      ? "gke-fqdn"
      : awsApplicationNetworkPolicy
        ? "aws-application-network-policy"
        : "kubernetes";
  const supportsFqdn =
    ciliumNetworkPolicy || gkeFqdnNetworkPolicy || awsApplicationNetworkPolicy;

  const capabilities: K8sCapabilities = {
    networkPolicy: {
      kubernetesNetworkPolicy: true,
      ciliumNetworkPolicy,
      gkeFqdnNetworkPolicy,
      awsApplicationNetworkPolicy,
      provider,
      supportsFqdn,
      supportsHttpMethods: false,
      message: capabilityMessage({
        ciliumNetworkPolicy,
        gkeFqdnNetworkPolicy,
        awsApplicationNetworkPolicy,
        supportsFqdn,
      }),
    },
  };
  apiCapabilitiesCache.set(customObjectsApi, createCacheEntry(capabilities));
  return capabilities;
}

/** @internal exported for tests */
export function clearK8sCapabilitiesCache(): void {
  globalCapabilitiesCache = null;
  apiCapabilitiesCache = new WeakMap();
}

// === Internal helpers ===

const K8S_CAPABILITIES_CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = {
  expiresAt: number;
  value: K8sCapabilities;
};

let globalCapabilitiesCache: CacheEntry | null = null;
let apiCapabilitiesCache = new WeakMap<k8s.CustomObjectsApi, CacheEntry>();

function createCacheEntry(value: K8sCapabilities): CacheEntry {
  return {
    value,
    expiresAt: Date.now() + K8S_CAPABILITIES_CACHE_TTL_MS,
  };
}

function getValidCacheEntry(entry: CacheEntry | null | undefined) {
  if (!entry || entry.expiresAt <= Date.now()) {
    return null;
  }
  return entry.value;
}

async function hasCiliumNetworkPolicyResource(
  customObjectsApi: k8s.CustomObjectsApi,
): Promise<boolean> {
  try {
    const resourceList = await customObjectsApi.getAPIResources({
      group: "cilium.io",
      version: "v2",
    });
    return (
      resourceList.resources?.some(
        (resource) => resource.name === "ciliumnetworkpolicies",
      ) ?? false
    );
  } catch (error) {
    if (isK8sNotFoundError(error)) {
      return false;
    }
    logger.warn(
      { err: error },
      "Failed to inspect Cilium Kubernetes API resources",
    );
    return false;
  }
}

function capabilityMessage(params: {
  ciliumNetworkPolicy: boolean;
  gkeFqdnNetworkPolicy: boolean;
  awsApplicationNetworkPolicy: boolean;
  supportsFqdn: boolean;
}): string {
  if (params.ciliumNetworkPolicy) {
    return "CiliumNetworkPolicy API detected. Domain allowlists can be enforced by Cilium.";
  }
  if (params.gkeFqdnNetworkPolicy) {
    return "GKE FQDNNetworkPolicy API detected. Domain allowlists can be enforced by GKE.";
  }
  if (params.awsApplicationNetworkPolicy) {
    return "AWS ApplicationNetworkPolicy API detected. Domain allowlists can be enforced by EKS Auto Mode.";
  }
  if (!params.supportsFqdn) {
    return "No supported FQDN policy provider detected. Kubernetes NetworkPolicy only enforces IP/CIDR egress.";
  }
  return "Network policy capabilities detected.";
}

async function hasGkeFqdnNetworkPolicyResource(
  customObjectsApi: k8s.CustomObjectsApi,
): Promise<boolean> {
  try {
    const resourceList = await customObjectsApi.getAPIResources({
      group: "networking.gke.io",
      version: "v1alpha1",
    });
    return (
      resourceList.resources?.some(
        (resource) => resource.name === "fqdnnetworkpolicies",
      ) ?? false
    );
  } catch (error) {
    if (isK8sNotFoundError(error)) {
      return false;
    }
    logger.warn(
      { err: error },
      "Failed to inspect GKE FQDN Kubernetes API resources",
    );
    return false;
  }
}

async function hasAwsApplicationNetworkPolicyResource(
  customObjectsApi: k8s.CustomObjectsApi,
): Promise<boolean> {
  try {
    const resourceList = await customObjectsApi.getAPIResources({
      group: "networking.k8s.aws",
      version: "v1alpha1",
    });
    return (
      resourceList.resources?.some(
        (resource) => resource.name === "applicationnetworkpolicies",
      ) ?? false
    );
  } catch (error) {
    if (isK8sNotFoundError(error)) {
      return false;
    }
    logger.warn(
      { err: error },
      "Failed to inspect AWS ApplicationNetworkPolicy Kubernetes API resources",
    );
    return false;
  }
}

function unavailableCapabilities(): K8sCapabilities {
  return {
    networkPolicy: {
      kubernetesNetworkPolicy: false,
      ciliumNetworkPolicy: false,
      gkeFqdnNetworkPolicy: false,
      awsApplicationNetworkPolicy: false,
      provider: "none",
      supportsFqdn: false,
      supportsHttpMethods: false,
      message:
        "Kubernetes capabilities could not be inspected. Network policy enforcement is unavailable until Kubernetes access is configured.",
    },
  };
}
