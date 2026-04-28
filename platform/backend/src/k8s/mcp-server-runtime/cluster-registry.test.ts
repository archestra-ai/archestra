import { vi } from "vitest";
import type * as originalConfigModule from "@/config";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { McpServer } from "@/types";
import type { Cluster } from "@/types/cluster";

/**
 * Tests for ClusterRegistry — a stateful per-cluster cache of K8s clients
 * with a routing resolver that maps an McpServer to the correct cluster.
 */

// --- Mock @kubernetes/client-node (same idiom as manager.test.ts) -----------
vi.mock("@kubernetes/client-node", () => {
  class MockKubeConfig {
    clusters: Array<{ name: string; server: string }> = [];
    contexts: Array<{ name: string }> = [];
    users: Array<{ name: string }> = [];
    loadFromString = vi.fn();
    loadFromCluster = vi.fn();
    loadFromFile = vi.fn();
    loadFromDefault = vi.fn();
    makeApiClient = vi.fn(() => ({}));
  }
  return {
    KubeConfig: MockKubeConfig,
    CoreV1Api: vi.fn(),
    AppsV1Api: vi.fn(),
    BatchV1Api: vi.fn(),
    Attach: vi.fn(),
    Log: vi.fn(),
    Exec: vi.fn(),
  };
});

// --- Mock @/config to fix orchestrator.kubernetes shape --------------------
vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof originalConfigModule>();
  return {
    default: {
      ...actual.default,
      orchestrator: {
        ...actual.default.orchestrator,
        kubernetes: {
          namespace: "env-namespace",
          kubeconfig: undefined,
          loadKubeconfigFromCurrentCluster: false,
          k8sNodeHost: undefined,
          clusterDomain: "cluster.local",
        },
      },
    },
  };
});

// --- Mock ClusterModel (registry calls getById/getDefault/getPersonalDefault)
vi.mock("@/models/cluster", () => ({
  default: {
    getById: vi.fn(),
    getDefault: vi.fn(),
    getPersonalDefault: vi.fn(),
  },
}));

// --- Mock SecretModel (registry decrypts kubeconfigSecretId via findById) --
vi.mock("@/models/secret", () => ({
  default: {
    findById: vi.fn(),
  },
}));

// --- Mock @/k8s/shared so we can spy on buildKubeConfig and createK8sClients
vi.mock("@/k8s/shared", () => ({
  buildKubeConfig: vi.fn(),
  createK8sClients: vi.fn(),
  validateKubeconfig: vi.fn(),
  isK8sConfigured: vi.fn(() => true),
  getK8sNamespace: vi.fn(() => "env-namespace"),
  loadKubeConfig: vi.fn(),
}));

// --- Helpers ----------------------------------------------------------------
function makeCluster(overrides: Partial<Cluster> = {}): Cluster {
  return {
    id: "cluster-default-id",
    name: "default",
    namespace: null,
    kubeconfigSecretId: null,
    loadFromCluster: false,
    isDefault: true,
    isPersonalDefault: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Cluster;
}

function makeMcpServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: "srv-1",
    name: "test-server",
    catalogId: "catalog-1",
    secretId: null,
    ownerId: null,
    teamId: null,
    reinstallRequired: false,
    localInstallationStatus: "idle",
    localInstallationError: null,
    oauthRefreshError: null,
    oauthRefreshFailedAt: null,
    serverType: "local",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as McpServer;
}

/**
 * Lazy-import helpers — registry file does not exist yet.
 * Each call uses fresh module state via vi.resetModules() in beforeEach.
 */
async function importRegistry() {
  const mod = await import("./cluster-registry");
  return mod;
}

async function importMocks() {
  const ClusterModel = (await import("@/models/cluster")).default;
  const SecretModel = (await import("@/models/secret")).default;
  const shared = await import("@/k8s/shared");
  return { ClusterModel, SecretModel, shared };
}

/**
 * Default behavior for `buildKubeConfig` and `createK8sClients`:
 * each call returns a fresh, identifiable kubeConfig object so that
 * cache-hit tests can assert by-reference equality.
 */
function setupDefaultMocks(
  shared: Awaited<ReturnType<typeof importMocks>>["shared"],
) {
  let counter = 0;
  vi.mocked(shared.buildKubeConfig).mockImplementation((input) => {
    counter += 1;
    return {
      kubeConfig: {
        __id: `kc-${counter}`,
        __input: input,
      } as unknown as import("@kubernetes/client-node").KubeConfig,
      namespace: input.namespace?.trim() || "default",
    };
  });
  vi.mocked(shared.createK8sClients).mockImplementation(
    (kubeConfig, resolvedNamespace) =>
      ({
        kubeConfig,
        coreApi: {},
        appsApi: {},
        batchApi: {},
        attach: {},
        exec: {},
        log: {},
        namespace: resolvedNamespace,
      }) as unknown as ReturnType<typeof shared.createK8sClients>,
  );
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ClusterRegistry.resolveForServer (routing)", () => {
  test("explicit mcpServer.clusterId → uses that cluster (ClusterModel.getById)", async () => {
    const { ClusterModel, shared } = await importMocks();
    setupDefaultMocks(shared);

    const explicit = makeCluster({
      id: "cluster-explicit",
      name: "team-eu",
      isDefault: false,
      namespace: "team-eu-ns",
      loadFromCluster: true,
    });
    vi.mocked(ClusterModel.getById).mockResolvedValue(explicit);

    const { ClusterRegistry } = await importRegistry();
    const registry = new ClusterRegistry();

    const result = await registry.resolveForServer(
      makeMcpServer({ clusterId: "cluster-explicit" } as Partial<McpServer>),
    );

    expect(ClusterModel.getById).toHaveBeenCalledWith("cluster-explicit");
    expect(ClusterModel.getDefault).not.toHaveBeenCalled();
    expect(ClusterModel.getPersonalDefault).not.toHaveBeenCalled();
    expect(result.clusterId).toBe("cluster-explicit");
    expect(result.namespace).toBe("team-eu-ns");
    expect(result.clients.kubeConfig).toBeDefined();
  });

  test("personal MCP + personal-default exists → uses personal-default cluster", async () => {
    const { ClusterModel, shared } = await importMocks();
    setupDefaultMocks(shared);

    const personalDefault = makeCluster({
      id: "cluster-personal",
      name: "personal-default",
      isDefault: false,
      isPersonalDefault: true,
      namespace: "personal-ns",
      loadFromCluster: true,
    });
    vi.mocked(ClusterModel.getPersonalDefault).mockResolvedValue(
      personalDefault,
    );

    const { ClusterRegistry } = await importRegistry();
    const registry = new ClusterRegistry();

    const result = await registry.resolveForServer(
      makeMcpServer({ ownerId: "user-1", teamId: null }),
    );

    expect(ClusterModel.getPersonalDefault).toHaveBeenCalled();
    expect(ClusterModel.getDefault).not.toHaveBeenCalled();
    expect(ClusterModel.getById).not.toHaveBeenCalled();
    expect(result.clusterId).toBe("cluster-personal");
    expect(result.namespace).toBe("personal-ns");
  });

  test("personal MCP + no personal-default → falls back to default cluster", async () => {
    const { ClusterModel, shared } = await importMocks();
    setupDefaultMocks(shared);

    vi.mocked(ClusterModel.getPersonalDefault).mockResolvedValue(null);
    const def = makeCluster({ id: "cluster-default", name: "default" });
    vi.mocked(ClusterModel.getDefault).mockResolvedValue(def);

    const { ClusterRegistry } = await importRegistry();
    const registry = new ClusterRegistry();

    const result = await registry.resolveForServer(
      makeMcpServer({ ownerId: "user-1", teamId: null }),
    );

    expect(ClusterModel.getPersonalDefault).toHaveBeenCalled();
    expect(ClusterModel.getDefault).toHaveBeenCalled();
    expect(result.clusterId).toBe("cluster-default");
  });

  test("team MCP (teamId set) → uses default cluster", async () => {
    const { ClusterModel, shared } = await importMocks();
    setupDefaultMocks(shared);

    const def = makeCluster({ id: "cluster-default", name: "default" });
    vi.mocked(ClusterModel.getDefault).mockResolvedValue(def);

    const { ClusterRegistry } = await importRegistry();
    const registry = new ClusterRegistry();

    const result = await registry.resolveForServer(
      makeMcpServer({ ownerId: null, teamId: "team-a" }),
    );

    expect(ClusterModel.getDefault).toHaveBeenCalled();
    expect(ClusterModel.getPersonalDefault).not.toHaveBeenCalled();
    expect(result.clusterId).toBe("cluster-default");
  });

  test("built-in MCP (no owner, no team) → uses default cluster", async () => {
    const { ClusterModel, shared } = await importMocks();
    setupDefaultMocks(shared);

    const def = makeCluster({ id: "cluster-default", name: "default" });
    vi.mocked(ClusterModel.getDefault).mockResolvedValue(def);

    const { ClusterRegistry } = await importRegistry();
    const registry = new ClusterRegistry();

    const result = await registry.resolveForServer(
      makeMcpServer({ ownerId: null, teamId: null }),
    );

    expect(ClusterModel.getDefault).toHaveBeenCalled();
    expect(ClusterModel.getPersonalDefault).not.toHaveBeenCalled();
    expect(result.clusterId).toBe("cluster-default");
  });
});

describe("ClusterRegistry caching", () => {
  test("cache hit: two consecutive calls reuse the same kubeConfig (buildKubeConfig called once)", async () => {
    const { ClusterModel, shared } = await importMocks();
    setupDefaultMocks(shared);

    const def = makeCluster({ id: "cluster-default", name: "default" });
    vi.mocked(ClusterModel.getDefault).mockResolvedValue(def);

    const { ClusterRegistry } = await importRegistry();
    const registry = new ClusterRegistry();

    const first = await registry.resolveForServer(makeMcpServer());
    const second = await registry.resolveForServer(makeMcpServer());

    expect(shared.buildKubeConfig).toHaveBeenCalledTimes(1);
    expect(first.clients.kubeConfig).toBe(second.clients.kubeConfig);
  });

  test("invalidate(clusterId) → next call rebuilds (buildKubeConfig spy called again)", async () => {
    const { ClusterModel, shared } = await importMocks();
    setupDefaultMocks(shared);

    const def = makeCluster({ id: "cluster-default", name: "default" });
    vi.mocked(ClusterModel.getDefault).mockResolvedValue(def);

    const { ClusterRegistry } = await importRegistry();
    const registry = new ClusterRegistry();

    await registry.resolveForServer(makeMcpServer());
    expect(shared.buildKubeConfig).toHaveBeenCalledTimes(1);

    registry.invalidate("cluster-default");

    await registry.resolveForServer(makeMcpServer());
    expect(shared.buildKubeConfig).toHaveBeenCalledTimes(2);
  });
});

describe("ClusterRegistry kubeconfig sources", () => {
  test("default cluster with kubeconfigSecretId=null → uses env-var path (config.orchestrator.kubernetes)", async () => {
    const { ClusterModel, SecretModel, shared } = await importMocks();
    setupDefaultMocks(shared);

    const def = makeCluster({
      id: "cluster-default",
      name: "default",
      isDefault: true,
      kubeconfigSecretId: null,
      namespace: null,
      loadFromCluster: false,
    });
    vi.mocked(ClusterModel.getDefault).mockResolvedValue(def);

    const { ClusterRegistry } = await importRegistry();
    const registry = new ClusterRegistry();

    const result = await registry.resolveForServer(makeMcpServer());

    // Should NOT decrypt any secret (no kubeconfigSecretId)
    expect(SecretModel.findById).not.toHaveBeenCalled();
    // Should call buildKubeConfig — but NOT with a kubeconfigYaml (env-var path)
    expect(shared.buildKubeConfig).toHaveBeenCalledTimes(1);
    const call = vi.mocked(shared.buildKubeConfig).mock.calls[0][0];
    expect(call.kubeconfigYaml).toBeFalsy();
    // Should resolve cleanly (no error)
    expect(result.clusterId).toBe("cluster-default");
  });

  test("non-default cluster with kubeconfigSecretId → SecretModel.findById decrypts, buildKubeConfig({ kubeconfigYaml }) called", async () => {
    const { ClusterModel, SecretModel, shared } = await importMocks();
    setupDefaultMocks(shared);

    const cluster = makeCluster({
      id: "cluster-team-eu",
      name: "team-eu",
      isDefault: false,
      kubeconfigSecretId: "secret-abc",
      namespace: "team-eu-ns",
      loadFromCluster: false,
    });
    vi.mocked(ClusterModel.getById).mockResolvedValue(cluster);
    vi.mocked(SecretModel.findById).mockResolvedValue({
      id: "secret-abc",
      name: "cluster-kubeconfig:team-eu",
      secret: { kubeconfig: "apiVersion: v1\nkind: Config" },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof SecretModel.findById>>);

    const { ClusterRegistry } = await importRegistry();
    const registry = new ClusterRegistry();

    const result = await registry.resolveForServer(
      makeMcpServer({ clusterId: "cluster-team-eu" } as Partial<McpServer>),
    );

    expect(SecretModel.findById).toHaveBeenCalledWith("secret-abc");
    expect(shared.buildKubeConfig).toHaveBeenCalledTimes(1);
    const call = vi.mocked(shared.buildKubeConfig).mock.calls[0][0];
    expect(call.kubeconfigYaml).toBe("apiVersion: v1\nkind: Config");
    expect(call.namespace).toBe("team-eu-ns");
    expect(result.clusterId).toBe("cluster-team-eu");
  });
});

describe("ClusterRegistry concurrency", () => {
  test("concurrent resolveForServer for same uncached cluster → buildKubeConfig called once (in-flight de-dup)", async () => {
    const { ClusterModel, shared } = await importMocks();

    // Make buildKubeConfig deliberately slow so the two awaits overlap.
    let buildCallCount = 0;
    vi.mocked(shared.buildKubeConfig).mockImplementation((input) => {
      buildCallCount += 1;
      return {
        kubeConfig: {
          __id: `kc-${buildCallCount}`,
        } as unknown as import("@kubernetes/client-node").KubeConfig,
        namespace: input.namespace?.trim() || "default",
      };
    });
    vi.mocked(shared.createK8sClients).mockImplementation(
      (kubeConfig, resolvedNamespace) =>
        ({
          kubeConfig,
          coreApi: {},
          appsApi: {},
          batchApi: {},
          attach: {},
          exec: {},
          log: {},
          namespace: resolvedNamespace,
        }) as unknown as ReturnType<typeof shared.createK8sClients>,
    );

    // ClusterModel.getDefault returns a slow promise so both calls land in-flight.
    let resolveCluster: ((c: Cluster) => void) | undefined;
    const clusterPromise = new Promise<Cluster>((r) => {
      resolveCluster = r;
    });
    vi.mocked(ClusterModel.getDefault).mockReturnValue(clusterPromise);

    const { ClusterRegistry } = await importRegistry();
    const registry = new ClusterRegistry();

    const p1 = registry.resolveForServer(makeMcpServer());
    const p2 = registry.resolveForServer(makeMcpServer());

    // Both calls in flight — release the cluster lookup
    resolveCluster?.(makeCluster({ id: "cluster-default", name: "default" }));

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(shared.buildKubeConfig).toHaveBeenCalledTimes(1);
    expect(r1.clients.kubeConfig).toBe(r2.clients.kubeConfig);
  });
});
