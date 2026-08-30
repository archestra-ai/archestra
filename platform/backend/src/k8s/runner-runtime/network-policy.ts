import type * as k8s from "@kubernetes/client-node";
import {
  buildManagedAwsApplicationNetworkPolicy,
  buildManagedCiliumNetworkPolicy,
  buildManagedGkeFqdnNetworkPolicy,
  buildManagedNetworkPolicy,
  buildUnrestrictedFloorAwsApplicationNetworkPolicy,
  buildUnrestrictedFloorPolicy,
  isAwsApplicationNetworkPolicyProvider,
  shouldUseAwsApplicationNetworkPolicy,
  shouldUseCiliumNetworkPolicy,
  shouldUseGkeFqdnNetworkPolicy,
} from "@/k8s/mcp-server-runtime/network-policy";
import type { K8sNetworkPolicyCapabilities } from "@/types";
import type { KubernetesRunnerLaunchSpec } from "./manifests";
import { RUNNER_TASK_LABEL, runnerLabels, runnerNames } from "./naming";

/** A provider-specific Environment egress policy ready for the Kubernetes API. */
export type RunnerEgressPolicyObject =
  | { kind: "NetworkPolicy"; object: k8s.V1NetworkPolicy }
  | {
      kind:
        | "CiliumNetworkPolicy"
        | "FQDNNetworkPolicy"
        | "ApplicationNetworkPolicy";
      object: Record<string, unknown>;
    };

export const RUNNER_EGRESS_POLICY_CRDS = {
  CiliumNetworkPolicy: {
    group: "cilium.io",
    version: "v2",
    plural: "ciliumnetworkpolicies",
  },
  FQDNNetworkPolicy: {
    group: "networking.gke.io",
    version: "v1alpha1",
    plural: "fqdnnetworkpolicies",
  },
  ApplicationNetworkPolicy: {
    group: "networking.k8s.aws",
    version: "v1alpha1",
    plural: "applicationnetworkpolicies",
  },
} as const;

/**
 * Apply the Agent Environment's effective egress policy to one execution.
 *
 * Provider selection deliberately matches the MCP and Dagger runtimes:
 * Cilium, then GKE FQDN, then AWS ApplicationNetworkPolicy, then the standard
 * Kubernetes policy. The GKE path also emits a standard policy for CIDRs.
 */
export function buildRunnerEnvironmentEgressPolicies(params: {
  spec: KubernetesRunnerLaunchSpec;
  capabilities?: K8sNetworkPolicyCapabilities | null;
  clusterDnsIps?: string[];
}): RunnerEgressPolicyObject[] {
  const { spec, capabilities } = params;
  const clusterDnsIps = params.clusterDnsIps ?? [];
  const names = runnerNames(spec.frozenName);
  const podSelectorLabels = { [RUNNER_TASK_LABEL]: spec.taskId };
  const metadata = {
    namespace: spec.namespace,
    labels: runnerLabels({ taskId: spec.taskId, runnerId: spec.runnerId }),
    ownerReferences: spec.ownerReferences,
  };

  if (
    !spec.effectiveNetworkPolicy.policy ||
    spec.effectiveNetworkPolicy.policy.egressMode === "unrestricted"
  ) {
    const allowedCidrs = spec.effectiveNetworkPolicy.policy?.allowedCidrs ?? [];
    const object = isAwsApplicationNetworkPolicyProvider(capabilities)
      ? buildUnrestrictedFloorAwsApplicationNetworkPolicy({
          name: names.environmentNetworkPolicy,
          podSelectorLabels,
          labels: metadata.labels,
          clusterDnsIps,
          allowedCidrs,
        })
      : buildUnrestrictedFloorPolicy({
          name: names.environmentNetworkPolicy,
          podSelectorLabels,
          labels: metadata.labels,
          clusterDnsIps,
          allowedCidrs,
        });
    return [
      withRunnerMetadata({
        kind: isAwsApplicationNetworkPolicyProvider(capabilities)
          ? "ApplicationNetworkPolicy"
          : "NetworkPolicy",
        object,
        metadata,
      }),
    ];
  }

  if (
    shouldUseCiliumNetworkPolicy({
      effectivePolicy: spec.effectiveNetworkPolicy,
      capabilities,
    })
  ) {
    return [
      withRunnerMetadata({
        kind: "CiliumNetworkPolicy",
        object: buildManagedCiliumNetworkPolicy({
          name: names.environmentNetworkPolicy,
          podSelectorLabels,
          effectivePolicy: spec.effectiveNetworkPolicy,
        }),
        metadata,
      }),
    ];
  }

  if (
    shouldUseGkeFqdnNetworkPolicy({
      effectivePolicy: spec.effectiveNetworkPolicy,
      capabilities,
    })
  ) {
    return [
      withRunnerMetadata({
        kind: "FQDNNetworkPolicy",
        object: buildManagedGkeFqdnNetworkPolicy({
          name: names.environmentNetworkPolicy,
          podSelectorLabels,
          effectivePolicy: spec.effectiveNetworkPolicy,
        }),
        metadata,
      }),
      withRunnerMetadata({
        kind: "NetworkPolicy",
        object: buildManagedNetworkPolicy({
          name: names.environmentNetworkPolicy,
          podSelectorLabels,
          effectivePolicy: spec.effectiveNetworkPolicy,
        }),
        metadata,
      }),
    ];
  }

  if (
    shouldUseAwsApplicationNetworkPolicy({
      effectivePolicy: spec.effectiveNetworkPolicy,
      capabilities,
    })
  ) {
    return [
      withRunnerMetadata({
        kind: "ApplicationNetworkPolicy",
        object: buildManagedAwsApplicationNetworkPolicy({
          name: names.environmentNetworkPolicy,
          podSelectorLabels,
          effectivePolicy: spec.effectiveNetworkPolicy,
          clusterDnsIps,
        }),
        metadata,
      }),
    ];
  }

  return [
    withRunnerMetadata({
      kind: "NetworkPolicy",
      object: buildManagedNetworkPolicy({
        name: names.environmentNetworkPolicy,
        podSelectorLabels,
        effectivePolicy: spec.effectiveNetworkPolicy,
      }),
      metadata,
    }),
  ];
}

// === Internal helpers ===

function withRunnerMetadata(params: {
  kind: RunnerEgressPolicyObject["kind"];
  object: k8s.V1NetworkPolicy | Record<string, unknown>;
  metadata: {
    namespace: string;
    labels: Record<string, string>;
    ownerReferences: k8s.V1OwnerReference[] | undefined;
  };
}): RunnerEgressPolicyObject {
  const existingMetadata = (params.object.metadata ?? {}) as Record<
    string,
    unknown
  >;
  const object = {
    ...params.object,
    metadata: {
      ...existingMetadata,
      namespace: params.metadata.namespace,
      labels: params.metadata.labels,
      ...(params.metadata.ownerReferences
        ? { ownerReferences: params.metadata.ownerReferences }
        : {}),
    },
  };
  return params.kind === "NetworkPolicy"
    ? { kind: params.kind, object: object as k8s.V1NetworkPolicy }
    : { kind: params.kind, object };
}
