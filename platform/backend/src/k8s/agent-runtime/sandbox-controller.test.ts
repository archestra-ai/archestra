import { KubeConfig } from "@kubernetes/client-node";
import { HttpResponse, http } from "msw";
import { beforeEach, expect, test, vi } from "vitest";
import { useMswServer } from "@/test/msw";
import manager from "./manager";

// The singleton caches clients: keep this fake cluster out of shared workers.
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    agentRuntime: { enabled: true },
    orchestrator: {
      kubernetes: { kubeconfig: "", loadKubeconfigFromCurrentCluster: false },
    },
  }),
);

const origin = "https://kubernetes.example.test";
const discoveryUrl = `${origin}/apis/agents.x-k8s.io/v1beta1`;
// biome-ignore lint/correctness/useHookAtTopLevel: MSW test lifecycle helper, not a React hook.
const server = useMswServer();

beforeEach(() => {
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
});

test("rejects runs until the Agent Sandbox controller is installed", async () => {
  // A cluster without the CRD answers discovery with a plain-text 404.
  server.use(
    http.get(
      discoveryUrl,
      () => new HttpResponse("404 page not found\n", { status: 404 }),
    ),
  );
  await expect(manager.assertSandboxApiInstalled()).rejects.toMatchObject({
    statusCode: 503,
    message: expect.stringContaining("Agent Sandbox controller"),
  });

  // Installing the controller takes effect without a platform restart.
  server.use(
    http.get(discoveryUrl, () =>
      HttpResponse.json({
        kind: "APIResourceList",
        groupVersion: "agents.x-k8s.io/v1beta1",
        resources: [
          {
            name: "sandboxes",
            singularName: "sandbox",
            namespaced: true,
            kind: "Sandbox",
            verbs: ["create", "get", "list"],
          },
        ],
      }),
    ),
  );
  await expect(manager.assertSandboxApiInstalled()).resolves.toBeUndefined();
});
