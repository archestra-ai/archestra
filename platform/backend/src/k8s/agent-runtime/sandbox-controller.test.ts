import { KubeConfig } from "@kubernetes/client-node";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useMswServer } from "@/test/msw";
import manager from "./manager";
import { agentSandboxApi } from "./sandbox-api";

// The singleton caches clients: keep this fake cluster out of shared workers.
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    orchestrator: {
      kubernetes: { kubeconfig: "", loadKubeconfigFromCurrentCluster: false },
    },
  }),
);

const origin = "https://kubernetes.example.test";
const sandboxDiscoveryUrl = `${origin}/apis/agents.x-k8s.io/v1beta1`;
const extensionsDiscoveryUrl = `${origin}/apis/extensions.agents.x-k8s.io/v1beta1`;
// biome-ignore lint/correctness/useHookAtTopLevel: MSW test lifecycle helper, not a React hook.
const server = useMswServer();
let discoveryRequests: number;

beforeEach(() => {
  // The shared setup stubs detection off; this file exercises the real thing.
  vi.restoreAllMocks();
  agentSandboxApi.reset();
  discoveryRequests = 0;
  server.events.on("request:start", ({ request }) => {
    if (new URL(request.url).pathname.startsWith("/apis/")) {
      discoveryRequests++;
    }
  });
  vi.spyOn(KubeConfig.prototype, "loadFromDefault").mockImplementation(
    function (this: KubeConfig) {
      this.loadFromOptions({
        clusters: [{ name: "test", server: origin }],
        users: [{ name: "test" }],
        contexts: [{ name: "test", cluster: "test", user: "test" }],
        currentContext: "test",
      });
    },
  );
  serveController({ installed: false });
});

afterEach(() => {
  server.events.removeAllListeners();
  agentSandboxApi.reset();
});

test("rejects runs until the Agent Sandbox controller is installed", async () => {
  await expect(manager.assertSandboxApiInstalled()).rejects.toMatchObject({
    statusCode: 503,
    message: expect.stringContaining("Agent Sandbox controller"),
  });

  // Installing the controller takes effect without a platform restart.
  serveController({ installed: true });
  await expect(manager.assertSandboxApiInstalled()).resolves.toBeUndefined();
});

test("a cluster serving only the core Sandbox API is not ready for Agent Runtime", async () => {
  // The warm pool claims sandboxes through the extensions group.
  server.use(
    http.get(sandboxDiscoveryUrl, () =>
      resourceList("agents.x-k8s.io/v1beta1", ["sandboxes"]),
    ),
  );

  await expect(agentSandboxApi.refresh()).resolves.toBe(false);
  expect(agentSandboxApi.isInstalled).toBe(false);
});

test("re-checks a negative answer once it is stale and flips without a restart", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  await expect(agentSandboxApi.refresh()).resolves.toBe(false);
  const afterFirstCheck = discoveryRequests;
  expect(afterFirstCheck).toBeGreaterThan(0);

  // A fresh negative answer is served from memory.
  serveController({ installed: true });
  expect(agentSandboxApi.isInstalled).toBe(false);
  expect(discoveryRequests).toBe(afterFirstCheck);

  // Once stale, the synchronous read re-inspects the cluster in the background.
  vi.advanceTimersByTime(30_000);
  expect(agentSandboxApi.isInstalled).toBe(false);
  await vi.waitFor(() => expect(agentSandboxApi.isInstalled).toBe(true));
  expect(discoveryRequests).toBeGreaterThan(afterFirstCheck);

  // A positive answer is kept for good: no further discovery traffic.
  const afterInstall = discoveryRequests;
  serveController({ installed: false });
  vi.advanceTimersByTime(60_000);
  expect(agentSandboxApi.isInstalled).toBe(true);
  await expect(agentSandboxApi.refresh()).resolves.toBe(true);
  expect(discoveryRequests).toBe(afterInstall);
});

test("launch on retry waits for a Sandbox whose first read has no deletionTimestamp yet until it finishes deleting", async () => {
  serveController({ installed: true });
  await expect(manager.assertSandboxApiInstalled()).resolves.toBeUndefined();

  let sandboxReads = 0;
  const cacheControlHeaders: Array<string | null> = [];
  let createdSandboxName: string | undefined;

  server.use(
    http.get(
      `${origin}/apis/rbac.authorization.k8s.io/v1/namespaces/test/roles/archestra-agent-runtime`,
      () => HttpResponse.json({ code: 404 }, { status: 404 }),
    ),
    http.get(
      `${origin}/apis/agents.x-k8s.io/v1beta1/namespaces/test/sandboxes/workspace`,
      ({ request }) => {
        sandboxReads += 1;
        cacheControlHeaders.push(request.headers.get("cache-control"));
        if (sandboxReads === 1) {
          // Simulate a cached Sandbox snapshot that does not yet carry deletionTimestamp.
          return HttpResponse.json({
            apiVersion: "agents.x-k8s.io/v1beta1",
            kind: "Sandbox",
            metadata: {
              name: "workspace",
              namespace: "test",
            },
            spec: {},
          });
        }
        if (sandboxReads === 2) {
          return HttpResponse.json({
            apiVersion: "agents.x-k8s.io/v1beta1",
            kind: "Sandbox",
            metadata: {
              name: "workspace",
              namespace: "test",
              deletionTimestamp: "2026-11-04T16:00:00Z",
            },
            spec: {},
          });
        }
        return HttpResponse.json({ code: 404 }, { status: 404 });
      },
    ),
    http.get(
      `${origin}/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/test/sandboxclaims/workspace`,
      () => HttpResponse.json({ code: 404 }, { status: 404 }),
    ),
    http.post(`${origin}/api/v1/namespaces/test/secrets`, () =>
      HttpResponse.json({}, { status: 201 }),
    ),
    http.get(`${origin}/apis/cilium.io/v2`, () =>
      HttpResponse.json({ code: 404 }, { status: 404 }),
    ),
    http.get(`${origin}/apis/crd.projectcalico.org/v1`, () =>
      HttpResponse.json({ code: 404 }, { status: 404 }),
    ),
    http.get(`${origin}/api/v1/namespaces/kube-system/services/kube-dns`, () =>
      HttpResponse.json({ spec: { clusterIP: "10.96.0.10" } }),
    ),
    http.get(`${origin}/api/v1/namespaces/default/services/kubernetes`, () =>
      HttpResponse.json({ spec: { ipFamilies: ["IPv4"] } }),
    ),
    http.get(`${origin}/api/v1/namespaces/:ns/services/:svc`, () =>
      HttpResponse.json({ code: 404 }, { status: 404 }),
    ),
    http.post(
      `${origin}/apis/networking.k8s.io/v1/namespaces/test/networkpolicies`,
      () => HttpResponse.json({}, { status: 201 }),
    ),
    http.patch(
      `${origin}/apis/networking.k8s.io/v1/namespaces/test/networkpolicies/:name`,
      () => HttpResponse.json({}, { status: 200 }),
    ),
    http.post(
      `${origin}/apis/agents.x-k8s.io/v1beta1/namespaces/test/sandboxes`,
      async ({ request }) => {
        const body = (await request.json()) as { metadata?: { name?: string } };
        createdSandboxName = body.metadata?.name;
        return HttpResponse.json(body, { status: 201 });
      },
    ),
  );

  await manager.launch({
    taskId: "task-1",
    agentRuntimeId: "agent-1",
    frozenName: "workspace",
    runtimeScope: "test",
    image: "runtime:v1",
    command: ["echo", "hello"],
    privileged: false,
    resources: { cpuRequest: "500m", memoryRequest: "1Gi" },
    tier: null,
    warmTiers: [],
    env: {},
    secretEnv: {},
    inputFileCount: 0,
    activeDeadlineSeconds: 600,
    nodeSelector: {},
    imagePullSecrets: [],
    effectiveNetworkPolicy: { source: "built_in", policy: null },
    replacePriorAttempt: true,
  });

  expect(sandboxReads).toBe(3);
  expect(cacheControlHeaders).toEqual(["no-cache", "no-cache", "no-cache"]);
  expect(createdSandboxName).toBe("workspace");
});

// === Internal helpers ===

function serveController({ installed }: { installed: boolean }) {
  // A cluster without the CRD answers discovery with a plain-text 404.
  const notFound = () =>
    new HttpResponse("404 page not found\n", { status: 404 });
  server.use(
    http.get(
      sandboxDiscoveryUrl,
      installed
        ? () => resourceList("agents.x-k8s.io/v1beta1", ["sandboxes"])
        : notFound,
    ),
    http.get(
      extensionsDiscoveryUrl,
      installed
        ? () =>
            resourceList("extensions.agents.x-k8s.io/v1beta1", [
              "sandboxclaims",
              "sandboxtemplates",
              "sandboxwarmpools",
            ])
        : notFound,
    ),
  );
}

function resourceList(groupVersion: string, plurals: string[]) {
  return HttpResponse.json({
    kind: "APIResourceList",
    groupVersion,
    resources: plurals.map((name) => ({
      name,
      singularName: name.replace(/s$/, ""),
      namespaced: true,
      kind: name,
      verbs: ["create", "get", "list"],
    })),
  });
}
