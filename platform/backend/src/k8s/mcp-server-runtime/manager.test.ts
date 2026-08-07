import * as fs from "node:fs";
import { PassThrough } from "node:stream";
import * as k8s from "@kubernetes/client-node";
import { vi } from "vitest";
// Resolve to this file's model mocks — the adopt tests assert on their calls.
import { enterpriseTier } from "@/enterprise-tier";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import McpServerModel, {
  MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS,
} from "@/models/mcp-server";
import OrganizationModel from "@/models/organization";
// biome-ignore lint/style/noRestrictedImports: runtime-gated EE model import
import { mcpActiveUseTracker } from "@/services/mcp-active-use.ee";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { McpServer, NetworkPolicy } from "@/types";

// Mock fs module first
vi.mock("node:fs");

// Mock @kubernetes/client-node for validateKubeconfig tests
vi.mock("@kubernetes/client-node", () => {
  interface MockCluster {
    name?: string;
    server?: string;
  }
  interface MockContext {
    name?: string;
  }
  interface MockUser {
    name?: string;
  }

  class MockKubeConfig {
    clusters: MockCluster[] = [];
    contexts: MockContext[] = [];
    users: MockUser[] = [];
    loadFromString(content: string) {
      try {
        const parsed = JSON.parse(content);
        this.clusters = parsed.clusters || [];
        this.contexts = parsed.contexts || [];
        this.users = parsed.users || [];
      } catch {
        throw new Error("Failed to parse kubeconfig");
      }
    }
    loadFromCluster() {}
    loadFromFile() {}
    loadFromDefault() {}
    makeApiClient() {}
  }
  return {
    KubeConfig: MockKubeConfig,
    CoreV1Api: vi.fn(),
    AppsV1Api: vi.fn(),
    AuthorizationV1Api: vi.fn(),
    NetworkingV1Api: vi.fn(),
    CustomObjectsApi: vi.fn(),
    BatchV1Api: vi.fn(),
    Attach: vi.fn(),
    Log: vi.fn(),
    Exec: vi.fn(),
    // A regular function so `new Watch(...)` works (arrows aren't constructable)
    Watch: vi.fn(function mockWatch() {
      return { watch: vi.fn().mockResolvedValue(new AbortController()) };
    }),
  };
});

// Mock the dependencies before importing the manager
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    orchestrator: {
      kubernetes: {
        namespace: "test-namespace",
        kubeconfig: undefined,
        loadKubeconfigFromCurrentCluster: false,
        // Pin to empty: configModuleMock inherits the real config, so an
        // ambient ARCHESTRA_ORCHESTRATOR_ENVIRONMENT_NAMESPACES (dev .env,
        // CI's copied .env.example) would add sweep namespaces and double
        // every reap/cleanup call count.
        environmentNamespaces: [],
      },
    },
  }),
);

// Track K8sDeployment constructor calls and method invocations
const mockCreateK8sSecret = vi.fn().mockResolvedValue(undefined);
const mockStartOrCreateDeployment = vi.fn().mockResolvedValue(undefined);
const mockCreateDockerRegistrySecrets = vi.fn().mockResolvedValue([]);
const mockDeleteK8sNetworkPolicy = vi.fn().mockResolvedValue(undefined);
const mockResolveHttpEndpoint = vi.fn().mockResolvedValue(undefined);
const mockWaitForDeploymentReady = vi.fn().mockResolvedValue(undefined);
const mockRemoveDeployment = vi.fn().mockResolvedValue(undefined);
const mockK8sDeploymentInstances: Array<{
  options: Record<string, unknown>;
  createK8sSecret: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("@/models/internal-mcp-catalog", () => ({
  default: {
    findById: vi.fn(),
    setDeploymentName: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/models/mcp-server", () => ({
  // Mirrors the real constant — the idle-hibernation sweeper adds it to the
  // idle window as grace for the throttled last-used stamp. NOT passed
  // through via importOriginal: the real module's import graph reaches
  // mcp-client and this runtime, so evaluating it at mock-registration time
  // caches the REAL McpServerModel into the `@/models` barrel before the
  // mock exists, un-mocking the model for the module under test. A
  // drift-guard test below asserts this value against the real constant.
  MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS: 30_000,
  default: {
    findById: vi.fn().mockResolvedValue(null),
    findByCatalogId: vi.fn().mockResolvedValue([]),
    setDeploymentName: vi.fn().mockResolvedValue(undefined),
    getLatestUsageAt: vi.fn().mockResolvedValue(null),
    // Per-install hibernation overrides; "no overrides" by default.
    getHibernationModes: vi.fn().mockResolvedValue([]),
  },
}));

// In-process demand signals consumed by the idle-hibernation sweeper. Defaults
// mean "no demand"; individual tests override per call.
vi.mock("@/services/mcp-active-use.ee", () => ({
  mcpActiveUseTracker: {
    trackActiveUse: vi.fn(),
    stamp: vi.fn(),
    getActiveUseCount: vi.fn(() => 0),
    getInMemoryLastUsedAt: vi.fn(() => null),
    remove: vi.fn(),
  },
}));

// Several tests below call vi.resetModules(), which rebuilds the graph the
// dynamically-imported manager pulls in — a real singleton imported statically
// by this file would then be a different object from the one the code under
// test uses, and stubbing it would silently do nothing. Mock factories survive
// the reset, so the enterprise gate is mocked like every other dependency.
vi.mock("@/enterprise-tier", () => ({
  enterpriseTier: {
    isCoreActive: vi.fn(() => true),
    isKnowledgeBaseActive: vi.fn(() => true),
    setUserCountForTesting: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  },
}));

vi.mock("@/models/mcp-http-session", () => ({
  default: {
    deleteByMcpServerId: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/models/organization", () => ({
  default: {
    getFirst: vi.fn().mockResolvedValue({
      id: "test-org",
      defaultNetworkPolicy: null,
    }),
    getById: vi.fn().mockResolvedValue({
      id: "test-org",
      defaultNetworkPolicy: null,
    }),
    // The organization's idle-hibernation opt-in. Defaulted ON here so the
    // sweeper tests are about the sweep; the gate has its own tests.
    getMcpIdleHibernationEnabled: vi.fn().mockResolvedValue(true),
    getMcpIdleHibernationEnabledSync: vi.fn().mockReturnValue(true),
  },
}));

vi.mock("@/services/environments/network-policy", () => ({
  resolveEffectiveNetworkPolicy: vi
    .fn()
    .mockResolvedValue({ source: "built_in", policy: null }),
}));

vi.mock("@/secrets-manager", () => ({
  secretManager: vi.fn(() => ({
    getSecret: vi.fn(),
  })),
}));

vi.mock("./k8s-deployment", () => {
  return {
    default: class MockK8sDeployment {
      options: Record<string, unknown>;
      createK8sSecret: ReturnType<typeof vi.fn>;
      startOrCreateDeployment: ReturnType<typeof vi.fn>;
      createDockerRegistrySecrets: ReturnType<typeof vi.fn>;
      deleteK8sNetworkPolicy: ReturnType<typeof vi.fn>;
      resolveHttpEndpoint: ReturnType<typeof vi.fn>;
      waitForDeploymentReady: ReturnType<typeof vi.fn>;
      removeDeployment: ReturnType<typeof vi.fn>;

      constructor(options: Record<string, unknown>) {
        this.options = options;
        this.createK8sSecret = mockCreateK8sSecret;
        this.startOrCreateDeployment = mockStartOrCreateDeployment;
        this.createDockerRegistrySecrets = mockCreateDockerRegistrySecrets;
        this.deleteK8sNetworkPolicy = mockDeleteK8sNetworkPolicy;
        this.resolveHttpEndpoint = mockResolveHttpEndpoint;
        this.waitForDeploymentReady = mockWaitForDeploymentReady;
        this.removeDeployment = mockRemoveDeployment;
        mockK8sDeploymentInstances.push({
          options,
          createK8sSecret: this.createK8sSecret,
        });
      }
      static sanitizeLabelValue(value: string): string {
        return value;
      }
      static collectImagePullSecretNames(): string[] {
        return [];
      }
      // Mirrors the real annotation check so the manager's direct-read guards
      // (cache-cold wake, external-scale seizure guard) behave.
      static hasHibernationAnnotation(deployment: {
        metadata?: { annotations?: Record<string, string> };
      }): boolean {
        return (
          deployment?.metadata?.annotations?.["archestra.io/hibernated"] ===
          "true"
        );
      }
      // Mirrors the real frozen-first logic: the stored deploymentName wins;
      // the name-derived recompute is only the NULL fallback.
      static constructDeploymentName(
        mcpServer: {
          name: string;
          deploymentName?: string | null;
          catalogId?: string | null;
        },
        catalogItem?: {
          multitenant?: boolean;
          name: string;
          deploymentName?: string | null;
        } | null,
      ): string {
        if (catalogItem?.multitenant && mcpServer.catalogId) {
          return (
            catalogItem.deploymentName ??
            `mcp-mt-${mcpServer.catalogId.slice(0, 8)}-${catalogItem.name.replaceAll(" ", "-")}`
          );
        }
        return (
          mcpServer.deploymentName ??
          `mcp-${mcpServer.name.replaceAll(" ", "-")}`
        );
      }
    },
    fetchPlatformPodNodeSelector: vi.fn().mockResolvedValue(undefined),
    fetchPlatformPodTolerations: vi.fn().mockResolvedValue(undefined),
    // The real class, not a stub: the manager distinguishes it from a slow
    // wake with `instanceof`, so the identity has to match.
    McpServerDeploymentFailedError: class McpServerDeploymentFailedError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "McpServerDeploymentFailedError";
      }
    },
    // Likewise: the wake path tells a full cluster apart from a broken pod by
    // identity, and re-reports the scheduler's own words to the caller.
    McpServerUnschedulableError: class McpServerUnschedulableError extends Error {
      constructor(
        deploymentName: string,
        readonly schedulerMessage: string,
      ) {
        super(
          `Deployment ${deploymentName} has a pod the cluster cannot schedule: ${schedulerMessage}`,
        );
        this.name = "McpServerUnschedulableError";
      }
    },
  };
});

// Some tests stub findById with a sticky mockResolvedValue; vi.clearAllMocks()
// clears calls but NOT implementations, so under randomized test order the
// catalog leaked into unrelated tests (extra sweep namespaces, throwing paths).
// Reset the implementation after every test.
afterEach(() => {
  vi.mocked(InternalMcpCatalogModel.findById).mockReset();
});

describe("validateKubeconfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("should not throw when no path provided", async () => {
    const { validateKubeconfig } = await import("@/k8s/shared");
    expect(() => validateKubeconfig(undefined)).not.toThrow();
  });

  test("should throw error when kubeconfig file does not exist", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { validateKubeconfig } = await import("@/k8s/shared");
    expect(() => validateKubeconfig("/nonexistent/path")).toThrow(
      /❌ Kubeconfig file not found/,
    );
  });

  test("should throw error when kubeconfig file cannot be parsed", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("invalid yaml content");
    const { validateKubeconfig } = await import("@/k8s/shared");
    expect(() => validateKubeconfig("/path")).toThrow(
      /❌ Malformed kubeconfig: could not parse YAML/,
    );
  });

  test("should throw error when clusters field is missing", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        contexts: [],
        users: [],
      }),
    );
    const { validateKubeconfig } = await import("@/k8s/shared");
    expect(() => validateKubeconfig("/path")).toThrow(
      /❌ Invalid kubeconfig: clusters section missing/,
    );
  });

  test("should throw error when clusters[0] is missing", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        clusters: [],
        contexts: [],
        users: [],
      }),
    );
    const { validateKubeconfig } = await import("@/k8s/shared");
    expect(() => validateKubeconfig("/path")).toThrow(
      /❌ Invalid kubeconfig: clusters section missing/,
    );
  });

  test("should throw error when cluster name or server is missing", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        clusters: [{}],
        contexts: [{ name: "test" }],
        users: [{ name: "test" }],
      }),
    );
    const { validateKubeconfig } = await import("@/k8s/shared");
    expect(() => validateKubeconfig("/path")).toThrow(
      /❌ Invalid kubeconfig: cluster entry is missing required fields/,
    );
  });

  test("should throw error when contexts field is missing", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        clusters: [{ name: "test", server: "https://test.com" }],
        contexts: [],
        users: [{ name: "test" }],
      }),
    );
    const { validateKubeconfig } = await import("@/k8s/shared");
    expect(() => validateKubeconfig("/path")).toThrow(
      /❌ Invalid kubeconfig: contexts section missing/,
    );
  });

  test("should throw error when users field is missing", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        clusters: [{ name: "test", server: "https://test.com" }],
        contexts: [{ name: "test" }],
        users: [],
      }),
    );
    const { validateKubeconfig } = await import("@/k8s/shared");
    expect(() => validateKubeconfig("/path")).toThrow(
      /❌ Invalid kubeconfig: users section missing/,
    );
  });

  test("should not throw error when kubeconfig is valid", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        clusters: [{ name: "test", server: "https://test.com" }],
        contexts: [{ name: "test" }],
        users: [{ name: "test" }],
      }),
    );
    const { validateKubeconfig } = await import("@/k8s/shared");
    expect(() => validateKubeconfig("/path")).not.toThrow();
  });
});

// --- McpServerRuntimeManager suite
describe("McpServerRuntimeManager", () => {
  describe("isEnabled", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
      mockK8sDeploymentInstances.length = 0;
    });

    test("should return false when k8s config fails to load", async () => {
      // Mock KubeConfig to throw an error when loading
      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {
          throw new Error("Failed to load kubeconfig");
        });

      // Dynamically import to get a fresh instance
      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      // isEnabled should be false when config fails to load
      expect(manager.isEnabled).toBe(false);

      mockLoadFromDefault.mockRestore();
    });

    test("should return true when k8s config loads successfully", async () => {
      // Mock successful loading
      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {
          // Do nothing - successful load
        });

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockReturnValue({} as k8s.CoreV1Api);

      // Dynamically import to get a fresh instance
      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      // isEnabled should be true when config loads successfully
      expect(manager.isEnabled).toBe(true);

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });

    test("should return false after shutdown", async () => {
      // Mock successful loading
      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {
          // Do nothing - successful load
        });

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockReturnValue({} as k8s.CoreV1Api);

      // Dynamically import to get a fresh instance
      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      // Should be enabled initially
      expect(manager.isEnabled).toBe(true);

      // Shutdown the runtime
      await manager.shutdown();

      // Should be disabled after shutdown
      expect(manager.isEnabled).toBe(false);

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });
  });

  describe("status transitions", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
    });

    test("should start with not_initialized status when config loads", async () => {
      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockReturnValue({} as k8s.CoreV1Api);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      // Status should be not_initialized (not error), so isEnabled should be true
      expect(manager.isEnabled).toBe(true);

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });

    test("should have error status when config fails", async () => {
      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {
          throw new Error("Config load failed");
        });

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      // Status should be error, so isEnabled should be false
      expect(manager.isEnabled).toBe(false);

      mockLoadFromDefault.mockRestore();
    });
  });

  describe("stopServer", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
    });

    test("should call stopDeployment, deleteK8sService, and deleteK8sSecret when deployment exists", async () => {
      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockReturnValue({} as k8s.CoreV1Api);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      // Create mock deployment with all cleanup methods
      const mockStopDeployment = vi.fn().mockResolvedValue(undefined);
      const mockDeleteK8sService = vi.fn().mockResolvedValue(undefined);
      const mockDeleteK8sSecret = vi.fn().mockResolvedValue(undefined);
      const mockDeleteDockerRegistrySecrets = vi
        .fn()
        .mockResolvedValue(undefined);
      const mockDeleteK8sNetworkPolicy = vi.fn().mockResolvedValue(undefined);

      const mockDeployment = {
        stopDeployment: mockStopDeployment,
        deleteK8sService: mockDeleteK8sService,
        deleteK8sSecret: mockDeleteK8sSecret,
        deleteDockerRegistrySecrets: mockDeleteDockerRegistrySecrets,
        deleteK8sNetworkPolicy: mockDeleteK8sNetworkPolicy,
      };

      // Access internal map and add mock deployment
      // @ts-expect-error - accessing private property for testing
      manager.mcpServerIdToDeploymentMap.set("test-server-id", mockDeployment);

      // Call stopServer
      await manager.stopServer("test-server-id");

      // Verify all cleanup methods were called
      expect(mockStopDeployment).toHaveBeenCalledTimes(1);
      expect(mockDeleteK8sService).toHaveBeenCalledTimes(1);
      expect(mockDeleteK8sSecret).toHaveBeenCalledTimes(1);
      expect(mockDeleteDockerRegistrySecrets).toHaveBeenCalledTimes(1);
      expect(mockDeleteK8sNetworkPolicy).toHaveBeenCalledTimes(1);

      // Verify deployment was removed from map
      // @ts-expect-error - accessing private property for testing
      expect(manager.mcpServerIdToDeploymentMap.has("test-server-id")).toBe(
        false,
      );

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });

    test("should do nothing when deployment does not exist", async () => {
      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockReturnValue({} as k8s.CoreV1Api);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      // Call stopServer with non-existent server ID - should not throw
      await expect(
        manager.stopServer("non-existent-server"),
      ).resolves.toBeUndefined();

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });

    test("lazy-loaded deployments receive custom-object API and network policy capabilities", async () => {
      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockK8sClient = {
        getAPIResources: vi.fn().mockResolvedValue({ resources: [] }),
      };
      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockReturnValue(mockK8sClient as unknown as k8s.CoreV1Api);

      const McpServerModel = (await import("@/models/mcp-server")).default;
      const InternalMcpCatalogModel = (
        await import("@/models/internal-mcp-catalog")
      ).default;

      vi.mocked(McpServerModel.findById).mockResolvedValueOnce({
        id: "lazy-server",
        name: "lazy-server",
        catalogId: "local-catalog",
      } as Awaited<ReturnType<typeof McpServerModel.findById>>);
      vi.mocked(InternalMcpCatalogModel.findById).mockResolvedValueOnce({
        id: "local-catalog",
        serverType: "local",
        localConfig: null,
      } as unknown as Awaited<
        ReturnType<typeof InternalMcpCatalogModel.findById>
      >);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();
      const managerAny = manager as unknown as {
        k8sApi: unknown;
        k8sAppsApi: unknown;
        k8sNetworkingApi: unknown;
        k8sCustomObjectsApi: unknown;
        k8sAttach: unknown;
        k8sLog: unknown;
        k8sExec: unknown;
      };
      managerAny.k8sApi = mockK8sClient;
      managerAny.k8sAppsApi = mockK8sClient;
      managerAny.k8sNetworkingApi = mockK8sClient;
      managerAny.k8sCustomObjectsApi = mockK8sClient;
      managerAny.k8sAttach = {};
      managerAny.k8sLog = {};
      managerAny.k8sExec = {};

      const deployment = await manager.getOrLoadDeployment("lazy-server");

      expect(deployment).toBeDefined();
      expect(mockResolveHttpEndpoint).toHaveBeenCalledTimes(1);
      const deploymentOptions = mockK8sDeploymentInstances.at(-1)?.options;
      expect(deploymentOptions).toHaveProperty("k8sCustomObjectsApi");
      expect(deploymentOptions).toMatchObject({
        // The mock exposes no provider CRDs, so no NetworkPolicy enforcer is
        // detected and the capability reports "none".
        networkPolicyCapabilities: {
          kubernetesNetworkPolicy: false,
          provider: "none",
          supportsFqdn: false,
        },
      });

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });

    test("getOrLoadDeployment with namespaceOverride bypasses the cache and builds in the override namespace", async () => {
      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});
      const mockK8sClient = {
        getAPIResources: vi.fn().mockResolvedValue({ resources: [] }),
      };
      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockReturnValue(mockK8sClient as unknown as k8s.CoreV1Api);

      const McpServerModel = (await import("@/models/mcp-server")).default;
      const InternalMcpCatalogModel = (
        await import("@/models/internal-mcp-catalog")
      ).default;
      const staleServer = {
        id: "stale-server",
        name: "stale-server",
        catalogId: "stale-catalog",
      } as Awaited<ReturnType<typeof McpServerModel.findById>>;
      // No environmentId → resolves to the manager's default namespace.
      const staleCatalog = {
        id: "stale-catalog",
        serverType: "local",
        environmentId: null,
        localConfig: null,
      } as unknown as Awaited<
        ReturnType<typeof InternalMcpCatalogModel.findById>
      >;
      // Two loads (normal + override) look these up once each. Use *Once so the
      // mock reverts to its default afterward and never leaks into other tests —
      // the suite runs in a shuffled order.
      vi.mocked(McpServerModel.findById)
        .mockResolvedValueOnce(staleServer)
        .mockResolvedValueOnce(staleServer);
      vi.mocked(InternalMcpCatalogModel.findById)
        .mockResolvedValueOnce(staleCatalog)
        .mockResolvedValueOnce(staleCatalog);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();
      const managerAny = manager as unknown as {
        k8sApi: unknown;
        k8sAppsApi: unknown;
        k8sNetworkingApi: unknown;
        k8sCustomObjectsApi: unknown;
        k8sAttach: unknown;
        k8sLog: unknown;
        k8sExec: unknown;
      };
      managerAny.k8sApi = mockK8sClient;
      managerAny.k8sAppsApi = mockK8sClient;
      managerAny.k8sNetworkingApi = mockK8sClient;
      managerAny.k8sCustomObjectsApi = mockK8sClient;
      managerAny.k8sAttach = {};
      managerAny.k8sLog = {};
      managerAny.k8sExec = {};

      // A normal load caches the deployment against the manager's default namespace.
      await manager.getOrLoadDeployment("stale-server");
      const cachedNamespace =
        mockK8sDeploymentInstances.at(-1)?.options.namespace;
      const builtBeforeOverride = mockK8sDeploymentInstances.length;

      // The override load must IGNORE that cached entry and build a fresh
      // deployment pinned to the supplied namespace. This is the staleness
      // bypass the relocation teardown relies on: a cached entry can point at a
      // now-wrong namespace, so trusting it would delete the wrong namespace and
      // orphan the old-namespace pod.
      const overridden = await manager.getOrLoadDeployment("stale-server", {
        namespaceOverride: "old-env-namespace",
      });
      const overrideNamespace =
        mockK8sDeploymentInstances.at(-1)?.options.namespace;

      expect(cachedNamespace).not.toBe("old-env-namespace");
      expect(overrideNamespace).toBe("old-env-namespace");
      // A NEW deployment object was constructed for the override (cache not reused)...
      expect(mockK8sDeploymentInstances.length).toBe(builtBeforeOverride + 1);
      expect(overridden).toBeDefined();
      // ...and the override (teardown-only) path skips serving-endpoint resolution.
      expect(mockResolveHttpEndpoint).toHaveBeenCalledTimes(1);

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });

    test("should call cleanup methods in correct order", async () => {
      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockReturnValue({} as k8s.CoreV1Api);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      // Track call order
      const callOrder: string[] = [];

      const mockDeployment = {
        stopDeployment: vi.fn().mockImplementation(async () => {
          callOrder.push("stopDeployment");
        }),
        deleteK8sService: vi.fn().mockImplementation(async () => {
          callOrder.push("deleteK8sService");
        }),
        deleteK8sSecret: vi.fn().mockImplementation(async () => {
          callOrder.push("deleteK8sSecret");
        }),
        deleteDockerRegistrySecrets: vi.fn().mockImplementation(async () => {
          callOrder.push("deleteDockerRegistrySecrets");
        }),
        deleteK8sNetworkPolicy: vi.fn().mockImplementation(async () => {
          callOrder.push("deleteK8sNetworkPolicy");
        }),
      };

      // @ts-expect-error - accessing private property for testing
      manager.mcpServerIdToDeploymentMap.set("test-server-id", mockDeployment);

      await manager.stopServer("test-server-id");

      // Verify order: stopDeployment -> deleteK8sService -> deleteK8sSecret -> deleteDockerRegistrySecrets
      expect(callOrder).toEqual([
        "stopDeployment",
        "deleteK8sService",
        "deleteK8sSecret",
        "deleteDockerRegistrySecrets",
        "deleteK8sNetworkPolicy",
      ]);

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });
  });

  describe("stopServer - multi-tenant teardown guard", () => {
    // Sibling-aware short-circuit from PR #4288.

    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
    });

    function buildCleanupSpies() {
      return {
        stopDeployment: vi.fn().mockResolvedValue(undefined),
        deleteK8sService: vi.fn().mockResolvedValue(undefined),
        deleteK8sSecret: vi.fn().mockResolvedValue(undefined),
        deleteDockerRegistrySecrets: vi.fn().mockResolvedValue(undefined),
        deleteK8sNetworkPolicy: vi.fn().mockResolvedValue(undefined),
      };
    }

    test("preserves shared Deployment when another sibling install exists", async () => {
      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});
      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockReturnValue({} as k8s.CoreV1Api);

      const McpServerModel = (await import("@/models/mcp-server")).default;
      const InternalMcpCatalogModel = (
        await import("@/models/internal-mcp-catalog")
      ).default;

      const tenantAId = "server-tenant-a";
      const tenantBId = "server-tenant-b";
      const catalogId = "shared-multitenant-catalog";

      vi.mocked(McpServerModel.findById).mockResolvedValueOnce({
        id: tenantAId,
        catalogId,
      } as Awaited<ReturnType<typeof McpServerModel.findById>>);
      vi.mocked(InternalMcpCatalogModel.findById).mockResolvedValueOnce({
        id: catalogId,
        multitenant: true,
      } as unknown as Awaited<
        ReturnType<typeof InternalMcpCatalogModel.findById>
      >);
      vi.mocked(McpServerModel.findByCatalogId).mockResolvedValueOnce([
        { id: tenantAId, catalogId },
        { id: tenantBId, catalogId },
      ] as unknown as Awaited<
        ReturnType<typeof McpServerModel.findByCatalogId>
      >);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      const spies = buildCleanupSpies();

      // @ts-expect-error - accessing private property for testing
      manager.mcpServerIdToDeploymentMap.set(tenantAId, spies);

      await manager.stopServer(tenantAId);

      // Tenant B is still using the shared Deployment — no teardown should fire.
      expect(spies.stopDeployment).not.toHaveBeenCalled();
      expect(spies.deleteK8sService).not.toHaveBeenCalled();
      expect(spies.deleteK8sSecret).not.toHaveBeenCalled();
      expect(spies.deleteDockerRegistrySecrets).not.toHaveBeenCalled();

      // The in-memory cache entry for the leaving caller is dropped.
      // @ts-expect-error - accessing private property for testing
      expect(manager.mcpServerIdToDeploymentMap.has(tenantAId)).toBe(false);

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });

    test("tears down Deployment when the last sibling install is removed", async () => {
      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});
      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockReturnValue({} as k8s.CoreV1Api);

      const McpServerModel = (await import("@/models/mcp-server")).default;
      const InternalMcpCatalogModel = (
        await import("@/models/internal-mcp-catalog")
      ).default;

      const lastTenantId = "server-last-tenant";
      const catalogId = "shared-multitenant-catalog";

      vi.mocked(McpServerModel.findById).mockResolvedValueOnce({
        id: lastTenantId,
        catalogId,
      } as Awaited<ReturnType<typeof McpServerModel.findById>>);
      vi.mocked(InternalMcpCatalogModel.findById).mockResolvedValueOnce({
        id: catalogId,
        multitenant: true,
      } as unknown as Awaited<
        ReturnType<typeof InternalMcpCatalogModel.findById>
      >);
      vi.mocked(McpServerModel.findByCatalogId).mockResolvedValueOnce([
        { id: lastTenantId, catalogId },
      ] as unknown as Awaited<
        ReturnType<typeof McpServerModel.findByCatalogId>
      >);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      const spies = buildCleanupSpies();

      // @ts-expect-error - accessing private property for testing
      manager.mcpServerIdToDeploymentMap.set(lastTenantId, spies);

      await manager.stopServer(lastTenantId);

      // After last installation deletion — full teardown.
      expect(spies.stopDeployment).toHaveBeenCalledTimes(1);
      expect(spies.deleteK8sService).toHaveBeenCalledTimes(1);
      expect(spies.deleteK8sSecret).toHaveBeenCalledTimes(1);
      expect(spies.deleteDockerRegistrySecrets).toHaveBeenCalledTimes(1);

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });
  });

  describe("reinstallSharedDeployment", () => {
    // Catalog-level reinstall path used by the multi-tenant catalog
    // reinstall endpoint. Bypasses the sibling guard that protects
    // per-tenant uninstall and recreates the shared K8s Deployment.

    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
    });

    test("tears down shared Deployment for all siblings then recreates via startServer", async () => {
      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});
      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockReturnValue({} as k8s.CoreV1Api);

      const McpServerModel = (await import("@/models/mcp-server")).default;
      const McpHttpSessionModel = (await import("@/models/mcp-http-session"))
        .default;
      const InternalMcpCatalogModel = (
        await import("@/models/internal-mcp-catalog")
      ).default;

      const catalogId = "shared-multitenant-catalog";
      const tenantAId = "server-tenant-a";
      const tenantBId = "server-tenant-b";

      const installs = [
        { id: tenantAId, catalogId, serverType: "local" },
        { id: tenantBId, catalogId, serverType: "local" },
      ];

      vi.mocked(McpServerModel.findByCatalogId).mockResolvedValue(
        installs as unknown as Awaited<
          ReturnType<typeof McpServerModel.findByCatalogId>
        >,
      );
      vi.mocked(McpServerModel.findById).mockImplementation(async (id) => {
        const found = installs.find((s) => s.id === id);
        return (found ?? null) as unknown as Awaited<
          ReturnType<typeof McpServerModel.findById>
        >;
      });
      vi.mocked(InternalMcpCatalogModel.findById).mockResolvedValue({
        id: catalogId,
        serverType: "local",
        multitenant: true,
        localConfig: {
          dockerImage: "registry/mcp:v2",
          command: "node",
          arguments: ["server.js"],
          environment: [],
        },
      } as unknown as Awaited<
        ReturnType<typeof InternalMcpCatalogModel.findById>
      >);
      vi.mocked(McpHttpSessionModel.deleteByMcpServerId).mockResolvedValue(0);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      // Inject mock K8s clients startServer checks for.
      const managerAny = manager as unknown as {
        k8sAttach: unknown;
        k8sLog: unknown;
        k8sExec: unknown;
      };
      managerAny.k8sAttach = {};
      managerAny.k8sLog = {};
      managerAny.k8sExec = {};

      // Pre-seed the in-memory map with a mock deployment for tenant A
      // (the representative). All cleanup methods are spies.
      const stopDeployment = vi.fn().mockResolvedValue(undefined);
      const deleteK8sService = vi.fn().mockResolvedValue(undefined);
      const deleteK8sSecret = vi.fn().mockResolvedValue(undefined);
      const deleteDockerRegistrySecrets = vi.fn().mockResolvedValue(undefined);
      const deleteK8sNetworkPolicy = vi.fn().mockResolvedValue(undefined);
      const waitForDeploymentReady = vi.fn().mockResolvedValue(undefined);

      // @ts-expect-error - accessing private property for testing
      manager.mcpServerIdToDeploymentMap.set(tenantAId, {
        stopDeployment,
        deleteK8sService,
        deleteK8sSecret,
        deleteDockerRegistrySecrets,
        deleteK8sNetworkPolicy,
        waitForDeploymentReady,
      });
      // Also seed tenant B so we can verify its entry gets dropped too.
      // @ts-expect-error - accessing private property for testing
      manager.mcpServerIdToDeploymentMap.set(tenantBId, {
        stopDeployment: vi.fn(),
        deleteK8sService: vi.fn(),
        deleteK8sSecret: vi.fn(),
        deleteDockerRegistrySecrets: vi.fn(),
        deleteK8sNetworkPolicy: vi.fn(),
      });

      // Spy startServer so we don't exercise the full pod-creation flow —
      // we only care that it was called for the representative install.
      const startServerSpy = vi
        .spyOn(manager, "startServer")
        .mockResolvedValue(undefined);

      await manager.reinstallSharedDeployment(catalogId);

      // Stale HTTP sessions were dropped for both siblings.
      expect(
        vi
          .mocked(McpHttpSessionModel.deleteByMcpServerId)
          .mock.calls.map((c) => c[0]),
      ).toEqual(expect.arrayContaining([tenantAId, tenantBId]));

      // Full teardown ran exactly once against the representative —
      // sibling guard bypassed.
      expect(stopDeployment).toHaveBeenCalledTimes(1);
      expect(deleteK8sService).toHaveBeenCalledTimes(1);
      expect(deleteK8sSecret).toHaveBeenCalledTimes(1);
      expect(deleteDockerRegistrySecrets).toHaveBeenCalledTimes(1);
      expect(deleteK8sNetworkPolicy).toHaveBeenCalledTimes(1);

      // Tenant B's stale entry is cleared; tenant A is reloaded after recreate.
      // @ts-expect-error - accessing private property for testing
      expect(manager.mcpServerIdToDeploymentMap.has(tenantAId)).toBe(true);
      // @ts-expect-error - accessing private property for testing
      expect(manager.mcpServerIdToDeploymentMap.has(tenantBId)).toBe(false);

      // Recreate happened via startServer for the representative.
      expect(startServerSpy).toHaveBeenCalledTimes(1);
      expect(startServerSpy.mock.calls[0][0]).toMatchObject({ id: tenantAId });

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });

    test("no-ops when no installs exist for the catalog", async () => {
      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});
      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockReturnValue({} as k8s.CoreV1Api);

      const McpServerModel = (await import("@/models/mcp-server")).default;
      vi.mocked(McpServerModel.findByCatalogId).mockResolvedValueOnce([]);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      const startServerSpy = vi
        .spyOn(manager, "startServer")
        .mockResolvedValue(undefined);

      await manager.reinstallSharedDeployment("empty-catalog");

      expect(startServerSpy).not.toHaveBeenCalled();

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });
  });

  describe("streamMcpServerLogs", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
    });

    test("writes a helpful message when runtime is not configured", async () => {
      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {
          throw new Error("Config load failed");
        });

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      const stream = new PassThrough();
      let output = "";
      stream.on("data", (chunk) => {
        output += chunk.toString();
      });

      await manager.streamMcpServerLogs("test-server-id", stream);

      expect(output).toContain("Unable to stream logs");
      expect(output).toContain(
        "Kubernetes runtime is not configured on this instance.",
      );
      expect(output).toContain("mcp-server-id=test-server-id");

      mockLoadFromDefault.mockRestore();
    });
  });

  describe("startServer - cross-server secret isolation (#3148)", () => {
    // These tests reproduce the original issue from #3148 / #3191:
    // When multiple MCP servers share a vault path, secretManager().getSecret()
    // returns ALL keys from that path. Without filtering, every server's pod
    // gets every other server's env vars/secrets injected via K8s Secret.

    function createMcpServer(overrides: Partial<McpServer> = {}): McpServer {
      return {
        id: "server-1",
        name: "test-server",
        catalogId: "catalog-1",
        secretId: "shared-vault-secret-id",
        ownerId: null,
        reinstallRequired: false,
        localInstallationStatus: "idle",
        localInstallationError: null,
        oauthRefreshError: null,
        oauthRefreshFailedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        serverType: "local",
        teamId: null,
        ...overrides,
      } as McpServer;
    }

    async function setupStartServerTest(options: {
      vaultSecret: Record<string, unknown>;
      catalogEnvironment: Array<{
        key: string;
        type: string;
        promptOnInstallation?: boolean;
        value?: string;
      }>;
      catalogLocalConfigSecretId?: string;
      catalogSecretData?: Record<string, unknown>;
      mcpServerOverrides?: Partial<McpServer>;
    }) {
      const {
        vaultSecret,
        catalogEnvironment,
        catalogLocalConfigSecretId,
        catalogSecretData,
        mcpServerOverrides,
      } = options;

      // Reset tracking
      mockCreateK8sSecret.mockClear();
      mockStartOrCreateDeployment.mockClear();
      mockCreateDockerRegistrySecrets.mockClear();
      mockK8sDeploymentInstances.length = 0;

      // Mock secretManager to return the shared vault secret
      const mockGetSecret = vi.fn().mockImplementation((secretId: string) => {
        if (secretId === "shared-vault-secret-id") {
          return { secret: vaultSecret };
        }
        if (
          catalogLocalConfigSecretId &&
          secretId === catalogLocalConfigSecretId
        ) {
          return { secret: catalogSecretData ?? {} };
        }
        return null;
      });

      const { secretManager } = await import("@/secrets-manager");
      vi.mocked(secretManager).mockReturnValue({
        getSecret: mockGetSecret,
      } as unknown as ReturnType<typeof secretManager>);

      // Mock InternalMcpCatalogModel.findById to return catalog with environment config
      const InternalMcpCatalogModel = (
        await import("@/models/internal-mcp-catalog")
      ).default;
      vi.mocked(InternalMcpCatalogModel.findById).mockResolvedValue({
        id: "catalog-1",
        serverType: "local",
        localConfig: {
          environment: catalogEnvironment,
        },
        localConfigSecretId: catalogLocalConfigSecretId ?? null,
      } as unknown as Awaited<
        ReturnType<typeof InternalMcpCatalogModel.findById>
      >);

      // Set up the manager with mock K8s clients
      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});
      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockReturnValue({} as k8s.CoreV1Api);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      // Inject mock K8s clients that startServer checks for
      const managerAny = manager as unknown as {
        k8sAttach: unknown;
        k8sLog: unknown;
        k8sExec: unknown;
      };
      managerAny.k8sAttach = {};
      managerAny.k8sLog = {};
      managerAny.k8sExec = {};

      const mcpServer = createMcpServer(mcpServerOverrides);

      return {
        manager,
        mcpServer,
        cleanup: () => {
          mockLoadFromDefault.mockRestore();
          mockMakeApiClient.mockRestore();
        },
      };
    }

    test("filters vault secrets to only keys declared in server's catalog environment", async () => {
      // Reproduces #3148: vault path contains secrets for 3 different servers
      // (Slack, GitHub, Jira), but this server only needs SLACK_TOKEN
      const { manager, mcpServer, cleanup } = await setupStartServerTest({
        vaultSecret: {
          SLACK_TOKEN: "xoxb-slack-token",
          GITHUB_TOKEN: "ghp_github_token",
          JIRA_API_KEY: "jira-key-123",
        },
        catalogEnvironment: [{ key: "SLACK_TOKEN", type: "secret" }],
      });

      await manager.startServer(mcpServer);

      // createK8sSecret should only receive SLACK_TOKEN, not GITHUB_TOKEN or JIRA_API_KEY
      expect(mockCreateK8sSecret).toHaveBeenCalledWith({
        SLACK_TOKEN: "xoxb-slack-token",
      });

      cleanup();
    });

    test("prevents cross-server secret leakage with shared vault path (3 servers)", async () => {
      // Full reproduction of the reported scenario:
      // One shared vault path with secrets for Outlook, Slack, and Jira servers.
      // Server B (Slack) should only see its own 2 keys.
      const sharedVault = {
        OUTLOOK_CLIENT_ID: "outlook-id",
        OUTLOOK_CLIENT_SECRET: "outlook-secret",
        SLACK_BOT_TOKEN: "slack-bot",
        SLACK_SIGNING_SECRET: "slack-sign",
        JIRA_API_TOKEN: "jira-token",
        JIRA_BASE_URL: "https://jira.example.com",
      };

      const { manager, mcpServer, cleanup } = await setupStartServerTest({
        vaultSecret: sharedVault,
        catalogEnvironment: [
          { key: "SLACK_BOT_TOKEN", type: "secret" },
          { key: "SLACK_SIGNING_SECRET", type: "secret" },
        ],
      });

      await manager.startServer(mcpServer);

      // Only Slack keys should be passed to createK8sSecret
      expect(mockCreateK8sSecret).toHaveBeenCalledWith({
        SLACK_BOT_TOKEN: "slack-bot",
        SLACK_SIGNING_SECRET: "slack-sign",
      });

      // Verify none of the other servers' secrets leaked
      const passedSecretData = mockCreateK8sSecret.mock.calls[0][0] as Record<
        string,
        string
      >;
      expect(Object.keys(passedSecretData)).toHaveLength(2);
      expect(passedSecretData).not.toHaveProperty("OUTLOOK_CLIENT_ID");
      expect(passedSecretData).not.toHaveProperty("OUTLOOK_CLIENT_SECRET");
      expect(passedSecretData).not.toHaveProperty("JIRA_API_TOKEN");
      expect(passedSecretData).not.toHaveProperty("JIRA_BASE_URL");

      cleanup();
    });

    test("passes all keys through when catalog has no environment config (backward compat)", async () => {
      // For servers without catalog environment config (e.g., BYOS with no defined env schema),
      // all vault keys should pass through to maintain backward compatibility
      const { manager, mcpServer, cleanup } = await setupStartServerTest({
        vaultSecret: {
          SOME_KEY: "some-value",
          OTHER_KEY: "other-value",
        },
        catalogEnvironment: [], // No environment config
      });

      await manager.startServer(mcpServer);

      // All keys should pass through
      expect(mockCreateK8sSecret).toHaveBeenCalledWith({
        SOME_KEY: "some-value",
        OTHER_KEY: "other-value",
      });

      cleanup();
    });

    test("uses the organization default network policy for global catalog installs", async () => {
      const defaultNetworkPolicy = {
        egressMode: "restricted",
        domainPreset: "package_managers",
        allowedDomains: ["docs.example.com"],
        allowedCidrs: [],
      } satisfies NetworkPolicy;
      const OrganizationModel = (await import("@/models/organization")).default;
      // Persistent (not Once): startServer consults the org twice — once for
      // namespace resolution, once for network-policy resolution.
      vi.mocked(OrganizationModel.getFirst).mockResolvedValue({
        id: "org-with-network-policy",
        defaultNetworkPolicy,
      } as unknown as Awaited<ReturnType<typeof OrganizationModel.getFirst>>);

      const { resolveEffectiveNetworkPolicy } = await import(
        "@/services/environments/network-policy"
      );
      vi.mocked(resolveEffectiveNetworkPolicy).mockResolvedValueOnce({
        source: "organization_default",
        policy: defaultNetworkPolicy,
      });

      const { manager, mcpServer, cleanup } = await setupStartServerTest({
        vaultSecret: {},
        catalogEnvironment: [],
        mcpServerOverrides: {
          secretId: null,
        },
      });

      await manager.startServer(mcpServer);

      expect(resolveEffectiveNetworkPolicy).toHaveBeenCalledWith({
        organizationId: "org-with-network-policy",
        environmentId: undefined,
        environmentNetworkPolicy: undefined,
        defaultNetworkPolicy,
      });
      expect(mockK8sDeploymentInstances.at(-1)?.options).toMatchObject({
        effectiveNetworkPolicy: {
          source: "organization_default",
          policy: defaultNetworkPolicy,
        },
      });

      // Restore the module-mock default so later tests aren't polluted.
      vi.mocked(OrganizationModel.getFirst).mockResolvedValue({
        id: "test-org",
        defaultNetworkPolicy: null,
      } as unknown as Awaited<ReturnType<typeof OrganizationModel.getFirst>>);
      cleanup();
    });

    test("deploys default-environment catalog installs into the organization's default environment namespace", async () => {
      const { manager, mcpServer, cleanup } = await setupStartServerTest({
        vaultSecret: {},
        catalogEnvironment: [],
        mcpServerOverrides: { secretId: null },
      });

      // Default-environment catalog: no environmentId, org-owned.
      const InternalMcpCatalogModel = (
        await import("@/models/internal-mcp-catalog")
      ).default;
      vi.mocked(InternalMcpCatalogModel.findById).mockResolvedValue({
        id: "catalog-1",
        serverType: "local",
        environmentId: null,
        organizationId: "org-1",
        localConfig: { environment: [] },
        localConfigSecretId: null,
      } as unknown as Awaited<
        ReturnType<typeof InternalMcpCatalogModel.findById>
      >);
      const OrganizationModel = (await import("@/models/organization")).default;
      vi.mocked(OrganizationModel.getById).mockResolvedValue({
        id: "org-1",
        defaultEnvironmentNamespace: "org-default-ns",
        defaultNetworkPolicy: null,
      } as unknown as Awaited<ReturnType<typeof OrganizationModel.getById>>);

      await manager.startServer(mcpServer);

      expect(mockK8sDeploymentInstances.at(-1)?.options.namespace).toBe(
        "org-default-ns",
      );

      // Restore module-mock defaults so later tests aren't polluted.
      vi.mocked(OrganizationModel.getById).mockResolvedValue({
        id: "test-org",
        defaultNetworkPolicy: null,
      } as unknown as Awaited<ReturnType<typeof OrganizationModel.getById>>);
      cleanup();
    });

    test("does not create K8s secret when server has no secretId", async () => {
      mockCreateK8sSecret.mockClear();
      mockStartOrCreateDeployment.mockClear();
      mockCreateDockerRegistrySecrets.mockClear();
      mockK8sDeploymentInstances.length = 0;

      const InternalMcpCatalogModel = (
        await import("@/models/internal-mcp-catalog")
      ).default;
      vi.mocked(InternalMcpCatalogModel.findById).mockResolvedValue({
        id: "catalog-1",
        serverType: "local",
        localConfig: { environment: [] },
        localConfigSecretId: null,
      } as unknown as Awaited<
        ReturnType<typeof InternalMcpCatalogModel.findById>
      >);

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});
      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockReturnValue({} as k8s.CoreV1Api);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();
      const managerAny = manager as unknown as {
        k8sAttach: unknown;
        k8sLog: unknown;
        k8sExec: unknown;
      };
      managerAny.k8sAttach = {};
      managerAny.k8sLog = {};
      managerAny.k8sExec = {};

      const mcpServer = createMcpServer({ secretId: null });
      await manager.startServer(mcpServer);

      // createK8sSecret should NOT be called when there's no secret data
      expect(mockCreateK8sSecret).not.toHaveBeenCalled();

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });

    test("merges non-prompted catalog secrets into secretData without overwriting existing keys", async () => {
      const { manager, mcpServer, cleanup } = await setupStartServerTest({
        vaultSecret: {
          USER_API_KEY: "user-provided-value",
        },
        catalogEnvironment: [
          {
            key: "USER_API_KEY",
            type: "secret",
            promptOnInstallation: true,
            value: "user-provided-value",
          },
          {
            key: "STATIC_SECRET",
            type: "secret",
            promptOnInstallation: false,
            value: "catalog-static-value",
          },
          {
            key: "PLAIN_VAR",
            type: "plain_text",
            promptOnInstallation: false,
            value: "should-be-ignored",
          },
        ],
      });

      await manager.startServer(mcpServer);

      // createK8sSecret should include the vault key + the non-prompted catalog secret
      expect(mockCreateK8sSecret).toHaveBeenCalledWith({
        USER_API_KEY: "user-provided-value",
        STATIC_SECRET: "catalog-static-value",
      });

      cleanup();
    });

    test("non-prompted catalog secret overwrites stale per-server secret with same key", async () => {
      const { manager, mcpServer, cleanup } = await setupStartServerTest({
        vaultSecret: {
          SHARED_KEY: "stale-per-server-value",
        },
        catalogEnvironment: [
          {
            key: "SHARED_KEY",
            type: "secret",
            promptOnInstallation: false,
            value: "updated-catalog-value",
          },
        ],
      });

      await manager.startServer(mcpServer);

      // Catalog is the source of truth for non-prompted secrets
      expect(mockCreateK8sSecret).toHaveBeenCalledWith({
        SHARED_KEY: "updated-catalog-value",
      });

      cleanup();
    });

    test("a successful start stamps demand so a just-(re)created deployment gets a full idle window", async () => {
      const { manager, mcpServer, cleanup } = await setupStartServerTest({
        vaultSecret: {},
        catalogEnvironment: [],
      });

      await manager.startServer(mcpServer);

      // Without the stamp, a reinstall inherits the row's stale last_used_at
      // and the sweeper hibernates the fresh pod within seconds
      // (live-reproduced).
      expect(vi.mocked(mcpActiveUseTracker.stamp)).toHaveBeenCalledWith(
        mcpServer.id,
      );

      cleanup();
    });
  });

  describe("startServer - success auto redeploy", () => {
    // Auto redeploy fires when a catalog edit doesn't require new user
    // input — `cascadeReinstallForCatalog → autoReinstallServer →
    // McpServerRuntimeManager.restartServer(id) → startServer(mcpServer)`
    // (manager.ts:558). Crucially, `restartServer` calls `startServer`
    // with NO `environmentValues`, so startServer must reconstruct every
    // previously-supplied env value from persistent state alone.
    //
    // The cases below cover the full env-var matrix:
    //   scope    : static / promptOnInstallation
    //   type     : plain_text / secret
    //   required : true / false   (only meaningful for prompted;
    //                              for static the value is admin-set,
    //                              required has no runtime effect)
    //
    // The user report ("Not required prompted envs missing after auto
    // re-install") singled out the optional+plain+prompted cell — but
    // the bug actually drops every plain prompted value regardless of
    // `required`. Per-row tests make it obvious which cells are red
    // without requiring readers to scan a giant diff.
    //
    // STATIC_PLAIN is the one row whose contract is "must NOT be in
    // environmentValues" — it bypasses the map entirely and reaches the
    // pod via envDef.value at deployment-build time (k8s-deployment.ts:
    // 1318). Encoded as `expected: undefined`.

    let manager: import("./manager").McpServerRuntimeManager;
    let mcpServer: McpServer;
    let envValues: Record<string, string> | undefined;
    let mockLoadFromDefault: ReturnType<typeof vi.spyOn>;
    let mockMakeApiClient: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      mockCreateK8sSecret.mockClear();
      mockStartOrCreateDeployment.mockClear();
      mockCreateDockerRegistrySecrets.mockClear();
      mockK8sDeploymentInstances.length = 0;

      // Stage what was persisted at install time:
      //   - install Secret bag (secretManager mock below) holds every
      //     secret-typed prompted value (the only thing that belongs in a
      //     Secret object — values referenced by secretKeyRef from the pod
      //     spec).
      //   - mcp_server row's environmentValues (mcpServer mock below)
      //     holds plain `promptOnInstallation` values (per-install source
      //     of truth).
      const mockGetSecret = vi.fn().mockResolvedValue({
        secret: {
          USER_REQ_SECRET: "user-req-sec-stored",
          USER_OPT_SECRET: "user-opt-sec-stored",
        },
      });
      const { secretManager } = await import("@/secrets-manager");
      vi.mocked(secretManager).mockReturnValue({
        getSecret: mockGetSecret,
      } as unknown as ReturnType<typeof secretManager>);

      const InternalMcpCatalogModel = (
        await import("@/models/internal-mcp-catalog")
      ).default;
      vi.mocked(InternalMcpCatalogModel.findById).mockResolvedValue({
        id: "catalog-1",
        serverType: "local",
        localConfig: {
          environment: [
            // Static — admin-set on catalog row, `required` has no runtime
            // effect (value isn't user-supplied).
            {
              key: "STATIC_PLAIN",
              type: "plain_text",
              promptOnInstallation: false,
              value: "static-plain-from-catalog",
            },
            {
              key: "STATIC_SECRET",
              type: "secret",
              promptOnInstallation: false,
              value: "static-secret-from-catalog",
            },
            // promptOnInstallation × required × type
            {
              key: "USER_REQ_SECRET",
              type: "secret",
              promptOnInstallation: true,
              required: true,
            },
            {
              key: "USER_OPT_SECRET",
              type: "secret",
              promptOnInstallation: true,
              required: false,
            },
            {
              key: "USER_REQ_PLAIN",
              type: "plain_text",
              promptOnInstallation: true,
              required: true,
            },
            {
              key: "USER_OPT_PLAIN",
              type: "plain_text",
              promptOnInstallation: true,
              required: false,
            },
          ],
        },
        localConfigSecretId: null,
      } as unknown as Awaited<
        ReturnType<typeof InternalMcpCatalogModel.findById>
      >);

      mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});
      mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockReturnValue({} as k8s.CoreV1Api);

      const { McpServerRuntimeManager } = await import("./manager");
      manager = new McpServerRuntimeManager();
      const managerAny = manager as unknown as {
        k8sAttach: unknown;
        k8sLog: unknown;
        k8sExec: unknown;
      };
      managerAny.k8sAttach = {};
      managerAny.k8sLog = {};
      managerAny.k8sExec = {};

      mcpServer = {
        id: "server-1",
        name: "test-server",
        catalogId: "catalog-1",
        secretId: "install-secret-bag",
        // Plain (non-secret) `promptOnInstallation` env values persisted on
        // the install row at install time. Recovered on restart via
        // startServer's environmentValues overlay (the new fix). Compare
        // with the install Secret bag mock above, which holds the
        // secret-typed values.
        environmentValues: {
          USER_REQ_PLAIN: "user-req-plain-stored",
          USER_OPT_PLAIN: "user-opt-plain-stored",
        },
        ownerId: null,
        reinstallRequired: false,
        localInstallationStatus: "idle",
        localInstallationError: null,
        oauthRefreshError: null,
        oauthRefreshFailedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        serverType: "local",
        teamId: null,
      } as unknown as McpServer;

      // Auto redeploy: startServer is invoked with no environmentValues,
      // exactly as McpServerRuntimeManager.restartServer does.
      await manager.startServer(mcpServer);
      envValues = mockK8sDeploymentInstances[0]?.options.environmentValues as
        | Record<string, string>
        | undefined;
    });

    afterEach(() => {
      mockLoadFromDefault?.mockRestore();
      mockMakeApiClient?.mockRestore();
    });

    // The `expected` column is `undefined` for cells whose contract is
    // "must NOT be in environmentValues" (i.e. STATIC_PLAIN — flows via
    // envDef.value, never touches the env-values map). All other cells
    // assert their value is present and correct.
    test.each`
      key                  | expected                        | via
      ${"STATIC_PLAIN"}    | ${undefined}                    | ${"bypasses env-values; flows via envDef.value"}
      ${"STATIC_SECRET"}   | ${"static-secret-from-catalog"} | ${"catalog static-secret merge (manager.ts:259-277)"}
      ${"USER_REQ_SECRET"} | ${"user-req-sec-stored"}        | ${"install Secret bag (prompted+secret, required)"}
      ${"USER_OPT_SECRET"} | ${"user-opt-sec-stored"}        | ${"install Secret bag (prompted+secret, optional)"}
      ${"USER_REQ_PLAIN"}  | ${"user-req-plain-stored"}      | ${"mcp_server.environmentValues overlay"}
      ${"USER_OPT_PLAIN"}  | ${"user-opt-plain-stored"}      | ${"mcp_server.environmentValues overlay"}
    `(
      "auto redeploy preserves $key — $via",
      ({ key, expected }: { key: string; expected: string | undefined }) => {
        if (expected === undefined) {
          expect(envValues).not.toHaveProperty(key);
        } else {
          expect(envValues?.[key]).toBe(expected);
        }
      },
    );
  });
});

describe("McpServerRuntimeManager.listDockerRegistrySecrets", () => {
  function dockerConfigData(registryServers: string[]) {
    return {
      ".dockerconfigjson": Buffer.from(
        JSON.stringify({
          auths: Object.fromEntries(
            registryServers.map((server) => [server, { auth: "redacted" }]),
          ),
        }),
      ).toString("base64"),
    };
  }

  test("returns empty array when k8sApi is not initialized", async () => {
    const { McpServerRuntimeManager } = await import("./manager");
    const manager = new McpServerRuntimeManager();
    const result = await manager.listDockerRegistrySecrets({ isAdmin: true });
    expect(result).toEqual([]);
  });

  test("returns empty array when called without options (restrictive default)", async () => {
    const { McpServerRuntimeManager } = await import("./manager");
    const manager = new McpServerRuntimeManager();

    const mockListSecrets = vi.fn().mockResolvedValue({
      items: [
        {
          metadata: {
            name: "regcred-team-a",
            labels: { app: "mcp-server", type: "regcred", "team-id": "a" },
          },
        },
      ],
    });
    (manager as unknown as { k8sApi: unknown }).k8sApi = {
      listNamespacedSecret: mockListSecrets,
    };

    const result = await manager.listDockerRegistrySecrets();
    expect(result).toEqual([]);
    expect(mockListSecrets).not.toHaveBeenCalled();
  });

  test("admin sees all Archestra-managed secrets", async () => {
    const { McpServerRuntimeManager } = await import("./manager");
    const manager = new McpServerRuntimeManager();

    const mockListSecrets = vi.fn().mockResolvedValue({
      items: [
        {
          metadata: {
            name: "regcred-team-a",
            labels: {
              app: "mcp-server",
              type: "regcred",
              "team-id": "team-a",
            },
          },
          data: dockerConfigData(["registry-b.example.com"]),
        },
        {
          metadata: {
            name: "regcred-team-b",
            labels: {
              app: "mcp-server",
              type: "regcred",
              "team-id": "team-b",
            },
          },
          data: dockerConfigData(["registry-a.example.com"]),
        },
      ],
    });
    (manager as unknown as { k8sApi: unknown }).k8sApi = {
      listNamespacedSecret: mockListSecrets,
    };

    const result = await manager.listDockerRegistrySecrets({ isAdmin: true });
    expect(result).toEqual([
      {
        name: "regcred-team-a",
        registryServers: ["registry-b.example.com"],
      },
      {
        name: "regcred-team-b",
        registryServers: ["registry-a.example.com"],
      },
    ]);

    expect(mockListSecrets).toHaveBeenCalledWith(
      expect.objectContaining({
        labelSelector: "app=mcp-server,type=regcred",
      }),
    );
  });

  test("non-admin only sees secrets matching their team IDs", async () => {
    const { McpServerRuntimeManager } = await import("./manager");
    const manager = new McpServerRuntimeManager();

    const mockListSecrets = vi.fn().mockResolvedValue({
      items: [
        {
          metadata: {
            name: "regcred-team-a",
            labels: {
              app: "mcp-server",
              type: "regcred",
              "team-id": "team-a",
            },
          },
        },
        {
          metadata: {
            name: "regcred-team-b",
            labels: {
              app: "mcp-server",
              type: "regcred",
              "team-id": "team-b",
            },
          },
        },
        {
          metadata: {
            name: "regcred-no-team",
            labels: { app: "mcp-server", type: "regcred" },
          },
        },
      ],
    });
    (manager as unknown as { k8sApi: unknown }).k8sApi = {
      listNamespacedSecret: mockListSecrets,
    };

    const result = await manager.listDockerRegistrySecrets({
      teamIds: ["team-a"],
    });
    expect(result).toEqual([{ name: "regcred-team-a", registryServers: [] }]);
  });

  test("non-admin with no teams sees no secrets", async () => {
    const { McpServerRuntimeManager } = await import("./manager");
    const manager = new McpServerRuntimeManager();

    const mockListSecrets = vi.fn().mockResolvedValue({
      items: [
        {
          metadata: {
            name: "regcred-team-a",
            labels: {
              app: "mcp-server",
              type: "regcred",
              "team-id": "team-a",
            },
          },
        },
      ],
    });
    (manager as unknown as { k8sApi: unknown }).k8sApi = {
      listNamespacedSecret: mockListSecrets,
    };

    const result = await manager.listDockerRegistrySecrets({ teamIds: [] });
    expect(result).toEqual([]);
  });

  test("returns sorted registry servers parsed from docker config json", async () => {
    const { McpServerRuntimeManager } = await import("./manager");
    const manager = new McpServerRuntimeManager();

    (manager as unknown as { k8sApi: unknown }).k8sApi = {
      listNamespacedSecret: vi.fn().mockResolvedValue({
        items: [
          {
            metadata: {
              name: "regcred-private",
              labels: {
                app: "mcp-server",
                type: "regcred",
                "team-id": "team-a",
              },
            },
            data: dockerConfigData([
              "z.registry.example.com",
              "a.registry.example.com",
            ]),
          },
        ],
      }),
    };

    const result = await manager.listDockerRegistrySecrets({
      teamIds: ["team-a"],
    });

    expect(result).toEqual([
      {
        name: "regcred-private",
        registryServers: ["a.registry.example.com", "z.registry.example.com"],
      },
    ]);
  });

  test("returns empty registry server list when docker config json is invalid", async () => {
    const { McpServerRuntimeManager } = await import("./manager");
    const manager = new McpServerRuntimeManager();

    (manager as unknown as { k8sApi: unknown }).k8sApi = {
      listNamespacedSecret: vi.fn().mockResolvedValue({
        items: [
          {
            metadata: {
              name: "regcred-private",
              labels: {
                app: "mcp-server",
                type: "regcred",
                "team-id": "team-a",
              },
            },
            data: {
              ".dockerconfigjson": Buffer.from("not-json").toString("base64"),
            },
          },
        ],
      }),
    };

    const result = await manager.listDockerRegistrySecrets({
      teamIds: ["team-a"],
    });

    expect(result).toEqual([{ name: "regcred-private", registryServers: [] }]);
  });
});

describe("McpServerRuntimeManager.backfillRegcredTeamLabels", () => {
  async function createManagerWithMockK8s(mockK8sApi: Record<string, unknown>) {
    const { McpServerRuntimeManager } = await import("./manager");
    const manager = new McpServerRuntimeManager();
    (manager as unknown as { k8sApi: unknown }).k8sApi = mockK8sApi;
    return manager;
  }

  function callBackfill(
    manager: unknown,
    servers: Array<{ id: string; teamId: string | null }>,
  ) {
    const castServers = servers.map((s) => ({
      ...s,
      name: "test",
      catalogId: "cat-1",
      secretId: null,
      ownerId: null,
      reinstallRequired: false,
      localInstallationStatus: "idle" as const,
      localInstallationError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      serverType: "local" as const,
    }));
    return (
      manager as { backfillRegcredTeamLabels: (s: unknown[]) => Promise<void> }
    ).backfillRegcredTeamLabels(castServers);
  }

  test("patches secrets that lack team-id label", async () => {
    const mockPatch = vi.fn().mockResolvedValue({});
    const mockList = vi.fn().mockResolvedValue({
      items: [
        {
          metadata: {
            name: "regcred-1",
            labels: {
              app: "mcp-server",
              type: "regcred",
              "mcp-server-id": "srv-1",
            },
          },
        },
      ],
    });

    const manager = await createManagerWithMockK8s({
      listNamespacedSecret: mockList,
      patchNamespacedSecret: mockPatch,
    });

    await callBackfill(manager, [{ id: "srv-1", teamId: "team-x" }]);

    expect(mockPatch).toHaveBeenCalledOnce();
    expect(mockPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "regcred-1",
        body: {
          metadata: { labels: { "team-id": "team-x" } },
        },
      }),
    );
  });

  test("skips secrets that already have team-id label", async () => {
    const mockPatch = vi.fn().mockResolvedValue({});
    const mockList = vi.fn().mockResolvedValue({
      items: [
        {
          metadata: {
            name: "regcred-1",
            labels: {
              app: "mcp-server",
              type: "regcred",
              "mcp-server-id": "srv-1",
              "team-id": "existing-team",
            },
          },
        },
      ],
    });

    const manager = await createManagerWithMockK8s({
      listNamespacedSecret: mockList,
      patchNamespacedSecret: mockPatch,
    });

    await callBackfill(manager, [{ id: "srv-1", teamId: "team-x" }]);

    expect(mockPatch).not.toHaveBeenCalled();
  });

  test("skips secrets with no matching mcp-server-id", async () => {
    const mockPatch = vi.fn().mockResolvedValue({});
    const mockList = vi.fn().mockResolvedValue({
      items: [
        {
          metadata: {
            name: "regcred-orphan",
            labels: {
              app: "mcp-server",
              type: "regcred",
              "mcp-server-id": "unknown-srv",
            },
          },
        },
      ],
    });

    const manager = await createManagerWithMockK8s({
      listNamespacedSecret: mockList,
      patchNamespacedSecret: mockPatch,
    });

    await callBackfill(manager, [{ id: "srv-1", teamId: "team-x" }]);

    expect(mockPatch).not.toHaveBeenCalled();
  });

  test("patch failure on one secret does not prevent patching others", async () => {
    const mockPatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("patch failed"))
      .mockResolvedValueOnce({});
    const mockList = vi.fn().mockResolvedValue({
      items: [
        {
          metadata: {
            name: "regcred-fail",
            labels: {
              app: "mcp-server",
              type: "regcred",
              "mcp-server-id": "srv-1",
            },
          },
        },
        {
          metadata: {
            name: "regcred-ok",
            labels: {
              app: "mcp-server",
              type: "regcred",
              "mcp-server-id": "srv-2",
            },
          },
        },
      ],
    });

    const manager = await createManagerWithMockK8s({
      listNamespacedSecret: mockList,
      patchNamespacedSecret: mockPatch,
    });

    await callBackfill(manager, [
      { id: "srv-1", teamId: "team-a" },
      { id: "srv-2", teamId: "team-b" },
    ]);

    expect(mockPatch).toHaveBeenCalledTimes(2);
    expect(mockPatch).toHaveBeenCalledWith(
      expect.objectContaining({ name: "regcred-ok" }),
    );
  });

  test("skips servers with no teamId", async () => {
    const mockPatch = vi.fn().mockResolvedValue({});
    const mockList = vi.fn().mockResolvedValue({
      items: [
        {
          metadata: {
            name: "regcred-personal",
            labels: {
              app: "mcp-server",
              type: "regcred",
              "mcp-server-id": "srv-personal",
            },
          },
        },
      ],
    });

    const manager = await createManagerWithMockK8s({
      listNamespacedSecret: mockList,
      patchNamespacedSecret: mockPatch,
    });

    await callBackfill(manager, [{ id: "srv-personal", teamId: null }]);

    // No servers with teamId → early return, no K8s calls
    expect(mockList).not.toHaveBeenCalled();
    expect(mockPatch).not.toHaveBeenCalled();
  });

  test("does nothing when k8sApi is not initialized", async () => {
    const { McpServerRuntimeManager } = await import("./manager");
    const manager = new McpServerRuntimeManager();
    // k8sApi is undefined — should return without error
    await callBackfill(manager, [{ id: "srv-1", teamId: "team-x" }]);
  });
});

describe("McpServerRuntimeManager.cleanupOrphanedDeployments", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // clearAllMocks resets call history but not implementations, so a
    // persistent mockResolvedValue from another suite would otherwise leak in
    // under a shuffling seed. These tests expect the frozen-name path by
    // default, so pin findById back to null — and pin the other models the
    // namespace-resolution path consults, since leaked implementations change
    // which sweep branch runs.
    const OrganizationModel = (await import("@/models/organization")).default;
    vi.mocked(InternalMcpCatalogModel.findById).mockResolvedValue(null);
    vi.mocked(McpServerModel.findById).mockReset();
    vi.mocked(McpServerModel.findById).mockResolvedValue(null);
    vi.mocked(OrganizationModel.getById).mockResolvedValue({
      id: "test-org",
      defaultNetworkPolicy: null,
    } as unknown as Awaited<ReturnType<typeof OrganizationModel.getById>>);
    vi.mocked(OrganizationModel.getFirst).mockResolvedValue({
      id: "test-org",
      defaultNetworkPolicy: null,
    } as unknown as Awaited<ReturnType<typeof OrganizationModel.getFirst>>);
  });

  async function createManagerWithMockK8s(params: {
    mockK8sApi: Record<string, unknown>;
    mockK8sAppsApi: Record<string, unknown>;
  }) {
    const { McpServerRuntimeManager } = await import("./manager");
    const manager = new McpServerRuntimeManager();
    (manager as unknown as { k8sApi: unknown }).k8sApi = params.mockK8sApi;
    (manager as unknown as { k8sAppsApi: unknown }).k8sAppsApi =
      params.mockK8sAppsApi;
    return manager;
  }

  function callCleanup(
    manager: unknown,
    servers: Array<{
      id: string;
      name: string;
      catalogId: string;
      deploymentName?: string | null;
    }>,
  ) {
    const castServers = servers.map((s) => ({
      deploymentName: null,
      ...s,
      secretId: null,
      ownerId: null,
      teamId: null,
      scope: "org" as const,
      reinstallRequired: false,
      localInstallationStatus: "idle" as const,
      localInstallationError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      serverType: "local" as const,
    }));
    return (
      manager as { cleanupOrphanedDeployments: (s: unknown[]) => Promise<void> }
    ).cleanupOrphanedDeployments(castServers);
  }

  test("deletes legacy name-derived deployments for existing servers", async () => {
    const mockDeleteDeployment = vi.fn().mockResolvedValue({});
    const mockDeleteService = vi.fn().mockResolvedValue({});
    const manager = await createManagerWithMockK8s({
      mockK8sApi: { deleteNamespacedService: mockDeleteService },
      mockK8sAppsApi: {
        listNamespacedDeployment: vi.fn().mockResolvedValue({
          items: [
            {
              metadata: {
                name: "mcp-legacy-name",
                labels: {
                  app: "mcp-server",
                  "mcp-server-id": "123e4567-e89b-12d3-a456-426614174000",
                },
              },
            },
            {
              metadata: {
                name: "mcp-current-name",
                labels: {
                  app: "mcp-server",
                  "mcp-server-id": "123e4567-e89b-12d3-a456-426614174000",
                },
              },
            },
          ],
        }),
        deleteNamespacedDeployment: mockDeleteDeployment,
      },
    });

    await callCleanup(manager, [
      {
        id: "123e4567-e89b-12d3-a456-426614174000",
        name: "current-name",
        catalogId: "cat-1",
        // Frozen by the adopt pass (which always runs before the sweep).
        deploymentName: "mcp-current-name",
      },
    ]);

    expect(mockDeleteDeployment).toHaveBeenCalledOnce();
    expect(mockDeleteDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ name: "mcp-legacy-name" }),
    );
    expect(mockDeleteService).toHaveBeenCalledWith(
      expect.objectContaining({ name: "mcp-legacy-name-service" }),
    );
  });

  test("keeps a deployment whose name matches the FROZEN name even when it differs from the recompute", async () => {
    const mockDeleteDeployment = vi.fn().mockResolvedValue({});
    const manager = await createManagerWithMockK8s({
      mockK8sApi: { deleteNamespacedService: vi.fn().mockResolvedValue({}) },
      mockK8sAppsApi: {
        listNamespacedDeployment: vi.fn().mockResolvedValue({
          items: [
            {
              metadata: {
                name: "mcp-pre-rename-frozen",
                labels: {
                  app: "mcp-server",
                  "mcp-server-id": "123e4567-e89b-12d3-a456-426614174000",
                },
              },
            },
          ],
        }),
        deleteNamespacedDeployment: mockDeleteDeployment,
      },
    });

    // Renamed row: the recompute would be "mcp-renamed-name", but deployment
    // identity is frozen — the live deployment must survive.
    await callCleanup(manager, [
      {
        id: "123e4567-e89b-12d3-a456-426614174000",
        name: "renamed-name",
        catalogId: "cat-1",
        deploymentName: "mcp-pre-rename-frozen",
      },
    ]);

    expect(mockDeleteDeployment).not.toHaveBeenCalled();
  });

  test("skips servers whose deployment_name is still NULL instead of comparing a recomputed guess", async () => {
    const mockDeleteDeployment = vi.fn().mockResolvedValue({});
    const manager = await createManagerWithMockK8s({
      mockK8sApi: { deleteNamespacedService: vi.fn().mockResolvedValue({}) },
      mockK8sAppsApi: {
        listNamespacedDeployment: vi.fn().mockResolvedValue({
          items: [
            {
              metadata: {
                name: "mcp-some-live-name",
                labels: {
                  app: "mcp-server",
                  "mcp-server-id": "123e4567-e89b-12d3-a456-426614174000",
                },
              },
            },
          ],
        }),
        deleteNamespacedDeployment: mockDeleteDeployment,
      },
    });

    await callCleanup(manager, [
      {
        id: "123e4567-e89b-12d3-a456-426614174000",
        name: "current-name",
        catalogId: "cat-1",
        deploymentName: null,
      },
    ]);

    expect(mockDeleteDeployment).not.toHaveBeenCalled();
  });

  test("tears down a deployment left in a stale namespace after the catalog resolves elsewhere", async () => {
    // Upgrade scenario: default-environment installs used to deploy into the
    // platform namespace; once the resolver honors the org's
    // defaultEnvironmentNamespace, the old platform-namespace copy must be
    // reaped on startup.
    const serverId = "123e4567-e89b-12d3-a456-426614174000";
    const serverRow = {
      id: serverId,
      name: "current-name",
      catalogId: "cat-default-env",
      deploymentName: "mcp-current-name",
      secretId: null,
      ownerId: null,
      teamId: null,
      scope: "org" as const,
      reinstallRequired: false,
      localInstallationStatus: "idle" as const,
      localInstallationError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      serverType: "local" as const,
    };
    const catalogRow = {
      id: "cat-default-env",
      serverType: "local" as const,
      multitenant: false,
      environmentId: null,
      organizationId: "org-1",
      localConfig: { command: "node", arguments: ["server.js"] },
    };

    const McpServerModel = (await import("@/models/mcp-server")).default;
    const InternalMcpCatalogModel = (
      await import("@/models/internal-mcp-catalog")
    ).default;
    const OrganizationModel = (await import("@/models/organization")).default;
    vi.mocked(McpServerModel.findById).mockResolvedValue(
      serverRow as unknown as Awaited<
        ReturnType<typeof McpServerModel.findById>
      >,
    );
    vi.mocked(InternalMcpCatalogModel.findById).mockResolvedValue(
      catalogRow as unknown as Awaited<
        ReturnType<typeof InternalMcpCatalogModel.findById>
      >,
    );
    vi.mocked(OrganizationModel.getById).mockResolvedValue({
      id: "org-1",
      defaultEnvironmentNamespace: "org-default-ns",
    } as unknown as Awaited<ReturnType<typeof OrganizationModel.getById>>);

    const mockDeleteDeployment = vi.fn().mockResolvedValue({});
    const mockDeleteService = vi.fn().mockResolvedValue({});
    const staleDeploymentItem = {
      metadata: {
        name: "mcp-current-name",
        labels: { app: "mcp-server", "mcp-server-id": serverId },
      },
    };
    const manager = await createManagerWithMockK8s({
      mockK8sApi: { deleteNamespacedService: mockDeleteService },
      mockK8sAppsApi: {
        // Both the platform namespace ("test-namespace") and the resolved
        // "org-default-ns" hold a same-named deployment for this server: the
        // former is the stale pre-upgrade copy, the latter is current.
        listNamespacedDeployment: vi.fn().mockResolvedValue({
          items: [staleDeploymentItem],
        }),
        deleteNamespacedDeployment: mockDeleteDeployment,
      },
    });
    // getOrLoadDeployment (namespaceOverride teardown path) needs the full
    // client set.
    const managerAny = manager as unknown as Record<string, unknown>;
    managerAny.k8sNetworkingApi = {};
    managerAny.k8sCustomObjectsApi = {
      getAPIResources: vi.fn().mockResolvedValue({ resources: [] }),
    };
    managerAny.k8sAttach = {};
    managerAny.k8sLog = {};
    managerAny.k8sExec = {};

    mockRemoveDeployment.mockClear();
    mockK8sDeploymentInstances.length = 0;

    await callCleanup(manager, [serverRow]);

    // Exactly one teardown: the platform-namespace ("test-namespace") copy.
    // The org-default-ns copy matches its resolved namespace + frozen name.
    expect(mockRemoveDeployment).toHaveBeenCalledTimes(1);
    const tornDown = mockK8sDeploymentInstances.find(
      (instance) => instance.options.namespace === "test-namespace",
    );
    expect(tornDown).toBeDefined();
    // Name matches the frozen name, so no additional direct deletes fire.
    expect(mockDeleteDeployment).not.toHaveBeenCalled();

    // Restore module-mock defaults so later tests aren't polluted.
    vi.mocked(McpServerModel.findById).mockResolvedValue(null);
    vi.mocked(InternalMcpCatalogModel.findById).mockReset();
    vi.mocked(OrganizationModel.getById).mockResolvedValue({
      id: "test-org",
      defaultNetworkPolicy: null,
    } as unknown as Awaited<ReturnType<typeof OrganizationModel.getById>>);
  });

  test("ignores deployments that do not belong to installed servers", async () => {
    const mockDeleteDeployment = vi.fn().mockResolvedValue({});
    const manager = await createManagerWithMockK8s({
      mockK8sApi: { deleteNamespacedService: vi.fn().mockResolvedValue({}) },
      mockK8sAppsApi: {
        listNamespacedDeployment: vi.fn().mockResolvedValue({
          items: [
            {
              metadata: {
                name: "mcp-orphan",
                labels: {
                  app: "mcp-server",
                  "mcp-server-id": "missing-server",
                },
              },
            },
          ],
        }),
        deleteNamespacedDeployment: mockDeleteDeployment,
      },
    });

    await callCleanup(manager, []);

    expect(mockDeleteDeployment).not.toHaveBeenCalled();
  });
});

describe("McpServerRuntimeManager.reapFailedMcpPods", () => {
  async function createManagerWithMockK8s(mockK8sApi: Record<string, unknown>) {
    const { McpServerRuntimeManager } = await import("./manager");
    const manager = new McpServerRuntimeManager();
    (manager as unknown as { k8sApi: unknown }).k8sApi = mockK8sApi;
    return manager;
  }

  function callReap(manager: unknown) {
    return (
      manager as { reapFailedMcpPods: () => Promise<void> }
    ).reapFailedMcpPods();
  }

  test("deletes Failed MCP pods returned by the list call", async () => {
    const mockList = vi.fn().mockResolvedValue({
      items: [
        { metadata: { name: "mcp-server-a-abc123" } },
        { metadata: { name: "mcp-server-b-def456" } },
        // Pod without a name is skipped
        { metadata: {} },
      ],
    });
    const mockDelete = vi.fn().mockResolvedValue({});
    const manager = await createManagerWithMockK8s({
      listNamespacedPod: mockList,
      deleteNamespacedPod: mockDelete,
    });

    await callReap(manager);

    // Sweeps only the platform namespace when no environment namespaces are
    // configured, filtering server-side to Failed pods owned by Archestra.
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({
        labelSelector: "app=mcp-server",
        fieldSelector: "status.phase=Failed",
      }),
    );
    expect(mockDelete).toHaveBeenCalledTimes(2);
    expect(mockDelete).toHaveBeenCalledWith(
      expect.objectContaining({ name: "mcp-server-a-abc123" }),
    );
    expect(mockDelete).toHaveBeenCalledWith(
      expect.objectContaining({ name: "mcp-server-b-def456" }),
    );
  });

  test("continues reaping when a single pod deletion fails", async () => {
    const mockList = vi.fn().mockResolvedValue({
      items: [
        { metadata: { name: "mcp-gone-already" } },
        { metadata: { name: "mcp-still-there" } },
      ],
    });
    const mockDelete = vi
      .fn()
      .mockRejectedValueOnce(new Error("404 pod not found"))
      .mockResolvedValueOnce({});
    const manager = await createManagerWithMockK8s({
      listNamespacedPod: mockList,
      deleteNamespacedPod: mockDelete,
    });

    await callReap(manager);

    expect(mockDelete).toHaveBeenCalledTimes(2);
  });

  test("does not throw when listing pods fails", async () => {
    const manager = await createManagerWithMockK8s({
      listNamespacedPod: vi.fn().mockRejectedValue(new Error("forbidden")),
      deleteNamespacedPod: vi.fn(),
    });

    await expect(callReap(manager)).resolves.toBeUndefined();
  });

  test("does nothing when k8sApi is not initialized", async () => {
    const { McpServerRuntimeManager } = await import("./manager");
    const manager = new McpServerRuntimeManager();
    (manager as unknown as { k8sApi: unknown }).k8sApi = undefined;
    await expect(callReap(manager)).resolves.toBeUndefined();
  });
});

describe("McpServerRuntimeManager.adoptDeploymentNames", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeLocalServerRow(overrides: {
    id: string;
    name: string;
    catalogId?: string | null;
    deploymentName?: string | null;
  }) {
    return {
      catalogId: "cat-1",
      deploymentName: null,
      secretId: null,
      ownerId: null,
      teamId: null,
      scope: "org" as const,
      reinstallRequired: false,
      localInstallationStatus: "idle" as const,
      localInstallationError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      serverType: "local" as const,
      ...overrides,
    };
  }

  async function createManagerForAdopt(
    deployments: Array<{
      name: string;
      selectorId: string;
      creationTimestamp?: Date;
      namespace?: string;
    }>,
  ) {
    const { McpServerRuntimeManager } = await import("./manager");
    const manager = new McpServerRuntimeManager();
    (manager as unknown as { k8sAppsApi: unknown }).k8sAppsApi = {
      listNamespacedDeployment: vi
        .fn()
        .mockImplementation(({ namespace }: { namespace: string }) =>
          Promise.resolve({
            items: deployments
              .filter((d) => (d.namespace ?? "test-namespace") === namespace)
              .map((d) => ({
                metadata: {
                  name: d.name,
                  labels: { app: "mcp-server", "mcp-server-id": d.selectorId },
                  creationTimestamp: d.creationTimestamp,
                },
              })),
          }),
        ),
    };
    return manager;
  }

  function callAdopt(
    manager: unknown,
    params: { localServers: unknown[]; localCatalogItems: unknown[] },
  ) {
    return (
      manager as { adoptDeploymentNames: (p: unknown) => Promise<void> }
    ).adoptDeploymentNames(params);
  }

  test("adopts the live deployment's ACTUAL name for a diverged row (DB name ≠ live)", async () => {
    const server = makeLocalServerRow({ id: "srv-1", name: "current-name" });
    const manager = await createManagerForAdopt([
      { name: "mcp-old-diverged-name", selectorId: "srv-1" },
    ]);

    await callAdopt(manager, {
      localServers: [server],
      localCatalogItems: [null],
    });

    expect(McpServerModel.setDeploymentName).toHaveBeenCalledExactlyOnceWith({
      id: "srv-1",
      deploymentName: "mcp-old-diverged-name",
    });
    // In-memory mutation — the same row object feeds startServer + sweep.
    expect(server.deploymentName).toBe("mcp-old-diverged-name");
  });

  test("adopts the live deployment from an environment namespace (not only the platform namespace)", async () => {
    const catalog = {
      id: "cat-env",
      environmentId: "env-staging",
      multitenant: false,
      deploymentName: null as string | null,
      serverType: "local" as const,
    };
    const server = makeLocalServerRow({
      id: "srv-env",
      name: "current-name",
      catalogId: "cat-env",
    });
    const manager = await createManagerForAdopt([
      {
        name: "mcp-old-diverged-name",
        selectorId: "srv-env",
        namespace: "env-staging-ns",
      },
    ]);
    (
      manager as unknown as {
        resolveNamespaceForCatalog: (
          catalogItem: typeof catalog,
        ) => Promise<string>;
      }
    ).resolveNamespaceForCatalog = vi.fn().mockResolvedValue("env-staging-ns");

    await callAdopt(manager, {
      localServers: [server],
      localCatalogItems: [catalog],
    });

    expect(server.deploymentName).toBe("mcp-old-diverged-name");
    expect(McpServerModel.setDeploymentName).toHaveBeenCalledExactlyOnceWith({
      id: "srv-env",
      deploymentName: "mcp-old-diverged-name",
    });
  });

  test("freezes the legacy recompute for a row with no live deployment", async () => {
    const server = makeLocalServerRow({ id: "srv-1", name: "current-name" });
    const manager = await createManagerForAdopt([]);

    await callAdopt(manager, {
      localServers: [server],
      localCatalogItems: [null],
    });

    expect(McpServerModel.setDeploymentName).toHaveBeenCalledExactlyOnceWith({
      id: "srv-1",
      deploymentName: "mcp-current-name",
    });
    expect(server.deploymentName).toBe("mcp-current-name");
  });

  test("tie-break prefers the deployment matching the legacy recompute", async () => {
    const server = makeLocalServerRow({ id: "srv-1", name: "current-name" });
    const manager = await createManagerForAdopt([
      {
        name: "mcp-newer-stray",
        selectorId: "srv-1",
        creationTimestamp: new Date("2026-01-02"),
      },
      {
        name: "mcp-current-name",
        selectorId: "srv-1",
        creationTimestamp: new Date("2026-01-01"),
      },
    ]);

    await callAdopt(manager, {
      localServers: [server],
      localCatalogItems: [null],
    });

    expect(server.deploymentName).toBe("mcp-current-name");
  });

  test("tie-break falls back to the newest deployment when none matches the recompute", async () => {
    const server = makeLocalServerRow({ id: "srv-1", name: "current-name" });
    const manager = await createManagerForAdopt([
      {
        name: "mcp-older",
        selectorId: "srv-1",
        creationTimestamp: new Date("2026-01-01"),
      },
      {
        name: "mcp-newer",
        selectorId: "srv-1",
        creationTimestamp: new Date("2026-01-02"),
      },
    ]);

    await callAdopt(manager, {
      localServers: [server],
      localCatalogItems: [null],
    });

    expect(server.deploymentName).toBe("mcp-newer");
  });

  test("multitenant freezes onto the CATALOG row (label carries the catalog id) and updates every catalog copy", async () => {
    // start() fetches a separate catalog object per install.
    const catalogCopyA = {
      id: "cat-mt",
      name: "shared catalog",
      multitenant: true,
      deploymentName: null as string | null,
      serverType: "local" as const,
    };
    const catalogCopyB = { ...catalogCopyA };
    const serverA = makeLocalServerRow({
      id: "srv-a",
      name: "install-a",
      catalogId: "cat-mt",
    });
    const serverB = makeLocalServerRow({
      id: "srv-b",
      name: "install-b",
      catalogId: "cat-mt",
    });
    const manager = await createManagerForAdopt([
      { name: "mcp-mt-live-name", selectorId: "cat-mt" },
    ]);

    await callAdopt(manager, {
      localServers: [serverA, serverB],
      localCatalogItems: [catalogCopyA, catalogCopyB],
    });

    expect(
      InternalMcpCatalogModel.setDeploymentName,
    ).toHaveBeenCalledExactlyOnceWith({
      id: "cat-mt",
      deploymentName: "mcp-mt-live-name",
    });
    expect(catalogCopyA.deploymentName).toBe("mcp-mt-live-name");
    expect(catalogCopyB.deploymentName).toBe("mcp-mt-live-name");
    // The per-install rows share the catalog deployment — never frozen here.
    expect(McpServerModel.setDeploymentName).not.toHaveBeenCalled();
  });

  test("idempotent: already-frozen rows are skipped", async () => {
    const server = makeLocalServerRow({
      id: "srv-1",
      name: "renamed-name",
      deploymentName: "mcp-frozen-earlier",
    });
    const manager = await createManagerForAdopt([
      { name: "mcp-something-else", selectorId: "srv-1" },
    ]);

    await callAdopt(manager, {
      localServers: [server],
      localCatalogItems: [null],
    });

    expect(McpServerModel.setDeploymentName).not.toHaveBeenCalled();
    expect(server.deploymentName).toBe("mcp-frozen-earlier");
  });
});

describe("McpServerRuntimeManager.start — adopt gate settling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // A boot failure BEFORE the adopt block (here: verifyK8sConnection's pod-list
  // rejects, simulating a transient K8s blip) must still settle
  // deploymentNamesAdopted. Otherwise the rename route — which awaits that
  // promise with no timeout — hangs the request for the process lifetime, since
  // start() is fire-and-forget with no retry.
  test("rejects deploymentNamesAdopted when start() throws before the adopt pass", async () => {
    const { McpServerRuntimeManager } = await import("./manager");
    const manager = new McpServerRuntimeManager();

    // All four clients set so start() clears its "not initialized" guard and
    // reaches verifyK8sConnection; k8sApi's pod-list rejects to fail there.
    const injected = manager as unknown as {
      k8sApi: unknown;
      k8sAppsApi: unknown;
      k8sNetworkingApi: unknown;
      k8sCustomObjectsApi: unknown;
    };
    injected.k8sApi = {
      listNamespacedPod: vi.fn().mockRejectedValue(new Error("k8s boot blip")),
    };
    injected.k8sAppsApi = {};
    injected.k8sNetworkingApi = {};
    injected.k8sCustomObjectsApi = {};

    // The gate is still pending after construction (the mocked kubeconfig loads
    // fine), so this exercises start()'s outer catch, not the constructor's.
    const adopted = manager.deploymentNamesAdopted;

    // start() still rethrows (behavior unchanged); the gate now settles too.
    await expect(manager.start()).rejects.toThrow("k8s boot blip");
    await expect(adopted).rejects.toThrow("k8s boot blip");
  });
});

describe("McpServerRuntimeManager deployment-state watch layer", () => {
  type ManagerInternals = {
    mcpServerIdToDeploymentMap: Map<
      string,
      { refreshState: () => Promise<void>; k8sNamespace: string }
    >;
    startDeploymentStateWatchers: () => void;
    stopDeploymentStateWatchers: () => void;
    scheduleWatchTriggeredRefresh: () => void;
    onWatchStreamClosed: (
      namespace: string,
      kind: "pods" | "deployments",
      error: unknown,
    ) => void;
  };

  async function makeManager() {
    const { McpServerRuntimeManager } = await import("./manager");
    const manager = new McpServerRuntimeManager();
    return {
      manager,
      internals: manager as unknown as ManagerInternals,
    };
  }

  test("refreshAllStates is single-flight: concurrent callers coalesce onto one sweep", async () => {
    const { manager, internals } = await makeManager();

    let resolveRefresh!: () => void;
    const refreshState = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    internals.mcpServerIdToDeploymentMap.set("server-1", {
      refreshState,
      k8sNamespace: "default",
    });

    const first = manager.refreshAllStates();
    const second = manager.refreshAllStates();
    resolveRefresh();
    await Promise.all([first, second]);

    expect(refreshState).toHaveBeenCalledTimes(1);

    // A later call (no sweep in flight) starts a fresh one.
    const third = manager.refreshAllStates();
    resolveRefresh();
    await third;
    expect(refreshState).toHaveBeenCalledTimes(2);
  });

  test("bursts of watch events coalesce into one refresh and notify listeners once", async () => {
    vi.useFakeTimers();
    try {
      const { manager, internals } = await makeManager();
      const refreshState = vi.fn().mockResolvedValue(undefined);
      internals.mcpServerIdToDeploymentMap.set("server-1", {
        refreshState,
        k8sNamespace: "default",
      });

      const listener = vi.fn();
      const unsubscribe = manager.onDeploymentStatesRefreshed(listener);

      // A rollout emits many events in quick succession.
      internals.scheduleWatchTriggeredRefresh();
      internals.scheduleWatchTriggeredRefresh();
      internals.scheduleWatchTriggeredRefresh();

      await vi.advanceTimersByTimeAsync(1_500);

      expect(refreshState).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      internals.scheduleWatchTriggeredRefresh();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("deploymentStateWatchersActive tracks stream health so pollers can fall back", async () => {
    const { manager, internals } = await makeManager();
    try {
      expect(manager.deploymentStateWatchersActive).toBe(false);

      internals.startDeploymentStateWatchers();
      // Stream opening is async (watch() resolves an AbortController).
      await vi.waitFor(() =>
        expect(manager.deploymentStateWatchersActive).toBe(true),
      );

      // One stream drops (API-server close, RBAC, connectivity): report
      // inactive so the websocket poller falls back to its fast interval.
      internals.onWatchStreamClosed(
        "test-namespace",
        "pods",
        new Error("boom"),
      );
      expect(manager.deploymentStateWatchersActive).toBe(false);
    } finally {
      internals.stopDeploymentStateWatchers();
    }
    expect(manager.deploymentStateWatchersActive).toBe(false);
  });
});

describe("McpServerRuntimeManager idle hibernation", () => {
  type MockHibernationDeployment = {
    state: string;
    mcpServer: { id: string; name: string };
    catalogItem: {
      id: string;
      serverType: string;
      deploymentSpecYaml: string | null;
      multitenant: boolean;
    };
    k8sNamespace: string;
    k8sDeploymentName: string;
    readonly statusSummary: { state: string; serverName: string };
    getCatalogItem: () => Promise<MockHibernationDeployment["catalogItem"]>;
    syncStateFromSibling: (state: string) => void;
    hibernate: ReturnType<typeof vi.fn>;
    beginWake: ReturnType<typeof vi.fn>;
    completeWake: ReturnType<typeof vi.fn>;
    refreshState: ReturnType<typeof vi.fn>;
    readLiveDeployment: ReturnType<typeof vi.fn>;
    waitForDeploymentReady: ReturnType<typeof vi.fn>;
    assessWakeImageCache: ReturnType<typeof vi.fn>;
  };

  type HibernationInternals = {
    mcpServerIdToDeploymentMap: Map<string, MockHibernationDeployment>;
    startIdleHibernationSweeper: () => void;
    sweepIdleDeployments: () => Promise<void>;
    idleHibernationSweepTimer?: NodeJS.Timeout;
    idleHibernationSweepInFlight?: Promise<void>;
    wakeInFlightByPhysicalKey: Map<string, Promise<void>>;
  };

  /** One sweeper tick: min(window/2, 60)s. */
  const SWEEP_TICK_MS = 60_000;

  const IDLE_WINDOW_SECONDS = 300;
  // Idle window + MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS stamp grace.
  const IDLE_CUTOFF_MS =
    IDLE_WINDOW_SECONDS * 1000 + MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS;

  /** A live-deployment read the seizure guard accepts: awake, unannotated. */
  function awakeLiveDeployment() {
    return {
      metadata: { annotations: {} },
      spec: { replicas: 1 },
      status: { availableReplicas: 1 },
    };
  }

  function makeDeployment(
    overrides: Partial<MockHibernationDeployment> = {},
  ): MockHibernationDeployment {
    return {
      state: "running",
      mcpServer: { id: "server-1", name: "sleepy-server" },
      catalogItem: {
        id: "catalog-1",
        serverType: "local",
        deploymentSpecYaml: null,
        multitenant: false,
      },
      k8sNamespace: "test-namespace",
      k8sDeploymentName: "mcp-sleepy",
      get statusSummary() {
        return { state: this.state, serverName: this.mcpServer.name };
      },
      async getCatalogItem() {
        return this.catalogItem;
      },
      syncStateFromSibling(state: string) {
        this.state = state;
      },
      hibernate: vi.fn().mockResolvedValue({ hibernated: true }),
      beginWake: vi.fn().mockResolvedValue(undefined),
      completeWake: vi.fn().mockResolvedValue(undefined),
      refreshState: vi.fn().mockResolvedValue(undefined),
      readLiveDeployment: vi.fn().mockResolvedValue(awakeLiveDeployment()),
      waitForDeploymentReady: vi.fn().mockResolvedValue(undefined),
      // Post-hibernate image-cache observability. The real method reports
      // "could not assess" as null rather than throwing, so the hibernation
      // outcome never depends on it.
      assessWakeImageCache: vi.fn().mockResolvedValue(null),
      ...overrides,
    };
  }

  /**
   * A manager with idle hibernation ON (beta flag on, organization opted in,
   * licence active, operator kill switch off) and the given idle window. Pass
   * `{ hardDisabled: true }` for the operator's kill switch or
   * `{ betaEnabled: false }` for a deployment that does not offer the feature.
   */
  async function makeManager(
    options: {
      windowSeconds?: number;
      hardDisabled?: boolean;
      betaEnabled?: boolean;
    } = {},
  ) {
    const config = (await import("@/config")).default;
    config.orchestrator.mcpIdleHibernation.windowSeconds =
      options.windowSeconds ?? IDLE_WINDOW_SECONDS;
    config.orchestrator.mcpIdleHibernation.hardDisabled =
      options.hardDisabled ?? false;
    config.orchestrator.mcpIdleHibernation.betaEnabled =
      options.betaEnabled ?? true;
    const managerModule = await import("./manager");
    const manager = new managerModule.McpServerRuntimeManager();
    return {
      manager,
      internals: manager as unknown as HibernationInternals,
      McpServerWakeError: managerModule.McpServerWakeError,
      config,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // The feature flags live on the (mocked, file-shared) config object and
    // several model mocks get sticky implementations here — restore the
    // factory defaults so a shuffled test order can't leak them.
    const config = (await import("@/config")).default;
    config.orchestrator.mcpIdleHibernation.hardDisabled = true;
    config.orchestrator.mcpIdleHibernation.betaEnabled = false;
    vi.mocked(OrganizationModel.getMcpIdleHibernationEnabled).mockReset();
    vi.mocked(OrganizationModel.getMcpIdleHibernationEnabled).mockResolvedValue(
      true,
    );
    vi.mocked(OrganizationModel.getMcpIdleHibernationEnabledSync).mockReset();
    vi.mocked(
      OrganizationModel.getMcpIdleHibernationEnabledSync,
    ).mockReturnValue(true);
    vi.mocked(McpServerModel.getHibernationModes).mockReset();
    vi.mocked(McpServerModel.getHibernationModes).mockResolvedValue([]);
    // clearAllMocks keeps implementations, so an unlicensed instance would
    // otherwise leak into every later test.
    vi.mocked(enterpriseTier.isCoreActive).mockReturnValue(true);
    vi.mocked(McpServerModel.findById).mockReset();
    vi.mocked(McpServerModel.findById).mockResolvedValue(null);
    vi.mocked(McpServerModel.findByCatalogId).mockReset();
    vi.mocked(McpServerModel.findByCatalogId).mockResolvedValue([]);
    vi.mocked(McpServerModel.getLatestUsageAt).mockReset();
    vi.mocked(McpServerModel.getLatestUsageAt).mockResolvedValue(null);
    vi.mocked(mcpActiveUseTracker.getActiveUseCount).mockReset();
    vi.mocked(mcpActiveUseTracker.getActiveUseCount).mockReturnValue(0);
    vi.mocked(mcpActiveUseTracker.getInMemoryLastUsedAt).mockReset();
    vi.mocked(mcpActiveUseTracker.getInMemoryLastUsedAt).mockReturnValue(null);
  });

  test("the mocked last-used grace constant matches the real one (drift guard)", async () => {
    // importActual is safe HERE (after the module graph settled with mocks in
    // place) but not inside the mock factory — see the factory comment.
    const actual = await vi.importActual<typeof import("@/models/mcp-server")>(
      "@/models/mcp-server",
    );
    expect(actual.MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS).toBe(
      MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS,
    );
  });

  describe("sweeper", () => {
    /** One idle-past-cutoff candidate loaded in the map, ready to sweep. */
    async function makeDeploymentInSweep() {
      const { manager, internals } = await makeManager();
      internals.mcpServerIdToDeploymentMap.set("server-1", makeDeployment());
      vi.mocked(McpServerModel.getLatestUsageAt).mockResolvedValue(
        new Date(Date.now() - IDLE_CUTOFF_MS - 60_000),
      );
      return { manager, internals };
    }

    test("hibernates a shared deployment idle past window+grace once, syncing every sibling alias, listeners, and durable sessions", async () => {
      const { manager, internals } = await makeManager();
      const McpHttpSessionModel = (await import("@/models/mcp-http-session"))
        .default;

      // Two sibling installs alias ONE physical deployment.
      const depA = makeDeployment({
        mcpServer: { id: "sib-a", name: "shared-server" },
        k8sDeploymentName: "mcp-mt-shared",
      });
      const depB = makeDeployment({
        mcpServer: { id: "sib-b", name: "shared-server" },
        k8sDeploymentName: "mcp-mt-shared",
      });
      internals.mcpServerIdToDeploymentMap.set("sib-a", depA);
      internals.mcpServerIdToDeploymentMap.set("sib-b", depB);

      vi.mocked(McpServerModel.findById).mockImplementation(
        async (id) =>
          ({ id, catalogId: "cat-mt" }) as unknown as Awaited<
            ReturnType<typeof McpServerModel.findById>
          >,
      );
      vi.mocked(InternalMcpCatalogModel.findById).mockResolvedValue({
        id: "cat-mt",
        multitenant: true,
      } as unknown as Awaited<
        ReturnType<typeof InternalMcpCatalogModel.findById>
      >);
      vi.mocked(McpServerModel.findByCatalogId).mockResolvedValue([
        { id: "sib-a" },
        { id: "sib-b" },
      ] as unknown as Awaited<
        ReturnType<typeof McpServerModel.findByCatalogId>
      >);
      vi.mocked(McpServerModel.getLatestUsageAt).mockResolvedValue(
        new Date(Date.now() - IDLE_CUTOFF_MS - 60_000),
      );

      const listener = vi.fn().mockResolvedValue(undefined);
      manager.registerHibernationListener(listener);

      await internals.sweepIdleDeployments();

      // Physical dedupe: exactly ONE hibernate patch for the shared deployment.
      expect(depA.hibernate).toHaveBeenCalledTimes(1);
      expect(depB.hibernate).not.toHaveBeenCalled();
      // Every loaded sibling alias transitions, not only the patched object.
      expect(depA.state).toBe("hibernated");
      expect(depB.state).toBe("hibernated");
      // Connection-pool invalidation gets the whole sibling group.
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(["sib-a", "sib-b"]);
      // Durable HTTP sessions dropped for every sibling.
      expect(
        vi
          .mocked(McpHttpSessionModel.deleteByMcpServerId)
          .mock.calls.map((c) => c[0]),
      ).toEqual(expect.arrayContaining(["sib-a", "sib-b"]));
      expect(manager.isDeploymentDormant("sib-a")).toBe(true);
      expect(manager.isDeploymentDormant("sib-b")).toBe(true);
    });

    test("an actively-used deployment is skipped before any query runs", async () => {
      const { internals } = await makeDeploymentInSweep();
      const deployment = internals.mcpServerIdToDeploymentMap.get("server-1");
      vi.mocked(mcpActiveUseTracker.getActiveUseCount).mockReturnValue(1);

      await internals.sweepIdleDeployments();

      expect(deployment?.hibernate).not.toHaveBeenCalled();
      // The sweep ticks over every loaded deployment forever. A server with
      // work in progress is provably not idle from memory alone, so it must
      // not cost a sibling-resolution and usage query every time.
      expect(McpServerModel.findById).not.toHaveBeenCalled();
      expect(McpServerModel.getLatestUsageAt).not.toHaveBeenCalled();
    });

    test("a stale sibling alias cannot veto a group the cluster says is running", async () => {
      const { internals } = await makeManager();
      // Same physical deployment, two aliases, and only one of them has ever
      // been refreshed. Map order decided which one the sweep evaluated, so a
      // never-refreshed alias could keep a genuinely idle group awake forever.
      const coldAlias = makeDeployment({
        state: "not_created",
        mcpServer: { id: "sib-a", name: "shared-server" },
        k8sDeploymentName: "mcp-mt-shared",
      });
      const runningAlias = makeDeployment({
        mcpServer: { id: "sib-b", name: "shared-server" },
        k8sDeploymentName: "mcp-mt-shared",
      });
      internals.mcpServerIdToDeploymentMap.set("sib-a", coldAlias);
      internals.mcpServerIdToDeploymentMap.set("sib-b", runningAlias);
      vi.mocked(McpServerModel.getLatestUsageAt).mockResolvedValue(
        new Date(Date.now() - IDLE_CUTOFF_MS - 60_000),
      );

      await internals.sweepIdleDeployments();

      expect(runningAlias.hibernate).toHaveBeenCalledTimes(1);
      expect(coldAlias.hibernate).not.toHaveBeenCalled();
    });

    test("keeps a deployment whose last use is within window+grace (persisted stamp)", async () => {
      const { internals } = await makeManager();
      const deployment = makeDeployment();
      internals.mcpServerIdToDeploymentMap.set("server-1", deployment);

      // Past the raw window but inside the stamp-throttle grace.
      vi.mocked(McpServerModel.getLatestUsageAt).mockResolvedValue(
        new Date(Date.now() - IDLE_CUTOFF_MS + 10_000),
      );

      await internals.sweepIdleDeployments();

      expect(deployment.hibernate).not.toHaveBeenCalled();
      expect(deployment.state).toBe("running");
    });

    test("keeps a deployment whose in-memory watermark is fresh even when the persisted stamp is stale", async () => {
      const { internals } = await makeManager();
      const deployment = makeDeployment();
      internals.mcpServerIdToDeploymentMap.set("server-1", deployment);

      vi.mocked(McpServerModel.getLatestUsageAt).mockResolvedValue(
        new Date(Date.now() - IDLE_CUTOFF_MS - 60_000),
      );
      // A failed stamp write can leave the DB stale while the process knows
      // better — effective last-use is the max of both signals.
      vi.mocked(mcpActiveUseTracker.getInMemoryLastUsedAt).mockReturnValue(
        new Date(),
      );

      await internals.sweepIdleDeployments();

      expect(deployment.hibernate).not.toHaveBeenCalled();
    });

    test("an active call on ANY sibling blocks hibernation", async () => {
      const { internals } = await makeManager();
      const depA = makeDeployment({
        mcpServer: { id: "sib-a", name: "shared-server" },
        k8sDeploymentName: "mcp-mt-shared",
      });
      internals.mcpServerIdToDeploymentMap.set("sib-a", depA);

      vi.mocked(McpServerModel.findById).mockResolvedValue({
        id: "sib-a",
        catalogId: "cat-mt",
      } as unknown as Awaited<ReturnType<typeof McpServerModel.findById>>);
      vi.mocked(InternalMcpCatalogModel.findById).mockResolvedValue({
        id: "cat-mt",
        multitenant: true,
      } as unknown as Awaited<
        ReturnType<typeof InternalMcpCatalogModel.findById>
      >);
      vi.mocked(McpServerModel.findByCatalogId).mockResolvedValue([
        { id: "sib-a" },
        { id: "sib-b" },
      ] as unknown as Awaited<
        ReturnType<typeof McpServerModel.findByCatalogId>
      >);
      vi.mocked(McpServerModel.getLatestUsageAt).mockResolvedValue(
        new Date(Date.now() - IDLE_CUTOFF_MS - 60_000),
      );
      // The in-flight call runs on the OTHER sibling.
      vi.mocked(mcpActiveUseTracker.getActiveUseCount).mockImplementation(
        (id: string) => (id === "sib-b" ? 1 : 0),
      );

      await internals.sweepIdleDeployments();

      expect(depA.hibernate).not.toHaveBeenCalled();
      // The guarded usage read is never reached — the active counter already
      // decided.
      expect(McpServerModel.getLatestUsageAt).not.toHaveBeenCalled();
    });

    test("a usage-lookup DB error skips the deployment this cycle (never hibernate on doubt)", async () => {
      const { internals } = await makeManager();
      const deployment = makeDeployment();
      internals.mcpServerIdToDeploymentMap.set("server-1", deployment);

      vi.mocked(McpServerModel.getLatestUsageAt).mockRejectedValue(
        new Error("connection refused"),
      );

      await expect(internals.sweepIdleDeployments()).resolves.toBeUndefined();

      expect(deployment.hibernate).not.toHaveBeenCalled();
      expect(deployment.state).toBe("running");
    });

    test("a custom-YAML deployment hibernates like any other", async () => {
      // Previously excluded on the theory that an operator-authored spec owns
      // its replica count. It doesn't: deploymentSpecYaml is only consumed
      // when the Deployment is generated, never re-applied on a schedule, and
      // hibernate records the LIVE replica count — so a spec asking for 3
      // comes back as 3. Excluding it only denied idle savings to exactly the
      // heavyweight servers most worth hibernating.
      const { internals } = await makeManager();
      const customYaml = makeDeployment({
        mcpServer: { id: "custom-yaml", name: "custom-yaml-server" },
        k8sDeploymentName: "mcp-custom-yaml",
        catalogItem: {
          id: "catalog-yaml",
          serverType: "local",
          deploymentSpecYaml: "kind: Deployment",
          multitenant: false,
        },
      });
      internals.mcpServerIdToDeploymentMap.set("custom-yaml", customYaml);

      vi.mocked(McpServerModel.getLatestUsageAt).mockResolvedValue(
        new Date(Date.now() - IDLE_CUTOFF_MS - 60_000),
      );

      await internals.sweepIdleDeployments();

      expect(customYaml.hibernate).toHaveBeenCalledTimes(1);
      expect(customYaml.state).toBe("hibernated");
    });

    test("non-running deployments are never candidates", async () => {
      const { internals } = await makeManager();
      const pending = makeDeployment({
        mcpServer: { id: "pending-server", name: "pending-server" },
        k8sDeploymentName: "mcp-pending",
        state: "pending",
      });
      const hibernated = makeDeployment({
        mcpServer: { id: "hibernated-server", name: "hibernated-server" },
        k8sDeploymentName: "mcp-hibernated",
        state: "hibernated",
      });
      internals.mcpServerIdToDeploymentMap.set("pending-server", pending);
      internals.mcpServerIdToDeploymentMap.set("hibernated-server", hibernated);

      vi.mocked(McpServerModel.getLatestUsageAt).mockResolvedValue(
        new Date(Date.now() - IDLE_CUTOFF_MS - 60_000),
      );

      await internals.sweepIdleDeployments();

      expect(pending.hibernate).not.toHaveBeenCalled();
      expect(hibernated.hibernate).not.toHaveBeenCalled();
    });

    test("one sibling pinned to hibernationMode 'disabled' keeps the whole group awake", async () => {
      const { internals } = await makeManager();
      const deployment = makeDeployment();
      internals.mcpServerIdToDeploymentMap.set("server-1", deployment);
      vi.mocked(McpServerModel.getLatestUsageAt).mockResolvedValue(
        new Date(Date.now() - IDLE_CUTOFF_MS - 60_000),
      );
      // Siblings share ONE pod, so there is no way to honour a single
      // install's "keep me awake" without keeping all of them awake.
      vi.mocked(McpServerModel.getHibernationModes).mockResolvedValue([
        "inherit",
        "disabled",
      ]);

      await internals.sweepIdleDeployments();

      expect(deployment.hibernate).not.toHaveBeenCalled();
      expect(deployment.state).toBe("running");
      // Vetoed before the usage query: the answer is already decided.
      expect(McpServerModel.getLatestUsageAt).not.toHaveBeenCalled();
    });

    test("'enabled' and 'inherit' modes both sleep while the org toggle is on", async () => {
      const { internals } = await makeManager();
      const deployment = makeDeployment();
      internals.mcpServerIdToDeploymentMap.set("server-1", deployment);
      vi.mocked(McpServerModel.getLatestUsageAt).mockResolvedValue(
        new Date(Date.now() - IDLE_CUTOFF_MS - 60_000),
      );
      vi.mocked(McpServerModel.getHibernationModes).mockResolvedValue([
        "enabled",
        "inherit",
      ]);

      await internals.sweepIdleDeployments();

      expect(deployment.hibernate).toHaveBeenCalledTimes(1);
    });

    test("an inactive enterprise licence stops the sweep dead", async () => {
      // Idle hibernation is enterprise-licensed. A team that grew past the
      // small-team allowance without a licence keeps every server awake —
      // it must never silently keep scaling workloads away.
      // Unlicensed by either route the gate knows about (no env licence and
      // a head count past the small-team allowance).
      vi.mocked(enterpriseTier.isCoreActive).mockReturnValue(false);
      const { internals } = await makeManager();
      const deployment = makeDeployment();
      internals.mcpServerIdToDeploymentMap.set("server-1", deployment);
      vi.mocked(McpServerModel.getLatestUsageAt).mockResolvedValue(
        new Date(Date.now() - IDLE_CUTOFF_MS - 60_000),
      );

      await internals.sweepIdleDeployments();

      expect(deployment.hibernate).not.toHaveBeenCalled();
      expect(deployment.state).toBe("running");
    });

    test("compensation: demand arriving during the hibernate patch wakes the deployment immediately", async () => {
      const { manager, internals } = await makeManager();
      const deployment = makeDeployment();
      internals.mcpServerIdToDeploymentMap.set("server-1", deployment);

      vi.mocked(McpServerModel.getLatestUsageAt).mockResolvedValue(
        new Date(Date.now() - IDLE_CUTOFF_MS - 60_000),
      );
      // Three reads in order: the cheap own-server pre-filter, the sibling
      // group check, then the post-patch re-check. Only the last sees demand.
      vi.mocked(mcpActiveUseTracker.getInMemoryLastUsedAt)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(new Date());

      const ensureAwakeSpy = vi
        .spyOn(manager, "ensureAwake")
        .mockResolvedValue(undefined);

      await internals.sweepIdleDeployments();

      expect(deployment.hibernate).toHaveBeenCalledTimes(1);
      expect(ensureAwakeSpy).toHaveBeenCalledWith("server-1");
    });

    test("seizure guard: an externally-scaled-to-0 deployment (no annotation) is never annotated", async () => {
      const { internals } = await makeDeploymentInSweep();
      const deployment = internals.mcpServerIdToDeploymentMap.get("server-1");
      // The debounce leaves the cached state "running" for up to 3 refreshes
      // after an operator scaled to 0 — only the fresh direct read knows.
      deployment?.readLiveDeployment.mockResolvedValue({
        metadata: { annotations: {} },
        spec: { replicas: 0 },
        status: { availableReplicas: 0 },
      });

      await internals.sweepIdleDeployments();

      expect(deployment?.hibernate).not.toHaveBeenCalled();
      expect(deployment?.state).toBe("running");
    });

    test("seizure guard: an already-annotated or missing live deployment is skipped", async () => {
      const { internals } = await makeDeploymentInSweep();
      const deployment = internals.mcpServerIdToDeploymentMap.get("server-1");

      // Another replica hibernated it between our idle check and the patch.
      deployment?.readLiveDeployment.mockResolvedValue({
        metadata: { annotations: { "archestra.io/hibernated": "true" } },
        spec: { replicas: 0 },
        status: { availableReplicas: 0 },
      });
      await internals.sweepIdleDeployments();
      expect(deployment?.hibernate).not.toHaveBeenCalled();

      // Deployment deleted out from under the sweep.
      deployment?.readLiveDeployment.mockResolvedValue(null);
      await internals.sweepIdleDeployments();
      expect(deployment?.hibernate).not.toHaveBeenCalled();
    });

    test("the operator kill switch installs no sweeper timer at all", async () => {
      const { internals } = await makeManager({ hardDisabled: true });
      internals.startIdleHibernationSweeper();
      expect(internals.idleHibernationSweepTimer).toBeUndefined();
    });

    test("the beta flag off installs no sweeper timer at all", async () => {
      const { internals } = await makeManager({ betaEnabled: false });
      internals.startIdleHibernationSweeper();
      expect(internals.idleHibernationSweepTimer).toBeUndefined();
    });

    test("the timer runs while only the org toggle is off, so flipping it on needs no restart", async () => {
      // The organization toggle is re-read on every tick; latching the timer
      // on it would mean an administrator turning hibernation on had to wait
      // for a redeploy before anything ever slept.
      vi.mocked(
        OrganizationModel.getMcpIdleHibernationEnabled,
      ).mockResolvedValue(false);
      const { manager, internals } = await makeManager();
      const deployment = makeDeployment();
      internals.mcpServerIdToDeploymentMap.set("server-1", deployment);
      vi.mocked(McpServerModel.getLatestUsageAt).mockResolvedValue(
        new Date(Date.now() - IDLE_CUTOFF_MS - 60_000),
      );

      internals.startIdleHibernationSweeper();
      expect(internals.idleHibernationSweepTimer).toBeDefined();

      await internals.sweepIdleDeployments();
      expect(deployment.hibernate).not.toHaveBeenCalled();
      expect(deployment.state).toBe("running");

      // Don't leave a live interval behind for later tests to trip over.
      await manager.shutdown();
    });

    test("sweeper ticks at min(window/2, 60)s and shutdown clears the timer and wake map", async () => {
      vi.useFakeTimers();
      try {
        const { manager, internals } = await makeManager();
        const deployment = makeDeployment();
        internals.mcpServerIdToDeploymentMap.set("server-1", deployment);
        vi.mocked(McpServerModel.getLatestUsageAt).mockResolvedValue(
          new Date(Date.now() - IDLE_CUTOFF_MS - 60_000),
        );

        internals.startIdleHibernationSweeper();
        expect(internals.idleHibernationSweepTimer).toBeDefined();

        // window/2 = 150s caps at 60s.
        await vi.advanceTimersByTimeAsync(59_000);
        expect(deployment.hibernate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(deployment.hibernate).toHaveBeenCalledTimes(1);

        internals.mcpServerIdToDeploymentMap.clear();
        internals.wakeInFlightByPhysicalKey.set(
          "test-namespace/mcp-sleepy",
          Promise.resolve(),
        );
        await manager.shutdown();
        expect(internals.idleHibernationSweepTimer).toBeUndefined();
        expect(internals.wakeInFlightByPhysicalKey.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    test("a sweep that never settles releases the in-flight guard so a later tick sweeps again", async () => {
      vi.useFakeTimers();
      try {
        const { manager, internals } = await makeManager();
        // biome-ignore lint/style/noRestrictedImports: the sweep deadline under test is enterprise-licensed
        const { SWEEP_DEADLINE_MS } = await import("./hibernation.ee");
        // The first sweep hangs on its very first await; later ones are normal.
        vi.mocked(OrganizationModel.getMcpIdleHibernationEnabled)
          .mockReturnValueOnce(new Promise<boolean>(() => {}))
          .mockResolvedValue(true);
        const deployment = makeDeployment();
        internals.mcpServerIdToDeploymentMap.set("server-1", deployment);
        vi.mocked(McpServerModel.getLatestUsageAt).mockResolvedValue(
          new Date(Date.now() - IDLE_CUTOFF_MS - 60_000),
        );

        internals.startIdleHibernationSweeper();

        // The first tick starts the sweep that never settles, and every tick
        // after it is skipped while the guard is held: without a deadline this
        // is where hibernation stops platform-wide until a restart.
        await vi.advanceTimersByTimeAsync(SWEEP_TICK_MS * 2);
        expect(
          OrganizationModel.getMcpIdleHibernationEnabled,
        ).toHaveBeenCalledTimes(1);
        expect(internals.idleHibernationSweepInFlight).toBeDefined();
        expect(deployment.hibernate).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(SWEEP_DEADLINE_MS + SWEEP_TICK_MS);

        expect(internals.idleHibernationSweepInFlight).toBeUndefined();
        // A later tick sweeps for real: the abandoned sweep cost this install
        // some idle savings, not the feature.
        expect(deployment.hibernate).toHaveBeenCalledTimes(1);
        expect(deployment.state).toBe("hibernated");

        internals.mcpServerIdToDeploymentMap.clear();
        await manager.shutdown();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("ensureAwake", () => {
    test("fast no-op on a cached running state — no K8s call of any kind", async () => {
      const { manager, internals } = await makeManager();
      const deployment = makeDeployment({ state: "running" });
      internals.mcpServerIdToDeploymentMap.set("server-1", deployment);

      await manager.ensureAwake("server-1");

      expect(deployment.refreshState).not.toHaveBeenCalled();
      expect(deployment.beginWake).not.toHaveBeenCalled();
      expect(deployment.waitForDeploymentReady).not.toHaveBeenCalled();
      expect(deployment.completeWake).not.toHaveBeenCalled();
      expect(manager.isDeploymentDormant("server-1")).toBe(false);
    });

    test("isDeploymentDormant covers waking as well as hibernated", async () => {
      const { manager, internals } = await makeManager();
      internals.mcpServerIdToDeploymentMap.set(
        "asleep",
        makeDeployment({ state: "hibernated" }),
      );
      internals.mcpServerIdToDeploymentMap.set(
        "waking",
        makeDeployment({ state: "waking" }),
      );
      internals.mcpServerIdToDeploymentMap.set(
        "up",
        makeDeployment({ state: "running" }),
      );

      // Background paths skip anything not yet serving, so a deployment
      // mid-wake counts as dormant just like a hibernated one.
      expect(manager.isDeploymentDormant("asleep")).toBe(true);
      expect(manager.isDeploymentDormant("waking")).toBe(true);
      expect(manager.isDeploymentDormant("up")).toBe(false);
      expect(manager.isDeploymentDormant("never-loaded")).toBe(false);
    });

    // A cache-cold alias is covered in manager.dormancy.test.ts, which drives
    // real K8sDeployment objects through the lifecycle instead of hand-building
    // a state a K8sDeployment cannot actually reach.
    test("nothing is dormant while idle hibernation is off", async () => {
      vi.mocked(
        OrganizationModel.getMcpIdleHibernationEnabledSync,
      ).mockReturnValue(false);
      const { manager, internals } = await makeManager();
      internals.mcpServerIdToDeploymentMap.set(
        "cold",
        makeDeployment({ state: "not_created" }),
      );

      // Without a sweeper nothing can be asleep, so a cold cache must never
      // cost a background path the servers it would otherwise refresh.
      expect(manager.isDeploymentDormant("cold")).toBe(false);
    });

    test("concurrent callers single-flight onto one wake", async () => {
      const { manager, internals } = await makeManager();
      const deployment = makeDeployment({ state: "hibernated" });
      internals.mcpServerIdToDeploymentMap.set("server-1", deployment);

      const first = manager.ensureAwake("server-1");
      const second = manager.ensureAwake("server-1");
      await Promise.all([first, second]);

      expect(deployment.refreshState).toHaveBeenCalledTimes(1);
      expect(deployment.beginWake).toHaveBeenCalledTimes(1);
      expect(deployment.completeWake).toHaveBeenCalledTimes(1);
      expect(deployment.state).toBe("running");
      // The single-flight entry is cleared once the wake settles.
      expect(internals.wakeInFlightByPhysicalKey.size).toBe(0);
    });

    test("ready-wait failure throws McpServerWakeError and a later call resumes the wake without a second beginWake", async () => {
      const { manager, internals, McpServerWakeError } = await makeManager();
      const deployment = makeDeployment({ state: "hibernated" });
      deployment.waitForDeploymentReady.mockRejectedValueOnce(
        new Error("deployment did not become ready"),
      );
      internals.mcpServerIdToDeploymentMap.set("server-1", deployment);

      const wakeError = await manager.ensureAwake("server-1").then(
        () => null,
        (error) => error,
      );
      expect(wakeError).toBeInstanceOf(McpServerWakeError);
      expect(wakeError).toMatchObject({
        name: "McpServerWakeError",
        message: expect.stringContaining("sleepy-server"),
      });

      // completeWake never ran, so the hibernation annotation stays on the
      // deployment (deliberate: refreshState reports it "waking", keeping the
      // sweeper away from a half-woken pod), and the cached state returns to
      // "hibernated" so the next call re-enters the wake path.
      expect(deployment.completeWake).not.toHaveBeenCalled();
      expect(deployment.state).toBe("hibernated");
      expect(internals.wakeInFlightByPhysicalKey.size).toBe(0);

      // Cluster truth on retry: replicas ≥ 1 with the annotation → "waking".
      deployment.refreshState.mockImplementation(async () => {
        deployment.state = "waking";
      });

      await manager.ensureAwake("server-1");

      // Resume path: no second scale-up patch, just wait + completeWake.
      expect(deployment.beginWake).toHaveBeenCalledTimes(1);
      expect(deployment.completeWake).toHaveBeenCalledTimes(1);
      expect(deployment.state).toBe("running");
    });

    test("a full cluster is retryable, not a failed deployment: the wake rides out Unschedulable and resumes later", async () => {
      const { manager, internals, McpServerWakeError } = await makeManager();
      const { McpServerDeploymentFailedError, McpServerUnschedulableError } =
        await import("./k8s-deployment");
      const deployment = makeDeployment({ state: "hibernated" });
      // The mass-wake case: a fleet that went to sleep together asks the
      // scheduler for every pod back at once and the cluster runs out of room.
      const schedulerMessage =
        "0/3 nodes are available: 3 Insufficient memory.";
      deployment.waitForDeploymentReady.mockRejectedValueOnce(
        new McpServerUnschedulableError("mcp-sleepy", schedulerMessage),
      );
      internals.mcpServerIdToDeploymentMap.set("server-1", deployment);

      const wakeError = await manager.ensureAwake("server-1").then(
        () => null,
        (error) => error,
      );

      // Riding out Unschedulable is what makes the capacity case survivable:
      // a first install fails fast on it after ~20s, which on a wake would
      // brand a full-but-healthy cluster a deployment defect.
      expect(deployment.waitForDeploymentReady).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(Number),
        { waitOutUnschedulablePods: true },
      );
      expect(wakeError).toBeInstanceOf(McpServerWakeError);
      expect(wakeError).not.toBeInstanceOf(McpServerDeploymentFailedError);
      // Retryable AND diagnosable: "retry shortly" with no reason is
      // indistinguishable from a wake hung on something nobody is fixing.
      expect(wakeError.message).toContain("no free capacity");
      expect(wakeError.message).toContain(schedulerMessage);

      // Nothing is marked broken: completeWake never ran, so the hibernation
      // annotation stays put, and the cache goes back to "hibernated" so the
      // next demand re-enters the wake instead of trusting a half-woken pod.
      expect(deployment.completeWake).not.toHaveBeenCalled();
      expect(deployment.state).toBe("hibernated");
      expect(internals.wakeInFlightByPhysicalKey.size).toBe(0);

      // Capacity freed: the resumed wake finishes without a second scale-up.
      deployment.refreshState.mockImplementation(async () => {
        deployment.state = "waking";
      });
      await manager.ensureAwake("server-1");

      expect(deployment.beginWake).toHaveBeenCalledTimes(1);
      expect(deployment.completeWake).toHaveBeenCalledTimes(1);
      expect(deployment.state).toBe("running");
    });

    test("a genuinely broken pod stays terminal — a failed wake is never dressed up as retryable", async () => {
      const { manager, internals, McpServerWakeError } = await makeManager();
      const { McpServerDeploymentFailedError } = await import(
        "./k8s-deployment"
      );
      const deployment = makeDeployment({ state: "hibernated" });
      deployment.waitForDeploymentReady.mockRejectedValueOnce(
        new McpServerDeploymentFailedError(
          "Deployment mcp-sleepy failed: CrashLoopBackOff - server exited on boot",
        ),
      );
      internals.mcpServerIdToDeploymentMap.set("server-1", deployment);

      const error = await manager.ensureAwake("server-1").then(
        () => null,
        (thrown) => thrown,
      );

      // Telling a caller to "retry shortly" for a pod only an operator can
      // clear loops forever, so the real failure has to survive the wake path.
      expect(error).toBeInstanceOf(McpServerDeploymentFailedError);
      expect(error).not.toBeInstanceOf(McpServerWakeError);
      expect(deployment.state).toBe("failed");
      expect(deployment.completeWake).not.toHaveBeenCalled();
      expect(internals.wakeInFlightByPhysicalKey.size).toBe(0);
    });

    test("a wake attempt that never settles releases its waiters and frees the slot for a fresh attempt", async () => {
      vi.useFakeTimers();
      try {
        const { manager, internals, McpServerWakeError } = await makeManager();
        // biome-ignore lint/style/noRestrictedImports: the wake deadline under test is enterprise-licensed
        const { WAKE_ATTEMPT_DEADLINE_MS } = await import("./hibernation.ee");
        const deployment = makeDeployment({ state: "hibernated" });
        // A Kubernetes call that never comes back. The ready-wait's own budget
        // cannot end this, because the wait itself is what hangs.
        deployment.waitForDeploymentReady.mockImplementation(
          () => new Promise<void>(() => {}),
        );
        internals.mcpServerIdToDeploymentMap.set("server-1", deployment);

        const firstOutcome = manager.ensureAwake("server-1").then(
          () => null,
          (error) => error,
        );
        const joined = manager.ensureAwake("server-1").then(
          () => null,
          (error) => error,
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(deployment.waitForDeploymentReady).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(WAKE_ATTEMPT_DEADLINE_MS);

        // Every caller parked on the wedged attempt is released, not left
        // waiting for a promise that will never settle.
        expect(await firstOutcome).toBeInstanceOf(McpServerWakeError);
        expect(await joined).toBeInstanceOf(McpServerWakeError);
        expect(internals.wakeInFlightByPhysicalKey.size).toBe(0);

        // The next demand starts a NEW attempt instead of queueing behind the
        // wedge — which is the difference between a slow call and a server
        // that can never be woken again this process.
        deployment.waitForDeploymentReady.mockResolvedValue(undefined);
        await manager.ensureAwake("server-1");

        expect(deployment.waitForDeploymentReady).toHaveBeenCalledTimes(2);
        expect(deployment.completeWake).toHaveBeenCalledTimes(1);
        expect(deployment.state).toBe("running");
      } finally {
        vi.useRealTimers();
      }
    });

    test("a cached 'waking' state takes the slow path and resumes the wake", async () => {
      const { manager, internals } = await makeManager();
      // A wake started by another replica (or by a process that died): there
      // is no in-flight promise to join, so a fast return would leave the
      // caller talking to a pod that is not up yet.
      const deployment = makeDeployment({ state: "waking" });
      internals.mcpServerIdToDeploymentMap.set("server-1", deployment);

      await manager.ensureAwake("server-1");

      expect(deployment.refreshState).toHaveBeenCalledTimes(1);
      // Resume, not restart: the deployment is already scaled up.
      expect(deployment.beginWake).not.toHaveBeenCalled();
      expect(deployment.waitForDeploymentReady).toHaveBeenCalledTimes(1);
      expect(deployment.completeWake).toHaveBeenCalledTimes(1);
      expect(deployment.state).toBe("running");
    });

    test("every sibling alias flips to 'waking' as soon as beginWake lands, not only when the wake finishes", async () => {
      const { manager, internals } = await makeManager();
      const depA = makeDeployment({
        mcpServer: { id: "sib-a", name: "shared-server" },
        k8sDeploymentName: "mcp-mt-shared",
        state: "hibernated",
      });
      const depB = makeDeployment({
        mcpServer: { id: "sib-b", name: "shared-server" },
        k8sDeploymentName: "mcp-mt-shared",
        state: "hibernated",
      });
      internals.mcpServerIdToDeploymentMap.set("sib-a", depA);
      internals.mcpServerIdToDeploymentMap.set("sib-b", depB);

      vi.mocked(McpServerModel.findById).mockImplementation(
        async (id) =>
          ({ id, catalogId: "cat-mt" }) as unknown as Awaited<
            ReturnType<typeof McpServerModel.findById>
          >,
      );
      vi.mocked(InternalMcpCatalogModel.findById).mockResolvedValue({
        id: "cat-mt",
        multitenant: true,
      } as unknown as Awaited<
        ReturnType<typeof InternalMcpCatalogModel.findById>
      >);
      vi.mocked(McpServerModel.findByCatalogId).mockResolvedValue([
        { id: "sib-a" },
        { id: "sib-b" },
      ] as unknown as Awaited<
        ReturnType<typeof McpServerModel.findByCatalogId>
      >);

      // Hold the wake open at the readiness wait so the in-between state is
      // observable — that window is exactly what the UI renders.
      let finishReadyWait: () => void = () => {};
      depA.waitForDeploymentReady.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishReadyWait = resolve;
          }),
      );

      const wake = manager.ensureAwake("sib-a");

      await vi.waitFor(() => expect(depA.beginWake).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(depB.state).toBe("waking"));
      expect(depA.state).toBe("waking");

      finishReadyWait();
      await wake;

      expect(depA.state).toBe("running");
      expect(depB.state).toBe("running");
    });

    test("a successful wake stamps the group so the next sweep sees a full idle window", async () => {
      const { manager, internals } = await makeManager();
      const deployment = makeDeployment({
        mcpServer: { id: "sib-a", name: "shared-server" },
        state: "hibernated",
      });
      internals.mcpServerIdToDeploymentMap.set("sib-a", deployment);

      vi.mocked(McpServerModel.findById).mockResolvedValue({
        id: "sib-a",
        catalogId: "cat-mt",
      } as unknown as Awaited<ReturnType<typeof McpServerModel.findById>>);
      vi.mocked(InternalMcpCatalogModel.findById).mockResolvedValue({
        id: "cat-mt",
        multitenant: true,
      } as unknown as Awaited<
        ReturnType<typeof InternalMcpCatalogModel.findById>
      >);
      vi.mocked(McpServerModel.findByCatalogId).mockResolvedValue([
        { id: "sib-a" },
        { id: "sib-b" },
      ] as unknown as Awaited<
        ReturnType<typeof McpServerModel.findByCatalogId>
      >);

      await manager.ensureAwake("sib-a");

      expect(deployment.completeWake).toHaveBeenCalledTimes(1);
      // The woken deployment gets a full idle window: without the stamp, the
      // stale pre-hibernation last_used_at would re-hibernate it on the very
      // next sweep. One stamp is enough for the whole multitenant group —
      // every idle check takes the MAXIMUM last-used across siblings — and
      // stamping each one meant a write per install.
      expect(
        vi.mocked(mcpActiveUseTracker.stamp).mock.calls.map((c) => c[0]),
      ).toEqual(["sib-a"]);
    });

    test("cache-cold wake: a hibernated deployment loaded fresh (state not_created) is still woken from the direct read", async () => {
      const { manager } = await makeManager();
      // Fresh lazy K8sDeployment: cached state "not_created", so refreshState
      // early-returns and says nothing about the cluster.
      const deployment = makeDeployment({ state: "not_created" });
      deployment.readLiveDeployment.mockResolvedValue({
        metadata: { annotations: { "archestra.io/hibernated": "true" } },
        spec: { replicas: 0 },
        status: { availableReplicas: 0 },
      });
      const loadSpy = vi
        .spyOn(manager, "getOrLoadDeployment")
        .mockResolvedValue(
          deployment as unknown as Awaited<
            ReturnType<typeof manager.getOrLoadDeployment>
          >,
        );

      await manager.ensureAwake("cold-1");

      expect(loadSpy).toHaveBeenCalledWith("cold-1");
      expect(deployment.readLiveDeployment).toHaveBeenCalledTimes(1);
      expect(deployment.beginWake).toHaveBeenCalledTimes(1);
      expect(deployment.waitForDeploymentReady).toHaveBeenCalledTimes(1);
      expect(deployment.completeWake).toHaveBeenCalledTimes(1);
    });

    test("an ALREADY-LOADED not_created alias is woken too, not trusted as awake", async () => {
      const { manager, internals } = await makeManager();
      // The difference from the test above is the map: a multitenant sibling
      // holds its own K8sDeployment for the shared pod, and that object sits
      // at "not_created" until something refreshes it. Treating the cached
      // state as proof the deployment was awake made every wake through this
      // alias a permanent no-op — the tool call then hit a pod that was gone.
      const deployment = makeDeployment({ state: "not_created" });
      deployment.readLiveDeployment.mockResolvedValue({
        metadata: { annotations: { "archestra.io/hibernated": "true" } },
        spec: { replicas: 0 },
        status: { availableReplicas: 0 },
      });
      internals.mcpServerIdToDeploymentMap.set("alias-1", deployment);
      const loadSpy = vi.spyOn(manager, "getOrLoadDeployment");

      await manager.ensureAwake("alias-1");

      expect(loadSpy).not.toHaveBeenCalled();
      expect(deployment.beginWake).toHaveBeenCalledTimes(1);
      expect(deployment.completeWake).toHaveBeenCalledTimes(1);
    });

    test("cache-cold read without our annotation is not ours — no wake", async () => {
      const { manager } = await makeManager();
      const deployment = makeDeployment({ state: "not_created" });
      deployment.readLiveDeployment.mockResolvedValue({
        metadata: { annotations: {} },
        spec: { replicas: 0 },
        status: { availableReplicas: 0 },
      });
      vi.spyOn(manager, "getOrLoadDeployment").mockResolvedValue(
        deployment as unknown as Awaited<
          ReturnType<typeof manager.getOrLoadDeployment>
        >,
      );

      await manager.ensureAwake("cold-2");

      expect(deployment.beginWake).not.toHaveBeenCalled();
      expect(deployment.completeWake).not.toHaveBeenCalled();
    });

    test("cache-cold read with the annotation at replicas >= 1 resumes the half-woken wake", async () => {
      const { manager } = await makeManager();
      const deployment = makeDeployment({ state: "not_created" });
      deployment.readLiveDeployment.mockResolvedValue({
        metadata: { annotations: { "archestra.io/hibernated": "true" } },
        spec: { replicas: 1 },
        status: { availableReplicas: 0 },
      });
      vi.spyOn(manager, "getOrLoadDeployment").mockResolvedValue(
        deployment as unknown as Awaited<
          ReturnType<typeof manager.getOrLoadDeployment>
        >,
      );

      await manager.ensureAwake("cold-3");

      // Resume: no second scale-up patch, straight to wait + completeWake.
      expect(deployment.beginWake).not.toHaveBeenCalled();
      expect(deployment.waitForDeploymentReady).toHaveBeenCalledTimes(1);
      expect(deployment.completeWake).toHaveBeenCalledTimes(1);
    });
  });
});
