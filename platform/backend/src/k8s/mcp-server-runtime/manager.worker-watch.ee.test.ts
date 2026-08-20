// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

/**
 * A dedicated worker process (ARCHESTRA_PROCESS_TYPE=worker) never runs the
 * runtime's full start() — no reconcile, no sweeper — but it wakes servers on
 * demand and then trusts its cached state. These tests pin the watchers-only
 * entry point that keeps that cache honest: after a WEB replica hibernates a
 * deployment, the worker's watch stream must converge the worker's cached
 * "running" to "hibernated", so the next scheduled call re-enters the wake
 * path instead of dispatching to a zero-replica Service.
 */
import type * as k8s from "@kubernetes/client-node";
import { vi } from "vitest";
import {
  MCP_HIBERNATED_ANNOTATION,
  MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION,
} from "@/k8s/shared";
import { describe, expect, test } from "@/test";
import type K8sDeployment from "./k8s-deployment";
import { McpServerRuntimeManager } from "./manager";
import type { K8sRuntimeStatus } from "./schemas";

const NAMESPACE = "worker-watch-namespace";
const NOT_FOUND = { statusCode: 404, message: "not found" };

const { watchCalls } = vi.hoisted(() => ({
  watchCalls: [] as {
    path: string;
    onEvent: (phase: string, obj?: unknown) => void;
  }[],
}));

vi.mock("@kubernetes/client-node", () => ({
  KubeConfig: vi.fn(function mockKubeConfig() {
    return {
      loadFromString() {},
      loadFromCluster() {},
      loadFromFile() {},
      loadFromDefault() {},
      makeApiClient() {},
    };
  }),
  CoreV1Api: vi.fn(),
  AppsV1Api: vi.fn(),
  AuthorizationV1Api: vi.fn(),
  NetworkingV1Api: vi.fn(),
  CustomObjectsApi: vi.fn(),
  BatchV1Api: vi.fn(),
  Attach: vi.fn(),
  Log: vi.fn(),
  Exec: vi.fn(),
  PatchStrategy: { MergePatch: "application/merge-patch+json" },
  setHeaderOptions: vi.fn(() => ({})),
  // A regular function so `new Watch(...)` works; records the event callback
  // so tests can play the API server's part.
  Watch: vi.fn(function mockWatch() {
    return {
      watch: vi.fn(
        async (
          path: string,
          _opts: unknown,
          onEvent: (phase: string, obj?: unknown) => void,
        ) => {
          watchCalls.push({ path, onEvent });
          return new AbortController();
        },
      ),
    };
  }),
}));

/** The one physical Deployment, mutated out of band to play the web replica. */
class FakeCluster {
  replicas = 1;
  annotations: Record<string, string> = {};
  resourceVersion = 1;
  patchCount = 0;

  constructor(private deploymentName: string) {}

  /** What a web replica's hibernate leaves behind. */
  hibernateOutOfBand(): void {
    this.annotations[MCP_HIBERNATED_ANNOTATION] = "true";
    this.annotations[MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION] = "1";
    this.replicas = 0;
    this.resourceVersion++;
  }

  readDeployment(): k8s.V1Deployment {
    return {
      metadata: {
        name: this.deploymentName,
        namespace: NAMESPACE,
        annotations: { ...this.annotations },
        resourceVersion: String(this.resourceVersion),
      },
      spec: { replicas: this.replicas },
      status: {
        availableReplicas: this.replicas,
        readyReplicas: this.replicas,
      },
    } as k8s.V1Deployment;
  }

  listPods(labelSelector?: string): k8s.V1Pod[] {
    const ours =
      labelSelector?.includes("mcp-server-id=") ||
      labelSelector?.includes("app=mcp-server");
    if (!ours || this.replicas === 0) return [];
    return [
      {
        metadata: {
          name: `${this.deploymentName}-6d4f9c7b5-abcde`,
          creationTimestamp: new Date(),
          labels: { app: "mcp-server" },
        },
        status: {
          phase: "Running",
          containerStatuses: [
            {
              name: "mcp-server",
              ready: true,
              restartCount: 0,
              state: { running: {} },
            },
          ],
        },
      } as unknown as k8s.V1Pod,
    ];
  }
}

type ManagerInternals = {
  k8sApi: k8s.CoreV1Api;
  k8sAppsApi: k8s.AppsV1Api;
  k8sAuthApi: k8s.AuthorizationV1Api;
  k8sNetworkingApi: k8s.NetworkingV1Api;
  k8sCustomObjectsApi: k8s.CustomObjectsApi;
  k8sAttach: k8s.Attach;
  k8sLog: k8s.Log;
  k8sExec: k8s.Exec;
  kubeConfig: k8s.KubeConfig;
  namespace: string;
  status: K8sRuntimeStatus;
  mcpServerIdToDeploymentMap: Map<string, K8sDeployment>;
};

function makeWorkerManager(cluster: FakeCluster) {
  const coreApi = {
    listNamespacedPod: vi.fn(
      async ({ labelSelector }: { labelSelector?: string }) => ({
        items: cluster.listPods(labelSelector),
      }),
    ),
    readNamespacedPod: vi.fn(async () => {
      throw NOT_FOUND;
    }),
    listNamespacedEvent: vi.fn(async () => ({ items: [] })),
    readNamespacedService: vi.fn(async () => {
      throw NOT_FOUND;
    }),
  } as unknown as k8s.CoreV1Api;

  const appsApi = {
    readNamespacedDeployment: vi.fn(async () => cluster.readDeployment()),
    patchNamespacedDeployment: vi.fn(async () => {
      cluster.patchCount++;
      throw new Error("a worker's watch refresh must never write");
    }),
  } as unknown as k8s.AppsV1Api;

  const customObjectsApi = {
    getAPIResources: vi.fn(async () => {
      throw NOT_FOUND;
    }),
  } as unknown as k8s.CustomObjectsApi;

  const manager = new McpServerRuntimeManager();
  const internals = manager as unknown as ManagerInternals;
  internals.k8sApi = coreApi;
  internals.k8sAppsApi = appsApi;
  internals.k8sAuthApi = {} as k8s.AuthorizationV1Api;
  internals.k8sNetworkingApi = {} as k8s.NetworkingV1Api;
  internals.k8sCustomObjectsApi = customObjectsApi;
  internals.k8sAttach = {} as k8s.Attach;
  internals.k8sLog = {} as k8s.Log;
  internals.k8sExec = {} as k8s.Exec;
  internals.kubeConfig = {} as k8s.KubeConfig;
  internals.namespace = NAMESPACE;
  internals.status = "running";
  return manager;
}

describe("worker-mode deployment-state watchers", () => {
  test("a lazily-loaded deployment converges after another replica hibernates it", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const org = await makeOrganization({ mcpIdleHibernationEnabled: true });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "Worker Watch Catalog",
      serverType: "local",
      localConfig: { command: "node", arguments: ["server.js"] },
    });
    const install = await makeMcpServer({
      catalogId: catalog.id,
      name: "worker-watch-install",
    });

    const cluster = new FakeCluster(
      catalog.deploymentName ?? "worker-watch-catalog",
    );
    const worker = makeWorkerManager(cluster);

    worker.startStateWatchersOnly();
    // One pods stream and one deployments stream for the runtime namespace.
    expect(watchCalls.map(({ path }) => path).sort()).toEqual([
      `/api/v1/namespaces/${NAMESPACE}/pods`,
      `/apis/apps/v1/namespaces/${NAMESPACE}/deployments`,
    ]);
    // Idempotent: the worker entry point must not stack duplicate streams.
    worker.startStateWatchersOnly();
    expect(watchCalls).toHaveLength(2);

    // A cache-cold worker must classify the live deployment directly. Without
    // this, later watch events are ignored forever and pooled clients survive
    // a remote pod replacement.
    const deployment = await worker.getOrLoadDeployment(install.id);
    if (!deployment) throw new Error("the deployment did not lazy-load");
    await deployment.refreshState();
    expect(deployment.statusSummary.state).toBe("running");

    // A web replica hibernates the deployment. Nothing has told this worker:
    // its cache still says "running" — the exact staleness that made
    // scheduled calls dispatch to a zero-replica Service.
    cluster.hibernateOutOfBand();
    expect(deployment.statusSummary.state).toBe("running");

    // The API server streams the change; the debounced refresh must converge
    // the worker's cache without writing anything back.
    for (const { onEvent } of watchCalls) {
      onEvent("MODIFIED");
    }
    await vi.waitFor(
      () => {
        expect(deployment.statusSummary.state).toBe("hibernated");
      },
      { timeout: 8_000, interval: 250 },
    );
    expect(cluster.patchCount).toBe(0);
  });
});
