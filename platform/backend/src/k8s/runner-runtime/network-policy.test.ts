import type * as k8s from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import type { K8sNetworkPolicyCapabilities } from "@/types";
import type { KubernetesRunnerLaunchSpec } from "./manifests";
import { RUNNER_TASK_LABEL } from "./naming";
import { buildRunnerEnvironmentEgressPolicies } from "./network-policy";

const SPEC: KubernetesRunnerLaunchSpec = {
  taskId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  runnerId: "11111111-2222-3333-4444-555555555555",
  frozenName: "runner-deploy-app-11111111",
  namespace: "archestra-dev",
  image: "registry.example.test/agent-archestra:latest",
  command: null,
  privileged: false,
  resources: null,
  env: {},
  secretEnv: {},
  activeDeadlineSeconds: 3600,
  ephemeralStorageLimit: "10Gi",
  imagePullSecrets: [],
  ownerReferences: undefined,
  effectiveNetworkPolicy: { source: "built_in", policy: null },
  inputFileCount: 0,
};

const CAPABILITIES: K8sNetworkPolicyCapabilities = {
  kubernetesNetworkPolicy: true,
  ciliumNetworkPolicy: false,
  gkeFqdnNetworkPolicy: false,
  awsApplicationNetworkPolicy: false,
  provider: "kubernetes",
  supportsFqdn: false,
  supportsHttpMethods: false,
  message: null,
  enforcementSource: "probe",
  enforcementStatus: "verified-enforced",
  probe: "enforced",
  probedAt: "2026-08-29T00:00:00.000Z",
};

describe("buildRunnerEnvironmentEgressPolicies", () => {
  it("gives the built-in Environment public egress without private-network access", () => {
    const [policy] = buildRunnerEnvironmentEgressPolicies({
      spec: SPEC,
      capabilities: CAPABILITIES,
      clusterDnsIps: ["10.96.0.10"],
    });
    expect(policy?.kind).toBe("NetworkPolicy");
    const object = policy?.object as k8s.V1NetworkPolicy;
    const publicRule = object.spec?.egress?.find((rule) =>
      rule.to?.some((target) => target.ipBlock?.cidr === "0.0.0.0/0"),
    );

    expect(object.metadata?.name).toBe("runner-deploy-app-11111111-egress");
    expect(object.metadata?.namespace).toBe("archestra-dev");
    expect(object.spec?.podSelector?.matchLabels).toEqual({
      [RUNNER_TASK_LABEL]: SPEC.taskId,
    });
    expect(publicRule?.to?.[0]?.ipBlock?.except).toContain("10.0.0.0/8");
    expect(
      object.spec?.egress?.some((rule) =>
        rule.to?.some((target) => target.ipBlock?.cidr === "10.96.0.10/32"),
      ),
    ).toBe(true);
  });

  it("adds explicit CIDR exceptions to Public internet", () => {
    const [policy] = buildRunnerEnvironmentEgressPolicies({
      spec: {
        ...SPEC,
        effectiveNetworkPolicy: {
          source: "environment",
          policy: {
            egressMode: "unrestricted",
            domainPreset: "none",
            allowedDomains: [],
            allowedCidrs: ["10.20.0.0/16"],
          },
        },
      },
      capabilities: CAPABILITIES,
    });
    const egress = (policy?.object as k8s.V1NetworkPolicy).spec?.egress ?? [];
    expect(egress).toContainEqual({
      to: [{ ipBlock: { cidr: "10.20.0.0/16" } }],
    });
  });

  it("uses Cilium for a domain allowlist when the cluster supports it", () => {
    const policies = buildRunnerEnvironmentEgressPolicies({
      spec: restrictedSpec(),
      capabilities: {
        ...CAPABILITIES,
        ciliumNetworkPolicy: true,
        provider: "cilium",
        supportsFqdn: true,
      },
    });

    expect(policies.map((policy) => policy.kind)).toEqual([
      "CiliumNetworkPolicy",
    ]);
    expect(policies[0]?.object).toMatchObject({
      metadata: { namespace: "archestra-dev" },
      spec: {
        endpointSelector: {
          matchLabels: { [RUNNER_TASK_LABEL]: SPEC.taskId },
        },
        egress: expect.arrayContaining([
          { toFQDNs: [{ matchName: "api.example.test" }] },
        ]),
      },
    });
  });

  it("combines GKE FQDN and standard CIDR policies", () => {
    const policies = buildRunnerEnvironmentEgressPolicies({
      spec: restrictedSpec(),
      capabilities: {
        ...CAPABILITIES,
        gkeFqdnNetworkPolicy: true,
        provider: "gke-fqdn",
        supportsFqdn: true,
      },
    });

    expect(policies.map((policy) => policy.kind)).toEqual([
      "FQDNNetworkPolicy",
      "NetworkPolicy",
    ]);
    expect(policies[0]?.object).toMatchObject({
      spec: { egress: [{ matches: [{ name: "api.example.test" }] }] },
    });
    const standard = policies[1]?.object as k8s.V1NetworkPolicy;
    expect(
      standard.spec?.egress?.some((rule) =>
        rule.to?.some((target) => target.ipBlock?.cidr === "203.0.113.0/24"),
      ),
    ).toBe(true);
  });

  it("uses AWS ApplicationNetworkPolicy for restricted, blocked, and built-in egress", () => {
    const capabilities: K8sNetworkPolicyCapabilities = {
      ...CAPABILITIES,
      awsApplicationNetworkPolicy: true,
      provider: "aws-application-network-policy",
      supportsFqdn: true,
      enforcementSource: "api-discovery",
      enforcementStatus: "unknown",
      probe: "absent",
    };

    const restricted = buildRunnerEnvironmentEgressPolicies({
      spec: restrictedSpec(),
      capabilities,
      clusterDnsIps: ["172.20.0.10"],
    });
    const builtIn = buildRunnerEnvironmentEgressPolicies({
      spec: SPEC,
      capabilities,
      clusterDnsIps: ["172.20.0.10"],
    });
    const blocked = buildRunnerEnvironmentEgressPolicies({
      spec: {
        ...SPEC,
        effectiveNetworkPolicy: {
          source: "environment",
          policy: {
            egressMode: "off",
            domainPreset: "none",
            allowedDomains: [],
            allowedCidrs: [],
          },
        },
      },
      capabilities,
      clusterDnsIps: ["172.20.0.10"],
    });

    expect(restricted.map((policy) => policy.kind)).toEqual([
      "ApplicationNetworkPolicy",
    ]);
    expect(restricted[0]?.object).toMatchObject({
      metadata: {
        annotations: {
          "archestra.io/network-policy-cluster-dns": "172.20.0.10",
        },
      },
      spec: {
        egress: expect.arrayContaining([
          { to: [{ domainNames: ["api.example.test"] }] },
        ]),
      },
    });
    expect(builtIn.map((policy) => policy.kind)).toEqual([
      "ApplicationNetworkPolicy",
    ]);
    expect(blocked.map((policy) => policy.kind)).toEqual([
      "ApplicationNetworkPolicy",
    ]);
    expect(blocked[0]?.object).toMatchObject({ spec: { egress: [] } });
  });

  it("falls back to a standard CIDR policy without an FQDN provider", () => {
    const policies = buildRunnerEnvironmentEgressPolicies({
      spec: restrictedSpec(),
      capabilities: CAPABILITIES,
    });

    expect(policies.map((policy) => policy.kind)).toEqual(["NetworkPolicy"]);
    expect(
      (policies[0]?.object as k8s.V1NetworkPolicy).metadata?.annotations?.[
        "archestra.io/network-policy-domain-enforcement"
      ],
    ).toBe("requires-fqdn-policy-provider");
  });
});

function restrictedSpec(): KubernetesRunnerLaunchSpec {
  return {
    ...SPEC,
    effectiveNetworkPolicy: {
      source: "environment",
      policy: {
        egressMode: "restricted",
        domainPreset: "none",
        allowedDomains: ["api.example.test"],
        allowedCidrs: ["203.0.113.0/24"],
      },
    },
  };
}
