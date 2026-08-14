// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import type * as k8s from "@kubernetes/client-node";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    orchestrator: {
      // In-cluster, so the reconcile builds its ingress rule from the client
      // pod label instead of resolving node addresses over a real socket.
      kubernetes: { loadKubeconfigFromCurrentCluster: true },
    },
  }),
);

vi.mock("@/k8s/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/k8s/shared")>()),
  isK8sConfigured: vi.fn(),
  getK8sNamespace: vi.fn(),
  loadKubeConfig: vi.fn(),
  createK8sClients: vi.fn(),
}));

import {
  createK8sClients,
  getK8sNamespace,
  isK8sConfigured,
  loadKubeConfig,
} from "@/k8s/shared";
import { p4ShimRuntimeManager } from "./manager";
import { P4_SHIM_SCOPE_LABEL } from "./manifests";

const CONNECTOR = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const NAMESPACE = "archestra";

const listNamespacedDeployment = vi.fn();
const createNamespacedDeployment = vi.fn();
const patchNamespacedDeployment = vi.fn(
  async (_request: { body?: { metadata?: { annotations?: unknown } } }) => ({
    metadata: { generation: 2 },
  }),
);
const readNamespacedSecret = vi.fn();
const createNamespacedSecret = vi.fn(async () => ({}));
const createNamespacedService = vi.fn(async () => ({}));
const createNamespacedNetworkPolicy = vi.fn(async () => ({}));
const deleteNamespacedDeployment = vi.fn(async () => ({}));
const deleteNamespacedService = vi.fn(async () => ({}));
const deleteNamespacedSecret = vi.fn(async () => ({}));
const deleteNamespacedNetworkPolicy = vi.fn(async () => ({}));

/** One shim Deployment as the sweep sees it: a scope label and an age. */
function shim(params: {
  scope?: string;
  createdSecondsAgo?: number;
  omitScopeLabel?: boolean;
  omitCreationTimestamp?: boolean;
}): k8s.V1Deployment {
  const scope = params.scope ?? CONNECTOR;
  return {
    metadata: {
      name: `archestra-p4-shim-${scope}`,
      labels: params.omitScopeLabel ? {} : { [P4_SHIM_SCOPE_LABEL]: scope },
      creationTimestamp: params.omitCreationTimestamp
        ? undefined
        : new Date(Date.now() - (params.createdSecondsAgo ?? 0) * 1000),
    },
  } as unknown as k8s.V1Deployment;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isK8sConfigured).mockReturnValue(true);
  vi.mocked(getK8sNamespace).mockReturnValue(NAMESPACE);
  vi.mocked(loadKubeConfig).mockReturnValue({
    kubeConfig: {},
  } as unknown as ReturnType<typeof loadKubeConfig>);
  // A shim that already exists: the create 409s and the reconcile patches.
  createNamespacedDeployment.mockRejectedValue(
    Object.assign(new Error("exists"), { code: 409 }),
  );
  readNamespacedSecret.mockRejectedValue(
    Object.assign(new Error("not found"), { code: 404 }),
  );
  vi.mocked(createK8sClients).mockReturnValue({
    appsApi: {
      listNamespacedDeployment,
      deleteNamespacedDeployment,
      createNamespacedDeployment,
      patchNamespacedDeployment,
    },
    coreApi: {
      deleteNamespacedService,
      deleteNamespacedSecret,
      readNamespacedSecret,
      createNamespacedSecret,
      createNamespacedService,
    },
    networkingApi: {
      deleteNamespacedNetworkPolicy,
      createNamespacedNetworkPolicy,
    },
  } as unknown as ReturnType<typeof createK8sClients>);
});

describe("listShims", () => {
  it("reports each shim's connector and how long it has existed", async () => {
    listNamespacedDeployment.mockResolvedValue({
      items: [shim({ createdSecondsAgo: 120 })],
    });

    const [found] = await p4ShimRuntimeManager.listShims();

    expect(found.scope).toBe(CONNECTOR);
    expect(found.ageMs).toBeGreaterThanOrEqual(120_000);
    expect(found.ageMs).toBeLessThan(130_000);
  });

  it("treats a shim with no creation timestamp as ancient, never as new", async () => {
    // The age feeds a grace that spares deletion. A shim that cannot say how
    // old it is must not be able to outlive the sweep by staying silent.
    listNamespacedDeployment.mockResolvedValue({
      items: [shim({ omitCreationTimestamp: true })],
    });

    const [found] = await p4ShimRuntimeManager.listShims();

    expect(found.ageMs).toBe(Infinity);
  });

  it("ignores a Deployment carrying no scope label", async () => {
    // Nothing to reconcile it against: the sweep would have no connector id to
    // compare, and deleting on a guess is the one irreversible thing it does.
    listNamespacedDeployment.mockResolvedValue({
      items: [shim({ omitScopeLabel: true })],
    });

    expect(await p4ShimRuntimeManager.listShims()).toEqual([]);
  });

  it("reports nothing when Kubernetes is not configured", async () => {
    vi.mocked(isK8sConfigured).mockReturnValue(false);

    expect(await p4ShimRuntimeManager.listShims()).toEqual([]);
    expect(listNamespacedDeployment).not.toHaveBeenCalled();
  });
});

describe("teardown", () => {
  it("removes the pod, its Service, its token and its egress policy", async () => {
    await p4ShimRuntimeManager.teardown(CONNECTOR);

    expect(deleteNamespacedDeployment).toHaveBeenCalled();
    expect(deleteNamespacedService).toHaveBeenCalled();
    expect(deleteNamespacedSecret).toHaveBeenCalled();
    expect(deleteNamespacedNetworkPolicy).toHaveBeenCalled();
  });

  it("keeps deleting the rest after one resource is already gone", async () => {
    // Teardown runs on paths that may have partly run before — a retried
    // delete, the sweep after a lost call — so a 404 is the expected case,
    // not a reason to leave the token and the egress rule behind.
    deleteNamespacedDeployment.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { code: 404 }),
    );

    await p4ShimRuntimeManager.teardown(CONNECTOR);

    expect(deleteNamespacedSecret).toHaveBeenCalled();
    expect(deleteNamespacedNetworkPolicy).toHaveBeenCalled();
  });
});

describe("apply — rolling an existing shim forward", () => {
  async function applyShim() {
    await p4ShimRuntimeManager.apply({
      connectorId: CONNECTOR,
      organizationId: "aaaabbbb-cccc-4ddd-8eee-ffff00001111",
      server: { host: "perforce.example.com", port: 1666 },
      configFingerprint: "0123456789abcdef0123456789abcdef",
      configIsCurrent: async () => true,
    });
  }

  it("removes the idle annotations an older build left on the Deployment", async () => {
    await applyShim();

    // A JSON merge patch only adds and overwrites, so a shim carried across
    // the upgrade would keep advertising an idle TTL forever. A null value is
    // what deletes the key.
    const annotations =
      patchNamespacedDeployment.mock.calls[0][0].body?.metadata?.annotations;
    expect(annotations).toMatchObject({
      "archestra.io/p4-shim-last-used": null,
      "archestra.io/p4-shim-idle-ttl": null,
    });
  });

  it("refuses to write settings the connector no longer has", async () => {
    await expect(
      p4ShimRuntimeManager.apply({
        connectorId: CONNECTOR,
        organizationId: "aaaabbbb-cccc-4ddd-8eee-ffff00001111",
        server: { host: "perforce.example.com", port: 1666 },
        configFingerprint: "0123456789abcdef0123456789abcdef",
        configIsCurrent: async () => false,
      }),
    ).rejects.toThrow(/settings changed/i);

    // Nothing at all, not "most of it": the token, the pod template and the
    // egress rule all belong to the settings that were replaced.
    expect(createNamespacedSecret).not.toHaveBeenCalled();
    expect(patchNamespacedDeployment).not.toHaveBeenCalled();
  });
});
