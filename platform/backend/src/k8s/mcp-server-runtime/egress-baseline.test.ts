import type * as k8s from "@kubernetes/client-node";
import { vi } from "vitest";
import { describe, expect, test } from "@/test";
import type { K8sNetworkPolicyCapabilities } from "@/types";
import { ensureEgressBaselineNetworkPolicy } from "./egress-baseline";

const MCP_EGRESS_BASELINE_POLICY_NAME = "mcp-server-egress-baseline";

function makeCapabilities(
  provider: K8sNetworkPolicyCapabilities["provider"],
): K8sNetworkPolicyCapabilities {
  return {
    kubernetesNetworkPolicy: provider !== "none",
    ciliumNetworkPolicy: provider === "cilium",
    gkeFqdnNetworkPolicy: provider === "gke-fqdn",
    awsApplicationNetworkPolicy: provider === "aws-application-network-policy",
    provider,
    supportsFqdn: false,
    supportsHttpMethods: false,
    message: null,
  };
}

describe("ensureEgressBaselineNetworkPolicy", () => {
  function makeApis(overrides?: {
    createNamespacedNetworkPolicy?: ReturnType<typeof vi.fn>;
  }) {
    const networkingApi = {
      createNamespacedNetworkPolicy:
        overrides?.createNamespacedNetworkPolicy ??
        vi.fn().mockResolvedValue({}),
      replaceNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
      deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    } as unknown as k8s.NetworkingV1Api;
    const customObjectsApi = {
      createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    } as unknown as k8s.CustomObjectsApi;
    return { networkingApi, customObjectsApi };
  }

  test("creates a plain NetworkPolicy baseline and removes the ANP on enforcing-plain providers", async () => {
    const { networkingApi, customObjectsApi } = makeApis();

    const succeeded = await ensureEgressBaselineNetworkPolicy({
      networkingApi,
      customObjectsApi,
      namespace: "archestra-dev",
      capabilities: makeCapabilities("cilium"),
    });

    expect(succeeded).toBe(true);
    expect(networkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "archestra-dev",
        body: expect.objectContaining({
          kind: "NetworkPolicy",
          metadata: expect.objectContaining({
            name: MCP_EGRESS_BASELINE_POLICY_NAME,
          }),
          spec: expect.objectContaining({
            podSelector: { matchLabels: { app: "mcp-server" } },
            egress: [],
          }),
        }),
      }),
    );
    // The other kind is removed so an ANP and a NetworkPolicy never share a name.
    expect(customObjectsApi.deleteNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ name: MCP_EGRESS_BASELINE_POLICY_NAME }),
    );
    expect(
      customObjectsApi.createNamespacedCustomObject,
    ).not.toHaveBeenCalled();
  });

  test("creates an ApplicationNetworkPolicy baseline and removes the plain NP on AWS", async () => {
    const { networkingApi, customObjectsApi } = makeApis();

    await ensureEgressBaselineNetworkPolicy({
      networkingApi,
      customObjectsApi,
      namespace: "archestra-dev",
      capabilities: makeCapabilities("aws-application-network-policy"),
    });

    expect(customObjectsApi.createNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        group: "networking.k8s.aws",
        version: "v1alpha1",
        plural: "applicationnetworkpolicies",
        namespace: "archestra-dev",
        body: expect.objectContaining({
          kind: "ApplicationNetworkPolicy",
          spec: expect.objectContaining({ egress: [] }),
        }),
      }),
    );
    expect(networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ name: MCP_EGRESS_BASELINE_POLICY_NAME }),
    );
    expect(networkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled();
  });

  test("replaces the baseline in place when it already exists (409)", async () => {
    const { networkingApi, customObjectsApi } = makeApis({
      createNamespacedNetworkPolicy: vi
        .fn()
        .mockRejectedValue({ statusCode: 409 }),
    });

    await ensureEgressBaselineNetworkPolicy({
      networkingApi,
      customObjectsApi,
      namespace: "archestra-dev",
      capabilities: makeCapabilities("kubernetes"),
    });

    expect(networkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ name: MCP_EGRESS_BASELINE_POLICY_NAME }),
    );
  });

  test("returns false (not throwing) when a non-conflict create fails, so the caller can retry", async () => {
    const { networkingApi, customObjectsApi } = makeApis({
      createNamespacedNetworkPolicy: vi
        .fn()
        .mockRejectedValue({ statusCode: 403 }),
    });

    await expect(
      ensureEgressBaselineNetworkPolicy({
        networkingApi,
        customObjectsApi,
        namespace: "archestra-dev",
        capabilities: makeCapabilities("kubernetes"),
      }),
    ).resolves.toBe(false);
  });

  test("still creates the baseline object under provider=none (accepted but unenforced)", async () => {
    const { networkingApi, customObjectsApi } = makeApis();

    await ensureEgressBaselineNetworkPolicy({
      networkingApi,
      customObjectsApi,
      namespace: "archestra-dev",
      capabilities: makeCapabilities("none"),
    });

    expect(networkingApi.createNamespacedNetworkPolicy).toHaveBeenCalled();
  });
});
