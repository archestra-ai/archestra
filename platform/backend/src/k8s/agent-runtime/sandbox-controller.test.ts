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
