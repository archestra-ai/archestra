import { describe, expect, it } from "vitest";
import type {
  EffectiveNetworkPolicy,
  K8sNetworkPolicyCapabilities,
  NetworkPolicy,
} from "@/types";
import {
  buildDaggerEgressPolicies,
  daggerEnginePodLabels,
} from "./network-policy";

const ENV_ID = "11111111-1111-1111-1111-111111111111";

// Loose view over the heterogeneous policy manifests (k8s NetworkPolicy + the
// CRD variants) for field-level assertions without `any`.
type PolicyManifest = {
  apiVersion?: string;
  spec: {
    [key: string]: unknown;
    podSelector?: { matchLabels?: unknown };
    endpointSelector?: { matchLabels?: unknown };
  };
};

function effective(policy: NetworkPolicy | null): EffectiveNetworkPolicy {
  return { source: policy ? "environment" : "built_in", policy };
}

function caps(
  overrides: Partial<K8sNetworkPolicyCapabilities>,
): K8sNetworkPolicyCapabilities {
  return {
    kubernetesNetworkPolicy: true,
    ciliumNetworkPolicy: false,
    gkeFqdnNetworkPolicy: false,
    awsApplicationNetworkPolicy: false,
    provider: "kubernetes",
    supportsFqdn: false,
    supportsHttpMethods: false,
    message: null,
    ...overrides,
  };
}

const restrictedCidrs: NetworkPolicy = {
  egressMode: "restricted",
  domainPreset: "none",
  allowedDomains: [],
  allowedCidrs: ["203.0.113.0/24", "198.51.100.7/32"],
};

const restrictedDomains: NetworkPolicy = {
  egressMode: "restricted",
  domainPreset: "none",
  allowedDomains: ["registry.npmjs.org", "*.pypi.org"],
  allowedCidrs: [],
};

describe("buildDaggerEgressPolicies (reuses MCP machinery for the dagger engine)", () => {
  it("applies an open-egress floor for an unrestricted environment", () => {
    const policies = buildDaggerEgressPolicies({
      environmentId: ENV_ID,
      effectivePolicy: effective({
        egressMode: "unrestricted",
        domainPreset: "none",
        allowedDomains: [],
        allowedCidrs: [],
      }),
      capabilities: caps({}),
    });
    expect(policies).toHaveLength(1);
    expect(policies[0].kind).toBe("NetworkPolicy");
    const np = policies[0].object as unknown as PolicyManifest;

    // scoped to the per-environment dagger engine pod
    expect(np.spec.podSelector?.matchLabels).toEqual(
      daggerEnginePodLabels(ENV_ID),
    );
    expect(np.spec.policyTypes).toEqual(["Egress"]);

    const egress = np.spec.egress as Array<{
      to?: Array<{ ipBlock?: { cidr?: string; except?: string[] } }>;
      ports?: unknown;
    }>;
    const json = JSON.stringify(egress);
    // private ranges blocked
    expect(json).toContain("169.254.0.0/16");
    expect(json).toContain("10.0.0.0/8");
    expect(json).toContain("fc00::/7");

    // DNS allowed to the kube-dns pods by selector (DNAT-proof under kube-proxy),
    // not the resolver ClusterIP, on :53
    const dns = egress.find((r) => r.ports !== undefined);
    expect(dns).toBeDefined();
    const dnsJson = JSON.stringify(dns);
    expect(dnsJson).toContain("k8s-app");
    expect(dnsJson).toContain("kube-system");

    // the public IPv4 rule allows ALL ports (no port cap)
    const publicV4 = egress.find((r) =>
      r.to?.some((t) => t.ipBlock?.cidr === "0.0.0.0/0"),
    );
    expect(publicV4).toBeDefined();
    expect(publicV4?.ports).toBeUndefined();
    expect(publicV4?.to?.[0].ipBlock?.except).toContain("169.254.0.0/16");
  });

  it("applies the open-egress floor when the environment has no policy (built-in)", () => {
    const policies = buildDaggerEgressPolicies({
      environmentId: ENV_ID,
      effectivePolicy: effective(null),
      capabilities: caps({}),
    });
    expect(policies).toHaveLength(1);
    expect(policies[0].kind).toBe("NetworkPolicy");
    const np = policies[0].object as unknown as PolicyManifest;
    expect(np.spec.podSelector?.matchLabels).toEqual(
      daggerEnginePodLabels(ENV_ID),
    );
    // private ranges blocked in the built-in default too
    expect(JSON.stringify(np.spec.egress)).toContain("169.254.0.0/16");
  });

  it("emits a deny-all-egress NetworkPolicy for egressMode=off", () => {
    const policies = buildDaggerEgressPolicies({
      environmentId: ENV_ID,
      effectivePolicy: effective({
        egressMode: "off",
        domainPreset: "none",
        allowedDomains: [],
        allowedCidrs: [],
      }),
      capabilities: caps({}),
    });
    expect(policies).toHaveLength(1);
    expect(policies[0].kind).toBe("NetworkPolicy");
    const np = policies[0].object as unknown as PolicyManifest;
    expect(np.spec.policyTypes).toEqual(["Egress"]);
    // "off" => no egress rules => default-deny egress
    expect(np.spec.egress).toEqual([]);
  });

  it("targets the dagger ENGINE pod (not mcp-server) and reflects the env's CIDRs", () => {
    const policies = buildDaggerEgressPolicies({
      environmentId: ENV_ID,
      effectivePolicy: effective(restrictedCidrs),
      capabilities: caps({}),
    });
    expect(policies).toHaveLength(1);
    expect(policies[0].kind).toBe("NetworkPolicy");
    const np = policies[0].object as unknown as PolicyManifest;

    // scoped to the per-environment dagger engine pod
    expect(np.spec.podSelector?.matchLabels).toEqual(
      daggerEnginePodLabels(ENV_ID),
    );

    // the environment's allowed CIDRs are present as ipBlock egress rules
    const json = JSON.stringify(np.spec.egress);
    expect(json).toContain("203.0.113.0/24");
    expect(json).toContain("198.51.100.7/32");
    // DNS is always allowed in restricted mode so name resolution still works
    expect(json).toContain("53");
  });

  it("selects a CiliumNetworkPolicy for domain allow-lists on a Cilium cluster", () => {
    const policies = buildDaggerEgressPolicies({
      environmentId: ENV_ID,
      effectivePolicy: effective(restrictedDomains),
      capabilities: caps({ ciliumNetworkPolicy: true, supportsFqdn: true }),
    });
    expect(policies).toHaveLength(1);
    expect(policies[0].kind).toBe("CiliumNetworkPolicy");
    const cnp = policies[0].object as unknown as PolicyManifest;
    expect(cnp.apiVersion).toBe("cilium.io/v2");
    expect(cnp.spec.endpointSelector?.matchLabels).toEqual(
      daggerEnginePodLabels(ENV_ID),
    );
    // the allow-listed domains are carried as FQDN rules
    const json = JSON.stringify(cnp.spec.egress);
    expect(json).toContain("registry.npmjs.org");
    expect(json).toContain("pypi.org");
  });

  it("selects GKE FQDNNetworkPolicy (+ a NetworkPolicy for CIDRs) on a GKE Dataplane-V2 cluster", () => {
    const policies = buildDaggerEgressPolicies({
      environmentId: ENV_ID,
      effectivePolicy: effective({
        ...restrictedDomains,
        allowedCidrs: ["203.0.113.0/24"],
      }),
      capabilities: caps({
        gkeFqdnNetworkPolicy: true,
        supportsFqdn: true,
        provider: "gke-fqdn",
      }),
    });
    const kinds = policies.map((p) => p.kind).sort();
    expect(kinds).toEqual(["FQDNNetworkPolicy", "NetworkPolicy"]);
    const fqdnPolicy = policies.find((p) => p.kind === "FQDNNetworkPolicy");
    expect(fqdnPolicy).toBeDefined();
    const fqdn = fqdnPolicy?.object as unknown as PolicyManifest;
    expect(fqdn.apiVersion).toBe("networking.gke.io/v1alpha1");
    expect(JSON.stringify(fqdn)).toContain("registry.npmjs.org");
  });

  it("selects AWS ApplicationNetworkPolicy on an EKS Auto Mode cluster", () => {
    const policies = buildDaggerEgressPolicies({
      environmentId: ENV_ID,
      effectivePolicy: effective(restrictedDomains),
      capabilities: caps({
        awsApplicationNetworkPolicy: true,
        supportsFqdn: true,
        provider: "aws-application-network-policy",
      }),
    });
    expect(policies).toHaveLength(1);
    expect(policies[0].kind).toBe("ApplicationNetworkPolicy");
    expect((policies[0].object as unknown as PolicyManifest).apiVersion).toBe(
      "networking.k8s.aws/v1alpha1",
    );
  });
});
