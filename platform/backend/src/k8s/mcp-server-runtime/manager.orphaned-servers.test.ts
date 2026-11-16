import { KubeConfig } from "@kubernetes/client-node";
import { HttpResponse, http } from "msw";
import config from "@/config";
import { createK8sClients } from "@/k8s/shared";
import { afterEach, beforeEach, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { McpServerRuntimeManager } from "./manager";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();

const ORIGIN = "https://kubernetes.example.test";
const NAMESPACE = "mcp";
const OWNER_ROLE = "archestra-mcp-runtime-owner";
const OWNER_UID = "owner-uid";
const OTHER_INSTALL_UID = "other-install-uid";
let previousOwnerRole: string | undefined;
let previousEnvironmentNamespaces: string[];
let previousRetiredNamespaces: string[];

beforeEach(() => {
  previousOwnerRole = config.orchestrator.kubernetes.runtimeOwnerRoleName;
  previousEnvironmentNamespaces =
    config.orchestrator.kubernetes.environmentNamespaces;
  previousRetiredNamespaces = config.orchestrator.kubernetes.retiredNamespaces;
  config.orchestrator.kubernetes.runtimeOwnerRoleName = OWNER_ROLE;
  config.orchestrator.kubernetes.environmentNamespaces = [];
  config.orchestrator.kubernetes.retiredNamespaces = [];
});

afterEach(() => {
  config.orchestrator.kubernetes.runtimeOwnerRoleName = previousOwnerRole;
  config.orchestrator.kubernetes.environmentNamespaces =
    previousEnvironmentNamespaces;
  config.orchestrator.kubernetes.retiredNamespaces = previousRetiredNamespaces;
});

test("removes the objects of a deleted server, and only those this install owns", async ({
  makeMcpServer,
  makeInternalMcpCatalog,
}) => {
  const live = await makeMcpServer();
  const multitenantCatalog = await makeInternalMcpCatalog();
  const deletedServerId = crypto.randomUUID();
  const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const deployments = [
    // The server row is gone: everything it left behind goes.
    deployment("mcp-deleted", deletedServerId, { createdAt: old }),
    // Still being created: the row may not be committed yet.
    deployment("mcp-just-created", crypto.randomUUID(), {
      createdAt: new Date().toISOString(),
    }),
    // Another install sharing the namespace owns this one.
    deployment("mcp-other-install", crypto.randomUUID(), {
      createdAt: old,
      ownerUid: OTHER_INSTALL_UID,
    }),
    deployment("mcp-live", live.id, { createdAt: old }),
    // A multitenant deployment is labeled with its catalog id.
    deployment("mcp-mt-shared", multitenantCatalog.id, { createdAt: old }),
  ];

  const deleted: string[] = [];
  const core = `${ORIGIN}/api/v1/namespaces/${NAMESPACE}`;
  server.use(
    http.get(
      `${ORIGIN}/apis/rbac.authorization.k8s.io/v1/namespaces/${NAMESPACE}/roles/${OWNER_ROLE}`,
      () =>
        HttpResponse.json({ metadata: { name: OWNER_ROLE, uid: OWNER_UID } }),
    ),
    http.get(`${ORIGIN}/apis/apps/v1/namespaces/${NAMESPACE}/deployments`, () =>
      HttpResponse.json({ items: deployments }),
    ),
    http.delete(
      `${ORIGIN}/apis/apps/v1/namespaces/${NAMESPACE}/deployments/:name`,
      async ({ params, request }) => {
        const body = (await request.json()) as {
          preconditions?: { uid?: string };
        };
        deleted.push(`deployment/${params.name}@${body.preconditions?.uid}`);
        return HttpResponse.json({});
      },
    ),
    http.get(`${core}/services`, ({ request }) => {
      const selector = new URL(request.url).searchParams.get("labelSelector");
      return HttpResponse.json({
        items:
          selector === `app=mcp-server,mcp-server-id=${deletedServerId}`
            ? [owned("mcp-deleted-service")]
            : [],
      });
    }),
    http.delete(`${core}/services/:name`, ({ params }) => {
      deleted.push(`service/${params.name}`);
      return HttpResponse.json({});
    }),
    http.get(`${core}/secrets`, ({ request }) => {
      const selector = new URL(request.url).searchParams.get("labelSelector");
      return HttpResponse.json({
        items:
          selector === `mcp-server-id=${deletedServerId}`
            ? [
                owned(`mcp-server-${deletedServerId}-secrets`),
                owned("mcp-deleted-regcred-0"),
                // Same label, created by someone else: left alone.
                { metadata: { name: "hand-made-secret" } },
              ]
            : [],
      });
    }),
    http.delete(`${core}/secrets/:name`, ({ params }) => {
      deleted.push(`secret/${params.name}`);
      return HttpResponse.json({});
    }),
    http.get(
      `${ORIGIN}/apis/networking.k8s.io/v1/namespaces/${NAMESPACE}/networkpolicies/:name`,
      ({ params }) => HttpResponse.json(owned(String(params.name))),
    ),
    http.delete(
      `${ORIGIN}/apis/networking.k8s.io/v1/namespaces/${NAMESPACE}/networkpolicies/:name`,
      ({ params }) => {
        deleted.push(`networkpolicy/${params.name}`);
        return HttpResponse.json({});
      },
    ),
  );

  await sweep(managerFor(NAMESPACE));

  expect(deleted.sort()).toEqual(
    [
      "deployment/mcp-deleted@uid-mcp-deleted",
      "service/mcp-deleted-service",
      `secret/mcp-server-${deletedServerId}-secrets`,
      "secret/mcp-deleted-regcred-0",
      "networkpolicy/mcp-egress-mcp-deleted",
    ].sort(),
  );
});

test("removes every server this install left in a retired namespace, even live and new ones", async ({
  makeMcpServer,
}) => {
  const live = await makeMcpServer();
  config.orchestrator.kubernetes.retiredNamespaces = ["old-mcp"];
  const deployments: Record<string, unknown[]> = {
    [NAMESPACE]: [],
    "old-mcp": [
      // The server now runs in the new namespace; this copy is a duplicate.
      deployment("mcp-live", live.id, { createdAt: new Date().toISOString() }),
      deployment("mcp-other-install", crypto.randomUUID(), {
        createdAt: new Date().toISOString(),
        ownerUid: OTHER_INSTALL_UID,
      }),
    ],
  };
  const deleted: string[] = [];
  server.use(
    http.get(
      `${ORIGIN}/apis/rbac.authorization.k8s.io/v1/namespaces/:namespace/roles/${OWNER_ROLE}`,
      () =>
        HttpResponse.json({ metadata: { name: OWNER_ROLE, uid: OWNER_UID } }),
    ),
    http.get(
      `${ORIGIN}/apis/apps/v1/namespaces/:namespace/deployments`,
      ({ params }) =>
        HttpResponse.json({
          items: deployments[String(params.namespace)] ?? [],
        }),
    ),
    http.delete(
      `${ORIGIN}/apis/apps/v1/namespaces/:namespace/deployments/:name`,
      ({ params }) => {
        deleted.push(`${params.namespace}/deployment/${params.name}`);
        return HttpResponse.json({});
      },
    ),
    http.get(`${ORIGIN}/api/v1/namespaces/:namespace/services`, () =>
      HttpResponse.json({ items: [] }),
    ),
    http.get(`${ORIGIN}/api/v1/namespaces/:namespace/secrets`, () =>
      HttpResponse.json({ items: [owned(`mcp-server-${live.id}-secrets`)] }),
    ),
    http.delete(
      `${ORIGIN}/api/v1/namespaces/:namespace/secrets/:name`,
      ({ params }) => {
        deleted.push(`${params.namespace}/secret/${params.name}`);
        return HttpResponse.json({});
      },
    ),
    http.get(
      `${ORIGIN}/apis/networking.k8s.io/v1/namespaces/:namespace/networkpolicies/:name`,
      () => HttpResponse.json({ code: 404 }, { status: 404 }),
    ),
  );

  await sweep(managerFor(NAMESPACE));

  expect(deleted.sort()).toEqual([
    "old-mcp/deployment/mcp-live",
    `old-mcp/secret/mcp-server-${live.id}-secrets`,
  ]);
});

test("deletes nothing when ownership cannot be proven", async () => {
  config.orchestrator.kubernetes.runtimeOwnerRoleName = undefined;
  // Any Kubernetes request would be unhandled by MSW and fail the test.
  await sweep(managerFor(NAMESPACE));
});

// === helpers ===

function managerFor(namespace: string): McpServerRuntimeManager {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromOptions({
    clusters: [{ name: "test", server: ORIGIN }],
    users: [{ name: "test" }],
    contexts: [{ name: "test", cluster: "test", user: "test" }],
    currentContext: "test",
  });
  const clients = createK8sClients(kubeConfig, namespace);
  const manager = new McpServerRuntimeManager();
  Object.assign(manager, {
    namespace,
    k8sApi: clients.coreApi,
    k8sAppsApi: clients.appsApi,
    k8sRbacApi: clients.rbacApi,
    k8sNetworkingApi: clients.networkingApi,
  });
  return manager;
}

function sweep(manager: McpServerRuntimeManager): Promise<void> {
  return (
    manager as unknown as { removeObjectsOfMissingServers: () => Promise<void> }
  ).removeObjectsOfMissingServers();
}

function owned(name: string, ownerUid = OWNER_UID) {
  return {
    metadata: {
      name,
      ownerReferences: [
        {
          apiVersion: "rbac.authorization.k8s.io/v1",
          kind: "Role",
          name: OWNER_ROLE,
          uid: ownerUid,
        },
      ],
    },
  };
}

function deployment(
  name: string,
  serverId: string,
  options: { createdAt: string; ownerUid?: string },
) {
  const { metadata } = owned(name, options.ownerUid);
  return {
    metadata: {
      ...metadata,
      uid: `uid-${name}`,
      creationTimestamp: options.createdAt,
      labels: { app: "mcp-server", "mcp-server-id": serverId },
    },
  };
}
