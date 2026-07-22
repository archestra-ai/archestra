import { sanitizeMetadataLabels } from "@/k8s/shared";
import { describe, expect, test } from "@/test";
import type { EffectiveNetworkPolicy } from "@/types";
import {
  buildEgressBaselineAwsApplicationNetworkPolicy,
  buildEgressBaselineNetworkPolicy,
  buildManagedAwsApplicationNetworkPolicy,
  buildManagedCiliumNetworkPolicy,
  buildManagedGkeFqdnNetworkPolicy,
  buildManagedNetworkPolicy,
  buildUnrestrictedFloorAwsApplicationNetworkPolicy,
  buildUnrestrictedFloorPolicy,
  constructManagedNetworkPolicyName,
  isAwsApplicationNetworkPolicyProvider,
  shouldManageK8sNetworkPolicy,
  shouldUseAwsApplicationNetworkPolicy,
  shouldUseCiliumNetworkPolicy,
  shouldUseGkeFqdnNetworkPolicy,
} from "./network-policy";

describe("managed MCP Kubernetes NetworkPolicy", () => {
  test("builds a deny-all egress policy for egress off", () => {
    const manifest = buildManagedNetworkPolicy({
      name: "mcp-egress-test",
      podSelectorLabels: {
        app: "mcp-server",
        "mcp-server-id": "server-id",
      },
      effectivePolicy: makeEffectivePolicy({ egressMode: "off" }),
    });

    expect(manifest).toMatchObject({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: {
        name: "mcp-egress-test",
        annotations: {
          "archestra.io/network-policy-egress-mode": "off",
          "archestra.io/network-policy-domain-enforcement": "ip-only",
        },
      },
      spec: {
        podSelector: {
          matchLabels: {
            app: "mcp-server",
            "mcp-server-id": "server-id",
          },
        },
        policyTypes: ["Egress"],
        egress: [],
      },
    });
  });

  test("builds a restricted Kubernetes policy with DNS and CIDR egress", () => {
    const manifest = buildManagedNetworkPolicy({
      name: "mcp-egress-test",
      podSelectorLabels: {
        app: "mcp-server",
        "mcp-server-id": "server-id",
      },
      effectivePolicy: makeEffectivePolicy({
        egressMode: "restricted",
        allowedDomains: ["registry.npmjs.org"],
        allowedCidrs: ["203.0.113.0/24"],
      }),
    });

    expect(manifest.spec?.egress).toEqual([
      {
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
      },
      {
        to: [{ ipBlock: { cidr: "203.0.113.0/24" } }],
      },
    ]);
    expect(manifest.metadata?.annotations).toMatchObject({
      "archestra.io/network-policy-allowed-domains": "registry.npmjs.org",
      "archestra.io/network-policy-allowed-cidrs": "203.0.113.0/24",
      "archestra.io/network-policy-domain-enforcement":
        "requires-fqdn-policy-provider",
    });
  });

  test("summarizes large annotation lists", () => {
    const domains = Array.from({ length: 52 }, (_, i) => `d${i}.example.com`);
    const cidrs = Array.from({ length: 52 }, (_, i) => `203.0.${i}.0/24`);
    const manifest = buildManagedNetworkPolicy({
      name: "mcp-egress-test",
      podSelectorLabels: {
        app: "mcp-server",
        "mcp-server-id": "server-id",
      },
      effectivePolicy: makeEffectivePolicy({
        egressMode: "restricted",
        allowedDomains: domains,
        allowedCidrs: cidrs,
      }),
    });

    expect(
      manifest.metadata?.annotations?.[
        "archestra.io/network-policy-allowed-domains"
      ],
    ).toContain("...and 2 more");
    expect(
      manifest.metadata?.annotations?.[
        "archestra.io/network-policy-allowed-cidrs"
      ],
    ).toContain("...and 2 more");
  });

  test("builds a Cilium policy with FQDN and CIDR egress", () => {
    const manifest = buildManagedCiliumNetworkPolicy({
      name: "mcp-egress-test",
      podSelectorLabels: {
        app: "mcp-server",
        "mcp-server-id": "server-id",
      },
      effectivePolicy: makeEffectivePolicy({
        egressMode: "restricted",
        domainPreset: "package_managers",
        allowedDomains: ["api.example.com", "*.example.org"],
        allowedCidrs: ["203.0.113.0/24"],
      }),
    });

    expect(manifest).toMatchObject({
      apiVersion: "cilium.io/v2",
      kind: "CiliumNetworkPolicy",
      metadata: {
        annotations: {
          "archestra.io/network-policy-domain-enforcement": "active",
        },
      },
      spec: {
        endpointSelector: {
          matchLabels: {
            app: "mcp-server",
            "mcp-server-id": "server-id",
          },
        },
        egress: [
          {
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
          },
          {
            toCIDRSet: [{ cidr: "203.0.113.0/24" }],
          },
          {
            toFQDNs: expect.arrayContaining([
              { matchName: "registry.npmjs.org" },
              { matchName: "api.example.com" },
              { matchPattern: "*.example.org" },
            ]),
          },
        ],
      },
    });
  });

  test("builds a GKE FQDN policy with exact and wildcard domains", () => {
    const manifest = buildManagedGkeFqdnNetworkPolicy({
      name: "mcp-egress-test",
      podSelectorLabels: {
        app: "mcp-server",
        "mcp-server-id": "server-id",
      },
      effectivePolicy: makeEffectivePolicy({
        egressMode: "restricted",
        allowedDomains: ["api.example.com", "*.example.org"],
      }),
    });

    expect(manifest).toMatchObject({
      apiVersion: "networking.gke.io/v1alpha1",
      kind: "FQDNNetworkPolicy",
      spec: {
        podSelector: {
          matchLabels: {
            app: "mcp-server",
            "mcp-server-id": "server-id",
          },
        },
        egress: [
          {
            matches: [
              { name: "api.example.com" },
              { pattern: "*.example.org" },
            ],
          },
        ],
      },
    });
  });

  test("rejects a GKE FQDN policy without domain rules", () => {
    expect(() =>
      buildManagedGkeFqdnNetworkPolicy({
        name: "mcp-egress-test",
        podSelectorLabels: {
          app: "mcp-server",
          "mcp-server-id": "server-id",
        },
        effectivePolicy: makeEffectivePolicy({
          egressMode: "restricted",
          allowedDomains: [],
          domainPreset: "none",
        }),
      }),
    ).toThrow("Cannot build FQDNNetworkPolicy with empty domain list");
  });

  test("builds an AWS ApplicationNetworkPolicy with DNS bootstrap, FQDN and CIDR egress", () => {
    const manifest = buildManagedAwsApplicationNetworkPolicy({
      name: "mcp-egress-test",
      podSelectorLabels: {
        app: "mcp-server",
        "mcp-server-id": "server-id",
      },
      effectivePolicy: makeEffectivePolicy({
        egressMode: "restricted",
        allowedDomains: ["api.example.com", "*.example.org"],
        allowedCidrs: ["203.0.113.0/24"],
      }),
      clusterDnsIps: ["172.20.0.10"],
    });

    expect(manifest).toMatchObject({
      apiVersion: "networking.k8s.aws/v1alpha1",
      kind: "ApplicationNetworkPolicy",
      metadata: {
        annotations: {
          "archestra.io/network-policy-cluster-dns": "172.20.0.10",
        },
      },
      spec: {
        podSelector: {
          matchLabels: {
            app: "mcp-server",
            "mcp-server-id": "server-id",
          },
        },
        policyTypes: ["Egress"],
        egress: [
          // ApplicationNetworkPolicy has no pod/namespace selector peers, so
          // DNS must be allowlisted by the cluster DNS ClusterIP — without it
          // the policy blocks all lookups and domainNames rules never match.
          {
            to: [{ ipBlock: { cidr: "172.20.0.10/32" } }],
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
            ],
          },
          {
            to: [{ ipBlock: { cidr: "203.0.113.0/24" } }],
          },
          {
            to: [{ domainNames: ["api.example.com", "*.example.org"] }],
          },
        ],
      },
    });
  });

  test("falls back to DNS egress anywhere when the cluster DNS IP is unknown", () => {
    const manifest = buildManagedAwsApplicationNetworkPolicy({
      name: "mcp-egress-test",
      podSelectorLabels: {
        app: "mcp-server",
        "mcp-server-id": "server-id",
      },
      effectivePolicy: makeEffectivePolicy({
        egressMode: "restricted",
        allowedDomains: ["api.example.com"],
      }),
      clusterDnsIps: [],
    });

    expect(manifest).toMatchObject({
      metadata: {
        annotations: {
          "archestra.io/network-policy-cluster-dns": "any",
        },
      },
      spec: {
        egress: [
          {
            to: [{ ipBlock: { cidr: "0.0.0.0/0" } }],
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
            ],
          },
          {
            to: [{ domainNames: ["api.example.com"] }],
          },
        ],
      },
    });
  });

  test("uses Cilium only when Cilium is available and domain rules exist", () => {
    const policy = makeEffectivePolicy({
      egressMode: "restricted",
      allowedDomains: ["api.example.com"],
    });

    expect(
      shouldUseCiliumNetworkPolicy({
        effectivePolicy: policy,
        capabilities: {
          kubernetesNetworkPolicy: true,
          ciliumNetworkPolicy: true,
          gkeFqdnNetworkPolicy: false,
          awsApplicationNetworkPolicy: false,
          provider: "cilium",
          supportsFqdn: true,
          supportsHttpMethods: false,
          message: null,
        },
      }),
    ).toBe(true);
    expect(
      shouldUseCiliumNetworkPolicy({
        effectivePolicy: policy,
        capabilities: {
          kubernetesNetworkPolicy: true,
          ciliumNetworkPolicy: false,
          gkeFqdnNetworkPolicy: false,
          awsApplicationNetworkPolicy: false,
          provider: "kubernetes",
          supportsFqdn: false,
          supportsHttpMethods: false,
          message: null,
        },
      }),
    ).toBe(false);
  });

  test("uses GKE FQDN policy when GKE is available and Cilium is not", () => {
    const policy = makeEffectivePolicy({
      egressMode: "restricted",
      allowedDomains: ["api.example.com"],
    });

    expect(
      shouldUseGkeFqdnNetworkPolicy({
        effectivePolicy: policy,
        capabilities: {
          kubernetesNetworkPolicy: true,
          ciliumNetworkPolicy: false,
          gkeFqdnNetworkPolicy: true,
          awsApplicationNetworkPolicy: false,
          provider: "gke-fqdn",
          supportsFqdn: true,
          supportsHttpMethods: false,
          message: null,
        },
      }),
    ).toBe(true);
    expect(
      shouldUseGkeFqdnNetworkPolicy({
        effectivePolicy: policy,
        capabilities: {
          kubernetesNetworkPolicy: true,
          ciliumNetworkPolicy: true,
          gkeFqdnNetworkPolicy: true,
          awsApplicationNetworkPolicy: false,
          provider: "cilium",
          supportsFqdn: true,
          supportsHttpMethods: false,
          message: null,
        },
      }),
    ).toBe(false);
  });

  test("uses AWS ApplicationNetworkPolicy when AWS FQDN support is available and higher-priority providers are not", () => {
    const policy = makeEffectivePolicy({
      egressMode: "restricted",
      allowedDomains: ["api.example.com"],
    });

    expect(
      shouldUseAwsApplicationNetworkPolicy({
        effectivePolicy: policy,
        capabilities: {
          kubernetesNetworkPolicy: true,
          ciliumNetworkPolicy: false,
          gkeFqdnNetworkPolicy: false,
          awsApplicationNetworkPolicy: true,
          provider: "aws-application-network-policy",
          supportsFqdn: true,
          supportsHttpMethods: false,
          message: null,
        },
      }),
    ).toBe(true);
    expect(
      shouldUseAwsApplicationNetworkPolicy({
        effectivePolicy: policy,
        capabilities: {
          kubernetesNetworkPolicy: true,
          ciliumNetworkPolicy: false,
          gkeFqdnNetworkPolicy: true,
          awsApplicationNetworkPolicy: true,
          provider: "gke-fqdn",
          supportsFqdn: true,
          supportsHttpMethods: false,
          message: null,
        },
      }),
    ).toBe(false);
  });

  test("uses AWS ApplicationNetworkPolicy for off too, since a plain NetworkPolicy is unenforced on AWS", () => {
    const capabilities = {
      kubernetesNetworkPolicy: true,
      ciliumNetworkPolicy: false,
      gkeFqdnNetworkPolicy: false,
      awsApplicationNetworkPolicy: true,
      provider: "aws-application-network-policy" as const,
      supportsFqdn: true,
      supportsHttpMethods: false,
      message: null,
    };
    expect(
      shouldUseAwsApplicationNetworkPolicy({
        effectivePolicy: makeEffectivePolicy({ egressMode: "off" }),
        capabilities,
      }),
    ).toBe(true);
    // unrestricted is handled by the floor branch, not this predicate.
    expect(
      shouldUseAwsApplicationNetworkPolicy({
        effectivePolicy: makeEffectivePolicy({ egressMode: "unrestricted" }),
        capabilities,
      }),
    ).toBe(false);
  });

  test("does not manage a Kubernetes NetworkPolicy for unrestricted or built-in policy", () => {
    expect(
      shouldManageK8sNetworkPolicy(makeEffectivePolicy({ egressMode: "off" })),
    ).toBe(true);
    expect(
      shouldManageK8sNetworkPolicy(
        makeEffectivePolicy({ egressMode: "restricted" }),
      ),
    ).toBe(true);
    expect(
      shouldManageK8sNetworkPolicy(
        makeEffectivePolicy({ egressMode: "unrestricted" }),
      ),
    ).toBe(false);
    expect(
      shouldManageK8sNetworkPolicy({ source: "built_in", policy: null }),
    ).toBe(false);
  });

  test("constructs a DNS-safe managed policy name", () => {
    expect(constructManagedNetworkPolicyName("mcp.Test.Server")).toBe(
      "mcp-egress-mcp-Test-Server".toLowerCase(),
    );
  });

  test("constructs a non-empty managed policy name for punctuation-only input", () => {
    expect(constructManagedNetworkPolicyName("...")).toBe("mcp-egress");
  });
});

describe("MCP egress floor and default-deny baseline builders", () => {
  const MANAGED_LABELS = {
    app: "mcp-server",
    "app.kubernetes.io/managed-by": "archestra",
    "archestra.io/resource": "mcp-network-policy",
  };
  const BASELINE_LABELS = {
    "app.kubernetes.io/managed-by": "archestra",
    "archestra.io/resource": "mcp-egress-baseline",
  };
  const podSelectorLabels = { app: "mcp-server", "mcp-server-id": "server-id" };

  const SELECTOR_DNS_RULE = {
    to: [
      {
        namespaceSelector: {
          matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
        },
        podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
      },
    ],
    ports: [
      { protocol: "UDP", port: 53 },
      { protocol: "TCP", port: 53 },
    ],
  };

  test("builds a plain NetworkPolicy floor: selector-based DNS + public egress, reserved ranges blocked", () => {
    const manifest = buildUnrestrictedFloorPolicy({
      name: "mcp-egress-test",
      podSelectorLabels,
      labels: MANAGED_LABELS,
    });

    expect(manifest).toMatchObject({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: {
        name: "mcp-egress-test",
        labels: sanitizeMetadataLabels(MANAGED_LABELS),
      },
      spec: {
        podSelector: { matchLabels: podSelectorLabels },
        policyTypes: ["Egress"],
        egress: [
          SELECTOR_DNS_RULE,
          {
            to: [
              {
                ipBlock: {
                  cidr: "0.0.0.0/0",
                  except: [
                    "10.0.0.0/8",
                    "172.16.0.0/12",
                    "192.168.0.0/16",
                    "169.254.0.0/16",
                    "100.64.0.0/10",
                    "127.0.0.0/8",
                    "0.0.0.0/8",
                    "168.63.129.16/32",
                  ],
                },
              },
            ],
          },
          {
            to: [
              {
                ipBlock: {
                  cidr: "::/0",
                  except: ["::1/128", "fc00::/7", "fe80::/10", "64:ff9b::/96"],
                },
              },
            ],
          },
        ],
      },
    });
    // DNS targets the kube-dns pods by label, not the resolver ClusterIP:
    // kube-proxy DNATs the ClusterIP to a pod IP the public rule would block.
    expect(manifest.spec?.egress?.[0]?.to?.[0]).not.toHaveProperty("ipBlock");
    expect(manifest.spec?.egress?.[1]).not.toHaveProperty("ports");
  });

  test("AWS ANP floor pins DNS to the cluster resolver IPs; the plain floor stays selector-based", () => {
    const clusterDnsIps = ["10.100.0.10", "fd00:ec2::10"];
    const anp = buildUnrestrictedFloorAwsApplicationNetworkPolicy({
      name: "mcp-egress-test",
      podSelectorLabels,
      labels: MANAGED_LABELS,
      clusterDnsIps,
    });
    const anpEgress = (anp.spec as { egress: Array<Record<string, unknown>> })
      .egress;

    // ApplicationNetworkPolicy cannot express a selector peer, so DNS is pinned to
    // the resolver IPs explicitly on :53 (family-aware CIDR).
    expect(anpEgress[0]).toEqual({
      to: [
        { ipBlock: { cidr: "10.100.0.10/32" } },
        { ipBlock: { cidr: "fd00:ec2::10/128" } },
      ],
      ports: [
        { protocol: "UDP", port: 53 },
        { protocol: "TCP", port: 53 },
      ],
    });

    // The plain floor ignores resolver IPs entirely and uses selector-based DNS.
    const plain = buildUnrestrictedFloorPolicy({
      name: "mcp-egress-test",
      podSelectorLabels,
      labels: MANAGED_LABELS,
    });
    expect(plain.spec?.egress?.[0]).toEqual(SELECTOR_DNS_RULE);

    // Both variants share the identical public-egress rules.
    expect(anpEgress.slice(1)).toEqual(plain.spec?.egress?.slice(1));
  });

  test("plain floor adds a resolver-IP DNS allow alongside the selector rule (NodeLocal DNSCache / custom DNS)", () => {
    const plain = buildUnrestrictedFloorPolicy({
      name: "mcp-egress-test",
      podSelectorLabels,
      labels: MANAGED_LABELS,
      clusterDnsIps: ["169.254.20.10", "fd00::10"],
    });

    // Selector rule first (DNAT-proof standard kube-dns path)...
    expect(plain.spec?.egress?.[0]).toEqual(SELECTOR_DNS_RULE);
    // ...then an explicit :53 allow to the resolved nameserver IPs, so a
    // link-local/private resolver the public rule would block stays reachable.
    expect(plain.spec?.egress?.[1]).toEqual({
      to: [
        { ipBlock: { cidr: "169.254.20.10/32" } },
        { ipBlock: { cidr: "fd00::10/128" } },
      ],
      ports: [
        { protocol: "UDP", port: 53 },
        { protocol: "TCP", port: 53 },
      ],
    });
    expect(plain.spec?.egress?.[2]?.to?.[0]?.ipBlock?.cidr).toBe("0.0.0.0/0");
    expect(plain.spec?.egress?.[3]?.to?.[0]?.ipBlock?.cidr).toBe("::/0");

    // With no resolved resolver IP the supplementary rule is omitted; the
    // selector rule alone covers the standard kube-dns case.
    const noResolver = buildUnrestrictedFloorPolicy({
      name: "mcp-egress-test",
      podSelectorLabels,
      labels: MANAGED_LABELS,
    });
    expect(noResolver.spec?.egress).toHaveLength(3);
    expect(noResolver.spec?.egress?.[0]).toEqual(SELECTOR_DNS_RULE);
  });

  test("AWS ANP floor falls back to any-IP :53 when the resolver is unknown", () => {
    const anp = buildUnrestrictedFloorAwsApplicationNetworkPolicy({
      name: "mcp-egress-test",
      podSelectorLabels,
      labels: MANAGED_LABELS,
    });

    expect(anp).toMatchObject({
      apiVersion: "networking.k8s.aws/v1alpha1",
      kind: "ApplicationNetworkPolicy",
      metadata: {
        name: "mcp-egress-test",
        labels: sanitizeMetadataLabels(MANAGED_LABELS),
      },
      spec: {
        podSelector: { matchLabels: podSelectorLabels },
        policyTypes: ["Egress"],
      },
    });
    // A ports-only rule is not honored by the ANP agent, so without a resolved
    // ClusterIP the DNS rule allows :53 to any IP rather than dropping lookups.
    expect(
      (anp.spec as { egress: Array<Record<string, unknown>> }).egress[0],
    ).toEqual({
      to: [{ ipBlock: { cidr: "0.0.0.0/0" } }],
      ports: [
        { protocol: "UDP", port: 53 },
        { protocol: "TCP", port: 53 },
      ],
    });
  });

  test("builds a plain default-deny baseline over all app=mcp-server pods", () => {
    expect(
      buildEgressBaselineNetworkPolicy({
        name: "mcp-server-egress-baseline",
        labels: BASELINE_LABELS,
      }),
    ).toMatchObject({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: {
        name: "mcp-server-egress-baseline",
        labels: sanitizeMetadataLabels(BASELINE_LABELS),
      },
      spec: {
        podSelector: { matchLabels: { app: "mcp-server" } },
        policyTypes: ["Egress"],
        egress: [],
      },
    });
  });

  test("builds an AWS ApplicationNetworkPolicy default-deny baseline", () => {
    expect(
      buildEgressBaselineAwsApplicationNetworkPolicy({
        name: "mcp-server-egress-baseline",
        labels: BASELINE_LABELS,
      }),
    ).toMatchObject({
      apiVersion: "networking.k8s.aws/v1alpha1",
      kind: "ApplicationNetworkPolicy",
      metadata: {
        name: "mcp-server-egress-baseline",
        labels: sanitizeMetadataLabels(BASELINE_LABELS),
      },
      spec: {
        podSelector: { matchLabels: { app: "mcp-server" } },
        policyTypes: ["Egress"],
        egress: [],
      },
    });
  });

  test("isAwsApplicationNetworkPolicyProvider only matches the AWS provider", () => {
    const caps = (provider: string) =>
      ({ provider }) as unknown as Parameters<
        typeof isAwsApplicationNetworkPolicyProvider
      >[0];
    expect(
      isAwsApplicationNetworkPolicyProvider(
        caps("aws-application-network-policy"),
      ),
    ).toBe(true);
    expect(isAwsApplicationNetworkPolicyProvider(caps("cilium"))).toBe(false);
    expect(isAwsApplicationNetworkPolicyProvider(caps("kubernetes"))).toBe(
      false,
    );
    expect(isAwsApplicationNetworkPolicyProvider(caps("none"))).toBe(false);
    expect(isAwsApplicationNetworkPolicyProvider(null)).toBe(false);
  });
});

function makeEffectivePolicy(
  overrides: Partial<NonNullable<EffectiveNetworkPolicy["policy"]>>,
): EffectiveNetworkPolicy {
  return {
    source: "environment",
    policy: {
      egressMode: "restricted",
      domainPreset: "none",
      allowedDomains: [],
      allowedCidrs: [],
      ...overrides,
    },
  };
}
