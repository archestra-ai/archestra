/**
 * Repro: a local catalog's transport is edited from stdio to streamable-http
 * while more than one backend process holds the install.
 *
 * Each process caches one K8sDeployment per install, built from the catalog
 * row of the moment. The catalog row is only what the NEXT restart will run,
 * so every process has to agree on what the pod runs NOW:
 *
 * - before the owner restarts the install, a process that loads the install
 *   for the first time must keep speaking stdio to the stdio pod;
 * - after the owner restarts it on one process, a process that had the
 *   install cached must follow the new pod to HTTP.
 *
 * Drives the REAL manager and K8sDeployment against one shared database; only
 * the Kubernetes API is faked.
 */
import type * as k8s from "@kubernetes/client-node";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import { McpServerRuntimeManager } from "./manager";
import type { K8sRuntimeStatus } from "./schemas";

const NAMESPACE = "transport-change-namespace";
const DEPLOYMENT_NAME = "mcp-transport-change-server";
const NOT_FOUND = { statusCode: 404, message: "not found" };

type Transport = "stdio" | "streamable-http";

/** The one Deployment behind the install, and the transport its pod speaks. */
class FakeK8sCluster {
  podTransport: Transport = "stdio";
  /** False for a Deployment created before the transport was recorded on it. */
  recordsTransport = true;
  readonly createdServices: string[] = [];
  private generation = 1;

  /** What a restart does: delete the Deployment and create its successor. */
  replaceDeployment(transport: Transport): void {
    this.podTransport = transport;
    this.generation++;
  }

  readDeployment(): k8s.V1Deployment {
    return {
      metadata: {
        name: DEPLOYMENT_NAME,
        namespace: NAMESPACE,
        uid: `deployment-uid-${this.generation}`,
        annotations: this.recordsTransport
          ? { "archestra.ai/mcp-transport": this.podTransport }
          : {},
      },
      spec: { replicas: 1 },
      status: { availableReplicas: 1, readyReplicas: 1 },
    } as k8s.V1Deployment;
  }

  listPods(): k8s.V1Pod[] {
    return [
      {
        metadata: {
          name: `${DEPLOYMENT_NAME}-6d4f9c7b5-abcde`,
          creationTimestamp: new Date(),
          labels: { app: "mcp-server" },
        },
        status: {
          phase: "Running",
          conditions: [{ type: "Ready", status: "True" }],
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
  namespace: string;
  status: K8sRuntimeStatus;
};

/** One backend process (a web replica or the worker) with its own cache. */
function makeReplica(cluster: FakeK8sCluster): McpServerRuntimeManager {
  const coreApi = {
    listNamespacedPod: vi.fn(async () => ({ items: cluster.listPods() })),
    readNamespacedPod: vi.fn(async () => {
      throw NOT_FOUND;
    }),
    listNamespacedEvent: vi.fn(async () => ({ items: [] })),
    readNamespacedService: vi.fn(async () => {
      throw NOT_FOUND;
    }),
    createNamespacedService: vi.fn(
      async ({ body }: { body: k8s.V1Service }) => {
        cluster.createdServices.push(body.metadata?.name ?? "");
        return body;
      },
    ),
  } as unknown as k8s.CoreV1Api;

  const customObjectsApi = {
    getAPIResources: vi.fn(async () => {
      throw NOT_FOUND;
    }),
  } as unknown as k8s.CustomObjectsApi;

  const manager = new McpServerRuntimeManager();
  const internals = manager as unknown as ManagerInternals;
  internals.k8sApi = coreApi;
  internals.k8sAppsApi = {
    readNamespacedDeployment: vi.fn(async () => cluster.readDeployment()),
  } as unknown as k8s.AppsV1Api;
  internals.k8sAuthApi = {} as k8s.AuthorizationV1Api;
  internals.k8sNetworkingApi = {} as k8s.NetworkingV1Api;
  internals.k8sCustomObjectsApi = customObjectsApi;
  internals.k8sAttach = {} as k8s.Attach;
  internals.k8sLog = {} as k8s.Log;
  internals.k8sExec = {} as k8s.Exec;
  internals.namespace = NAMESPACE;
  internals.status = "running";
  return manager;
}

function localConfig(transportType: Transport) {
  return {
    command: "node",
    arguments: ["server.js"],
    transportType,
    // A fixed NodePort keeps endpoint resolution off the Service read.
    ...(transportType === "streamable-http" ? { nodePort: 30123 } : {}),
  };
}

/** What the catalog edit route persists when an admin changes the transport. */
async function editCatalogTransport(catalogId: string, transport: Transport) {
  await db
    .update(schema.internalMcpCatalogTable)
    .set({ localConfig: localConfig(transport) })
    .where(eq(schema.internalMcpCatalogTable.id, catalogId));
}

describe("local MCP server transport edited while several backend processes hold the install", () => {
  test("a process that had the install cached follows the pod to the new transport after the owner restarts it", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const cluster = new FakeK8sCluster();
    const catalog = await makeInternalMcpCatalog({
      name: "Transport Change Catalog",
      serverType: "local",
      localConfig: localConfig("stdio"),
    });
    const mcpServer = await makeMcpServer({
      catalogId: catalog.id,
      name: "transport-change-server",
      deploymentName: DEPLOYMENT_NAME,
    });

    // A session's tool calls ran through this process while the server was
    // stdio, so it holds the install in its cache.
    const bystander = makeReplica(cluster);
    expect(await bystander.usesStreamableHttp(mcpServer.id)).toBe(false);

    // An admin edits the transport; the owner then restarts the install. The
    // restart runs on ANOTHER process, which drops its own cache entry and
    // rebuilds the pod from the current catalog row.
    await editCatalogTransport(catalog.id, "streamable-http");
    cluster.replaceDeployment("streamable-http");
    const restarter = makeReplica(cluster);
    expect(await restarter.usesStreamableHttp(mcpServer.id)).toBe(true);

    // The Deployment watch wakes every process's state refresh.
    await bystander.refreshAllStates();

    // The pod now speaks HTTP only. A process still answering "stdio" would
    // attach to its stdin, and every call would wait out the tool-call timeout.
    expect(await bystander.usesStreamableHttp(mcpServer.id)).toBe(true);
    expect(await bystander.getHttpEndpointUrl(mcpServer.id)).toBe(
      await restarter.getHttpEndpointUrl(mcpServer.id),
    );
    expect(await bystander.getHttpEndpointUrl(mcpServer.id)).toMatch(/\/mcp$/);
  });

  test("a process loading the install for the first time keeps the deployed transport until the owner restarts it", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const cluster = new FakeK8sCluster();
    const catalog = await makeInternalMcpCatalog({
      name: "Transport Change Catalog Pending Restart",
      serverType: "local",
      localConfig: localConfig("stdio"),
    });
    const mcpServer = await makeMcpServer({
      catalogId: catalog.id,
      name: "transport-change-server-pending",
      deploymentName: DEPLOYMENT_NAME,
    });

    // The edit only marks a single-tenant install "restart required": the pod
    // keeps running the stdio process until its owner restarts it.
    await editCatalogTransport(catalog.id, "streamable-http");

    const coldReplica = makeReplica(cluster);
    expect(await coldReplica.usesStreamableHttp(mcpServer.id)).toBe(false);
    // It must not put an HTTP Service in front of a pod with no HTTP listener.
    expect(cluster.createdServices).toEqual([]);
  });

  test("a Deployment created before its transport was recorded follows the catalog", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const cluster = new FakeK8sCluster();
    cluster.recordsTransport = false;
    cluster.podTransport = "streamable-http";
    const catalog = await makeInternalMcpCatalog({
      name: "Transport Change Catalog Unrecorded",
      serverType: "local",
      localConfig: localConfig("streamable-http"),
    });
    const mcpServer = await makeMcpServer({
      catalogId: catalog.id,
      name: "transport-change-server-unrecorded",
      deploymentName: DEPLOYMENT_NAME,
    });

    const replica = makeReplica(cluster);
    expect(await replica.usesStreamableHttp(mcpServer.id)).toBe(true);
    expect(await replica.getHttpEndpointUrl(mcpServer.id)).toMatch(/\/mcp$/);
  });
});
