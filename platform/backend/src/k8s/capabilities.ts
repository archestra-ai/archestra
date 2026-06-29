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
    calicoNetworkPolicy,
    ciliumNetworkPolicy,
    gkeFqdnNetworkPolicy,
    awsApplicationNetworkPolicy,
  ] = await Promise.all([
    hasCalicoNetworkPolicyResource(customObjectsApi),
    hasCiliumNetworkPolicyResource(customObjectsApi),
    hasGkeFqdnNetworkPolicyResource(customObjectsApi),
    hasAwsApplicationNetworkPolicyResource(customObjectsApi),
  ]);
  const supportsFqdn =
    ciliumNetworkPolicy || gkeFqdnNetworkPolicy || awsApplicationNetworkPolicy;
  // A NetworkPolicy is only enforced if a dataplane agent backs it. Calico,
  // Cilium, and the FQDN providers each install a provider-exclusive CRD group
  // we can discover; absent all of them — e.g. GKE with the NetworkPolicy addon
  // off, only `netd` running — the API accepts NetworkPolicy objects but nothing
  // enforces them, so we report "none" rather than a false promise of isolation.
  // Known limitation: plain GKE Dataplane V2 enforces standard NetworkPolicy but
  // exposes no discoverable CRD (its FQDN CRD is feature-gated), so it is not
  // detected here and would report "none". Acceptable while no environment runs
  // plain Dataplane V2; revisit (probe the `anetd` DaemonSet) if one does.
  const enforced = supportsFqdn || calicoNetworkPolicy;
  const provider = !enforced
    ? "none"
    : ciliumNetworkPolicy
      ? "cilium"
      : gkeFqdnNetworkPolicy
        ? "gke-fqdn"
        : awsApplicationNetworkPolicy
          ? "aws-application-network-policy"
          : "kubernetes";

  const capabilities: K8sCapabilities = {
    networkPolicy: {
      kubernetesNetworkPolicy: enforced,
      ciliumNetworkPolicy,
      gkeFqdnNetworkPolicy,
      awsApplicationNetworkPolicy,
      provider,
      supportsFqdn,
      supportsHttpMethods: false,
      message: capabilityMessage({
        enforced,
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
  enforced: boolean;
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
  if (!params.enforced) {
    return "No NetworkPolicy enforcer detected (no Calico, Cilium, or FQDN policy provider). NetworkPolicy objects are accepted by the API but not enforced.";
  }
  return "NetworkPolicy enforcement detected. IP/CIDR egress is enforced; domain allowlists require a supported FQDN policy provider.";
}

async function hasCalicoNetworkPolicyResource(
  customObjectsApi: k8s.CustomObjectsApi,
): Promise<boolean> {
  // Calico (the legacy GKE NetworkPolicy addon or self-managed) installs the
  // provider-exclusive `crd.projectcalico.org` group; `felixconfigurations` is
  // its dataplane (Felix) config, present wherever Calico's CRDs are installed.
  try {
    const resourceList = await customObjectsApi.getAPIResources({
      group: "crd.projectcalico.org",
      version: "v1",
    });
    return (
      resourceList.resources?.some(
        (resource) => resource.name === "felixconfigurations",
      ) ?? false
    );
  } catch (error) {
    if (isK8sNotFoundError(error)) {
      return false;
    }
    logger.warn(
      { err: error },
      "Failed to inspect Calico Kubernetes API resources",
    );
    return false;
  }
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
