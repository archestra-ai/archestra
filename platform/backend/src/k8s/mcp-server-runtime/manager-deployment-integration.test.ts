// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

/**
 * Seam integration tests: the REAL {@link McpServerRuntimeManager} driving the
 * REAL {@link K8sDeployment}, with only the process boundary faked (the
 * `@kubernetes/client-node` API objects) and real `mcp_server` /
 * `internal_mcp_catalog` rows behind the manager's lazy load.
 *
 * `manager.test.ts` mocks `./k8s-deployment` wholesale and `k8s-deployment.test.ts`
 * never constructs a manager, so nothing else in the suite exercises the wiring
 * between them. That gap is not hypothetical: a cache-cold deployment (state
 * "not_created", whose `refreshState` early-returns) once made the manager's
 * wake silently do nothing while both sides' unit tests stayed green.
 *
 * Every assertion here is on an observable outcome — the merge-patch bodies that
 * reached the fake API server, the annotations/replicas the fake cluster is left
 * holding, and the resulting `statusSummary` — never on "a method was called".
 */
import type * as k8s from "@kubernetes/client-node";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import {
  MCP_HIBERNATED_ANNOTATION,
  MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION,
} from "@/k8s/shared";
import { MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS } from "@/models/mcp-server";
import { describe, expect, test } from "@/test";
import type K8sDeployment from "./k8s-deployment";
import { McpServerDeploymentFailedError } from "./k8s-deployment";
import { McpServerRuntimeManager, McpServerWakeError } from "./manager";
import type { K8sRuntimeStatus } from "./schemas";

const NAMESPACE = "seam-test-namespace";
const DEPLOYMENT_NAME = "mcp-seam-server";
const MERGE_PATCH_CONTENT_TYPE = "application/merge-patch+json";
const NOT_FOUND = { statusCode: 404, message: "not found" };

const IDLE_WINDOW_SECONDS = 300;
/** Idle window + the throttled-last-used-stamp grace the sweeper adds. */
const IDLE_CUTOFF_MS =
  IDLE_WINDOW_SECONDS * 1000 + MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS;

type MergePatchBody = {
  metadata?: {
    annotations?: Record<string, string | null>;
    resourceVersion?: string;
  };
  spec?: { replicas?: number };
};

const CONFLICT = { statusCode: 409, message: "the object has been modified" };

type RecordedPatch = {
  name: string;
  namespace: string;
  body: MergePatchBody;
  contentType: string | undefined;
};

/**
 * A single physical Deployment as the API server would hold it: replicas,
 * annotations, and a pod whose readiness the test schedules. Merge patches are
 * really applied (a `null` annotation value deletes the key), so the assertions
 * below read cluster truth rather than replaying the caller's intent.
 */
class FakeK8sCluster {
  readonly patches: RecordedPatch[] = [];
  exists = true;
  replicas: number;
  annotations: Record<string, string>;
  /**
   * The API server's optimistic-concurrency token: bumped by every write, and
   * the thing a patch's `metadata.resourceVersion` is checked against. This is
   * the whole cross-replica locking story — the cluster object IS the lock.
   */
  resourceVersion = 1;
  /** Terminal container waiting reason surfaced on the pod, if any. */
  containerWaitingReason: string | null = null;
  /** Deployment reads act as the clock the pod's readiness is scheduled on. */
  private deploymentReads = 0;
  private readyFromRead: number;

  constructor(init: {
    replicas: number;
    annotations?: Record<string, string>;
    /** false = the pod never comes up on its own (default true). */
    podComesUp?: boolean;
  }) {
    this.replicas = init.replicas;
    this.annotations = { ...init.annotations };
    this.readyFromRead =
      init.podComesUp === false ? Number.POSITIVE_INFINITY : 1;
  }

  /** From the read AFTER next onward, the scaled-up pod reports Running. */
  becomeReadyAfterNextRead(): void {
    this.readyFromRead = this.deploymentReads + 2;
  }

  get patchBodies(): MergePatchBody[] {
    return this.patches.map((patch) => patch.body);
  }

  /**
   * Patch bodies with the compare-and-swap precondition stripped, so tests
   * about WHAT was patched read cleanly. Whether a precondition was sent is
   * asserted separately — it is a different claim.
   */
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

  patchDeployment(
    request: { name: string; namespace: string; body: MergePatchBody },
    options: unknown,
  ): k8s.V1Deployment {
    if (!this.exists) throw NOT_FOUND;
    // A patch carrying a resourceVersion is a compare-and-swap: the API
    // server rejects it outright if anything else wrote to the object first.
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
      contentType: extractPatchContentType(options),
    });

    if (request.body.spec?.replicas !== undefined) {
      this.replicas = request.body.spec.replicas;
    }
    for (const [key, value] of Object.entries(
      request.body.metadata?.annotations ?? {},
    )) {
      // Merge-patch semantics: an explicit null deletes the key.
      if (value === null) delete this.annotations[key];
      else this.annotations[key] = value;
    }
    this.resourceVersion++;
    return this.readDeployment();
  }

  /** Any write by somebody else — an operator, a controller, a sibling pod. */
  externalWrite(mutate: (cluster: FakeK8sCluster) => void = () => {}): void {
    mutate(this);
    this.resourceVersion++;
  }

  listPods(labelSelector?: string): k8s.V1Pod[] {
    if (!this.exists || this.replicas === 0) return [];
    // Only the runtime's own selectors match; the network-policy probe's
    // selector must find nothing so capability discovery stays inconclusive.
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
                      message: this.containerWaitingReason
                        ? "container cannot be created"
                        : "creating container",
                    },
                  },
            },
          ],
        },
      } as unknown as k8s.V1Pod,
    ];
  }
}

/**
 * Recover the Content-Type a patch call's options carry: the client packs it
 * into middleware that stamps the outgoing request, so replay it on a recorder.
 * Merge-patch is load-bearing — it is what makes a null annotation a deletion.
 */
function extractPatchContentType(options: unknown): string | undefined {
  let contentType: string | undefined;
  const recorder = {
    setHeaderParam: (key: string, value: string) => {
      if (key === "Content-Type") contentType = value;
    },
  };
  const middleware =
    (options as { middleware?: Array<{ pre: (req: unknown) => unknown }> })
      ?.middleware ?? [];
  for (const entry of middleware) entry.pre(recorder);
  return contentType;
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

/**
 * A real manager whose K8s clients are the fake API server. The constructor's
 * own `loadKubeConfig()` is irrelevant here (it may fail on a machine with no
 * kubeconfig) — the clients and the runtime status are replaced outright, which
 * is the only injection point the manager exposes.
 */
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
      async (
        request: { name: string; namespace: string; body: MergePatchBody },
        options: unknown,
      ) => cluster.patchDeployment(request, options),
    ),
  } as unknown as k8s.AppsV1Api;

  const customObjectsApi = {
    // No CRDs served: capability discovery degrades to "no FQDN dialect".
    getAPIResources: vi.fn(async () => {
      throw NOT_FOUND;
    }),
  } as unknown as k8s.CustomObjectsApi;

  // Idle hibernation ships behind a beta flag that is off by default, and the
  // sweeper re-reads it on every tick — without it nothing in this seam sleeps.
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

/**
 * A local, single-tenant install whose deployment name is frozen, in an
 * organization that has opted into idle hibernation — the sweeper checks that
 * toggle on every tick, so without it nothing here would ever sleep.
 */
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

/** The exact body `hibernate()` must send for a deployment at `replicas`. */
function hibernatePatchBody(replicas: number): MergePatchBody {
  return {
    metadata: {
      annotations: {
        [MCP_HIBERNATED_ANNOTATION]: "true",
        [MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION]: String(replicas),
      },
    },
    spec: { replicas: 0 },
  };
}

/** The exact body `completeWake()` must send (null = delete the key). */
const COMPLETE_WAKE_PATCH_BODY: MergePatchBody = {
  metadata: {
    annotations: {
      [MCP_HIBERNATED_ANNOTATION]: null,
      [MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION]: null,
    },
  },
};

describe("McpServerRuntimeManager ↔ K8sDeployment hibernation seam", () => {
  test("renders log and diagnostic commands from the loaded deployment identity", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const cluster = new FakeK8sCluster({ replicas: 1 });
    const { manager } = makeManager(cluster);
    const { mcpServer } = await makeLocalInstall({
      makeOrganization,
      makeInternalMcpCatalog,
      makeMcpServer,
    });
    const deployment = await manager.getOrLoadDeployment(mcpServer.id);
    if (!deployment) throw new Error("deployment did not load");
    vi.spyOn(deployment, "getRecentLogs").mockResolvedValue("recent log line");

    await expect(manager.getMcpServerLogs(mcpServer.id, 42)).resolves.toEqual({
      logs: "recent log line",
      containerName: DEPLOYMENT_NAME,
      command: `kubectl logs -n ${NAMESPACE} deployment/${DEPLOYMENT_NAME} --tail=42`,
      namespace: NAMESPACE,
    });
    await expect(
      manager.getMcpServerLogsCommand(mcpServer.id, 42),
    ).resolves.toBe(
      `kubectl logs -n ${NAMESPACE} deployment/${DEPLOYMENT_NAME} --tail=42 -f`,
    );
    await expect(
      manager.getMcpServerDescribeCommand(mcpServer.id),
    ).resolves.toBe(
      `kubectl describe deployment -n ${NAMESPACE} ${DEPLOYMENT_NAME}`,
    );
    expect(manager.getExecCommand(mcpServer.id)).toContain(`-n ${NAMESPACE}`);
  });

  test("cache-cold wake: a deployment this process never loaded is scaled up and fully woken", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    // The cluster holds a hibernated deployment; this process has no
    // K8sDeployment for it at all (another replica hibernated it, or we
    // restarted since). The lazily built object starts "not_created", the
    // state refreshState refuses to evaluate — the exact shape of the bug
    // that shipped: the wake used to silently do nothing here.
    const cluster = new FakeK8sCluster({
      replicas: 0,
      annotations: { [MCP_HIBERNATED_ANNOTATION]: "true" },
    });
    const { manager, internals } = makeManager(cluster);
    const { mcpServer } = await makeLocalInstall({
      makeOrganization,
      makeInternalMcpCatalog,
      makeMcpServer,
    });
    expect(internals.mcpServerIdToDeploymentMap.has(mcpServer.id)).toBe(false);

    await manager.ensureAwake(mcpServer.id);

    // Scale-up first, annotation removal second — the order that makes a
    // half-woken deployment recognisable in between.
    expect(cluster.patchedIntents).toEqual([
      { spec: { replicas: 1 } },
      COMPLETE_WAKE_PATCH_BODY,
    ]);
    expect(cluster.patches.every((p) => p.name === DEPLOYMENT_NAME)).toBe(true);
    expect(cluster.patches.every((p) => p.namespace === NAMESPACE)).toBe(true);
    // Both annotations are really gone from the cluster object.
    expect(cluster.annotations).toEqual({});
    expect(cluster.replicas).toBe(1);

    const deployment = internals.mcpServerIdToDeploymentMap.get(mcpServer.id);
    expect(deployment?.statusSummary.state).toBe("running");
  });

  test("round trip on one physical deployment: hibernate at 2 replicas, wake back to 2", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    // An operator scaled this deployment to 2; hibernation must record that
    // and the wake must restore it, not reset to 1.
    const cluster = new FakeK8sCluster({ replicas: 2 });
    const { manager, internals } = makeManager(cluster);
    const { mcpServer } = await makeLocalInstall({
      makeOrganization,
      makeInternalMcpCatalog,
      makeMcpServer,
    });

    const deployment = await manager.getOrLoadDeployment(mcpServer.id);
    expect(deployment).toBeDefined();
    if (!deployment) return;
    // Seed the pre-refresh state a started deployment would carry, then let
    // cluster truth decide: refreshState is the real path to "running".
    deployment.syncStateFromSibling("pending");
    await deployment.refreshState();
    expect(deployment.statusSummary.state).toBe("running");

    // Idle past the window + stamp grace, with no in-flight use.
    config.orchestrator.mcpIdleHibernation.windowSeconds = IDLE_WINDOW_SECONDS;
    await db
      .update(schema.mcpServersTable)
      .set({ lastUsedAt: new Date(Date.now() - IDLE_CUTOFF_MS - 60_000) })
      .where(eq(schema.mcpServersTable.id, mcpServer.id));

    await internals.sweepIdleDeployments();

    expect(cluster.replicas).toBe(0);
    expect(cluster.annotations).toEqual({
      [MCP_HIBERNATED_ANNOTATION]: "true",
      [MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION]: "2",
    });
    expect(deployment.statusSummary.state).toBe("hibernated");
    // A hibernated deployment must not keep advertising its dead pod.
    expect(deployment.statusSummary.podName).toBeUndefined();

    await manager.ensureAwake(mcpServer.id);

    expect(cluster.patchedIntents).toEqual([
      hibernatePatchBody(2),
      { spec: { replicas: 2 } },
      COMPLETE_WAKE_PATCH_BODY,
    ]);
    // The annotation-removal patch must be a merge patch — that is the only
    // strategy under which a null value deletes the key rather than storing it.
    expect(cluster.patches.at(-1)?.contentType).toBe(MERGE_PATCH_CONTENT_TYPE);
    expect(cluster.replicas).toBe(2);
    expect(cluster.annotations).toEqual({});
    expect(deployment.statusSummary.state).toBe("running");

    // EVERY lifecycle write carries a compare-and-swap precondition, the
    // annotation removal included. It used to go out unconditional, justified
    // as "deleting keys is idempotent" — true of the merge operation, false of
    // the state: the marker is an ownership token bound to spec.replicas, so
    // landing this on top of a concurrent hibernate leaves `replicas: 0` with
    // no marker, which I1 forbids anything from ever waking.
    const [hibernatePatch, wakePatch, completeWakePatch] = cluster.patchBodies;
    expect(hibernatePatch.metadata?.resourceVersion).toBeDefined();
    expect(wakePatch.metadata?.resourceVersion).toBeDefined();
    expect(completeWakePatch.metadata?.resourceVersion).toBeDefined();
  });

  test("cache-cold with the annotation at replicas >= 1 resumes without a second scale-up", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    // A wake interrupted by a restart: beginWake landed, completeWake never
    // did. The replacement process must not re-issue the scale-up.
    const cluster = new FakeK8sCluster({
      replicas: 2,
      annotations: {
        [MCP_HIBERNATED_ANNOTATION]: "true",
        [MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION]: "2",
      },
    });
    const { manager, internals } = makeManager(cluster);
    const { mcpServer } = await makeLocalInstall({
      makeOrganization,
      makeInternalMcpCatalog,
      makeMcpServer,
    });

    await manager.ensureAwake(mcpServer.id);

    expect(cluster.patchedIntents).toEqual([COMPLETE_WAKE_PATCH_BODY]);
    expect(cluster.patchedIntents.some((body) => body.spec !== undefined)).toBe(
      false,
    );
    expect(cluster.replicas).toBe(2);
    expect(cluster.annotations).toEqual({});
    expect(
      internals.mcpServerIdToDeploymentMap.get(mcpServer.id)?.statusSummary
        .state,
    ).toBe("running");
  });

  test("cache-cold at replicas 0 WITHOUT the annotation is not ours — nothing is patched", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    // An operator scaled this deployment to zero. Waking it would override a
    // deliberate human decision.
    const cluster = new FakeK8sCluster({ replicas: 0 });
    const { manager } = makeManager(cluster);
    const { mcpServer } = await makeLocalInstall({
      makeOrganization,
      makeInternalMcpCatalog,
      makeMcpServer,
    });

    await manager.ensureAwake(mcpServer.id);

    expect(cluster.patches).toEqual([]);
    expect(cluster.replicas).toBe(0);
    expect(cluster.annotations).toEqual({});
  });

  test("a wake whose pod cannot start reports the real failure, keeps the annotation, and recovers through a status refresh", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const cluster = new FakeK8sCluster({
      replicas: 0,
      annotations: {
        [MCP_HIBERNATED_ANNOTATION]: "true",
        [MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION]: "1",
      },
      podComesUp: false,
    });
    // The scaled-up pod comes back in a terminal container state — a bad image
    // or config, not a slow start.
    cluster.containerWaitingReason = "CreateContainerConfigError";
    const { manager, internals } = makeManager(cluster);
    const { mcpServer } = await makeLocalInstall({
      makeOrganization,
      makeInternalMcpCatalog,
      makeMcpServer,
    });

    // NOT McpServerWakeError: telling the caller to "retry shortly" would loop
    // forever on a pod only an operator can fix, and would bury the reason.
    const error = await manager.ensureAwake(mcpServer.id).then(
      () => null,
      (thrown) => thrown,
    );
    expect(error).toBeInstanceOf(McpServerDeploymentFailedError);
    expect(error).not.toBeInstanceOf(McpServerWakeError);
    expect((error as Error).message).toContain("CreateContainerConfigError");

    // Scaled up, but the annotation deliberately stays: the sweeper only ever
    // considers cached-"running" deployments and a live read of annotation +
    // replicas >= 1 says "waking", so a half-woken deployment cannot be
    // re-hibernated out from under the recovery.
    expect(cluster.patchedIntents).toEqual([{ spec: { replicas: 1 } }]);
    expect(cluster.replicas).toBe(1);
    expect(cluster.annotations[MCP_HIBERNATED_ANNOTATION]).toBe("true");
    const deployment = internals.mcpServerIdToDeploymentMap.get(mcpServer.id);
    // A broken pod is the ordinary deployment lifecycle's problem, so the
    // cached state says so rather than pretending the server is asleep.
    expect(deployment?.statusSummary.state).toBe("failed");

    // The operator fixes the image. The status refresh — not another wake —
    // is what notices, and it finishes the half-done wake itself.
    cluster.containerWaitingReason = null;
    cluster.becomeReadyAfterNextRead();
    // Scaled up with the annotation still on it reads as "waking", never as a
    // failure that needs a human.
    await deployment?.refreshState();
    expect(deployment?.statusSummary.state).toBe("waking");
    // Once the pod actually reports available, the refresh drops the
    // annotations itself.
    await deployment?.refreshState();

    expect(cluster.patchedIntents).toEqual([
      { spec: { replicas: 1 } },
      COMPLETE_WAKE_PATCH_BODY,
    ]);
    expect(cluster.annotations).toEqual({});
    expect(deployment?.statusSummary.state).toBe("running");
  });

  test("self-heal: a status refresh finishes a wake whose annotation removal never landed", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    // Available replicas with the annotation still on the object: completeWake
    // failed (or its process died). Left alone the deployment reads "pending"
    // forever, so the ordinary status refresh has to finish the job.
    const cluster = new FakeK8sCluster({
      replicas: 1,
      annotations: {
        [MCP_HIBERNATED_ANNOTATION]: "true",
        [MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION]: "1",
      },
    });
    const { manager } = makeManager(cluster);
    const { mcpServer } = await makeLocalInstall({
      makeOrganization,
      makeInternalMcpCatalog,
      makeMcpServer,
    });

    const deployment = await manager.getOrLoadDeployment(mcpServer.id);
    expect(deployment).toBeDefined();
    if (!deployment) return;
    deployment.syncStateFromSibling("pending");

    await manager.refreshAllStates();

    expect(cluster.patchedIntents).toEqual([COMPLETE_WAKE_PATCH_BODY]);
    expect(cluster.patches.at(-1)?.contentType).toBe(MERGE_PATCH_CONTENT_TYPE);
    expect(cluster.annotations).toEqual({});
    expect(cluster.replicas).toBe(1);
    expect(deployment.statusSummary.state).toBe("running");
  });

  describe("cross-replica concurrency (resourceVersion compare-and-swap)", () => {
    /** One idle, running install ready for a sweep, in its own manager. */
    async function makeIdleCandidate(
      cluster: FakeK8sCluster,
      fixtures: {
        makeOrganization: (
          overrides?: Record<string, unknown>,
        ) => Promise<{ id: string }>;
        makeInternalMcpCatalog: (
          overrides?: Record<string, unknown>,
        ) => Promise<{ id: string }>;
        makeMcpServer: (
          overrides?: Record<string, unknown>,
        ) => Promise<{ id: string; name: string }>;
      },
      mcpServerId?: string,
    ) {
      const { manager, internals } = makeManager(cluster);
      const mcpServer = mcpServerId
        ? { id: mcpServerId }
        : (await makeLocalInstall(fixtures)).mcpServer;
      const deployment = await manager.getOrLoadDeployment(mcpServer.id);
      if (!deployment) throw new Error("deployment did not load");
      deployment.syncStateFromSibling("pending");
      await deployment.refreshState();
      return { manager, internals, deployment, mcpServer };
    }

    test("two replicas sweeping the same deployment: exactly one scale-to-zero lands", async ({
      makeOrganization,
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      // Two Archestra pods hold their own K8sDeployment for ONE physical
      // Deployment and sweep on their own timers. Without a compare-and-swap
      // both would patch: the loser would record a pre-hibernation replica
      // count of 0 (read after the winner scaled it down) and a later wake
      // would "restore" the deployment to a single replica it never had.
      const cluster = new FakeK8sCluster({ replicas: 3 });
      const fixtures = {
        makeOrganization,
        makeInternalMcpCatalog,
        makeMcpServer,
      };
      const first = await makeIdleCandidate(cluster, fixtures);
      // Second "replica": a distinct manager over the SAME install and the
      // same fake cluster.
      const second = await makeIdleCandidate(
        cluster,
        fixtures,
        first.mcpServer.id,
      );
      expect(first.deployment.statusSummary.state).toBe("running");
      expect(second.deployment.statusSummary.state).toBe("running");

      config.orchestrator.mcpIdleHibernation.windowSeconds =
        IDLE_WINDOW_SECONDS;
      await db
        .update(schema.mcpServersTable)
        .set({ lastUsedAt: new Date(Date.now() - IDLE_CUTOFF_MS - 60_000) })
        .where(eq(schema.mcpServersTable.id, first.mcpServer.id));

      await Promise.all([
        first.internals.sweepIdleDeployments(),
        second.internals.sweepIdleDeployments(),
      ]);

      // Exactly one write reached the API server, and it recorded the real
      // pre-hibernation count.
      expect(cluster.patchedIntents).toEqual([hibernatePatchBody(3)]);
      expect(cluster.replicas).toBe(0);
      expect(cluster.annotations).toEqual({
        [MCP_HIBERNATED_ANNOTATION]: "true",
        [MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION]: "3",
      });

      // The loser converged rather than erroring: whichever manager lost sees
      // the deployment as hibernated too (either from its own patch or from
      // the idempotent already-at-zero path).
      const states = [
        first.deployment.statusSummary.state,
        second.deployment.statusSummary.state,
      ];
      expect(states).toContain("hibernated");
      expect(states).not.toContain("failed");
    });

    test("an operator patch between the read and the patch aborts the hibernate cleanly", async ({
      makeOrganization,
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      // Never hibernate on doubt: the replica count this sweep read is now
      // stale, so recording it would scale the operator's change away on the
      // next wake. Abandon the attempt and let the next sweep re-evaluate.
      const cluster = new FakeK8sCluster({ replicas: 1 });
      const { internals, deployment, mcpServer } = await makeIdleCandidate(
        cluster,
        { makeOrganization, makeInternalMcpCatalog, makeMcpServer },
      );
      expect(deployment.statusSummary.state).toBe("running");

      config.orchestrator.mcpIdleHibernation.windowSeconds =
        IDLE_WINDOW_SECONDS;
      await db
        .update(schema.mcpServersTable)
        .set({ lastUsedAt: new Date(Date.now() - IDLE_CUTOFF_MS - 60_000) })
        .where(eq(schema.mcpServersTable.id, mcpServer.id));

      // Somebody scales the deployment up the instant after hibernate() has
      // read it — the last read hibernate() performs is its own live read.
      const appsApi = (
        internals as unknown as {
          k8sAppsApi: { readNamespacedDeployment: ReturnType<typeof vi.fn> };
        }
      ).k8sAppsApi;
      const readSpy = appsApi.readNamespacedDeployment;
      readSpy.mockImplementation(async () => {
        const read = cluster.readDeployment();
        cluster.externalWrite((c) => {
          c.replicas = 5;
        });
        return read;
      });

      await expect(internals.sweepIdleDeployments()).resolves.toBeUndefined();

      // Nothing was patched, the operator's scale stands, and the deployment
      // was never marked asleep.
      expect(cluster.patches).toEqual([]);
      expect(cluster.replicas).toBe(5);
      expect(cluster.annotations).toEqual({});
      expect(deployment.statusSummary.state).not.toBe("hibernated");
    });
  });
});
