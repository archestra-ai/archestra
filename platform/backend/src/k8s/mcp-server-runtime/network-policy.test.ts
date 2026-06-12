import { describe, expect, test } from "@/test";
import type { EffectiveNetworkPolicy } from "@/types";
import {
  buildManagedAwsApplicationNetworkPolicy,
  buildManagedCiliumNetworkPolicy,
  buildManagedGkeFqdnNetworkPolicy,
  buildManagedNetworkPolicy,
  constructManagedNetworkPolicyName,
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
