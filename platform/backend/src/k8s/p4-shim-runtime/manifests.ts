// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { createHash } from "node:crypto";
import type * as k8s from "@kubernetes/client-node";

/**
 * Pure manifest builders for the p4 shim — the per-tenant pod that executes
 * allowlisted Perforce CLI commands for knowledge-base permission sync
 * (`p4_shim_docker_image/`).
 *
 * **Tenancy.** One shim per CONNECTOR, never one per installation and never
 * one shared across a tenant's connectors. Every resource — Deployment,
 * Service, Secret, NetworkPolicy — is named and labelled for that connector,
 * so its credentials never transit another connector's pod and its egress
 * policy names exactly one Perforce server: its own.
 *
 * **Lifetime.** A connector that syncs permissions has exactly one shim pod,
 * running, for as long as it holds that configuration; a connector that does
 * not has none at all. There is no idle state and no scaling: the Deployment
 * exists at one replica or does not exist, and `manager.ts` reconciles which
 * of the two from the connector row.
 *
 * **Rotation.** The pod template carries a fingerprint of the connector's
 * identity-affecting settings ({@link P4_SHIM_CONFIG_ANNOTATION}: server URL,
 * wire address, admin user, credential version). Editing any of them changes
 * the fingerprint, which changes the pod template, which rolls the Deployment
 * onto a new pod with an empty `/work` — so no ticket, trust entry, resolved
 * endpoint or binary from the previous configuration can outlive it.
 *
 * **Isolation.**
 * - Ingress: only the platform's own pods ({@link P4_SHIM_CLIENT_LABEL},
 *   stamped by the Helm chart) may reach the shim port. When the platform
 *   runs OUTSIDE the cluster its traffic arrives from a node rather than a
 *   labelled pod, so the caller supplies the node addresses to allow instead.
 *   An empty set there is fail-closed: no ingress rather than open ingress.
 * - Egress: only the resolved Perforce addresses on their ports, plus
 *   in-cluster DNS. Everything else is denied by the default-deny posture.
 *
 * All builders are pure so the isolation contract is unit-testable.
 */

const P4_SHIM_APP_LABEL = "p4-shim";
const P4_SHIM_RESOURCE_PREFIX = "archestra-p4-shim";
export const P4_SHIM_PORT = 8080;

/**
 * Marks a scope's shim resources so the convergence sweep can list them
 * without knowing which scopes exist.
 *
 * @public — read back from live objects by the runtime manager.
 */
export const P4_SHIM_SCOPE_LABEL = "archestra.io/p4-shim-scope";

/**
 * Stamped on platform web/worker pods by the Helm chart; the shim's ingress
 * rule selects it.
 *
 * @public — the cross-artifact contract with the Helm chart's pod labels,
 * pinned by the manifests test (production code builds it via p4ShimLabels).
 */
export const P4_SHIM_CLIENT_LABEL = "archestra.io/p4-shim-client";

/**
 * Fingerprint of the connector settings the pod's behaviour depends on. Lives
 * on the POD TEMPLATE, so changing it rolls the pod rather than merely
 * annotating the Deployment.
 *
 * @public — the rotation contract, pinned by the manifests test.
 */
export const P4_SHIM_CONFIG_ANNOTATION = "archestra.io/p4-shim-config";

/**
 * Digest of the bearer token the pod is expected to be holding. Lives on the
 * POD TEMPLATE for the same reason the config fingerprint does, and separately
 * from it because the two rotate independently: a token can be reminted for a
 * configuration that did not change (a lost write, a concurrent reconcile),
 * and the pod reads its token once at boot. Without this, that rotation
 * leaves a Ready pod authenticating against a token nothing will ever hand it
 * — permanently, since the pod is never restarted for any other reason.
 *
 * A digest, never the token: anyone who can read a Deployment can read this.
 *
 * @public — the rotation contract, pinned by the manifests test.
 */
export const P4_SHIM_TOKEN_ANNOTATION = "archestra.io/p4-shim-token";

/**
 * Non-reversible marker for the token a pod template expects.
 *
 * @public — half of the rotation contract above, and the only way a test can
 * assert the annotation carries a digest rather than the token itself.
 */
export function p4ShimTokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

/**
 * Deployment annotations earlier builds wrote that this one must remove.
 *
 * A shim that predates the always-on lifecycle carries an idle-TTL and a
 * last-used stamp, and the reconcile rolls an existing Deployment forward with
 * a JSON merge patch — which only adds and overwrites. Left alone they survive
 * every upgrade, telling an operator the pod parks after two minutes when
 * nothing has parked a pod since. A null value in a merge patch removes the
 * key, which is the only way to retire an annotation without replacing the
 * whole object.
 *
 * @public — applied by the runtime manager's patch path. Removable once no
 * supported upgrade path starts before the always-on shim.
 */
export const P4_SHIM_RETIRED_ANNOTATIONS: Record<string, string | null> = {
  "archestra.io/p4-shim-last-used": null,
  "archestra.io/p4-shim-idle-ttl": null,
};

/** Records which connector a shim belongs to, for operators reading the fleet. */
const P4_SHIM_CONNECTOR_LABEL = "archestra.io/p4-shim-connector";
const P4_SHIM_ORG_LABEL = "archestra.io/p4-shim-organization";

/** One allowed egress destination: a Perforce server's resolved addresses. */
export interface P4ShimEgressTarget {
  /** Resolved IPv4/IPv6 addresses of the server host. */
  ips: string[];
  port: number;
}

/** Resource names for one connector's shim. All RFC1123, all under the 63-character DNS label limit. */
export function p4ShimNames(scope: string): {
  deployment: string;
  service: string;
  secret: string;
  networkPolicy: string;
} {
  const base = `${P4_SHIM_RESOURCE_PREFIX}-${sanitizeScope(scope)}`;
  return {
    deployment: base,
    service: base,
    secret: `${base}-tk`,
    networkPolicy: `${base}-np`,
  };
}

/** Selector matching every shim across scopes — how the sweep lists the fleet. */
export function p4ShimSelector(): string {
  return `app=${P4_SHIM_APP_LABEL}`;
}

export function buildP4ShimDeployment(params: {
  /** The connector this shim serves; its id scopes every resource. */
  scope: string;
  organizationId: string;
  image: string;
  imagePullPolicy: string;
  /**
   * Digest of the connector settings the pod depends on. Changing it rolls the
   * pod — that is the rotation guarantee, not a cosmetic label.
   */
  configFingerprint: string;
  /**
   * The bearer token this shim's Secret currently holds. Only its digest is
   * stored, and only so that reminting the token rolls the pod that has to
   * read it.
   */
  authToken: string;
}): k8s.V1Deployment {
  const labels = {
    ...p4ShimLabels(params.scope),
    [P4_SHIM_ORG_LABEL]: params.organizationId,
  };
  // Only the scope labels select pods: an organization id is metadata, and a
  // selector is immutable once set.
  const selector = p4ShimLabels(params.scope);
  return {
    metadata: {
      name: p4ShimNames(params.scope).deployment,
      labels,
    },
    spec: {
      // Always one. A connector that syncs permissions has a shim; one that
      // does not has no Deployment at all. Nothing scales this field, so a
      // pod that is Ready is a pod that is serving.
      replicas: 1,
      // Recreate, not the default RollingUpdate. At one replica the default is
      // maxSurge 1 / maxUnavailable 0, which keeps the OLD pod Ready — and
      // serving the Service, and honouring its own token — until the new one
      // passes readiness. That window is exactly what rotation is meant to
      // close, and it is unbounded if the new pod never becomes Ready. The
      // shim is a stateless helper the backend already waits on, so taking the
      // old pod down first costs a few seconds and makes "exactly one pod per
      // configuration" true.
      strategy: { type: "Recreate" },
      selector: { matchLabels: selector },
      template: {
        metadata: {
          labels,
          annotations: {
            [P4_SHIM_CONFIG_ANNOTATION]: params.configFingerprint,
            [P4_SHIM_TOKEN_ANNOTATION]: p4ShimTokenDigest(params.authToken),
          },
        },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          terminationGracePeriodSeconds: 5,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65534,
            runAsGroup: 65534,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "p4-shim",
              image: params.image,
              imagePullPolicy: params.imagePullPolicy,
              ports: [{ containerPort: P4_SHIM_PORT, name: "http" }],
              env: [
                { name: "P4_SHIM_TOKEN_FILE", value: "/secrets/token" },
                { name: "PORT", value: String(P4_SHIM_PORT) },
              ],
              volumeMounts: [
                // The provisioned p4 binary, trust store, and scratch space;
                // pod-lifetime only (the backend re-provisions on restart).
                { name: "work", mountPath: "/work" },
                { name: "token", mountPath: "/secrets", readOnly: true },
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
              readinessProbe: {
                httpGet: {
                  path: "/healthz",
                  port: P4_SHIM_PORT as unknown as k8s.IntOrString,
                },
                initialDelaySeconds: 1,
                periodSeconds: 5,
              },
              // Requests equal limits, which is what puts the pod in the
              // Guaranteed QoS class: it is never the kubelet's first choice
              // to evict under node pressure, and never CPU-throttled below
              // what it reserved. A shim that is evicted mid-pass loses its
              // provisioned `p4` binary and its login ticket, so the pass
              // fails and the next one pays a full re-provision — a bad trade
              // for a pod this small. Modest by design: enough for a Node
              // process, a `p4` child, and the 24MiB output ceiling the shim
              // enforces, and no more, because every connector holds one.
              resources: {
                requests: {
                  cpu: "200m",
                  memory: "256Mi",
                  "ephemeral-storage": "1Gi",
                },
                limits: {
                  cpu: "200m",
                  memory: "256Mi",
                  "ephemeral-storage": "1Gi",
                },
              },
            },
          ],
          volumes: [
            { name: "work", emptyDir: { sizeLimit: "512Mi" } },
            {
              name: "token",
              secret: { secretName: p4ShimNames(params.scope).secret },
            },
          ],
        },
      },
    },
  };
}

export function buildP4ShimService(params: {
  scope: string;
  /** ClusterIP when the platform runs in-cluster, NodePort for local dev. */
  inCluster: boolean;
}): k8s.V1Service {
  return {
    metadata: {
      name: p4ShimNames(params.scope).service,
      labels: p4ShimLabels(params.scope),
    },
    spec: {
      selector: p4ShimLabels(params.scope),
      type: params.inCluster ? "ClusterIP" : "NodePort",
      ports: [
        {
          name: "http",
          protocol: "TCP",
          port: P4_SHIM_PORT,
          targetPort: P4_SHIM_PORT as unknown as k8s.IntOrString,
        },
      ],
    },
  };
}

export function buildP4ShimTokenSecret(params: {
  scope: string;
  token: string;
  /** The configuration this token was minted for; a change retires it. */
  configFingerprint: string;
}): k8s.V1Secret {
  return {
    metadata: {
      name: p4ShimNames(params.scope).secret,
      labels: p4ShimLabels(params.scope),
      annotations: { [P4_SHIM_CONFIG_ANNOTATION]: params.configFingerprint },
    },
    type: "Opaque",
    stringData: { token: params.token },
  };
}

/**
 * One scope's complete network identity: default-deny both directions, then
 * exactly the allowed ingress (platform → shim port) and egress (that
 * tenant's Perforce servers + DNS) — see the module doc.
 */
/**
 * The ingress half of the policy, on its own. Computed without contacting the
 * pod — unlike egress, which needs the pod's own DNS view — so a reconcile can
 * apply it BEFORE trying to reach the shim. A stale rule would otherwise
 * deadlock: the platform cannot reach the pod, so it never completes the
 * reconcile that would have corrected the rule.
 */
export function buildP4ShimIngressRule(params: {
  restrictIngressToClientPods: boolean;
  clientAddresses?: string[];
}): k8s.V1NetworkPolicyIngressRule | null {
  // NOTE: the client-node model names the wire field `from` as `_from` (its
  // serializer maps it back). Assigning explicitly — not via a spread, which
  // would bypass the compiler's excess-property check and silently drop the
  // ingress restriction at serialization time.
  const rule: k8s.V1NetworkPolicyIngressRule = {
    ports: [
      { protocol: "TCP", port: P4_SHIM_PORT as unknown as k8s.IntOrString },
    ],
  };
  if (params.restrictIngressToClientPods) {
    rule._from = [
      { podSelector: { matchLabels: { [P4_SHIM_CLIENT_LABEL]: "true" } } },
    ];
    return rule;
  }
  const addresses = params.clientAddresses ?? [];
  // No rule at all when no client address is known. An empty `from` is NOT a
  // deny — measured on kindnet, a rule carrying `from: []` admits everyone,
  // exactly like omitting `from`. `spec.ingress: []` is the canonical
  // deny-all, and is what a caller must emit instead.
  if (addresses.length === 0) return null;
  rule._from = addresses.map((address) => ({
    ipBlock: { cidr: toCidr(address) },
  }));
  return rule;
}

export function buildP4ShimNetworkPolicy(params: {
  scope: string;
  egressTargets: P4ShimEgressTarget[];
  /**
   * True when the platform runs in-cluster and its pods carry
   * {@link P4_SHIM_CLIENT_LABEL}.
   */
  restrictIngressToClientPods: boolean;
  /**
   * Out-of-cluster only: the addresses the platform's traffic carries as the
   * cluster's policy engine sees it. An empty list yields `ingress: []` — the
   * shim is unreachable rather than reachable by anyone.
   */
  clientAddresses?: string[];
}): k8s.V1NetworkPolicy {
  const ingressRule = buildP4ShimIngressRule(params);

  const egressRules: k8s.V1NetworkPolicyEgressRule[] = params.egressTargets
    .filter((target) => target.ips.length > 0)
    .map((target) => ({
      to: target.ips.map((ip) => ({ ipBlock: { cidr: toCidr(ip) } })),
      ports: [
        {
          protocol: "TCP",
          port: target.port as unknown as k8s.IntOrString,
        },
      ],
    }));

  // In-cluster DNS so the shim can resolve the Perforce host itself. The
  // namespaceSelector matches all namespaces; the pod selector narrows to
  // kube-dns/CoreDNS.
  egressRules.push({
    to: [
      {
        namespaceSelector: {},
        podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
      },
    ],
    ports: [
      { protocol: "UDP", port: 53 as unknown as k8s.IntOrString },
      { protocol: "TCP", port: 53 as unknown as k8s.IntOrString },
    ],
  });

  return {
    metadata: {
      name: p4ShimNames(params.scope).networkPolicy,
      labels: p4ShimLabels(params.scope),
    },
    spec: {
      podSelector: { matchLabels: p4ShimLabels(params.scope) },
      policyTypes: ["Ingress", "Egress"],
      ingress: ingressRule ? [ingressRule] : [],
      egress: egressRules,
    },
  };
}

// ===== Internal helpers =====

function p4ShimLabels(scope: string): Record<string, string> {
  return {
    app: P4_SHIM_APP_LABEL,
    [P4_SHIM_SCOPE_LABEL]: sanitizeScope(scope),
    [P4_SHIM_CONNECTOR_LABEL]: sanitizeScope(scope),
    "app.kubernetes.io/managed-by": "archestra",
    "archestra.io/resource": "p4-shim",
  };
}

/**
 * Scopes are uuids in practice; this keeps a hand-set environment id from
 * producing an invalid name or label value (63-character ceiling).
 */
function sanitizeScope(scope: string): string {
  return scope
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function toCidr(address: string): string {
  return address.includes(":") ? `${address}/128` : `${address}/32`;
}
