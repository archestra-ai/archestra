import type * as k8s from "@kubernetes/client-node";
import { sanitizeMetadataLabels } from "@/k8s/shared";
import { networkPolicyDomains } from "@/services/environments/network-policy-domains";
import type {
  EffectiveNetworkPolicy,
  K8sNetworkPolicyCapabilities,
} from "@/types";

// === Public API ===

export function constructManagedNetworkPolicyName(
  deploymentName: string,
): string {
  const name = `mcp-egress-${deploymentName}`
    .toLowerCase()
    .replace(/\./g, "-")
    .slice(0, 253)
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/g, "");
  return name.length > 0 ? name : "mcp-egress";
}

export function shouldManageK8sNetworkPolicy(
  effectivePolicy?: EffectiveNetworkPolicy | null,
): boolean {
  return (
    effectivePolicy?.policy?.egressMode === "off" ||
    effectivePolicy?.policy?.egressMode === "restricted"
  );
}

export function buildManagedNetworkPolicy(params: {
  name: string;
  podSelectorLabels: Record<string, string>;
  effectivePolicy: EffectiveNetworkPolicy;
}): k8s.V1NetworkPolicy {
  const policy = params.effectivePolicy.policy;
  if (!policy) {
    throw new Error("Cannot build a managed NetworkPolicy without a policy");
  }

  const labels = sanitizeMetadataLabels({
    app: "mcp-server",
    "app.kubernetes.io/managed-by": "archestra",
    "archestra.io/resource": "mcp-network-policy",
    "archestra.io/network-policy-source": params.effectivePolicy.source,
  });

  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: params.name,
      labels,
      annotations: buildPolicyAnnotations(
        params.effectivePolicy,
        networkPolicyDomains(policy).length > 0
          ? "requires-fqdn-policy-provider"
          : "ip-only",
      ),
    },
    spec: {
      podSelector: {
        matchLabels: params.podSelectorLabels,
      },
      policyTypes: ["Egress"],
      egress: buildKubernetesEgressRules(policy),
    },
  };
}

export function buildManagedCiliumNetworkPolicy(params: {
  name: string;
  podSelectorLabels: Record<string, string>;
  effectivePolicy: EffectiveNetworkPolicy;
}): Record<string, unknown> {
  const policy = params.effectivePolicy.policy;
  if (!policy) {
    throw new Error(
      "Cannot build a managed CiliumNetworkPolicy without a policy",
    );
  }

  const labels = sanitizeMetadataLabels({
    app: "mcp-server",
    "app.kubernetes.io/managed-by": "archestra",
    "archestra.io/resource": "mcp-network-policy",
    "archestra.io/network-policy-source": params.effectivePolicy.source,
  });

  return {
    apiVersion: "cilium.io/v2",
    kind: "CiliumNetworkPolicy",
    metadata: {
      name: params.name,
      labels,
      annotations: buildPolicyAnnotations(params.effectivePolicy, "active"),
    },
    spec: {
      endpointSelector: {
        matchLabels: params.podSelectorLabels,
      },
      egress: buildCiliumEgressRules(policy),
    },
  };
}

export function buildManagedGkeFqdnNetworkPolicy(params: {
  name: string;
  podSelectorLabels: Record<string, string>;
  effectivePolicy: EffectiveNetworkPolicy;
}): Record<string, unknown> {
  const policy = params.effectivePolicy.policy;
  if (!policy) {
    throw new Error(
      "Cannot build a managed FQDNNetworkPolicy without a policy",
    );
  }
  const domainRules = ciliumDomainRules(policy);
  if (domainRules.length === 0) {
    throw new Error("Cannot build FQDNNetworkPolicy with empty domain list");
  }

  const labels = sanitizeMetadataLabels({
    app: "mcp-server",
    "app.kubernetes.io/managed-by": "archestra",
    "archestra.io/resource": "mcp-network-policy",
    "archestra.io/network-policy-source": params.effectivePolicy.source,
  });

  return {
    apiVersion: "networking.gke.io/v1alpha1",
    kind: "FQDNNetworkPolicy",
    metadata: {
      name: params.name,
      labels,
      annotations: buildPolicyAnnotations(params.effectivePolicy, "active"),
    },
    spec: {
      podSelector: {
        matchLabels: params.podSelectorLabels,
      },
      egress: [
        {
          matches: domainRules.map((domain) =>
            "matchPattern" in domain
              ? { pattern: domain.matchPattern }
              : { name: domain.matchName },
          ),
        },
      ],
    },
  };
}

export function buildManagedAwsApplicationNetworkPolicy(params: {
  name: string;
  podSelectorLabels: Record<string, string>;
  effectivePolicy: EffectiveNetworkPolicy;
  /**
   * ClusterIP(s) of the cluster DNS service. ApplicationNetworkPolicy only
   * supports ipBlock and domainNames egress peers (no pod/namespace
   * selectors), so DNS must be allowlisted by IP or the policy blocks all
   * lookups and every domainNames rule becomes unreachable.
   */
  clusterDnsIps: string[];
}): Record<string, unknown> {
  const policy = params.effectivePolicy.policy;
  if (!policy) {
    throw new Error(
      "Cannot build a managed ApplicationNetworkPolicy without a policy",
    );
  }

  const labels = sanitizeMetadataLabels({
    app: "mcp-server",
    "app.kubernetes.io/managed-by": "archestra",
    "archestra.io/resource": "mcp-network-policy",
    "archestra.io/network-policy-source": params.effectivePolicy.source,
  });

  return {
    apiVersion: "networking.k8s.aws/v1alpha1",
    kind: "ApplicationNetworkPolicy",
    metadata: {
      name: params.name,
      labels,
      annotations: {
        ...buildPolicyAnnotations(params.effectivePolicy, "active"),
        "archestra.io/network-policy-cluster-dns":
          params.clusterDnsIps.join(",") || "any",
      },
    },
    spec: {
      podSelector: {
        matchLabels: params.podSelectorLabels,
      },
      policyTypes: ["Egress"],
      egress: buildAwsApplicationEgressRules(policy, params.clusterDnsIps),
    },
  };
}

export function shouldUseCiliumNetworkPolicy(params: {
  effectivePolicy?: EffectiveNetworkPolicy | null;
  capabilities?: K8sNetworkPolicyCapabilities | null;
}): boolean {
  return (
    params.capabilities?.ciliumNetworkPolicy === true &&
    params.effectivePolicy?.policy?.egressMode === "restricted" &&
    ciliumDomainRules(params.effectivePolicy.policy).length > 0
  );
}

export function shouldUseGkeFqdnNetworkPolicy(params: {
  effectivePolicy?: EffectiveNetworkPolicy | null;
  capabilities?: K8sNetworkPolicyCapabilities | null;
}): boolean {
  return (
    params.capabilities?.ciliumNetworkPolicy !== true &&
    params.capabilities?.gkeFqdnNetworkPolicy === true &&
    params.effectivePolicy?.policy?.egressMode === "restricted" &&
    ciliumDomainRules(params.effectivePolicy.policy).length > 0
  );
}

export function shouldUseAwsApplicationNetworkPolicy(params: {
  effectivePolicy?: EffectiveNetworkPolicy | null;
  capabilities?: K8sNetworkPolicyCapabilities | null;
}): boolean {
  return (
    params.capabilities?.ciliumNetworkPolicy !== true &&
    params.capabilities?.gkeFqdnNetworkPolicy !== true &&
    params.capabilities?.awsApplicationNetworkPolicy === true &&
    params.effectivePolicy?.policy?.egressMode === "restricted" &&
    networkPolicyDomains(params.effectivePolicy.policy).length > 0
  );
}

// === Internal helpers ===

function buildKubernetesEgressRules(
  policy: NonNullable<EffectiveNetworkPolicy["policy"]>,
): k8s.V1NetworkPolicyEgressRule[] {
  if (policy.egressMode === "off") {
    return [];
  }

  if (policy.egressMode === "restricted") {
    return [
      buildDnsEgressRule(),
      ...policy.allowedCidrs.map((cidr) => ({
        to: [{ ipBlock: { cidr } }],
      })),
    ];
  }

  return [];
}

function buildCiliumEgressRules(
  policy: NonNullable<EffectiveNetworkPolicy["policy"]>,
): Array<Record<string, unknown>> {
  if (policy.egressMode === "off") {
    return [];
  }

  if (policy.egressMode !== "restricted") {
    return [];
  }

  const rules: Array<Record<string, unknown>> = [];
  const toFQDNs = ciliumDomainRules(policy);
  if (toFQDNs.length > 0) {
    rules.push(buildCiliumDnsEgressRule());
  }

  if (policy.allowedCidrs.length > 0) {
    rules.push({
      toCIDRSet: policy.allowedCidrs.map((cidr) => ({ cidr })),
    });
  }

  if (toFQDNs.length > 0) {
    rules.push({ toFQDNs });
  }

  return rules;
}

function buildAwsApplicationEgressRules(
  policy: NonNullable<EffectiveNetworkPolicy["policy"]>,
  clusterDnsIps: string[],
): Array<Record<string, unknown>> {
  if (policy.egressMode === "off") {
    return [];
  }

  if (policy.egressMode !== "restricted") {
    return [];
  }

  const domains = networkPolicyDomains(policy);

  return [
    buildAwsDnsBootstrapEgressRule(clusterDnsIps),
    ...policy.allowedCidrs.map((cidr) => ({
      to: [{ ipBlock: { cidr } }],
    })),
    // All domains go in a single domainNames list: one rule per domain
    // bloats the generated PolicyEndpoints on EKS Auto Mode.
    ...(domains.length > 0 ? [{ to: [{ domainNames: domains }] }] : []),
  ];
}

/**
 * DNS bootstrap rule for EKS Auto Mode. When the cluster DNS ClusterIP could
 * not be resolved, fall back to allowing port 53 anywhere — restricting DNS
 * to an unknown IP would break every domainNames rule in the policy.
 */
function buildAwsDnsBootstrapEgressRule(
  clusterDnsIps: string[],
): Record<string, unknown> {
  const to =
    clusterDnsIps.length > 0
      ? clusterDnsIps.map((ip) => ({
          ipBlock: { cidr: ip.includes(":") ? `${ip}/128` : `${ip}/32` },
        }))
      : [{ ipBlock: { cidr: "0.0.0.0/0" } }];

  return {
    to,
    ports: [
      { protocol: "UDP", port: 53 },
      { protocol: "TCP", port: 53 },
    ],
  };
}

function buildCiliumDnsEgressRule(): Record<string, unknown> {
  return {
    toEndpoints: [
      {
        matchLabels: {
          "k8s:io.kubernetes.pod.namespace": "kube-system",
          "k8s:k8s-app": "kube-dns",
        },
      },
    ],
    toPorts: [
      {
        ports: [{ port: "53", protocol: "ANY" }],
        rules: {
          dns: [{ matchPattern: "*" }],
        },
      },
    ],
  };
}

function buildDnsEgressRule(): k8s.V1NetworkPolicyEgressRule {
  return {
    to: [
      {
        namespaceSelector: {
          matchLabels: {
            "kubernetes.io/metadata.name": "kube-system",
          },
        },
        podSelector: {
          matchLabels: {
            "k8s-app": "kube-dns",
          },
        },
      },
    ],
    ports: [
      {
        protocol: "UDP",
        port: 53 as unknown as k8s.IntOrString,
      },
      {
        protocol: "TCP",
        port: 53 as unknown as k8s.IntOrString,
      },
    ],
  };
}

function buildPolicyAnnotations(
  effectivePolicy: EffectiveNetworkPolicy,
  domainEnforcement: "active" | "ip-only" | "requires-fqdn-policy-provider",
): Record<string, string> {
  const policy = effectivePolicy.policy;
  if (!policy) {
    return {};
  }

  return {
    "archestra.io/network-policy-source": effectivePolicy.source,
    "archestra.io/network-policy-egress-mode": policy.egressMode,
    "archestra.io/network-policy-domain-preset": policy.domainPreset,
    "archestra.io/network-policy-allowed-domains": summarizeAnnotationList(
      policy.allowedDomains,
    ),
    "archestra.io/network-policy-allowed-cidrs": summarizeAnnotationList(
      policy.allowedCidrs,
    ),
    "archestra.io/network-policy-domain-enforcement": domainEnforcement,
  };
}

function summarizeAnnotationList(values: string[]): string {
  const maxItems = 50;
  if (values.length <= maxItems) return values.join(",");
  return `${values.slice(0, maxItems).join(",")},...and ${values.length - maxItems} more`;
}

function ciliumDomainRules(
  policy: NonNullable<EffectiveNetworkPolicy["policy"]>,
): Array<{ matchName?: string; matchPattern?: string }> {
  return networkPolicyDomains(policy).map((domain) =>
    domain.startsWith("*.") ? { matchPattern: domain } : { matchName: domain },
  );
}
