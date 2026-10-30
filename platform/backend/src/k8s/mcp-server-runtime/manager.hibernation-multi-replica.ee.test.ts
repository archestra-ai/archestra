// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

/**
 * Two Archestra web replicas sweeping the SAME physical multitenant Deployment
 * on independent timers, against one shared database.
 *
 * Everything hibernation gets wrong at one replica is invisible here; the bugs
 * this file exists for are the ones that only appear when a second process is
 * making its own decisions about the same Deployment. A FakeK8sCluster really
 * applies merge patches and enforces resourceVersion CAS, driving the REAL
 * manager / K8sDeployment / sweeper.
 */
import type * as k8s from "@kubernetes/client-node";
import { inArray } from "drizzle-orm";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import {
  MCP_HIBERNATED_ANNOTATION,
  MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION,
} from "@/k8s/shared";
import { OrganizationModel } from "@/models";
import { MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS } from "@/models/mcp-server";
import { mcpActiveUseTracker } from "@/services/mcp-active-use.ee";
import { describe, expect, test } from "@/test";
import type K8sDeployment from "./k8s-deployment";
import { McpServerRuntimeManager } from "./manager";
import type { K8sRuntimeStatus } from "./schemas";

const NAMESPACE = "multi-replica-namespace";
const NOT_FOUND = { statusCode: 404, message: "not found" };
const CONFLICT = { statusCode: 409, message: "the object has been modified" };

const IDLE_WINDOW_SECONDS = 300;
// Window + the sweeper's grace, which is one persistence interval plus one
// demand-heartbeat tick (the heartbeat runs at half the persistence interval).
const IDLE_CUTOFF_MS =
  IDLE_WINDOW_SECONDS * 1000 +
  MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS +
  MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS / 2;

type MergePatchBody = {
  metadata?: {
    annotations?: Record<string, string | null>;
    resourceVersion?: string;
  };
  spec?: { replicas?: number };
};

type RecordedPatch = { name: string; body: MergePatchBody };

class FakeK8sCluster {
  readonly patches: RecordedPatch[] = [];
  exists = true;
  replicas: number;
  annotations: Record<string, string>;
  resourceVersion = 1;
  private deploymentReads = 0;
  private readyFromRead = 1;
  private deploymentName: string;

  constructor(init: {
    deploymentName: string;
    replicas: number;
    annotations?: Record<string, string>;
  }) {
    this.deploymentName = init.deploymentName;
    this.replicas = init.replicas;
    this.annotations = { ...init.annotations };
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
    return this.replicas > 0 && this.deploymentReads >= this.readyFromRead;
  }

  readDeployment(): k8s.V1Deployment {
    if (!this.exists) throw NOT_FOUND;
    this.deploymentReads++;
    return {
      metadata: {
        name: this.deploymentName,
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

  patchDeployment(
    request: { name: string; namespace: string; body: MergePatchBody },
    _options: unknown,
  ): k8s.V1Deployment {
    if (!this.exists) throw NOT_FOUND;
    const precondition = request.body.metadata?.resourceVersion;
    if (
      precondition !== undefined &&
      precondition !== String(this.resourceVersion)
    ) {
      throw CONFLICT;
    }
    this.patches.push({ name: request.name, body: request.body });
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
          name: `${this.deploymentName}-6d4f9c7b5-abcde`,
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
                      reason: "ContainerCreating",
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

/** One Archestra web replica: its own manager over the SHARED fake cluster. */
function makeReplica(cluster: FakeK8sCluster) {
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
      async (
        request: { name: string; namespace: string; body: MergePatchBody },
        options: unknown,
      ) => cluster.patchDeployment(request, options),
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

describe("MCP idle hibernation across replicas", () => {
  test("a replica that sweeps a deployment another replica already put to sleep keeps that read, and can still wake it", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const org = await makeOrganization({ mcpIdleHibernationEnabled: true });
    // Multitenant catalog: ONE physical Deployment, two installs, two alias
    // K8sDeployment objects per replica.
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "Shared Catalog",
      serverType: "local",
      multitenant: true,
      localConfig: { command: "node", arguments: ["server.js"] },
    });
    const install1 = await makeMcpServer({
      catalogId: catalog.id,
      name: "shared-install-1",
    });
    const install2 = await makeMcpServer({
      catalogId: catalog.id,
      name: "shared-install-2",
    });

    const catalogRow = (
      await db
        .select()
        .from(schema.internalMcpCatalogTable)
        .where(inArray(schema.internalMcpCatalogTable.id, [catalog.id]))
    )[0];
    const deploymentName = catalogRow.deploymentName;
    expect(deploymentName).toBeTruthy();
    if (!deploymentName) return;

    const cluster = new FakeK8sCluster({ deploymentName, replicas: 1 });

    // Two web replicas, each holding BOTH aliases, all cached "running".
    const replicaA = makeReplica(cluster);
    const replicaB = makeReplica(cluster);
    const aliases: Record<string, K8sDeployment[]> = { A: [], B: [] };
    for (const [label, replica] of [
      ["A", replicaA],
      ["B", replicaB],
    ] as const) {
      for (const id of [install1.id, install2.id]) {
        const deployment = await replica.manager.getOrLoadDeployment(id);
        if (!deployment) throw new Error(`alias ${label}/${id} did not load`);
        deployment.syncStateFromSibling("pending");
        await deployment.refreshState();
        aliases[label].push(deployment);
      }
    }
    // Both aliases on both replicas point at the SAME physical deployment.
    expect(
      new Set(
        [...aliases.A, ...aliases.B].map(
          (d) => `${d.k8sNamespace}/${d.k8sDeploymentName}`,
        ),
      ).size,
    ).toBe(1);
    expect(aliases.A.map((d) => d.statusSummary.state)).toEqual([
      "running",
      "running",
    ]);
    expect(aliases.B.map((d) => d.statusSummary.state)).toEqual([
      "running",
      "running",
    ]);

    // The whole group is idle.
    config.orchestrator.mcpIdleHibernation.windowSeconds = IDLE_WINDOW_SECONDS;
    await db
      .update(schema.mcpServersTable)
      .set({ lastUsedAt: new Date(Date.now() - IDLE_CUTOFF_MS - 60_000) })
      .where(inArray(schema.mcpServersTable.id, [install1.id, install2.id]));

    // (1) Replica A's sweep tick wins: it CAS-patches replicas=0 + annotations
    //     and mirrors "hibernated" onto BOTH of its aliases.
    await replicaA.internals.sweepIdleDeployments();

    expect(cluster.replicas).toBe(0);
    expect(cluster.annotations).toEqual({
      [MCP_HIBERNATED_ANNOTATION]: "true",
      [MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION]: "1",
    });
    expect(aliases.A.map((d) => d.statusSummary.state)).toEqual([
      "hibernated",
      "hibernated",
    ]);

    // (2) Replica B's sweep tick fires a moment later. Its candidate dedupe
    //     picks ONE alias, which passes every idle check and then performs the
    //     seizure-guard live read at hibernation.ee.ts:517 — seeing exactly the
    //     truth: replicas 0 with our annotation.
    const patchesBeforeBSweep = cluster.patches.length;
    await replicaB.internals.sweepIdleDeployments();
    // B correctly patched nothing (the deployment is already asleep).
    expect(cluster.patches.length).toBe(patchesBeforeBSweep);

    // ...and that definitive read must be KEPT. Discarding it left B caching
    // "running" for a deployment it had just seen asleep, and ensureAwake's
    // fast path then refused to wake it — so every tool call B routed to this
    // server went to a pod that was not there.
    const bStatesAfterSweep = aliases.B.map((d) => d.statusSummary.state);

    // (3) A tool call for install2 arrives on replica B. ensureAwake must make
    //     the deployment awake before the caller reaches it.
    const patchesBeforeWake = cluster.patches.length;
    await replicaB.manager.ensureAwake(install2.id);
    const wakePatchCount = cluster.patches.length - patchesBeforeWake;

    expect({
      bAliasStatesAfterItsOwnSweep: bStatesAfterSweep,
      dormantOnB: replicaB.manager.isDeploymentDormant(install2.id),
      patchesIssuedByEnsureAwakeOnB: wakePatchCount,
      clusterReplicasAfterEnsureAwake: cluster.replicas,
      clusterAnnotationsAfterEnsureAwake: cluster.annotations,
    }).toEqual({
      bAliasStatesAfterItsOwnSweep: ["hibernated", "hibernated"],
      // The wake above ran, so it is awake again — the point is that B was
      // able to reach that conclusion at all.
      dormantOnB: false,
      patchesIssuedByEnsureAwakeOnB: 2,
      clusterReplicasAfterEnsureAwake: 1,
      clusterAnnotationsAfterEnsureAwake: {},
    });
  });

  test("CONTROL: hibernate() itself would have converged the alias, and mirroring converges the group", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const org = await makeOrganization({ mcpIdleHibernationEnabled: true });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "Repro5 Control Catalog",
      serverType: "local",
      multitenant: true,
      localConfig: { command: "node", arguments: ["server.js"] },
    });
    const install1 = await makeMcpServer({
      catalogId: catalog.id,
      name: "repro5c-install-1",
    });
    const install2 = await makeMcpServer({
      catalogId: catalog.id,
      name: "repro5c-install-2",
    });
    const catalogRow = (
      await db
        .select()
        .from(schema.internalMcpCatalogTable)
        .where(inArray(schema.internalMcpCatalogTable.id, [catalog.id]))
    )[0];
    const deploymentName = catalogRow.deploymentName;
    if (!deploymentName) throw new Error("no multitenant deployment name");

    // The cluster is ALREADY asleep (replica A hibernated it), and replica B
    // holds both aliases cached "running".
    const cluster = new FakeK8sCluster({
      deploymentName,
      replicas: 0,
      annotations: {
        [MCP_HIBERNATED_ANNOTATION]: "true",
        [MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION]: "1",
      },
    });
    const replicaB = makeReplica(cluster);
    const aliasOne = await replicaB.manager.getOrLoadDeployment(install1.id);
    const aliasTwo = await replicaB.manager.getOrLoadDeployment(install2.id);
    if (!aliasOne || !aliasTwo) throw new Error("aliases did not load");
    aliasOne.syncStateFromSibling("running");
    aliasTwo.syncStateFromSibling("running");

    // (a) hibernate() — the call the seizure guard returns BEFORE reaching —
    //     recognises the already-asleep deployment and converges the alias it
    //     was called on, without patching anything.
    const result = await aliasOne.hibernate();
    expect(result).toEqual({ hibernated: false, reason: "already-hibernated" });
    expect(cluster.patches).toEqual([]);
    expect(aliasOne.statusSummary.state).toBe("hibernated");
    // The SIBLING alias is still wrong: line 534 returns before the mirroring
    // at line 535, so `hibernate()`'s own convergence covers one alias only.
    expect(aliasTwo.statusSummary.state).toBe("running");

    // (b) With the group mirrored (what the fix would do), the demand path on
    //     replica B wakes the deployment normally.
    aliasTwo.syncStateFromSibling("hibernated");
    await replicaB.manager.ensureAwake(install2.id);
    expect(cluster.replicas).toBe(1);
    expect(cluster.annotations).toEqual({});

    // (c) Blast radius: the wrong state is not permanent — a full status
    //     refresh converges it. It is the window until then that is the bug.
    const cluster2 = new FakeK8sCluster({
      deploymentName,
      replicas: 0,
      annotations: {
        [MCP_HIBERNATED_ANNOTATION]: "true",
        [MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION]: "1",
      },
    });
    const replicaC = makeReplica(cluster2);
    const cAliasOne = await replicaC.manager.getOrLoadDeployment(install1.id);
    const cAliasTwo = await replicaC.manager.getOrLoadDeployment(install2.id);
    if (!cAliasOne || !cAliasTwo) throw new Error("aliases did not load");
    cAliasOne.syncStateFromSibling("running");
    cAliasTwo.syncStateFromSibling("running");
    await replicaC.manager.refreshAllStates();
    expect([
      cAliasOne.statusSummary.state,
      cAliasTwo.statusSummary.state,
    ]).toEqual(["hibernated", "hibernated"]);
  });

  test("a call still running on one replica is not hibernated by another replica's sweeper", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    // Demand tracking used to be entirely process-local: replica A holding a
    // call open told replica B nothing, and B's sweeper — which reads only
    // mcp_server.last_used_at — scaled the deployment to zero underneath the
    // running call. MCP Tasks make that ordinary rather than exotic, since a
    // task may run for half an hour against an idle window whose floor is two
    // minutes.
    //
    // This also pins the arithmetic of the idle cutoff. An undefined term in
    // it makes the whole cutoff NaN, every `>=` against it false, and so every
    // candidate hibernates no matter how recently it was used — which is a
    // far worse failure than the one this test was written for, and is only
    // visible from a case that expects a server NOT to sleep.
    const org = await makeOrganization({ mcpIdleHibernationEnabled: true });
    await OrganizationModel.getMcpIdleHibernationEnabled();
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "Busy Catalog",
      serverType: "local",
      multitenant: true,
      localConfig: { command: "node", arguments: ["server.js"] },
    });
    const install = await makeMcpServer({
      catalogId: catalog.id,
      name: "busy-install",
    });
    const catalogRow = (
      await db
        .select()
        .from(schema.internalMcpCatalogTable)
        .where(inArray(schema.internalMcpCatalogTable.id, [catalog.id]))
    )[0];
    const deploymentName = catalogRow.deploymentName;
    expect(deploymentName).toBeTruthy();
    if (!deploymentName) return;

    const cluster = new FakeK8sCluster({ deploymentName, replicas: 1 });
    const replicaA = makeReplica(cluster);
    const replicaB = makeReplica(cluster);
    for (const replica of [replicaA, replicaB]) {
      const deployment = await replica.manager.getOrLoadDeployment(install.id);
      if (!deployment) throw new Error("alias did not load");
      deployment.syncStateFromSibling("pending");
      await deployment.refreshState();
    }

    // Idle long ago by the clock, so it would be swept on sight.
    config.orchestrator.mcpIdleHibernation.windowSeconds = IDLE_WINDOW_SECONDS;
    await db
      .update(schema.mcpServersTable)
      .set({ lastUsedAt: new Date(Date.now() - IDLE_CUTOFF_MS - 60_000) })
      .where(inArray(schema.mcpServersTable.id, [install.id]));
    // Forget what this process already persisted, so the throttle does not
    // suppress the entry stamp below: loading the deployment stamped it
    // moments ago, and the row update above is a shortcut the tracker cannot
    // observe.
    mcpActiveUseTracker.remove(install.id);

    // A long call starts on replica A and is still running. trackActiveUse
    // commits its entry stamp before the body runs, so B can see it.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlight = mcpActiveUseTracker.trackActiveUse(install.id, () => held);
    await new Promise((resolve) => setImmediate(resolve));

    // Replica B is a different PROCESS, so it has no in-memory knowledge of
    // A's call at all. The tracker is a singleton within this test process, so
    // blind it for the duration of B's sweep: the persisted row is the only
    // channel that may carry the demand, which is the real multi-replica case.
    const patchesBeforeSweep = cluster.patches.length;
    const activeCount = vi
      .spyOn(mcpActiveUseTracker, "getActiveUseCount")
      .mockReturnValue(0);
    const inMemoryUsage = vi
      .spyOn(mcpActiveUseTracker, "getInMemoryLastUsedAt")
      .mockReturnValue(null);
    try {
      await replicaB.internals.sweepIdleDeployments();
    } finally {
      activeCount.mockRestore();
      inMemoryUsage.mockRestore();
    }

    expect({
      patchesIssuedByBsSweep: cluster.patches.length - patchesBeforeSweep,
      replicas: cluster.replicas,
      annotations: cluster.annotations,
    }).toEqual({
      patchesIssuedByBsSweep: 0,
      replicas: 1,
      annotations: {},
    });

    release();
    await inFlight;
  });

  test("a wake whose annotation drop loses to an operator's re-zero fails retryably instead of reporting running", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const org = await makeOrganization({ mcpIdleHibernationEnabled: true });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "Raced Wake Catalog",
      serverType: "local",
      multitenant: true,
      localConfig: { command: "node", arguments: ["server.js"] },
    });
    const install = await makeMcpServer({
      catalogId: catalog.id,
      name: "raced-wake-install",
    });
    const catalogRow = (
      await db
        .select()
        .from(schema.internalMcpCatalogTable)
        .where(inArray(schema.internalMcpCatalogTable.id, [catalog.id]))
    )[0];
    const deploymentName = catalogRow.deploymentName;
    expect(deploymentName).toBeTruthy();
    if (!deploymentName) return;

    const cluster = new FakeK8sCluster({ deploymentName, replicas: 1 });
    const replica = makeReplica(cluster);
    const deployment = await replica.manager.getOrLoadDeployment(install.id);
    if (!deployment) throw new Error("the deployment did not load");
    deployment.syncStateFromSibling("pending");
    await deployment.refreshState();
    expect(deployment.statusSummary.state).toBe("running");

    // Another replica's sweep put it to sleep; this replica observes that.
    cluster.replicas = 0;
    cluster.annotations = {
      [MCP_HIBERNATED_ANNOTATION]: "true",
      [MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION]: "1",
    };
    cluster.resourceVersion++;
    await deployment.refreshState();
    expect(deployment.statusSummary.state).toBe("hibernated");

    // The operator's part: the moment completeWake tries to drop the marker,
    // scale the still-annotated deployment back to zero. The write the wake
    // then sends carries a stale resourceVersion and loses its CAS — the
    // window between readiness and the annotation drop, hit deterministically.
    const originalPatch = cluster.patchDeployment.bind(cluster);
    let operatorFired = false;
    cluster.patchDeployment = (request, options) => {
      const dropsMarker =
        request.body.metadata?.annotations?.[MCP_HIBERNATED_ANNOTATION] ===
        null;
      if (dropsMarker && !operatorFired) {
        operatorFired = true;
        cluster.replicas = 0;
        cluster.resourceVersion++;
      }
      return originalPatch(request, options);
    };

    // The wake must fail in its retryable shape, not dispatch: reporting
    // "running" here would send the caller's tool call at a Service with
    // nothing behind it and cache a state the cluster contradicts.
    await expect(replica.manager.ensureAwake(install.id)).rejects.toThrow(
      /superseded by a concurrent transition/,
    );
    expect(operatorFired).toBe(true);
    expect(deployment.statusSummary.state).toBe("hibernated");
    expect(cluster.annotations[MCP_HIBERNATED_ANNOTATION]).toBe("true");
    expect(cluster.replicas).toBe(0);

    // Retryable for real: with the operator gone, the next demand completes
    // the whole wake and the marker comes off.
    await replica.manager.ensureAwake(install.id);
    expect(deployment.statusSummary.state).toBe("running");
    expect(cluster.annotations[MCP_HIBERNATED_ANNOTATION]).toBeUndefined();
    expect(cluster.replicas).toBe(1);
  });
});
