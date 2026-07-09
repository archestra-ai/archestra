import type * as k8s from "@kubernetes/client-node";
import { PatchStrategy, setHeaderOptions } from "@kubernetes/client-node";
import { isK8sConflictError, isK8sNotFoundError } from "@/k8s/shared";
import logger from "@/logging";
import type { K8sNetworkPolicyCapabilities } from "@/types";
import {
  buildEgressBaselineAwsApplicationNetworkPolicy,
  buildEgressBaselineNetworkPolicy,
  isAwsApplicationNetworkPolicyProvider,
} from "./network-policy";

// === Public API ===

/**
 * Name of the namespace-wide default-deny egress baseline applied to every
 * `app: mcp-server` pod. Distinct `archestra.io/resource: mcp-egress-baseline`
 * label keeps it out of the per-deployment managed-policy cleanup.
 */
const MCP_EGRESS_BASELINE_POLICY_NAME = "mcp-server-egress-baseline";

/**
 * Ensure the always-on default-deny egress baseline for all MCP server pods.
 *
 * This is the fail-safe floor: a pod that is not yet reconciled — or whose
 * per-pod policy failed to apply — matches only this baseline and is denied,
 * never left with open egress. Emitted as an `ApplicationNetworkPolicy` on the
 * AWS VPC CNI (where a plain `NetworkPolicy` is accepted but not enforced),
 * otherwise a plain `NetworkPolicy`; the other kind is removed so an
 * `ApplicationNetworkPolicy` and a `NetworkPolicy` never share a name (which the
 * AWS agent silently mis-resolves). Returns `true` on success and `false` on
 * failure (logged), so the caller can retry a namespace rather than cache a
 * failed attempt as done; per-pod policies remain the primary control meanwhile.
 */
export async function ensureEgressBaselineNetworkPolicy(params: {
  networkingApi: k8s.NetworkingV1Api;
  customObjectsApi: k8s.CustomObjectsApi;
  namespace: string;
  capabilities: K8sNetworkPolicyCapabilities;
}): Promise<boolean> {
  const { networkingApi, customObjectsApi, namespace, capabilities } = params;

  if (capabilities.provider === "none") {
    logger.warn(
      { provider: capabilities.provider, message: capabilities.message },
      "NetworkPolicy enforcement unavailable on this cluster; MCP egress controls (off/restricted modes and the SSRF floor) are created but NOT enforced",
    );
  }

  try {
    if (isAwsApplicationNetworkPolicyProvider(capabilities)) {
      await upsertBaselineApplicationNetworkPolicy(customObjectsApi, namespace);
      await deleteBaselineNetworkPolicy(networkingApi, namespace);
    } else {
      await upsertBaselineNetworkPolicy(networkingApi, namespace);
      await deleteBaselineApplicationNetworkPolicy(customObjectsApi, namespace);
    }
    return true;
  } catch (error) {
    logger.error(
      {
        err: error,
        namespace,
        networkPolicyName: MCP_EGRESS_BASELINE_POLICY_NAME,
      },
      "Failed to ensure the MCP egress default-deny baseline; per-pod policies remain the primary control",
    );
    return false;
  }
}

// === Internal helpers ===

const BASELINE_LABELS = {
  "app.kubernetes.io/managed-by": "archestra",
  "archestra.io/resource": "mcp-egress-baseline",
};

const AWS_APPLICATION_NETWORK_POLICY = {
  group: "networking.k8s.aws",
  version: "v1alpha1",
  plural: "applicationnetworkpolicies",
};

async function upsertBaselineNetworkPolicy(
  networkingApi: k8s.NetworkingV1Api,
  namespace: string,
): Promise<void> {
  const body = buildEgressBaselineNetworkPolicy({
    name: MCP_EGRESS_BASELINE_POLICY_NAME,
    labels: BASELINE_LABELS,
  });
  try {
    await networkingApi.createNamespacedNetworkPolicy({ namespace, body });
  } catch (error) {
    if (!isK8sConflictError(error)) throw error;
    await networkingApi.replaceNamespacedNetworkPolicy({
      name: MCP_EGRESS_BASELINE_POLICY_NAME,
      namespace,
      body,
    });
  }
}

async function deleteBaselineNetworkPolicy(
  networkingApi: k8s.NetworkingV1Api,
  namespace: string,
): Promise<void> {
  try {
    await networkingApi.deleteNamespacedNetworkPolicy({
      name: MCP_EGRESS_BASELINE_POLICY_NAME,
      namespace,
    });
  } catch (error) {
    if (!isK8sNotFoundError(error)) throw error;
  }
}

async function upsertBaselineApplicationNetworkPolicy(
  customObjectsApi: k8s.CustomObjectsApi,
  namespace: string,
): Promise<void> {
  const body = buildEgressBaselineAwsApplicationNetworkPolicy({
    name: MCP_EGRESS_BASELINE_POLICY_NAME,
    labels: BASELINE_LABELS,
  });
  try {
    await customObjectsApi.createNamespacedCustomObject({
      ...AWS_APPLICATION_NETWORK_POLICY,
      namespace,
      body,
    });
  } catch (error) {
    if (!isK8sConflictError(error)) throw error;
    await customObjectsApi.patchNamespacedCustomObject(
      {
        ...AWS_APPLICATION_NETWORK_POLICY,
        namespace,
        name: MCP_EGRESS_BASELINE_POLICY_NAME,
        body,
      },
      setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
    );
  }
}

async function deleteBaselineApplicationNetworkPolicy(
  customObjectsApi: k8s.CustomObjectsApi,
  namespace: string,
): Promise<void> {
  try {
    await customObjectsApi.deleteNamespacedCustomObject({
      ...AWS_APPLICATION_NETWORK_POLICY,
      namespace,
      name: MCP_EGRESS_BASELINE_POLICY_NAME,
    });
  } catch (error) {
    if (!isK8sNotFoundError(error)) throw error;
  }
}
