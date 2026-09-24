import { CustomObjectsApi, KubeConfig } from "@kubernetes/client-node";
import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";
import config from "@/config";
import { useMswServer } from "@/test/msw";
import type { KubernetesAgentRunLaunchSpec } from "./manifests";
import { agentWarmPoolManager, readWorkspaceSandbox } from "./warm-pool";
import { warmPoolTemplate } from "./warm-pool-template";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();

test("shares warm capacity across tasks and Agents without exposing their instructions or credentials", () => {
  const first = warmPoolTemplate(SPEC);
  const second = warmPoolTemplate({
    ...SPEC,
    agentRuntimeId: "other-agent",
    taskId: "other-task",
    frozenName: "other-workspace",
    command: ["private-command"],
    env: { PRIVATE_TASK: "private-instructions" },
    secretEnv: { PRIVATE_KEY: "private-credential" },
  });
  expect(second).toEqual(first);
  expect(JSON.stringify(second)).not.toMatch(
    /private-command|private-instructions|private-credential|other-agent|other-task|other-workspace/,
  );
  // An upstream default public-internet policy would bypass restricted Environment egress.
  expect(second.spec.networkPolicyManagement).toBe("Unmanaged");
});

test.for([
  { poolScope: "other-organization:environment" },
  { poolScope: "organization:other-environment" },
  { namespace: "other-namespace" },
  { image: "other-image:v1" },
  { privileged: true },
  { resources: { cpuRequest: "2" } },
  { workspaceStorageSize: "50Gi" },
  { workspaceStorageClass: "other-storage" },
  { nodeSelector: { node: "other-pool" } },
  { imagePullSecrets: ["private-registry"] },
  {
    effectiveNetworkPolicy: {
      source: "environment" as const,
      policy: {
        egressMode: "off" as const,
        domainPreset: "none" as const,
        allowedDomains: [],
        allowedCidrs: [],
      },
    },
  },
])("does not allocate incompatible warm capacity: %j", (change) => {
  expect(warmPoolTemplate({ ...SPEC, ...change }).name).not.toBe(
    warmPoolTemplate(SPEC).name,
  );
});

test("falls back to direct Sandbox creation when extensions or a compatible pool are unavailable", async () => {
  config.agentRuntime.warmPoolSize = 1;
  server.use(
    http.get(
      `${ORIGIN}/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/test/sandboxwarmpools/:name`,
      () => HttpResponse.json({ code: 404 }, { status: 404 }),
    ),
  );
  expect(await agentWarmPoolManager.claim({ api: api(), spec: SPEC })).toBe(
    false,
  );
});

test("cold-starts a floating image instead of claiming a potentially stale pool", async () => {
  config.agentRuntime.warmPoolSize = 1;
  expect(
    await agentWarmPoolManager.claim({
      api: api(),
      spec: {
        ...SPEC,
        image: "registry.example.test/agent-claude-code:latest",
      },
    }),
  ).toBe(false);
});

test("claims without environment or disk overrides that would force an upstream cold start", async () => {
  config.agentRuntime.warmPoolSize = 1;
  let submitted: Record<string, unknown> | undefined;
  server.use(
    http.get(
      `${ORIGIN}/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/test/sandboxwarmpools/:name`,
      () => HttpResponse.json({}),
    ),
    http.post(
      `${ORIGIN}/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/test/sandboxclaims`,
      async ({ request }) => {
        submitted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(submitted, { status: 201 });
      },
    ),
  );
  expect(await agentWarmPoolManager.claim({ api: api(), spec: SPEC })).toBe(
    true,
  );
  expect(submitted?.spec).not.toHaveProperty("env");
  expect(submitted?.spec).not.toHaveProperty("volumeClaimTemplates");
  expect(JSON.stringify(submitted)).not.toContain("secret-value");
});

test("rejects a claim pointing at another workspace's Sandbox", async () => {
  server.use(
    http.get(
      `${ORIGIN}/apis/agents.x-k8s.io/v1beta1/namespaces/test/sandboxes/workspace`,
      () => HttpResponse.json({ code: 404 }, { status: 404 }),
    ),
    http.get(
      `${ORIGIN}/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/test/sandboxclaims/workspace`,
      () =>
        HttpResponse.json({
          metadata: { uid: "claim-owner" },
          status: { sandbox: { name: "assigned" } },
        }),
    ),
    http.get(
      `${ORIGIN}/apis/agents.x-k8s.io/v1beta1/namespaces/test/sandboxes/assigned`,
      () =>
        HttpResponse.json({
          metadata: {
            ownerReferences: [{ uid: "different-owner", kind: "SandboxClaim" }],
          },
        }),
    ),
  );
  await expect(
    readWorkspaceSandbox({ api: api(), namespace: "test", name: "workspace" }),
  ).rejects.toThrow("does not belong");
});

const ORIGIN = "https://kubernetes.example.test";
function api() {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromOptions({
    clusters: [{ name: "test", server: ORIGIN }],
    users: [{ name: "test" }],
    contexts: [{ name: "test", cluster: "test", user: "test" }],
    currentContext: "test",
  });
  return kubeConfig.makeApiClient(CustomObjectsApi);
}
const SPEC: KubernetesAgentRunLaunchSpec = {
  poolScope: "organization:environment",
  taskId: "task",
  agentRuntimeId: "agent",
  frozenName: "workspace",
  namespace: "test",
  image: "runtime:v1",
  command: ["echo", "hello"],
  privileged: false,
  resources: { cpuRequest: "500m", memoryRequest: "1Gi" },
  env: {},
  secretEnv: { PRIVATE: "secret-value" },
  inputFileCount: 0,
  activeDeadlineSeconds: 600,
  nodeSelector: {},
  imagePullSecrets: [],
  ownerReferences: undefined,
  effectiveNetworkPolicy: { source: "built_in", policy: null },
};
