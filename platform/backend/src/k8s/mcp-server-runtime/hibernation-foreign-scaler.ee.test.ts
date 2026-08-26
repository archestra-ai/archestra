// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

/**
 * A controller that owns `spec.replicas` — ArgoCD / Flux self-heal, an
 * HPA/KEDA `minReplicas >= 1`, an operator's `kubectl scale` habit — writes
 * replicas back to 1 after every hibernate. The hibernation lifecycle has to
 * notice it is fighting another writer and stop, rather than kill the pod once
 * per sweep tick forever.
 *
 * Harness is the seam test's FakeK8sCluster (real merge-patch application,
 * real resourceVersion compare-and-swap), driving the REAL manager, the REAL
 * K8sDeployment and the REAL sweeper.
 */
import type * as k8s from "@kubernetes/client-node";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import {
  MCP_FOREIGN_REPLICA_OWNER_ANNOTATION,
  MCP_HIBERNATED_ANNOTATION,
  MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION,
} from "@/k8s/shared";
import McpServerModel, {
  MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS,
} from "@/models/mcp-server";
import { describe, expect, test } from "@/test";
import type K8sDeployment from "./k8s-deployment";
import { McpServerRuntimeManager } from "./manager";
import type { K8sRuntimeStatus } from "./schemas";

const NAMESPACE = "seam-test-namespace";
const DEPLOYMENT_NAME = "mcp-seam-server";
const NOT_FOUND = { statusCode: 404, message: "not found" };
const CONFLICT = { statusCode: 409, message: "the object has been modified" };

const IDLE_WINDOW_SECONDS = 300;
const IDLE_CUTOFF_MS =
  IDLE_WINDOW_SECONDS * 1000 + MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS;

type MergePatchBody = {
  metadata?: {
    annotations?: Record<string, string | null>;
    resourceVersion?: string;
  };
  spec?: { replicas?: number };
};

type RecordedPatch = {
  name: string;
  namespace: string;
  body: MergePatchBody;
};

class FakeK8sCluster {
  readonly patches: RecordedPatch[] = [];
  exists = true;
  replicas: number;
  annotations: Record<string, string>;
  resourceVersion = 1;
  containerWaitingReason: string | null = null;
  private deploymentReads = 0;
  private readyFromRead: number;

  constructor(init: {
    replicas: number;
    annotations?: Record<string, string>;
    podComesUp?: boolean;
  }) {
    this.replicas = init.replicas;
    this.annotations = { ...init.annotations };
    this.readyFromRead =
      init.podComesUp === false ? Number.POSITIVE_INFINITY : 1;
  }

  get patchedIntents(): MergePatchBody[] {
    return this.patches.map(({ body }) => {
      if (body.metadata?.resourceVersion === undefined) return body;
      const { resourceVersion: _dropped, ...metadata } = body.metadata;
      const stripped: MergePatchBody = { ...body };
      if (Object.keys(metadata).length > 0) stripped.metadata = metadata;
      else delete stripped.metadata;
      return stripped;
    });
  }

  private get podRunning(): boolean {
    return (
      this.replicas > 0 &&
      this.containerWaitingReason === null &&
      this.deploymentReads >= this.readyFromRead
    );
  }

  readDeployment(): k8s.V1Deployment {
    if (!this.exists) throw NOT_FOUND;
    this.deploymentReads++;
    return {
      metadata: {
        name: DEPLOYMENT_NAME,
        namespace: NAMESPACE,
        annotations: { ...this.annotations },
        resourceVersion: String(this.resourceVersion),
      },
      spec: { replicas: this.replicas },
      status: {
        availableReplicas: this.podRunning ? this.replicas : 0,
        readyReplicas: this.podRunning ? this.replicas : 0,
      },
    } as k8s.V1Deployment;
  }

  patchDeployment(request: {
    name: string;
    namespace: string;
    body: MergePatchBody;
  }): k8s.V1Deployment {
    if (!this.exists) throw NOT_FOUND;
    const precondition = request.body.metadata?.resourceVersion;
    if (
      precondition !== undefined &&
      precondition !== String(this.resourceVersion)
    ) {
      throw CONFLICT;
    }
    this.patches.push({
      name: request.name,
      namespace: request.namespace,
      body: request.body,
    });

    if (request.body.spec?.replicas !== undefined) {
      this.replicas = request.body.spec.replicas;
    }
    for (const [key, value] of Object.entries(
      request.body.metadata?.annotations ?? {},
    )) {
      if (value === null) delete this.annotations[key];
      else this.annotations[key] = value;
    }
    this.resourceVersion++;
    return this.readDeployment();
  }

  /**
   * Another writer. This is the whole point of the repro: a GitOps controller
   * or an HPA restoring ITS desired replica count, WITHOUT touching annotations
   * it does not own (client-side 3-way apply and the scale subresource both
   * leave foreign annotations alone).
   */
  externalWrite(mutate: (cluster: FakeK8sCluster) => void = () => {}): void {
    mutate(this);
    this.resourceVersion++;
  }

  listPods(labelSelector?: string): k8s.V1Pod[] {
    if (!this.exists || this.replicas === 0) return [];
    const ours =
      labelSelector?.startsWith("mcp-server-id=") ||
      labelSelector === "app=mcp-server";
    if (!ours) return [];

    const running = this.podRunning;
    return [
      {
        metadata: {
          name: `${DEPLOYMENT_NAME}-6d4f9c7b5-abcde`,
          creationTimestamp: new Date(),
          labels: { app: "mcp-server" },
        },
        status: {
          phase: running ? "Running" : "Pending",
          conditions: [{ type: "Ready", status: running ? "True" : "False" }],
          containerStatuses: [
            {
              name: "mcp-server",
              ready: running,
              restartCount: 0,
              state: running
                ? { running: {} }
                : {
                    waiting: {
                      reason:
                        this.containerWaitingReason ?? "ContainerCreating",
                      message: "creating container",
                    },
                  },
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
  namespace: string;
  status: K8sRuntimeStatus;
  mcpServerIdToDeploymentMap: Map<string, K8sDeployment>;
  sweepIdleDeployments: () => Promise<void>;
};

function makeManager(cluster: FakeK8sCluster) {
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
    patchNamespacedDeployment: vi.fn(
      async (request: {
        name: string;
        namespace: string;
        body: MergePatchBody;
      }) => cluster.patchDeployment(request),
    ),
  } as unknown as k8s.AppsV1Api;

  const customObjectsApi = {
    getAPIResources: vi.fn(async () => {
      throw NOT_FOUND;
    }),
  } as unknown as k8s.CustomObjectsApi;

  config.orchestrator.mcpIdleHibernation.betaEnabled = true;

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
  internals.namespace = NAMESPACE;
  internals.status = "running";

  return { manager, internals };
}

async function makeLocalInstall(fixtures: {
  makeOrganization: (
    overrides?: Record<string, unknown>,
  ) => Promise<{ id: string }>;
  makeInternalMcpCatalog: (
    overrides?: Record<string, unknown>,
  ) => Promise<{ id: string }>;
  makeMcpServer: (
    overrides?: Record<string, unknown>,
  ) => Promise<{ id: string; name: string }>;
}) {
  await fixtures.makeOrganization({ mcpIdleHibernationEnabled: true });
  const catalog = await fixtures.makeInternalMcpCatalog({
    name: "Seam Catalog",
    serverType: "local",
    localConfig: { command: "node", arguments: ["server.js"] },
  });
  const mcpServer = await fixtures.makeMcpServer({
    catalogId: catalog.id,
    name: "seam-server",
    deploymentName: DEPLOYMENT_NAME,
  });
  return { catalog, mcpServer };
}

/** A patch that scales to zero, i.e. one full hibernate/teardown cycle. */
function isHibernatePatch(body: MergePatchBody): boolean {
  return (
    body.spec?.replicas === 0 &&
    body.metadata?.annotations?.[MCP_HIBERNATED_ANNOTATION] === "true"
  );
}

describe("MCP idle hibernation vs a foreign owner of spec.replicas", () => {
  test("wake demand on another replica is never classified as a foreign owner", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const cluster = new FakeK8sCluster({ replicas: 1 });
    const replicaA = makeManager(cluster);
    const replicaB = makeManager(cluster);
    const { mcpServer } = await makeLocalInstall({
      makeOrganization,
      makeInternalMcpCatalog,
      makeMcpServer,
    });
    const deploymentA = await replicaA.manager.getOrLoadDeployment(
      mcpServer.id,
    );
    expect(deploymentA).toBeDefined();
    if (!deploymentA) return;
    deploymentA.syncStateFromSibling("pending");
    await deploymentA.refreshState();

    config.orchestrator.mcpIdleHibernation.windowSeconds = IDLE_WINDOW_SECONDS;
    await db
      .update(schema.mcpServersTable)
      .set({ lastUsedAt: new Date(Date.now() - IDLE_CUTOFF_MS - 60_000) })
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    await replicaA.internals.sweepIdleDeployments();
    expect(cluster.replicas).toBe(0);

    await replicaB.manager.getOrLoadDeployment(mcpServer.id);
    for (let wake = 0; wake < 2; wake++) {
      // Demand commits before wake on every request path. Replica A did not own
      // this wake, but the shared timestamp proves it was platform demand.
      await McpServerModel.updateLastUsed(mcpServer.id);
      await replicaB.manager.ensureAwake(mcpServer.id);
      await replicaA.manager.refreshAllStates();
      expect(cluster.replicas).toBe(1);

      vi.setSystemTime(new Date(Date.now() + IDLE_CUTOFF_MS + 60_000));
      await replicaA.internals.sweepIdleDeployments();
      expect(cluster.replicas).toBe(0);
      expect(
        cluster.annotations[MCP_FOREIGN_REPLICA_OWNER_ANNOTATION],
      ).toBeUndefined();
    }
    vi.useRealTimers();
  });

  test("repeated foreign scale-ups persist a cluster-wide hibernation opt-out", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const cluster = new FakeK8sCluster({ replicas: 1 });
    const { manager, internals } = makeManager(cluster);
    const { mcpServer } = await makeLocalInstall({
      makeOrganization,
      makeInternalMcpCatalog,
      makeMcpServer,
    });

    // Count the teardown side effects: every hibernate invalidates every
    // pooled MCP client for the group through this listener.
    let teardowns = 0;
    manager.registerHibernationListener(() => {
      teardowns++;
    });

    const deployment = await manager.getOrLoadDeployment(mcpServer.id);
    expect(deployment).toBeDefined();
    if (!deployment) return;
    deployment.syncStateFromSibling("pending");
    await deployment.refreshState();
    expect(deployment.statusSummary.state).toBe("running");

    // Idle, and nothing ever uses it again.
    config.orchestrator.mcpIdleHibernation.windowSeconds = IDLE_WINDOW_SECONDS;
    await db
      .update(schema.mcpServersTable)
      .set({ lastUsedAt: new Date(Date.now() - IDLE_CUTOFF_MS - 60_000) })
      .where(eq(schema.mcpServersTable.id, mcpServer.id));

    // Tick 1: idle by the clock, nothing else has laid claim to it, so it
    // sleeps exactly as it should.
    await internals.sweepIdleDeployments();
    expect(cluster.replicas).toBe(0);
    expect(cluster.annotations).toEqual({
      [MCP_HIBERNATED_ANNOTATION]: "true",
      [MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION]: "1",
    });
    expect(deployment.statusSummary.state).toBe("hibernated");

    // ArgoCD self-heal / an HPA / a manual scale writes ITS replica count
    // back. It does not touch our annotations, so the next status refresh sees
    // marker + availability and "finishes" a wake nobody asked for.
    cluster.externalWrite((c) => {
      c.replicas = 1;
    });
    await manager.refreshAllStates();
    expect(cluster.annotations).toEqual({});
    expect(deployment.statusSummary.state).toBe("running");

    // Keep emulating the foreign controller. Two unsolicited resumes are the
    // proof threshold; after that the manager writes a Kubernetes annotation
    // every replica sees and no later sweep fights the external owner.
    for (let tick = 0; tick < 20; tick++) {
      await internals.sweepIdleDeployments();
      if (cluster.replicas === 0) {
        cluster.externalWrite((c) => {
          c.replicas = 1;
        });
        await manager.refreshAllStates();
      }
    }

    const hibernatePatches = cluster.patchedIntents.filter(isHibernatePatch);

    expect(cluster.annotations[MCP_FOREIGN_REPLICA_OWNER_ANNOTATION]).toBe(
      "true",
    );
    expect({
      hibernatePatches: hibernatePatches.length,
      poolTeardowns: teardowns,
    }).toEqual({
      hibernatePatches: 2,
      poolTeardowns: 2,
    });

    await manager.ensureAwake(mcpServer.id);
    expect(cluster.annotations[MCP_FOREIGN_REPLICA_OWNER_ANNOTATION]).toBe(
      undefined,
    );
  });
});
