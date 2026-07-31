import type * as k8s from "@kubernetes/client-node";
import logger from "@/logging";
import type { K8sCapabilities } from "@/types";
import {
  type NetworkPolicyProbeVerdict,
  networkPolicyProbeReader,
} from "./network-policy-probe";
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
      { coreApi: clients.coreApi, namespace: clients.namespace },
    );
    globalCapabilitiesCache = createCacheEntry(capabilities);
    return capabilities;
  } catch (error) {
    logger.warn({ err: error }, "Failed to inspect Kubernetes capabilities");
    return unavailableCapabilities();
  }
}

/**
 * `probeSource` points at the namespace the chart's enforcement probe runs in.
 * It is optional so callers without a CoreV1Api still get the inferred answer.
 */
export async function getK8sCapabilitiesFromApi(
  customObjectsApi: k8s.CustomObjectsApi,
  probeSource?: { coreApi: k8s.CoreV1Api; namespace: string },
): Promise<K8sCapabilities> {
  const cached = getValidCacheEntry(apiCapabilitiesCache.get(customObjectsApi));
  if (cached) return cached;

  const [
    calicoNetworkPolicy,
    ciliumNetworkPolicy,
    gkeFqdnNetworkPolicy,
    awsApplicationNetworkPolicy,
    probe,
  ] = await Promise.all([
    hasCalicoNetworkPolicyResource(customObjectsApi),
    hasCiliumNetworkPolicyResource(customObjectsApi),
    hasGkeFqdnNetworkPolicyResource(customObjectsApi),
    hasAwsApplicationNetworkPolicyResource(customObjectsApi),
    probeSource
      ? networkPolicyProbeReader.readVerdict(
          probeSource.coreApi,
          probeSource.namespace,
        )
      : Promise.resolve(NO_PROBE),
  ]);
  const supportsFqdn =
    ciliumNetworkPolicy || gkeFqdnNetworkPolicy || awsApplicationNetworkPolicy;
  // Which CRD group the API serves tells us which policy dialect this cluster
  // speaks, not whether anything acts on the objects. Those come apart in both
  // directions: GKE serves the Calico CRDs with node enforcement switched off,
  // while Dataplane V2, kindnet and the EKS VPC CNI enforce the standard API
  // and publish nothing. So inference only stands in when the probe has no
  // answer, and it stays the source of the dialect either way.
  const inferredEnforced = supportsFqdn || calicoNetworkPolicy;
  // The probe exercises a plain networking.k8s.io NetworkPolicy, so it only
  // speaks for clusters whose enforcing policy is that kind. On the AWS VPC CNI
  // a plain NetworkPolicy is accepted and never enforced (see
  // `shouldUseAwsApplicationNetworkPolicy`), so its verdict there describes a
  // dialect the runtime deliberately does not use — and letting it win would
  // drop the provider to "none" and tear down the ApplicationNetworkPolicy
  // baseline that is doing the actual enforcing.
  const probeMeasuresTheEnforcingKind = !awsApplicationNetworkPolicy;
  const probeDecided =
    probeMeasuresTheEnforcingKind &&
    (probe.result === "enforced" || probe.result === "not-enforced");
  const enforced = probeDecided
    ? probe.result === "enforced"
    : inferredEnforced;
  const enforcementSource = probeDecided ? "probe" : "api-discovery";
  const provider = !enforced
    ? "none"
    : ciliumNetworkPolicy
      ? "cilium"
      : gkeFqdnNetworkPolicy
        ? "gke-fqdn"
        : awsApplicationNetworkPolicy
          ? "aws-application-network-policy"
          : "kubernetes";

  if (probeDecided && enforced !== inferredEnforced) {
    logger.warn(
      { probe: probe.result, detail: probe.detail, provider },
      enforced
        ? "Network policy enforcement was measured on this cluster even though no policy CRD advertises it"
        : "Network policy CRDs are installed on this cluster but a probe found egress rules are not enforced",
    );
  }

  const capabilities: K8sCapabilities = {
    networkPolicy: {
      kubernetesNetworkPolicy: enforced,
      ciliumNetworkPolicy,
      gkeFqdnNetworkPolicy,
      awsApplicationNetworkPolicy,
      provider,
      // Only a provider CRD can carry domain rules, so a probe that proves the
      // standard API is enforced says nothing about FQDN support.
      supportsFqdn: enforced && supportsFqdn,
      supportsHttpMethods: false,
      message: capabilityMessage({
        enforced,
        ciliumNetworkPolicy,
        gkeFqdnNetworkPolicy,
        awsApplicationNetworkPolicy,
        supportsFqdn: enforced && supportsFqdn,
        probe: probe.result,
      }),
      enforcementSource,
      probe: probe.result,
      probedAt: probe.probedAt,
    },
  };
  apiCapabilitiesCache.set(customObjectsApi, createCacheEntry(capabilities));
  return capabilities;
}

/** @internal exported for tests */
export function clearK8sCapabilitiesCache(): void {
  globalCapabilitiesCache = null;
  apiCapabilitiesCache = new WeakMap();
  networkPolicyProbeReader.clearCache();
}

// === Internal helpers ===

const K8S_CAPABILITIES_CACHE_TTL_MS = 5 * 60 * 1000;
const PENDING_PROBE_CACHE_TTL_MS = 30 * 1000;

const NO_PROBE: NetworkPolicyProbeVerdict = {
  result: "absent",
  probedAt: null,
  detail: null,
};

type CacheEntry = {
  expiresAt: number;
  value: K8sCapabilities;
};

let globalCapabilitiesCache: CacheEntry | null = null;
let apiCapabilitiesCache = new WeakMap<k8s.CustomObjectsApi, CacheEntry>();

/**
 * A pending verdict expires quickly. The probe runs as a post-install hook, so
 * the platform starts up before it reports; caching the inferred answer for the
 * full interval would leave the measured one unused long after it arrived.
 */
function createCacheEntry(value: K8sCapabilities): CacheEntry {
  if (value.networkPolicy.probe === "absent") {
    return {
      value,
      expiresAt: Date.now() + PENDING_PROBE_CACHE_TTL_MS,
    };
  }
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
  probe: NetworkPolicyProbeVerdict["result"];
}): string {
  // A measured answer is stated as measured; the inferred wording below has to
  // hedge because serving a policy CRD is not evidence that anything enforces.
  if (params.probe === "not-enforced") {
    return "A test pod under a deny-all policy still reached the cluster, so NetworkPolicy objects are accepted but not enforced here.";
  }
  if (params.probe === "enforced" && !params.supportsFqdn) {
    return "NetworkPolicy enforcement confirmed by a test pod. IP/CIDR egress is enforced; domain allowlists require a supported FQDN policy provider.";
  }
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
      enforcementSource: "api-discovery",
      probe: "absent",
      probedAt: null,
    },
  };
}
