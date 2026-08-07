import { RouteId } from "@archestra/shared";
import type * as k8s from "@kubernetes/client-node";
import { and, eq } from "drizzle-orm";
import { type Mock, vi } from "vitest";
import db, { schema } from "@/database";
import { McpServerRuntimeManager } from "@/k8s/mcp-server-runtime";
import K8sDeployment from "@/k8s/mcp-server-runtime/k8s-deployment";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { AuditEventName, User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

const NAMESPACE = "hard-reset-test-namespace";
const DEPLOYMENT_NAME = "mcp-wedged-server";
const POD_NAME = `${DEPLOYMENT_NAME}-6d4f9c7b5-abcde`;
const NOT_FOUND = { statusCode: 404, message: "not found" };

type FakePod = {
  deployment: string;
  labels: Record<string, string>;
  phase: string;
  waitingReason?: string;
};

/**
 * The slice of the cluster a hard reset acts on: the Deployments in one
 * namespace and the pods behind them, with the delete cascade Kubernetes
 * performs and the label selectors it answers pod lists with.
 */
class FakeCluster {
  readonly deployments = new Set<string>([DEPLOYMENT_NAME]);
  readonly pods = new Map<string, FakePod>();
  readonly deletedDeployments: string[] = [];
  readonly createdDeployments: string[] = [];
  readonly deletedPods: Array<{ name: string; gracePeriodSeconds?: number }> =
    [];
  /** Recreated pods come up wedged instead of Running. */
  rebuildComesUp = true;
  /** Pod reads fail in the window where the Deployment is already gone. */
  failPodListsWhileDeploymentIsGone = false;

  get deploymentExists(): boolean {
    return this.deployments.has(DEPLOYMENT_NAME);
  }

  addPod(params: {
    name: string;
    deployment: string;
    mcpServerId: string;
  }): void {
    this.pods.set(params.name, {
      deployment: params.deployment,
      labels: { app: "mcp-server", "mcp-server-id": params.mcpServerId },
      phase: "Running",
    });
  }

  readDeployment(name: string): k8s.V1Deployment {
    if (!this.deployments.has(name)) throw NOT_FOUND;
    const available = [...this.pods.values()].some(
      (pod) => pod.deployment === name && pod.phase === "Running",
    )
      ? 1
      : 0;
    return {
      metadata: {
        name,
        namespace: NAMESPACE,
        annotations: {},
        resourceVersion: "1",
      },
      spec: { replicas: 1, selector: { matchLabels: {} } },
      status: { availableReplicas: available, readyReplicas: available },
    } as k8s.V1Deployment;
  }

  deleteDeployment(name: string): void {
    this.deletedDeployments.push(name);
    this.deployments.delete(name);
    for (const [podName, pod] of this.pods) {
      if (pod.deployment === name) this.pods.delete(podName);
    }
  }

  createDeployment(name: string, podLabels: Record<string, string>): void {
    this.createdDeployments.push(name);
    this.deployments.add(name);
    this.pods.set(`${name}-7c5f8d9a1-fghij`, {
      deployment: name,
      labels: podLabels,
      phase: this.rebuildComesUp ? "Running" : "Pending",
      waitingReason: this.rebuildComesUp
        ? undefined
        : "CreateContainerConfigError",
    });
  }

  deletePod(name: string, gracePeriodSeconds?: number): void {
    this.deletedPods.push({ name, gracePeriodSeconds });
    this.pods.delete(name);
  }

  listPods(labelSelector?: string): k8s.V1Pod[] {
    return [...this.pods]
      .filter(([, pod]) => matchesSelector(pod.labels, labelSelector))
      .map(
        ([name, pod]) =>
          ({
            metadata: { name, namespace: NAMESPACE, labels: pod.labels },
            status: {
              phase: pod.phase,
              containerStatuses: pod.waitingReason
                ? [
                    {
                      name: "mcp-server",
                      restartCount: 0,
                      state: {
                        waiting: {
                          reason: pod.waitingReason,
                          message: "referenced config is missing",
                        },
                      },
                    },
                  ]
                : [],
            },
          }) as unknown as k8s.V1Pod,
      );
  }
}

/** AND semantics over `key=value` terms, exactly as Kubernetes applies them. */
function matchesSelector(
  labels: Record<string, string>,
  labelSelector?: string,
): boolean {
  if (!labelSelector) return true;
  return labelSelector.split(",").every((term) => {
    const [key, value] = term.split("=");
    return labels[key] === value;
  });
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
  status: string;
  mcpServerIdToDeploymentMap: Map<string, unknown>;
  hardResetInFlightByPhysicalKey: Map<string, unknown>;
};

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition was never met");
}

/** {@link waitUntil} for a test whose `setTimeout` is faked. */
async function waitOnTicks(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 5000; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was never met");
}

/**
 * Point the runtime singleton the routes use at the fake cluster. Replacing the
 * clients outright is the only injection point the manager exposes; its own
 * `loadKubeConfig()` is irrelevant here (there is no kubeconfig in tests).
 */
function useFakeCluster(cluster: FakeCluster, deploymentDelay?: Promise<void>) {
  const coreApi = {
    listNamespacedPod: vi.fn(
      async ({ labelSelector }: { labelSelector?: string }) => {
        if (
          cluster.failPodListsWhileDeploymentIsGone &&
          !cluster.deploymentExists
        ) {
          throw new Error("pods is forbidden");
        }
        return { items: cluster.listPods(labelSelector) };
      },
    ),
    deleteNamespacedPod: vi.fn(
      async ({
        name,
        gracePeriodSeconds,
      }: {
        name: string;
        gracePeriodSeconds?: number;
      }) => {
        cluster.deletePod(name, gracePeriodSeconds);
        return {};
      },
    ),
    readNamespacedPod: vi.fn(async () => {
      throw NOT_FOUND;
    }),
    readNamespacedPodLog: vi.fn(async () => ""),
    listNamespacedEvent: vi.fn(async () => ({ items: [] })),
    listNamespacedSecret: vi.fn(async () => ({ items: [] })),
    createNamespacedSecret: vi.fn(async () => ({})),
    replaceNamespacedSecret: vi.fn(async () => ({})),
    deleteNamespacedSecret: vi.fn(async () => {
      throw NOT_FOUND;
    }),
    readNamespacedService: vi.fn(async () => {
      throw NOT_FOUND;
    }),
    createNamespacedService: vi.fn(async () => ({})),
    patchNamespacedService: vi.fn(async () => ({})),
    deleteNamespacedService: vi.fn(async () => {
      throw NOT_FOUND;
    }),
    listNode: vi.fn(async () => ({ items: [] })),
  } as unknown as k8s.CoreV1Api;

  const appsApi = {
    readNamespacedDeployment: vi.fn(async ({ name }: { name: string }) =>
      cluster.readDeployment(name),
    ),
    createNamespacedDeployment: vi.fn(async ({ body }: { body: unknown }) => {
      const deployment = body as k8s.V1Deployment;
      cluster.createDeployment(
        deployment.metadata?.name ?? DEPLOYMENT_NAME,
        deployment.spec?.template?.metadata?.labels ?? {},
      );
      return {};
    }),
    deleteNamespacedDeployment: vi.fn(async ({ name }: { name: string }) => {
      cluster.deleteDeployment(name);
      // Held open by the concurrency tests so a second request provably
      // arrives while the first teardown is still running.
      await deploymentDelay;
      return {};
    }),
    patchNamespacedDeployment: vi.fn(async ({ name }: { name: string }) =>
      cluster.readDeployment(name),
    ),
  } as unknown as k8s.AppsV1Api;

  const networkingApi = {
    createNamespacedNetworkPolicy: vi.fn(async () => ({})),
    replaceNamespacedNetworkPolicy: vi.fn(async () => ({})),
    deleteNamespacedNetworkPolicy: vi.fn(async () => {
      throw NOT_FOUND;
    }),
  } as unknown as k8s.NetworkingV1Api;

  const customObjectsApi = {
    // No CRDs served: network-policy capability discovery degrades gracefully.
    getAPIResources: vi.fn(async () => {
      throw NOT_FOUND;
    }),
    getNamespacedCustomObject: vi.fn(async () => {
      throw NOT_FOUND;
    }),
    createNamespacedCustomObject: vi.fn(async () => ({})),
    replaceNamespacedCustomObject: vi.fn(async () => ({})),
    deleteNamespacedCustomObject: vi.fn(async () => {
      throw NOT_FOUND;
    }),
  } as unknown as k8s.CustomObjectsApi;

  const internals = McpServerRuntimeManager as unknown as ManagerInternals;
  internals.k8sApi = coreApi;
  internals.k8sAppsApi = appsApi;
  internals.k8sAuthApi = {} as k8s.AuthorizationV1Api;
  internals.k8sNetworkingApi = networkingApi;
  internals.k8sCustomObjectsApi = customObjectsApi;
  internals.k8sAttach = {} as k8s.Attach;
  internals.k8sLog = {} as k8s.Log;
  internals.k8sExec = {} as k8s.Exec;
  internals.namespace = NAMESPACE;
  internals.status = "running";
  internals.mcpServerIdToDeploymentMap.clear();
  internals.hardResetInFlightByPhysicalKey.clear();
  return internals;
}

describe("POST /api/mcp_server/:id/hard-reset", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let cluster: FakeCluster;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    user = await makeUser();
    organizationId = (await makeOrganization()).id;
    // `mcp_server` has no org column; org membership is inferred through the
    // owner's membership row, which the org-scoped lookup and the audit
    // snapshot both join on.
    await makeMember(user.id, organizationId, { role: "admin" });

    cluster = new FakeCluster();
    useFakeCluster(cluster);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });
    registerAuditLogHook(app);

    const { default: routes } = await import("./mcp-server");
    await app.register(routes);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await app.close();
  });

  async function makeLocalInstall(fixtures: {
    makeInternalMcpCatalog: (o?: Record<string, unknown>) => Promise<{
      id: string;
    }>;
    makeMcpServer: (o?: Record<string, unknown>) => Promise<{ id: string }>;
    catalogOverrides?: Record<string, unknown>;
    serverOverrides?: Record<string, unknown>;
    /** Skip the live pod, so the reset finds nothing left to terminate. */
    withoutPod?: boolean;
  }) {
    const catalog = await fixtures.makeInternalMcpCatalog({
      organizationId,
      serverType: "local",
      localConfig: { command: "node", arguments: ["server.js"] },
      ...fixtures.catalogOverrides,
    });
    const mcpServer = await fixtures.makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: user.id,
      deploymentName: DEPLOYMENT_NAME,
      localInstallationStatus: "error",
      ...fixtures.serverOverrides,
    });
    if (!fixtures.withoutPod) {
      cluster.addPod({
        name: POD_NAME,
        deployment: (fixtures.serverOverrides?.deploymentName ??
          DEPLOYMENT_NAME) as string,
        mcpServerId: mcpServer.id,
      });
    }
    return { catalog, mcpServer };
  }

  async function readInstall(id: string) {
    const [row] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, id));
    return row;
  }

  async function auditRow(action: AuditEventName, resourceId: string) {
    for (let i = 0; i < 40; i++) {
      const rows = await db
        .select({
          action: schema.auditLogsTable.action,
          resourceType: schema.auditLogsTable.resourceType,
          before: schema.auditLogsTable.before,
          after: schema.auditLogsTable.after,
        })
        .from(schema.auditLogsTable)
        .where(
          and(
            eq(schema.auditLogsTable.action, action),
            eq(schema.auditLogsTable.resourceId, resourceId),
          ),
        );
      if (rows.length > 0) return rows[0];
      await new Promise((r) => setTimeout(r, 5));
    }
    return null;
  }

  test("destroys the deployment, redeploys it, and reports what it did", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const { mcpServer } = await makeLocalInstall({
      makeInternalMcpCatalog,
      makeMcpServer,
    });
    // Sessions that address the pod being destroyed must not survive the reset.
    // Connection keys carry the server id as their second segment.
    await db.insert(schema.mcpHttpSessionsTable).values({
      connectionKey: `catalog:${mcpServer.id}`,
      sessionId: "stale-session",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/hard-reset`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "completed",
      mcpServerId: mcpServer.id,
      physicalDeployment: `${NAMESPACE}/${DEPLOYMENT_NAME}`,
      resetServerIds: [mcpServer.id],
      teardown: { outcome: "terminated" },
      recreated: { target: "install-deployment" },
      rebuild: { outcome: "ready" },
    });

    expect(cluster.deletedDeployments).toEqual([DEPLOYMENT_NAME]);
    expect(cluster.createdDeployments).toEqual([DEPLOYMENT_NAME]);
    expect(cluster.deploymentExists).toBe(true);

    const sessions = await db
      .select()
      .from(schema.mcpHttpSessionsTable)
      .where(
        eq(
          schema.mcpHttpSessionsTable.connectionKey,
          `catalog:${mcpServer.id}`,
        ),
      );
    expect(sessions).toHaveLength(0);

    // The install row carries the outcome: a recovered server no longer shows
    // the error the administrator reached for the reset over.
    const row = await readInstall(mcpServer.id);
    expect(row?.localInstallationStatus).toBe("success");
    expect(row?.localInstallationError).toBeNull();
  });

  test("never touches the pods of a neighbour whose deployment name shares a prefix", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    // Two independent servers, one named as a prefix of the other — the shape
    // an organization gets from any "<product>" / "<product> EU" pair.
    const { mcpServer: target } = await makeLocalInstall({
      makeInternalMcpCatalog,
      makeMcpServer,
      serverOverrides: { deploymentName: "mcp-notion" },
      withoutPod: true,
    });
    const { mcpServer: neighbour } = await makeLocalInstall({
      makeInternalMcpCatalog,
      makeMcpServer,
      serverOverrides: { deploymentName: "mcp-notion-eu" },
      withoutPod: true,
    });
    const neighbourPod = "mcp-notion-eu-5f8c9d6b4-zzzzz";
    cluster.deployments.add("mcp-notion-eu");
    cluster.deployments.add("mcp-notion");
    cluster.addPod({
      name: neighbourPod,
      deployment: "mcp-notion-eu",
      mcpServerId: neighbour.id,
    });

    // The trap: this live pod belongs to the neighbour, yet its name is what a
    // name-prefix match on the target's deployment would accept.
    expect(neighbourPod.startsWith("mcp-notion-")).toBe(true);
    expect(
      cluster.listPods("app=mcp-server").map((pod) => pod.metadata?.name),
    ).toEqual([neighbourPod]);

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${target.id}/hard-reset`,
    });

    expect(res.statusCode).toBe(200);
    // The neighbour's pod is not a straggler of this reset: it must never be
    // reported as one, and never be force-deleted as one.
    expect(res.json().teardown).toEqual({ outcome: "terminated" });
    expect(cluster.deletedPods).toEqual([]);
    expect(cluster.pods.has(neighbourPod)).toBe(true);
    expect(cluster.deletedDeployments).toEqual(["mcp-notion"]);
  });

  test("reports a rebuild that never came up, and says so on the install row", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const { mcpServer } = await makeLocalInstall({
      makeInternalMcpCatalog,
      makeMcpServer,
    });
    cluster.rebuildComesUp = false;

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/hard-reset`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.recreated).toEqual({ target: "install-deployment" });
    expect(body.rebuild.outcome).toBe("not-ready");
    expect(body.rebuild.reason).toContain("CreateContainerConfigError");

    // A reset whose rebuild is still down is not a recovery, and must not be
    // reported as one — least of all by erasing the error that prompted it.
    const row = await readInstall(mcpServer.id);
    expect(row?.localInstallationStatus).toBe("error");
    expect(row?.localInstallationError).toContain("did not come back up");
  });

  test("leaves the administrator's hibernation choice alone — it is configuration, not state", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const { mcpServer } = await makeLocalInstall({
      makeInternalMcpCatalog,
      makeMcpServer,
      serverOverrides: { hibernationMode: "disabled" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/hard-reset`,
    });
    expect(res.statusCode).toBe(200);

    const row = await readInstall(mcpServer.id);
    expect(row?.hibernationMode).toBe("disabled");
  });

  test("reports an unconfirmed teardown rather than abandoning the rebuild", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const { mcpServer } = await makeLocalInstall({
      makeInternalMcpCatalog,
      makeMcpServer,
    });
    // The Deployment is already gone by the time the pod check fails; refusing
    // to rebuild here would leave the server down for good.
    cluster.failPodListsWhileDeploymentIsGone = true;

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/hard-reset`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().teardown).toEqual({
      outcome: "unverified",
      reason: "pods is forbidden",
    });
    expect(cluster.createdDeployments).toEqual([DEPLOYMENT_NAME]);
    expect(res.json().rebuild).toEqual({ outcome: "ready" });
  });

  test("resets a multitenant catalog's shared deployment once, for every install on it", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      serverType: "local",
      multitenant: true,
      localConfig: { command: "node", arguments: ["server.js"] },
    });
    const first = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: user.id,
      deploymentName: DEPLOYMENT_NAME,
    });
    const second = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: user.id,
      deploymentName: DEPLOYMENT_NAME,
    });

    // A rebuild is confirmed serving exactly once. The catalog-level recreate
    // this path reuses ends in a readiness wait of its own, and letting both
    // run would budget a reset for twice the wait it promises.
    const readyWait = vi.spyOn(
      K8sDeployment.prototype,
      "waitForDeploymentReady",
    );

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${first.id}/hard-reset`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.recreated).toEqual({
      target: "shared-catalog-deployment",
      catalogId: catalog.id,
    });
    expect([...body.resetServerIds].sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(cluster.createdDeployments).toHaveLength(1);
    expect(body.rebuild).toEqual({ outcome: "ready" });
    expect(readyWait).toHaveBeenCalledTimes(1);
  });

  test("two concurrent resets share one teardown", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    let releaseTeardown: () => void = () => {};
    const teardownGate = new Promise<void>((resolve) => {
      releaseTeardown = resolve;
    });
    cluster = new FakeCluster();
    const internals = useFakeCluster(cluster, teardownGate);
    const { mcpServer } = await makeLocalInstall({
      makeInternalMcpCatalog,
      makeMcpServer,
    });

    const first = app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/hard-reset`,
    });
    // The first reset is now parked inside its teardown, having dropped the
    // deployment from the runtime cache.
    await waitUntil(() => cluster.deletedDeployments.length === 1);

    const second = app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/hard-reset`,
    });
    // Re-appearing in the cache means the second caller has resolved the same
    // physical deployment — the point at which it either joins or races.
    await waitUntil(() =>
      internals.mcpServerIdToDeploymentMap.has(mcpServer.id),
    );
    releaseTeardown();

    const [a, b] = await Promise.all([first, second]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    // The second caller joined the first reset rather than tearing down a
    // deployment the first one was rebuilding.
    expect(a.json()).toEqual(b.json());
    expect(cluster.deletedDeployments).toEqual([DEPLOYMENT_NAME]);
    expect(cluster.createdDeployments).toEqual([DEPLOYMENT_NAME]);
  });

  test("a caller joining another install's reset gets a result about their own install", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    let releaseTeardown: () => void = () => {};
    const teardownGate = new Promise<void>((resolve) => {
      releaseTeardown = resolve;
    });
    cluster = new FakeCluster();
    const internals = useFakeCluster(cluster, teardownGate);

    const catalog = await makeInternalMcpCatalog({
      organizationId,
      serverType: "local",
      multitenant: true,
      localConfig: { command: "node", arguments: ["server.js"] },
    });
    const starter = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: user.id,
    });
    const joiner = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: user.id,
    });

    const first = app.inject({
      method: "POST",
      url: `/api/mcp_server/${starter.id}/hard-reset`,
    });
    await waitUntil(() => cluster.deletedDeployments.length === 1);

    const second = app.inject({
      method: "POST",
      url: `/api/mcp_server/${joiner.id}/hard-reset`,
    });
    await waitUntil(() => internals.mcpServerIdToDeploymentMap.has(joiner.id));
    releaseTeardown();

    const [a, b] = await Promise.all([first, second]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    // Both installs alias one pod, so both share the teardown — but a report
    // that named somebody else's server would be a report about nothing the
    // caller asked for.
    expect(a.json().mcpServerId).toBe(starter.id);
    expect(b.json().mcpServerId).toBe(joiner.id);
    expect(b.json().physicalDeployment).toBe(a.json().physicalDeployment);
    expect(b.json().teardown).toEqual(a.json().teardown);
    expect([...b.json().resetServerIds].sort()).toEqual(
      [...a.json().resetServerIds].sort(),
    );
    expect(cluster.createdDeployments).toHaveLength(1);
  });

  test("reports a reset that outlives the request, and lands its outcome on the install", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    let releaseTeardown: () => void = () => {};
    const teardownGate = new Promise<void>((resolve) => {
      releaseTeardown = resolve;
    });
    cluster = new FakeCluster();
    useFakeCluster(cluster, teardownGate);
    const { mcpServer } = await makeLocalInstall({
      makeInternalMcpCatalog,
      makeMcpServer,
    });

    // Faked from before the request so the wait it puts on itself is faked
    // too; everything the request does meanwhile runs on the real event loop.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    let answered = false;
    const pending = app
      .inject({
        method: "POST",
        url: `/api/mcp_server/${mcpServer.id}/hard-reset`,
      })
      .then((res) => {
        answered = true;
        return res;
      });
    await waitOnTicks(() => cluster.deletedDeployments.length === 1);

    // A wedged pod plus a fresh image pull keeps a real reset running for
    // minutes. No connection in front of this API survives that, so the
    // request must answer without one.
    for (let minutes = 0; minutes < 20 && !answered; minutes++) {
      await vi.advanceTimersByTimeAsync(60_000);
    }
    vi.useRealTimers();

    const res = await pending;
    expect(res.statusCode).toBe(200);
    // Truthful about what it does NOT know yet: no teardown outcome, no
    // rebuild verdict — only what the reset is acting on.
    expect(res.json()).toEqual({
      status: "in-progress",
      mcpServerId: mcpServer.id,
      physicalDeployment: `${NAMESPACE}/${DEPLOYMENT_NAME}`,
      resetServerIds: [mcpServer.id],
    });
    expect((await readInstall(mcpServer.id))?.localInstallationStatus).toBe(
      "pending",
    );

    releaseTeardown();

    // The administrator learns the outcome through the install status — the
    // channel that carries every other lifecycle action — not from the logs.
    await waitUntil(
      async () =>
        (await readInstall(mcpServer.id))?.localInstallationStatus ===
        "success",
    );
    expect(cluster.createdDeployments).toEqual([DEPLOYMENT_NAME]);
  });

  test("a tool call arriving mid-reset is refused, not raced against the teardown", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    let releaseTeardown: () => void = () => {};
    const teardownGate = new Promise<void>((resolve) => {
      releaseTeardown = resolve;
    });
    cluster = new FakeCluster();
    const internals = useFakeCluster(cluster, teardownGate);
    const { mcpServer } = await makeLocalInstall({
      makeInternalMcpCatalog,
      makeMcpServer,
    });

    const pending = app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/hard-reset`,
    });
    await waitUntil(() => cluster.deletedDeployments.length === 1);

    // Demand for the same server while its Deployment is being destroyed:
    // there is nothing to wake, and a scale-up patch here would land on an
    // object the reset is deleting.
    const wakeError = await McpServerRuntimeManager.ensureAwake(
      mcpServer.id,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(wakeError).toBeInstanceOf(Error);
    // The caller is told what is actually happening, not that its server is
    // waking from idle.
    expect((wakeError as Error).message).toContain("hard reset");
    expect(
      internals.k8sAppsApi.patchNamespacedDeployment as unknown as Mock,
    ).not.toHaveBeenCalled();

    releaseTeardown();
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json().rebuild).toEqual({ outcome: "ready" });
  });

  test("writes an audit record naming the reset, with a non-empty diff", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const { mcpServer } = await makeLocalInstall({
      makeInternalMcpCatalog,
      makeMcpServer,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/hard-reset`,
    });
    expect(res.statusCode).toBe(200);

    const audit = await auditRow("mcpServer.hardReset", mcpServer.id);
    expect(audit).not.toBeNull();
    expect(audit?.resourceType).toBe("mcpServer");
    // A hard reset must be findable as itself, never as an install or an
    // ordinary update.
    expect(audit?.before).toMatchObject({
      id: mcpServer.id,
      localInstallationStatus: "error",
    });
    expect(audit?.after).toMatchObject({
      id: mcpServer.id,
      localInstallationStatus: "success",
    });
  });

  test("a caller without mcpServerInstallation:admin is refused", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const { mcpServer } = await makeLocalInstall({
      makeInternalMcpCatalog,
      makeMcpServer,
    });

    // An editor/member-shaped caller: every ordinary connection permission,
    // but not the org-wide admin capability.
    mockHasPermission.mockImplementation(
      async (permissions: Record<string, string[]>) => ({
        success: !Object.values(permissions).some((actions) =>
          actions.includes("admin"),
        ),
        error: null,
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/hard-reset`,
    });
    expect(res.statusCode).toBe(403);
    expect(cluster.deletedDeployments).toEqual([]);
  });

  test("a remote server has no deployment to reset", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      serverType: "remote",
      serverUrl: "https://remote.example.com/mcp",
    });
    const mcpServer = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: user.id,
      serverType: "remote",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/hard-reset`,
    });
    expect(res.statusCode).toBe(400);
    expect(cluster.deletedDeployments).toEqual([]);
  });

  test("an unavailable Kubernetes runtime refuses the reset without touching the install", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const { mcpServer } = await makeLocalInstall({
      makeInternalMcpCatalog,
      makeMcpServer,
    });
    await db
      .update(schema.mcpServersTable)
      .set({ localInstallationError: "the original failure" })
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    (McpServerRuntimeManager as unknown as ManagerInternals).status = "error";

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/hard-reset`,
    });

    expect(res.statusCode).toBe(503);
    expect(cluster.deletedDeployments).toEqual([]);
    // A reset that never reached the cluster changed nothing — including the
    // error the administrator is still looking at.
    const row = await readInstall(mcpServer.id);
    expect(row?.localInstallationStatus).toBe("error");
    expect(row?.localInstallationError).toBe("the original failure");
  });

  test("an install with no resolvable deployment refuses the reset without touching the install", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    // A local install left behind by a catalog entry that has since been
    // pointed at a remote server: there is no Deployment to destroy.
    const { mcpServer } = await makeLocalInstall({
      makeInternalMcpCatalog,
      makeMcpServer,
      catalogOverrides: {
        serverType: "remote",
        serverUrl: "https://remote.example.com/mcp",
        localConfig: null,
      },
      withoutPod: true,
    });
    await db
      .update(schema.mcpServersTable)
      .set({ localInstallationError: "the original failure" })
      .where(eq(schema.mcpServersTable.id, mcpServer.id));

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/hard-reset`,
    });

    expect(res.statusCode).toBe(409);
    expect(cluster.deletedDeployments).toEqual([]);
    const row = await readInstall(mcpServer.id);
    expect(row?.localInstallationStatus).toBe("error");
    expect(row?.localInstallationError).toBe("the original failure");
  });

  test("an unknown server id is a 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${crypto.randomUUID()}/hard-reset`,
    });
    expect(res.statusCode).toBe(404);
  });

  test("a server in another organization is a 404, not a reset", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const otherOrgId = (await makeOrganization()).id;
    const otherUser = await makeUser();
    await makeMember(otherUser.id, otherOrgId, { role: "admin" });
    const catalog = await makeInternalMcpCatalog({
      organizationId: otherOrgId,
      serverType: "local",
      localConfig: { command: "node", arguments: ["server.js"] },
    });
    const foreign = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: otherUser.id,
      deploymentName: DEPLOYMENT_NAME,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${foreign.id}/hard-reset`,
    });
    expect(res.statusCode).toBe(404);
    expect(cluster.deletedDeployments).toEqual([]);
  });

  test("the route is gated on mcpServerInstallation:admin, which only admin-tier roles hold", async () => {
    const { requiredEndpointPermissionsMap, predefinedPermissionsMap } =
      await import("@archestra/shared/access-control");
    const {
      ADMIN_ROLE_NAME,
      EDITOR_ROLE_NAME,
      MEMBER_ROLE_NAME,
      PLATFORM_ADMIN_ROLE_NAME,
    } = await import("@archestra/shared");

    expect(requiredEndpointPermissionsMap[RouteId.HardResetMcpServer]).toEqual({
      mcpServerInstallation: ["admin"],
    });

    const holdsAdmin = (role: string) =>
      Boolean(
        predefinedPermissionsMap[
          role as keyof typeof predefinedPermissionsMap
        ]?.mcpServerInstallation?.includes("admin"),
      );
    expect(holdsAdmin(ADMIN_ROLE_NAME)).toBe(true);
    expect(holdsAdmin(PLATFORM_ADMIN_ROLE_NAME)).toBe(true);
    expect(holdsAdmin(EDITOR_ROLE_NAME)).toBe(false);
    expect(holdsAdmin(MEMBER_ROLE_NAME)).toBe(false);
  });
});
