import { KubeConfig } from "@kubernetes/client-node";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import config from "@/config";
import { beforeEach, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import manager from "./manager";

// The manager caches clients; isolate the fake cluster from shared workers.
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    agentRuntime: { enabled: true },
    orchestrator: {
      kubernetes: { kubeconfig: "", loadKubeconfigFromCurrentCluster: false },
    },
  }),
);

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();

beforeEach(() => {
  vi.spyOn(KubeConfig.prototype, "loadFromDefault").mockImplementation(
    function (this: KubeConfig) {
      this.loadFromOptions({
        clusters: [{ name: "test", server: ORIGIN }],
        users: [{ name: "test" }],
        contexts: [{ name: "test", cluster: "test", user: "test" }],
        currentContext: "test",
      });
    },
  );
});

test.for([
  403, 503,
])("omits optional connection hints when Kubernetes returns %i", async (status) => {
  server.use(http.get(SANDBOX_URL, () => new HttpResponse(null, { status })));
  await expect(manager.getWorkspaceConnection(SESSION)).resolves.toBeNull();
});

test("omits connection hints when the runtime is disabled", async () => {
  config.agentRuntime.enabled = false;
  await expect(manager.getWorkspaceConnection(SESSION)).resolves.toBeNull();
});

test("uses the assigned Sandbox for connection hints while preserving the logical workspace identity", async () => {
  server.use(
    http.get(SANDBOX_URL, ({ params }) =>
      params.name === "workspace"
        ? new HttpResponse(null, { status: 404 })
        : HttpResponse.json({
            metadata: {
              name: "pooled-sandbox",
              ownerReferences: [{ kind: "SandboxClaim", uid: "claim-uid" }],
            },
          }),
    ),
    http.get(
      `${ORIGIN}/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/test/sandboxclaims/workspace`,
      () =>
        HttpResponse.json({
          metadata: { uid: "claim-uid" },
          status: { sandbox: { name: "pooled-sandbox" } },
        }),
    ),
  );
  const connection = await manager.getWorkspaceConnection(SESSION);
  expect(connection?.hostname).toBe("pooled-sandbox.test");
  expect(connection?.shellCommand).toContain("pooled-sandbox");
  expect(connection?.shellCommand).toContain(
    "ARCHESTRA_AGENT_RUNTIME_TASK_ID=task",
  );
});

const ORIGIN = "https://kubernetes.example.test";
const SANDBOX_URL = `${ORIGIN}/apis/agents.x-k8s.io/v1beta1/namespaces/test/sandboxes/:name`;
const SESSION = {
  workloadName: "workspace",
  runtimeScope: "test",
  taskId: "task",
};
