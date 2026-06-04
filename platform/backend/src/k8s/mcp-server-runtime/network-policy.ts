import type * as k8s from "@kubernetes/client-node";
import { sanitizeMetadataLabels } from "@/k8s/shared";
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
      annotations: buildPolicyAnnotations(params.effectivePolicy, "active"),
    },
    spec: {
      podSelector: {
        matchLabels: params.podSelectorLabels,
      },
      policyTypes: ["Egress"],
      egress: buildAwsApplicationEgressRules(policy),
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
): Array<Record<string, unknown>> {
  if (policy.egressMode === "off") {
    return [];
  }

  if (policy.egressMode !== "restricted") {
    return [];
  }

  return [
    buildAwsDnsEgressRule(),
    ...policy.allowedCidrs.map((cidr) => ({
      to: [{ ipBlock: { cidr } }],
    })),
    ...networkPolicyDomains(policy).map((domain) => ({
      to: [{ domainNames: [domain] }],
    })),
  ];
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

function buildAwsDnsEgressRule(): Record<string, unknown> {
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
      { protocol: "UDP", port: 53 },
      { protocol: "TCP", port: 53 },
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

function networkPolicyDomains(
  policy: NonNullable<EffectiveNetworkPolicy["policy"]>,
): string[] {
  return [...presetDomains(policy.domainPreset), ...policy.allowedDomains];
}

/**
 * Preset allowlists are inspired by OpenAI Codex cloud internet access
 * presets and Claude Code web's trusted network access defaults.
 */
const COMMON_DEPENDENCY_DOMAINS = Object.freeze([
  "alpinelinux.org",
  "archlinux.org",
  "bitbucket.org",
  "centos.org",
  "crates.io",
  "debian.org",
  "docker.com",
  "docker.io",
  "*.docker.io",
  "fedoraproject.org",
  "files.pythonhosted.org",
  "gcr.io",
  "ghcr.io",
  "github.com",
  "*.github.com",
  "githubusercontent.com",
  "*.githubusercontent.com",
  "gitlab.com",
  "golang.org",
  "goproxy.io",
  "gradle.org",
  "hex.pm",
  "maven.org",
  "mcr.microsoft.com",
  "nodejs.org",
  "npmjs.com",
  "npmjs.org",
  "nuget.org",
  "packagecloud.io",
  "packages.microsoft.com",
  "packagist.org",
  "pkg.go.dev",
  "production.cloudflare.docker.com",
  "pub.dev",
  "pypa.io",
  "pypi.org",
  "pypi.python.org",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "quay.io",
  "registry-1.docker.io",
  "registry.npmjs.org",
  "ruby-lang.org",
  "rubygems.org",
  "rustup.rs",
  "ubuntu.com",
  "yarnpkg.com",
]);

const PACKAGE_MANAGER_DOMAINS = Object.freeze([
  "crates.io",
  "files.pythonhosted.org",
  "gcr.io",
  "ghcr.io",
  "golang.org",
  "goproxy.io",
  "gradle.org",
  "hex.pm",
  "maven.org",
  "mcr.microsoft.com",
  "npmjs.com",
  "npmjs.org",
  "nuget.org",
  "packagist.org",
  "pkg.go.dev",
  "registry-1.docker.io",
  "registry.npmjs.org",
  "rubygems.org",
  "rustup.rs",
  "pub.dev",
  "pypi.org",
  "pypi.python.org",
  "pythonhosted.org",
  "quay.io",
  "docker.io",
  "*.docker.io",
  "production.cloudflare.docker.com",
  "yarnpkg.com",
]);

function presetDomains(
  preset: NonNullable<EffectiveNetworkPolicy["policy"]>["domainPreset"],
): readonly string[] {
  switch (preset) {
    case "common_dependencies":
      return COMMON_DEPENDENCY_DOMAINS;
    case "package_managers":
      return PACKAGE_MANAGER_DOMAINS;
    case "none":
      return [];
  }
}
