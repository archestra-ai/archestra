// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { getAgentCatalogImages } from "@archestra/shared";
import { KubeConfig, type V1DaemonSet } from "@kubernetes/client-node";
import { HttpResponse, http } from "msw";
import { beforeEach, expect, test, vi } from "vitest";
import config from "@/config";
import { useMswServer } from "@/test/msw";
import { agentImagePrefetcher } from "./image-prefetch.ee";

vi.mock("@/k8s/shared", async (original) => ({
  ...(await original<typeof import("@/k8s/shared")>()),
  loadKubeConfig: () => {
    const kubeConfig = new KubeConfig();
    kubeConfig.loadFromOptions({
      clusters: [{ name: "test", server: "https://kubernetes.example.test" }],
      users: [{ name: "test" }],
      contexts: [{ name: "test", cluster: "test", user: "test" }],
      currentContext: "test",
    });
    return { kubeConfig, namespace: "prefetch-tests" };
  },
}));
// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();
const API =
  "https://kubernetes.example.test/apis/apps/v1/namespaces/prefetch-tests/daemonsets";
let fleet: Map<string, V1DaemonSet>;
let writes: number;
beforeEach(() => {
  config.agentRuntime.enabled = true;
  config.enterpriseFeatures.core = true;
  config.agentRuntime.catalogImages = getAgentCatalogImages({
    registry: "registry.example.test",
    tag: "v1",
  });
  config.agentRuntime.nodeSelector = { runtime: "true" };
  config.orchestrator.kubernetes.helmReleaseName = "test-release";
  config.orchestrator.kubernetes.runtimeOwnerRoleName = undefined;
  fleet = new Map();
  writes = 0;
  server.use(
    http.get(API, () => HttpResponse.json({ items: [...fleet.values()] })),
    http.get(
      "https://kubernetes.example.test/api/v1/namespaces/prefetch-tests/serviceaccounts/default",
      () =>
        HttpResponse.json({ imagePullSecrets: [{ name: "private-registry" }] }),
    ),
    http.post(API, async ({ request }) => {
      const body = (await request.json()) as V1DaemonSet;
      writes++;
      // A pending/failed pull does not block reconciliation of the other images.
      body.status = {
        currentNumberScheduled: 1,
        desiredNumberScheduled: 1,
        numberMisscheduled: 0,
        numberReady: 0,
      };
      fleet.set(body.metadata?.name ?? "", body);
      return HttpResponse.json(body);
    }),
    http.put(`${API}/:name`, async ({ request, params }) => {
      writes++;
      const body = (await request.json()) as V1DaemonSet;
      fleet.set(String(params.name), body);
      return HttpResponse.json(body);
    }),
    http.delete(`${API}/:name`, ({ params }) => {
      writes++;
      fleet.delete(String(params.name));
      return HttpResponse.json({});
    }),
  );
});

test("warms the catalog on the runtime pool, skips unchanged writes, and removes obsolete versions", async () => {
  await agentImagePrefetcher.reconcile();
  expect(fleet.size).toBe(
    Object.keys(config.agentRuntime.catalogImages).length,
  );
  for (const ds of fleet.values()) {
    expect(ds.spec?.template.spec).toMatchObject({
      automountServiceAccountToken: false,
      nodeSelector: { runtime: "true" },
      tolerations: [
        {
          key: "runtime",
          value: "true",
          operator: "Equal",
          effect: "NoSchedule",
        },
      ],
      imagePullSecrets: [{ name: "private-registry" }],
    });
    expect(ds.spec?.template.spec?.initContainers?.[1]).toMatchObject({
      imagePullPolicy: "IfNotPresent",
      command: ["/prepull/true"],
    });
  }
  const initialWrites = writes;
  await agentImagePrefetcher.reconcile();
  expect(writes).toBe(initialWrites);
  config.agentRuntime.catalogImages = getAgentCatalogImages({
    registry: "registry.example.test",
    tag: "v2",
  });
  await agentImagePrefetcher.reconcile();
  expect(
    [...fleet.values()]
      .map((ds) => ds.spec?.template.spec?.initContainers?.[1].image)
      .sort(),
  ).toEqual(Object.values(config.agentRuntime.catalogImages).sort());
  expect(writes).toBe(initialWrites * 3);
});

test("a transient API failure never breaks startup and a later pass retries", async () => {
  server.use(http.get(API, () => new HttpResponse(null, { status: 503 })));
  await expect(agentImagePrefetcher.reconcile()).resolves.toBeUndefined();
  expect(writes).toBe(0);
  server.use(http.get(API, () => HttpResponse.json({ items: [] })));
  await agentImagePrefetcher.reconcile();
  expect(fleet.size).toBe(5);
});

test("refreshes floating catalog images when the stable platform version advances", async () => {
  const originalVersion = config.api.version;
  config.agentRuntime.catalogImages = getAgentCatalogImages({
    registry: "registry.example.test",
    tag: "latest",
  });
  config.api.version = "1.3.65";
  try {
    await agentImagePrefetcher.reconcile();
    const claudeImage = config.agentRuntime.catalogImages["claude-code"];
    const before = [...fleet.values()].find((daemonSet) =>
      daemonSet.spec?.template.spec?.initContainers?.some(
        (container) => container.image === claudeImage,
      ),
    );
    expect(
      before?.spec?.template.spec?.initContainers?.[1]?.imagePullPolicy,
    ).toBe("Always");
    const previousFingerprint = before?.metadata?.annotations;

    config.api.version = "1.3.66";
    await agentImagePrefetcher.reconcile();
    const after = fleet.get(before?.metadata?.name ?? "");
    expect(after?.metadata?.annotations).not.toEqual(previousFingerprint);
    expect(
      after?.spec?.template.spec?.initContainers?.[1]?.imagePullPolicy,
    ).toBe("Always");
  } finally {
    config.api.version = originalVersion;
  }
});

test("does no cluster work when Agent Runtime is disabled", async () => {
  config.agentRuntime.enabled = false;
  await agentImagePrefetcher.reconcile();
  expect(writes).toBe(0);
});
