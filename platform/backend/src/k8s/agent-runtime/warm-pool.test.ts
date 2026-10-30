import { DEFAULT_AGENT_RUNTIME_TIERS } from "@archestra/shared";
import { CustomObjectsApi, KubeConfig } from "@kubernetes/client-node";
import { HttpResponse, http } from "msw";
import { expect, test, vi } from "vitest";
import config from "@/config";
import { createK8sClients } from "@/k8s/shared";
import { AgentModel, EnvironmentModel, OrganizationModel } from "@/models";
import { useMswServer } from "@/test/msw";
import type { KubernetesAgentRunLaunchSpec } from "./manifests";
import { agentSandboxApi } from "./sandbox-api";
import {
  agentWarmPoolManager,
  readWorkspaceSandbox,
  servedLaunchSpec,
} from "./warm-pool";
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
  expect(
    await agentWarmPoolManager.claim({ api: api(), spec: SPEC }),
  ).toBeNull();
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
  ).toBeNull();
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
  expect(await agentWarmPoolManager.claim({ api: api(), spec: SPEC })).toEqual({
    tier: null,
  });
  expect(submitted?.spec).not.toHaveProperty("env");
  expect(submitted?.spec).not.toHaveProperty("volumeClaimTemplates");
  expect(JSON.stringify(submitted)).not.toContain("secret-value");
});

test("serves a drained or missing tier from the larger tier's ready pool, never from a smaller one", async () => {
  config.agentRuntime.warmPoolSize = 1;
  // The organization's sizes: L is enlarged, so the claim must use the
  // spec's sizes rather than the code defaults.
  const sizes = {
    M: { cpuRequest: "2", memoryRequest: "4Gi", memoryLimit: "8Gi" },
    L: { cpuRequest: "6", memoryRequest: "12Gi", memoryLimit: "24Gi" },
  };
  const warmTiers = {
    M: [
      { tier: "M" as const, resources: sizes.M },
      { tier: "L" as const, resources: sizes.L },
    ],
    L: [{ tier: "L" as const, resources: sizes.L }],
  };
  const sized = (tier: "M" | "L") => ({
    ...SPEC,
    tier,
    warmTiers: warmTiers[tier],
    resources: sizes[tier],
  });
  const poolName = {
    M: warmPoolTemplate(sized("M")).name,
    L: warmPoolTemplate(sized("L")).name,
  };
  // Ready Sandboxes per tier; a missing key means the pool does not exist.
  let ready: Partial<Record<"M" | "L", number>> = {};
  type Claim = { spec?: { warmPoolRef?: { name: string } } };
  let submitted: Claim | undefined;
  server.use(
    http.get(
      `${ORIGIN}/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/test/sandboxwarmpools/:name`,
      ({ params }) => {
        const tier = (["M", "L"] as const).find(
          (t) => poolName[t] === params.name,
        );
        return tier && ready[tier] !== undefined
          ? HttpResponse.json({ status: { readyReplicas: ready[tier] } })
          : HttpResponse.json({ code: 404 }, { status: 404 });
      },
    ),
    http.post(
      `${ORIGIN}/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/test/sandboxclaims`,
      async ({ request }) => {
        submitted = (await request.json()) as typeof submitted;
        return HttpResponse.json(submitted, { status: 201 });
      },
    ),
  );
  const claim = async (tier: "M" | "L") => {
    submitted = undefined;
    const result = await agentWarmPoolManager.claim({
      api: api(),
      spec: sized(tier),
    });
    // Set by the POST handler during the claim; TypeScript cannot see that.
    const sent = submitted as Claim | undefined;
    return { result, pool: sent?.spec?.warmPoolRef?.name };
  };

  // Both ready: the requested tier serves.
  ready = { M: 1, L: 1 };
  expect(await claim("M")).toEqual({ result: { tier: "M" }, pool: poolName.M });
  // M drained or missing, L ready: the run is promoted to L.
  ready = { M: 0, L: 1 };
  expect(await claim("M")).toEqual({ result: { tier: "L" }, pool: poolName.L });
  ready = { L: 1 };
  expect(await claim("M")).toEqual({ result: { tier: "L" }, pool: poolName.L });
  // Both drained: the run waits on its own pool to refill.
  ready = { M: 0, L: 0 };
  expect(await claim("M")).toEqual({ result: { tier: "M" }, pool: poolName.M });
  // No M pool and an empty L pool: a larger tier never gets a waiting claim.
  ready = { L: 0 };
  expect(await claim("M")).toEqual({ result: null, pool: undefined });
  // An L run is never demoted to a ready M pool.
  ready = { M: 1 };
  expect(await claim("L")).toEqual({ result: null, pool: undefined });
  ready = { M: 1, L: 0 };
  expect(await claim("L")).toEqual({ result: { tier: "L" }, pool: poolName.L });
});

test("keeps tier L spares apart: none by default, and no pool slot taken from the other tiers", async () => {
  const runtime = (tier: "M" | "L") => ({
    image: "runtime:v1",
    command: null,
    inferenceProtocol: "anthropic" as const,
    backend: "kubernetes" as const,
    steerMode: "tmux_keys" as const,
    privileged: false,
    resources: null,
    tier,
    environment: null,
    credentials: null,
    ttlHours: null,
    idleTimeoutMinutes: null,
  });
  // The organization's administrator settings for its tiers (null: defaults).
  let agentRuntimeTiers: Record<string, Record<string, unknown>> | null = null;
  const candidate = (id: string, tier: "M" | "L") => ({
    id,
    organizationId: "org",
    environmentId: null,
    runtime: runtime(tier),
    namespace: "test",
    defaultNamespace: null,
    environmentPolicy: null,
    defaultPolicy: null,
    agentRuntimeTiers,
  });
  vi.spyOn(agentSandboxApi, "isInstalled", "get").mockReturnValue(true);
  // The L Agent ran most recently, so it comes first.
  vi.spyOn(AgentModel, "listWarmPoolCandidates").mockImplementation(
    async () =>
      [candidate("tilt", "L"), candidate("worker", "M")] as Awaited<
        ReturnType<typeof AgentModel.listWarmPoolCandidates>
      >,
  );
  vi.spyOn(EnvironmentModel, "listAll").mockResolvedValue([]);
  vi.spyOn(OrganizationModel, "listDefaultEngineTargets").mockResolvedValue([
    { id: "org", defaultEnvironmentNamespace: null },
  ] as Awaited<ReturnType<typeof OrganizationModel.listDefaultEngineTargets>>);
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromOptions({
    clusters: [{ name: "test", server: ORIGIN }],
    users: [{ name: "test" }],
    contexts: [{ name: "test", cluster: "test", user: "test" }],
    currentContext: "test",
  });
  Object.assign(agentWarmPoolManager, {
    clients: createK8sClients(kubeConfig, "test"),
  });
  const base = `${ORIGIN}/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/test`;
  let pools: Array<{
    spec: { replicas: number; sandboxTemplateRef: { name: string } };
  }> = [];
  server.use(
    http.get(`${base}/sandboxwarmpools`, () =>
      HttpResponse.json({ items: [] }),
    ),
    http.get(`${base}/sandboxclaims`, () => HttpResponse.json({ items: [] })),
    http.post(
      `${ORIGIN}/apis/networking.k8s.io/v1/namespaces/test/networkpolicies`,
      async ({ request }) =>
        HttpResponse.json(await request.json(), { status: 201 }),
    ),
    http.post(`${base}/sandboxtemplates`, async ({ request }) =>
      HttpResponse.json(await request.json(), { status: 201 }),
    ),
    http.post(`${base}/sandboxwarmpools`, async ({ request }) => {
      const body = (await request.json()) as (typeof pools)[number];
      pools.push(body);
      return HttpResponse.json(body, { status: 201 });
    }),
  );
  const poolOf = (
    tier: "M" | "L",
    resources: object = DEFAULT_AGENT_RUNTIME_TIERS[tier],
  ) => {
    const {
      warmPoolSize: _,
      cpuLimit: __,
      ...sized
    } = {
      cpuLimit: null,
      warmPoolSize: null,
      ...resources,
    };
    return warmPoolTemplate({
      ...SPEC,
      tier,
      resources: sized,
      poolScope: "org:default",
    }).name;
  };
  const replicasByPool = () =>
    Object.fromEntries(
      pools.map((pool) => [
        pool.spec.sandboxTemplateRef.name,
        pool.spec.replicas,
      ]),
    );

  // Defaults: tier L keeps no spares and the one slot goes to the M Agent.
  config.agentRuntime.warmPoolSize = 2;
  config.agentRuntime.warmPoolMaxPools = 1;
  await agentWarmPoolManager.reconcile();
  expect(replicasByPool()).toEqual({ [poolOf("M")]: 2 });

  // An administrator gives L one spare and a larger size: a small pool of
  // that size, next to M's two spares.
  pools = [];
  config.agentRuntime.warmPoolMaxPools = 2;
  agentRuntimeTiers = { L: { cpuRequest: "6", warmPoolSize: 1 } };
  await agentWarmPoolManager.reconcile();
  expect(replicasByPool()).toEqual({
    [poolOf("L", { ...DEFAULT_AGENT_RUNTIME_TIERS.L, cpuRequest: "6" })]: 1,
    [poolOf("M")]: 2,
  });
});

test("a run served from a larger pool is told the size of the pod it got", () => {
  const sizes = {
    S: { cpuRequest: "2", memoryRequest: "4Gi", memoryLimit: "8Gi" },
    M: { cpuRequest: "4", memoryRequest: "8Gi", memoryLimit: "16Gi" },
  };
  const spec = {
    ...SPEC,
    tier: "S" as const,
    resources: sizes.S,
    warmTiers: [
      { tier: "S" as const, resources: sizes.S },
      { tier: "M" as const, resources: sizes.M },
    ],
    env: {
      ARCHESTRA_AGENT_RUNTIME_TIER: "S",
      ARCHESTRA_AGENT_RUNTIME_MAX_TIER: "L",
      ARCHESTRA_AGENT_RUNTIME_POD_CPU_REQUEST: "2",
      ARCHESTRA_AGENT_RUNTIME_POD_MEMORY_LIMIT: "8Gi",
      OTHER: "kept",
    },
  };
  const served = servedLaunchSpec(spec, "M");
  expect(served.tier).toBe("M");
  expect(served.resources).toEqual(sizes.M);
  expect(served.env).toEqual({
    ARCHESTRA_AGENT_RUNTIME_TIER: "M",
    ARCHESTRA_AGENT_RUNTIME_MAX_TIER: "L",
    ARCHESTRA_AGENT_RUNTIME_POD_CPU_REQUEST: "4",
    ARCHESTRA_AGENT_RUNTIME_POD_MEMORY_LIMIT: "16Gi",
    OTHER: "kept",
  });
  // Served by its own tier, or with no tiers at all: unchanged.
  expect(servedLaunchSpec(spec, "S")).toBe(spec);
  expect(servedLaunchSpec(SPEC, null)).toBe(SPEC);
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
  tier: null,
  warmTiers: [],
  env: {},
  secretEnv: { PRIVATE: "secret-value" },
  inputFileCount: 0,
  activeDeadlineSeconds: 600,
  nodeSelector: {},
  imagePullSecrets: [],
  ownerReferences: undefined,
  effectiveNetworkPolicy: { source: "built_in", policy: null },
};
