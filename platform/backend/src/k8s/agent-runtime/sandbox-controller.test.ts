import { KubeConfig, type V1NetworkPolicy } from "@kubernetes/client-node";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import config from "@/config";
import { clusterDnsResolver } from "@/k8s/cluster-dns";
import { classifyAgentRunFailure } from "@/services/agent-runtime/run-failure";
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
let originalDnsIps: string[];

beforeEach(() => {
  originalDnsIps = config.orchestrator.kubernetes.clusterDnsIps;
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
  config.orchestrator.kubernetes.clusterDnsIps = originalDnsIps;
  clusterDnsResolver.clearCache();
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

test.each([
  { dnsSource: "discovered", configuredIps: [], expectedDnsIp: "10.96.0.10" },
  {
    dnsSource: "configured",
    configuredIps: ["169.254.20.10"],
    expectedDnsIp: "169.254.20.10",
  },
])("launch on retry waits for Sandbox deletion and applies $dnsSource DNS restrictions", async ({
  configuredIps,
  expectedDnsIp,
}) => {
  clusterDnsResolver.clearCache();
  config.orchestrator.kubernetes.clusterDnsIps = configuredIps;
  const policies: V1NetworkPolicy[] = [];
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
      async ({ request }) => {
        policies.push((await request.json()) as V1NetworkPolicy);
        return HttpResponse.json({}, { status: 201 });
      },
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
  const platformPolicy = policies.find(
    (policy) => policy.metadata?.name === "workspace-np",
  );
  const dnsRules = platformPolicy?.spec?.egress?.filter((rule) =>
    rule.ports?.some((port) => port.port === 53),
  );
  expect(dnsRules?.flatMap((rule) => rule.to ?? [])).toEqual([
    {
      namespaceSelector: {
        matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
      },
      podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
    },
    { ipBlock: { cidr: `${expectedDnsIp}/32` } },
  ]);
});

test("keeps the terminating-sandbox marker after a deletion timeout so a later launch never adopts the timed-out Sandbox and only creates once it is gone", async () => {
  serveController({ installed: true });
  await expect(manager.assertSandboxApiInstalled()).resolves.toBeUndefined();

  const originalTimeout = config.agentRuntime.podStartTimeoutSeconds;
  config.agentRuntime.podStartTimeoutSeconds = 0;

  let sandboxReads = 0;
  let sandboxDeletedInCluster = false;
  let sandboxCreateCount = 0;
  const cacheControlHeaders: Array<string | null> = [];

  try {
    server.use(
      http.get(
        `${origin}/apis/rbac.authorization.k8s.io/v1/namespaces/test/roles/archestra-agent-runtime`,
        () => HttpResponse.json({ code: 404 }, { status: 404 }),
      ),
      http.delete(
        `${origin}/apis/agents.x-k8s.io/v1beta1/namespaces/test/sandboxes/workspace`,
        () => HttpResponse.json({}, { status: 200 }),
      ),
      http.delete(`${origin}/api/v1/namespaces/test/secrets/:name`, () =>
        HttpResponse.json({ code: 404 }, { status: 404 }),
      ),
      http.delete(
        `${origin}/apis/networking.k8s.io/v1/namespaces/test/networkpolicies/:name`,
        () => HttpResponse.json({ code: 404 }, { status: 404 }),
      ),
      http.delete(
        `${origin}/apis/:group/:version/namespaces/test/:plural/:name`,
        () => HttpResponse.json({ code: 404 }, { status: 404 }),
      ),
      http.get(
        `${origin}/apis/agents.x-k8s.io/v1beta1/namespaces/test/sandboxes/workspace`,
        ({ request }) => {
          sandboxReads += 1;
          cacheControlHeaders.push(request.headers.get("cache-control"));
          if (sandboxDeletedInCluster) {
            return HttpResponse.json({ code: 404 }, { status: 404 });
          }
          return HttpResponse.json({
            apiVersion: "agents.x-k8s.io/v1beta1",
            kind: "Sandbox",
            metadata: {
              name: "workspace",
              namespace: "test",
            },
            spec: {},
          });
        },
      ),
      http.get(
        `${origin}/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/test/sandboxclaims/workspace`,
        () => HttpResponse.json({ code: 404 }, { status: 404 }),
      ),
      http.post(
        `${origin}/api/v1/namespaces/test/secrets`,
        async ({ request }) => {
          const body = await request.json();
          return HttpResponse.json(body, { status: 201 });
        },
      ),
      http.get(
        `${origin}/api/v1/namespaces/kube-system/services/kube-dns`,
        () =>
          HttpResponse.json({
            spec: { clusterIP: "10.96.0.10", clusterIPs: ["10.96.0.10"] },
          }),
      ),
      http.get(`${origin}/apis/networking.k8s.io/v1`, () =>
        HttpResponse.json({
          kind: "APIResourceList",
          apiVersion: "v1",
          groupVersion: "networking.k8s.io/v1",
          resources: [{ name: "networkpolicies", kind: "NetworkPolicy" }],
        }),
      ),
      http.post(
        `${origin}/apis/networking.k8s.io/v1/namespaces/test/networkpolicies`,
        async ({ request }) => {
          const body = await request.json();
          return HttpResponse.json(body, { status: 201 });
        },
      ),
      http.post(
        `${origin}/apis/agents.x-k8s.io/v1beta1/namespaces/test/sandboxes`,
        async ({ request }) => {
          sandboxCreateCount += 1;
          const body = await request.json();
          return HttpResponse.json(body, { status: 201 });
        },
      ),
    );

    await manager.deleteWorkspace({
      id: "run-1",
      runtimeScope: "test",
      workloadName: "workspace",
    });

    const launchSpec = {
      taskId: "task-timeout",
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
      effectiveNetworkPolicy: { source: "built_in" as const, policy: null },
    };

    let firstTimedOutError: unknown;
    try {
      await manager.launch(launchSpec);
    } catch (error) {
      firstTimedOutError = error;
    }
    expect(classifyAgentRunFailure(firstTimedOutError)?.code).toBe(
      "launch.capacity_timeout",
    );

    // While the previous Sandbox is still present (even without deletionTimestamp
    // and without replacePriorAttempt), a second launch must NOT adopt it.
    let secondTimedOutError: unknown;
    try {
      await manager.launch(launchSpec);
    } catch (error) {
      secondTimedOutError = error;
    }
    expect(classifyAgentRunFailure(secondTimedOutError)?.code).toBe(
      "launch.capacity_timeout",
    );
    expect(sandboxCreateCount).toBe(0);

    // Once the old Sandbox finishes deleting and returns NotFound, the next launch
    // clears the marker and creates a fresh Sandbox.
    sandboxDeletedInCluster = true;
    await expect(manager.launch(launchSpec)).resolves.toBeUndefined();
    expect(sandboxReads).toBe(3);
    expect(cacheControlHeaders).toEqual(["no-cache", "no-cache", "no-cache"]);
    expect(sandboxCreateCount).toBe(1);
  } finally {
    config.agentRuntime.podStartTimeoutSeconds = originalTimeout;
  }
});

test("continuation replaces the retained pod's platform policy with configured DNS peers", async () => {
  serveController({ installed: true });
  await expect(manager.assertSandboxApiInstalled()).resolves.toBeUndefined();
  config.orchestrator.kubernetes.clusterDnsIps = ["169.254.20.10"];
  clusterDnsResolver.clearCache();
  const replaced: V1NetworkPolicy[] = [];
  server.use(
    http.get(
      `${origin}/apis/agents.x-k8s.io/v1beta1/namespaces/test/sandboxes/workspace`,
      () =>
        HttpResponse.json({
          apiVersion: "agents.x-k8s.io/v1beta1",
          kind: "Sandbox",
          metadata: { name: "workspace", namespace: "test" },
          spec: {
            podTemplate: {
              metadata: {
                labels: { "archestra.io/agent-run-task-id": "original-task" },
              },
              spec: {
                containers: [{ name: "agent-runtime", image: "runtime:v1" }],
              },
            },
          },
        }),
    ),
    http.get(`${origin}/apis/cilium.io/v2`, () =>
      HttpResponse.json({ code: 404 }, { status: 404 }),
    ),
    http.get(`${origin}/apis/crd.projectcalico.org/v1`, () =>
      HttpResponse.json({ code: 404 }, { status: 404 }),
    ),
    http.get(`${origin}/api/v1/namespaces/default/services/kubernetes`, () =>
      HttpResponse.json({ spec: { ipFamilies: ["IPv4"] } }),
    ),
    http.get(`${origin}/api/v1/namespaces/:ns/services/:svc`, () =>
      HttpResponse.json({ code: 404 }, { status: 404 }),
    ),
    http.post(
      `${origin}/apis/networking.k8s.io/v1/namespaces/test/networkpolicies`,
      () => HttpResponse.json({ code: 409 }, { status: 409 }),
    ),
    http.put(
      `${origin}/apis/networking.k8s.io/v1/namespaces/test/networkpolicies/:name`,
      async ({ request }) => {
        const policy = (await request.json()) as V1NetworkPolicy;
        replaced.push(policy);
        return HttpResponse.json(policy);
      },
    ),
    http.delete(
      `${origin}/apis/:group/:version/namespaces/test/:plural/workspace-egress`,
      () => HttpResponse.json({ code: 404 }, { status: 404 }),
    ),
    // Stop at the next external boundary after policy replacement. No pod
    // wake-up or command execution is needed to observe this contract.
    http.patch(`${origin}/api/v1/namespaces/test/secrets/workspace-env`, () =>
      HttpResponse.json(
        { message: "stop after policy refresh", code: 403 },
        { status: 403 },
      ),
    ),
  );

  await expect(
    manager.continueRun({
      session: {
        runtimeScope: "test",
        workloadName: "workspace",
      } as Parameters<typeof manager.continueRun>[0]["session"],
      spec: {
        taskId: "next-task",
        agentRuntimeId: "agent-1",
        frozenName: "workspace",
        runtimeScope: "test",
        image: "runtime:v1",
        command: ["echo", "hello"],
        privileged: false,
        resources: null,
        tier: null,
        warmTiers: [],
        env: {},
        secretEnv: {},
        inputFileCount: 0,
        activeDeadlineSeconds: 600,
        nodeSelector: {},
        imagePullSecrets: [],
        effectiveNetworkPolicy: { source: "built_in", policy: null },
      },
    }),
  ).rejects.toThrow("stop after policy refresh");
  const policy = replaced.find(
    ({ metadata }) => metadata?.name === "workspace-np",
  );
  expect(policy?.spec?.podSelector?.matchLabels).toEqual({
    "archestra.io/agent-run-task-id": "original-task",
  });
  expect(
    policy?.spec?.egress?.filter((rule) =>
      rule.ports?.some((port) => port.port === 53),
    ),
  ).toEqual([
    {
      to: [
        {
          namespaceSelector: {
            matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
          },
          podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
        },
      ],
      ports: [
        { protocol: "UDP", port: 53 },
        { protocol: "TCP", port: 53 },
      ],
    },
    {
      to: [{ ipBlock: { cidr: "169.254.20.10/32" } }],
      ports: [
        { protocol: "UDP", port: 53 },
        { protocol: "TCP", port: 53 },
      ],
    },
  ]);
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
