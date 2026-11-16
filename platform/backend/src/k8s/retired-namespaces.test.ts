import { KubeConfig } from "@kubernetes/client-node";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test } from "vitest";
import config from "@/config";
import { createK8sClients, getK8sNamespace } from "@/k8s/shared";
import { useMswServer } from "@/test/msw";
import {
  retiredNamespaceDrainer,
  retiredWorkloadNamespaces,
} from "./retired-namespaces";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();

const ORIGIN = "https://kubernetes.example.test";
const OWNER_ROLE = "archestra-mcp-runtime-owner";
const OWNER_UID = "owner-uid";
const previous = {
  ownerRole: config.orchestrator.kubernetes.runtimeOwnerRoleName,
  retired: config.orchestrator.kubernetes.retiredNamespaces,
  environments: config.orchestrator.kubernetes.environmentNamespaces,
  agentRuntime: config.agentRuntime.namespace,
};

beforeEach(() => {
  config.orchestrator.kubernetes.runtimeOwnerRoleName = OWNER_ROLE;
  config.orchestrator.kubernetes.environmentNamespaces = ["env-team"];
  config.agentRuntime.namespace = "agent-runtimes";
  retiredNamespaceDrainer.reset();
});

afterEach(() => {
  config.orchestrator.kubernetes.runtimeOwnerRoleName = previous.ownerRole;
  config.orchestrator.kubernetes.retiredNamespaces = previous.retired;
  config.orchestrator.kubernetes.environmentNamespaces = previous.environments;
  config.agentRuntime.namespace = previous.agentRuntime;
  retiredNamespaceDrainer.reset();
});

test("never retires a namespace that is still in use", () => {
  config.orchestrator.kubernetes.retiredNamespaces = [
    "old",
    getK8sNamespace(),
    "agent-runtimes",
    "env-team",
    "old",
  ];
  expect(retiredWorkloadNamespaces()).toEqual(["old"]);
});

test("waits for this install's sessions to end, then removes the rest through the owner Role", async () => {
  config.orchestrator.kubernetes.retiredNamespaces = ["old"];
  let sandboxes = [owned("run-a"), { metadata: { name: "other-install" } }];
  const deletes: Array<{ name: string; uid?: string }> = [];
  server.use(
    http.get(
      `${ORIGIN}/apis/rbac.authorization.k8s.io/v1/namespaces/old/roles/${OWNER_ROLE}`,
      () =>
        HttpResponse.json({ metadata: { name: OWNER_ROLE, uid: OWNER_UID } }),
    ),
    http.get(
      `${ORIGIN}/apis/agents.x-k8s.io/v1beta1/namespaces/old/sandboxes`,
      () => HttpResponse.json({ items: sandboxes }),
    ),
    // Agent Sandbox extensions not installed.
    http.get(
      `${ORIGIN}/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/old/sandboxclaims`,
      () => HttpResponse.json({ code: 404 }, { status: 404 }),
    ),
    http.get(`${ORIGIN}/apis/apps/v1/namespaces/old/statefulsets`, () =>
      HttpResponse.json({ items: [] }),
    ),
    http.delete(
      `${ORIGIN}/apis/rbac.authorization.k8s.io/v1/namespaces/old/roles/:name`,
      async ({ params, request }) => {
        const body = (await request.json()) as {
          preconditions?: { uid?: string };
        };
        deletes.push({
          name: String(params.name),
          uid: body.preconditions?.uid,
        });
        return HttpResponse.json({});
      },
    ),
  );

  await retiredNamespaceDrainer.drain(clients);
  expect(deletes).toEqual([]);

  // The session ended; another install's sandbox does not hold the drain.
  sandboxes = [{ metadata: { name: "other-install" } }];
  await retiredNamespaceDrainer.drain(clients);
  expect(deletes).toEqual([{ name: OWNER_ROLE, uid: OWNER_UID }]);

  // Done for this process: nothing more is requested.
  await retiredNamespaceDrainer.drain(clients);
  expect(deletes).toHaveLength(1);
});

test("keeps the owner Role while a code sandbox engine it owns is still there", async () => {
  config.orchestrator.kubernetes.retiredNamespaces = ["old"];
  let deleted = false;
  server.use(
    http.get(
      `${ORIGIN}/apis/rbac.authorization.k8s.io/v1/namespaces/old/roles/${OWNER_ROLE}`,
      () =>
        HttpResponse.json({ metadata: { name: OWNER_ROLE, uid: OWNER_UID } }),
    ),
    http.get(
      `${ORIGIN}/apis/agents.x-k8s.io/v1beta1/namespaces/old/sandboxes`,
      () => HttpResponse.json({ items: [] }),
    ),
    http.get(
      `${ORIGIN}/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/old/sandboxclaims`,
      () => HttpResponse.json({ items: [] }),
    ),
    http.get(
      `${ORIGIN}/apis/apps/v1/namespaces/old/statefulsets`,
      ({ request }) =>
        HttpResponse.json({
          items:
            new URL(request.url).searchParams.get("labelSelector") ===
            `app=dagger-engine,archestra.io/dagger-runtime-owner=${OWNER_UID}`
              ? [{ metadata: { name: "dagger-engine-x" } }]
              : [],
        }),
    ),
    http.delete(
      `${ORIGIN}/apis/rbac.authorization.k8s.io/v1/namespaces/old/roles/:name`,
      () => {
        deleted = true;
        return HttpResponse.json({});
      },
    ),
  );

  await retiredNamespaceDrainer.drain(clients);
  expect(deleted).toBe(false);
});

function clients(namespace: string) {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromOptions({
    clusters: [{ name: "test", server: ORIGIN }],
    users: [{ name: "test" }],
    contexts: [{ name: "test", cluster: "test", user: "test" }],
    currentContext: "test",
  });
  return createK8sClients(kubeConfig, namespace);
}

function owned(name: string) {
  return {
    metadata: {
      name,
      ownerReferences: [
        {
          apiVersion: "rbac.authorization.k8s.io/v1",
          kind: "Role",
          name: OWNER_ROLE,
          uid: OWNER_UID,
        },
      ],
    },
  };
}
