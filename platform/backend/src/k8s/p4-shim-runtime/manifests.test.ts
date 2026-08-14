// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { describe, expect, test } from "@/test";
import {
  buildP4ShimDeployment,
  buildP4ShimNetworkPolicy,
  buildP4ShimService,
  buildP4ShimTokenSecret,
  P4_SHIM_CLIENT_LABEL,
  P4_SHIM_CONFIG_ANNOTATION,
  P4_SHIM_SCOPE_LABEL,
  P4_SHIM_TOKEN_ANNOTATION,
  p4ShimNames,
  p4ShimTokenDigest,
} from "./manifests";

// A scope is a connector id: one shim per connector.
const SCOPE = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const OTHER_SCOPE = "11112222-3333-4444-5555-666677778888";
const ORG = "aaaabbbb-cccc-4ddd-8eee-ffff00001111";
const FINGERPRINT = "0123456789abcdef0123456789abcdef";
const TOKEN = "1e5c0f4a8b7d6e3c2a190f8e7d6c5b4a";

function deployment(overrides: Record<string, unknown> = {}) {
  return buildP4ShimDeployment({
    scope: SCOPE,
    organizationId: ORG,
    image: "example/p4-shim:1.0.0",
    imagePullPolicy: "IfNotPresent",
    configFingerprint: FINGERPRINT,
    authToken: TOKEN,
    ...overrides,
  });
}

describe("p4ShimNames", () => {
  test("every resource of a scope is named for it, and distinctly per kind", () => {
    const names = p4ShimNames(SCOPE);
    expect(new Set(Object.values(names)).size).toBe(3);
    for (const name of Object.values(names)) {
      expect(name).toContain(SCOPE.slice(0, 8));
      // DNS label ceiling — a Service name over it is rejected by the API.
      expect(name.length).toBeLessThanOrEqual(63);
      expect(name).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    }
  });

  test("two scopes share no resource name", () => {
    const mine = Object.values(p4ShimNames(SCOPE));
    const theirs = Object.values(p4ShimNames(OTHER_SCOPE));
    expect(mine.some((name) => theirs.includes(name))).toBe(false);
  });
});

describe("buildP4ShimDeployment", () => {
  const built = deployment();
  const pod = built.spec?.template.spec;
  const container = pod?.containers[0];

  test("pod is hardened: non-root, read-only rootfs, no capabilities, no SA token", () => {
    expect(pod?.automountServiceAccountToken).toBe(false);
    expect(pod?.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 65534,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(container?.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
  });

  test("the p4 binary workspace is a pod-lifetime emptyDir, the token a read-only secret mount", () => {
    expect(pod?.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "work", emptyDir: expect.anything() }),
        expect.objectContaining({ name: "token", secret: expect.anything() }),
      ]),
    );
    expect(
      container?.volumeMounts?.find((m) => m.name === "token")?.readOnly,
    ).toBe(true);
  });

  test("mounts its own scope's token secret, never another scope's", () => {
    const secretName = pod?.volumes?.find((v) => v.name === "token")?.secret
      ?.secretName;
    expect(secretName).toBe(p4ShimNames(SCOPE).secret);
    expect(secretName).not.toBe(p4ShimNames(OTHER_SCOPE).secret);
  });

  test("runs at exactly one replica, and nothing about it is a duration", () => {
    // A connector that syncs Perforce permissions has a pod; one that does not
    // has no Deployment. There is no idle state to annotate, and no scaling.
    expect(built.spec?.replicas).toBe(1);
    expect(JSON.stringify(built.metadata?.annotations ?? {})).not.toMatch(
      /idle|last-used/,
    );
  });

  test("requests exactly what it limits, so the pod lands in Guaranteed QoS", () => {
    // The kubelet's eviction order is BestEffort, then Burstable, then
    // Guaranteed. This pod holds the provisioned `p4` binary and its login
    // ticket in an emptyDir, so an eviction mid-pass fails that pass and makes
    // the next one pay a full re-provision.
    const resources = pod?.containers?.[0]?.resources;
    expect(resources?.requests).toEqual(resources?.limits);
    expect(resources?.requests?.cpu).toBeTruthy();
    expect(resources?.requests?.memory).toBeTruthy();
  });

  test("carries the token digest on the POD TEMPLATE, never the token itself", () => {
    const digest =
      built.spec?.template?.metadata?.annotations?.[P4_SHIM_TOKEN_ANNOTATION];
    expect(digest).toBe(p4ShimTokenDigest(TOKEN));
    expect(JSON.stringify(built)).not.toContain(TOKEN);
  });

  test("reminting the token rolls the pod even when the configuration did not change", () => {
    // The pod reads its token once at boot. A Secret rewritten without a
    // template change leaves it Ready and authenticating against a token
    // nothing will hand it again — permanently, as nothing else restarts it.
    const reminted = deployment({
      authToken: "9f8e7d6c5b4a39281706f5e4d3c2b1a0",
    });
    expect(
      reminted.spec?.template?.metadata?.annotations?.[
        P4_SHIM_TOKEN_ANNOTATION
      ],
    ).not.toBe(
      built.spec?.template?.metadata?.annotations?.[P4_SHIM_TOKEN_ANNOTATION],
    );
  });

  // Rotation must not leave the retired pod serving. The default strategy at
  // one replica is maxSurge 1 / maxUnavailable 0, which keeps the OLD pod
  // Ready — and answering the Service with the old /work and old token — until
  // the new one passes readiness.
  test("replaces the pod outright rather than rolling, so two never serve at once", () => {
    expect(built.spec?.strategy).toEqual({ type: "Recreate" });
  });

  test("its selector matches only its own connector's pods", () => {
    expect(built.spec?.selector.matchLabels?.[P4_SHIM_SCOPE_LABEL]).toBe(SCOPE);
  });

  // The rotation contract: the fingerprint sits on the POD TEMPLATE, so a
  // settings change replaces the pod (and its /work) instead of annotating a
  // Deployment whose pod keeps running with the old ticket and binary.
  test("the config fingerprint is on the pod template, not just the Deployment", () => {
    expect(
      built.spec?.template.metadata?.annotations?.[P4_SHIM_CONFIG_ANNOTATION],
    ).toBe(FINGERPRINT);
  });

  test("a changed fingerprint changes the pod template", () => {
    const rotated = deployment({
      configFingerprint: "ffffffffffffffffffffffffffffffff",
    });
    expect(
      JSON.stringify(rotated.spec?.template.metadata?.annotations),
    ).not.toBe(JSON.stringify(built.spec?.template.metadata?.annotations));
    // Same Deployment and selector — Kubernetes rolls the pod rather than
    // orphaning the workload.
    expect(rotated.metadata?.name).toBe(built.metadata?.name);
    expect(JSON.stringify(rotated.spec?.selector)).toBe(
      JSON.stringify(built.spec?.selector),
    );
  });

  test("the selector omits mutable metadata, which Kubernetes forbids changing", () => {
    expect(Object.keys(built.spec?.selector.matchLabels ?? {})).not.toContain(
      "archestra.io/p4-shim-organization",
    );
  });
});

describe("buildP4ShimService", () => {
  test("ClusterIP in-cluster, NodePort for out-of-cluster dev", () => {
    expect(
      buildP4ShimService({ scope: SCOPE, inCluster: true }).spec?.type,
    ).toBe("ClusterIP");
    expect(
      buildP4ShimService({ scope: SCOPE, inCluster: false }).spec?.type,
    ).toBe("NodePort");
  });

  test("selects only its own scope's pods", () => {
    const service = buildP4ShimService({ scope: SCOPE, inCluster: true });
    expect(service.spec?.selector?.[P4_SHIM_SCOPE_LABEL]).toBe(SCOPE);
  });
});

describe("buildP4ShimTokenSecret", () => {
  test("a connector's token lives under its own secret name", () => {
    const secret = buildP4ShimTokenSecret({
      scope: SCOPE,
      token: "abc",
      configFingerprint: FINGERPRINT,
    });
    expect(secret.metadata?.name).toBe(p4ShimNames(SCOPE).secret);
    expect(secret.stringData?.token).toBe("abc");
  });

  test("records the configuration it was minted for, so a change can retire it", () => {
    const secret = buildP4ShimTokenSecret({
      scope: SCOPE,
      token: "abc",
      configFingerprint: FINGERPRINT,
    });
    expect(secret.metadata?.annotations?.[P4_SHIM_CONFIG_ANNOTATION]).toBe(
      FINGERPRINT,
    );
  });
});

describe("buildP4ShimNetworkPolicy", () => {
  test("default-denies both directions and allows exactly the Perforce servers plus DNS", () => {
    const policy = buildP4ShimNetworkPolicy({
      scope: SCOPE,
      egressTargets: [
        { ips: ["203.0.113.7", "2001:db8::1"], port: 1666 },
        { ips: ["198.51.100.2"], port: 2666 },
      ],
      restrictIngressToClientPods: true,
    });
    expect(policy.spec?.policyTypes).toEqual(["Ingress", "Egress"]);

    const egress = policy.spec?.egress ?? [];
    // One rule per server + the DNS rule, nothing else.
    expect(egress).toHaveLength(3);
    expect(egress[0].to).toEqual([
      { ipBlock: { cidr: "203.0.113.7/32" } },
      { ipBlock: { cidr: "2001:db8::1/128" } },
    ]);
    expect(egress[0].ports?.[0]).toMatchObject({ port: 1666 });
    expect(egress[1].to).toEqual([{ ipBlock: { cidr: "198.51.100.2/32" } }]);
    const dns = egress[2];
    expect(dns.to?.[0].podSelector?.matchLabels).toEqual({
      "k8s-app": "kube-dns",
    });
    expect(dns.ports?.map((p) => p.protocol)).toEqual(["UDP", "TCP"]);
  });

  test("applies to one connector's pods only, so its egress never governs another's", () => {
    const policy = buildP4ShimNetworkPolicy({
      scope: SCOPE,
      egressTargets: [],
      restrictIngressToClientPods: true,
    });
    expect(policy.spec?.podSelector?.matchLabels?.[P4_SHIM_SCOPE_LABEL]).toBe(
      SCOPE,
    );
    expect(policy.metadata?.name).toBe(p4ShimNames(SCOPE).networkPolicy);
  });

  test("in-cluster ingress is restricted to labelled platform pods", () => {
    const policy = buildP4ShimNetworkPolicy({
      scope: SCOPE,
      egressTargets: [],
      restrictIngressToClientPods: true,
    });
    expect(
      policy.spec?.ingress?.[0]._from?.[0].podSelector?.matchLabels,
    ).toEqual({ [P4_SHIM_CLIENT_LABEL]: "true" });
  });

  test("out-of-cluster ingress admits the node addresses and nothing else", () => {
    const policy = buildP4ShimNetworkPolicy({
      scope: SCOPE,
      egressTargets: [],
      restrictIngressToClientPods: false,
      clientAddresses: ["172.18.0.2", "fd00::2"],
    });
    expect(policy.spec?.ingress?.[0]._from).toEqual([
      { ipBlock: { cidr: "172.18.0.2/32" } },
      { ipBlock: { cidr: "fd00::2/128" } },
    ]);
    expect(policy.spec?.ingress?.[0].ports?.[0]).toMatchObject({ port: 8080 });
  });

  test("out-of-cluster with no known client address admits nobody, rather than everybody", () => {
    const policy = buildP4ShimNetworkPolicy({
      scope: SCOPE,
      egressTargets: [],
      restrictIngressToClientPods: false,
      clientAddresses: [],
    });
    // `spec.ingress: []` is the canonical deny-all. A rule carrying an empty
    // `from` is NOT a deny — measured on kindnet, it admits everyone, exactly
    // like omitting `from`. That is the bug this pins shut.
    expect(policy.spec?.ingress).toEqual([]);
  });

  test("an unresolvable server contributes no egress (fail-closed, not fail-open)", () => {
    const policy = buildP4ShimNetworkPolicy({
      scope: SCOPE,
      egressTargets: [{ ips: [], port: 1666 }],
      restrictIngressToClientPods: true,
    });
    // Only the DNS rule remains.
    expect(policy.spec?.egress).toHaveLength(1);
  });
});
