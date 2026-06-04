import * as fs from "node:fs";
import { PassThrough } from "node:stream";
import * as k8s from "@kubernetes/client-node";
import { vi } from "vitest";
import type * as originalConfigModule from "@/config";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { McpServer } from "@/types";

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
  };
});

// Mock the dependencies before importing the manager
vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof originalConfigModule>();
  return {
    default: {
      ...actual.default,
      orchestrator: {
        kubernetes: {
          namespace: "test-namespace",
          kubeconfig: undefined,
          loadKubeconfigFromCurrentCluster: false,
        },
      },
    },
  };
});

// Track K8sDeployment constructor calls and method invocations
const mockCreateK8sSecret = vi.fn().mockResolvedValue(undefined);
const mockStartOrCreateDeployment = vi.fn().mockResolvedValue(undefined);
const mockCreateDockerRegistrySecrets = vi.fn().mockResolvedValue([]);
const mockDeleteK8sNetworkPolicy = vi.fn().mockResolvedValue(undefined);
const mockResolveHttpEndpoint = vi.fn().mockResolvedValue(undefined);
const mockWaitForDeploymentReady = vi.fn().mockResolvedValue(undefined);
const mockK8sDeploymentInstances: Array<{
  options: Record<string, unknown>;
  createK8sSecret: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("@/models/internal-mcp-catalog", () => ({
  default: {
    findById: vi.fn(),
  },
}));

vi.mock("@/models/mcp-server", () => ({
  default: {
    findById: vi.fn().mockResolvedValue(null),
    findByCatalogId: vi.fn().mockResolvedValue([]),
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

      constructor(options: Record<string, unknown>) {
        this.options = options;
        this.createK8sSecret = mockCreateK8sSecret;
        this.startOrCreateDeployment = mockStartOrCreateDeployment;
        this.createDockerRegistrySecrets = mockCreateDockerRegistrySecrets;
        this.deleteK8sNetworkPolicy = mockDeleteK8sNetworkPolicy;
        this.resolveHttpEndpoint = mockResolveHttpEndpoint;
        this.waitForDeploymentReady = mockWaitForDeploymentReady;
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
      static constructDeploymentName(mcpServer: { name: string }): string {
        return `mcp-${mcpServer.name.replaceAll(" ", "-")}`;
      }
    },
    fetchPlatformPodNodeSelector: vi.fn().mockResolvedValue(undefined),
    fetchPlatformPodTolerations: vi.fn().mockResolvedValue(undefined),
  };
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
        networkPolicyCapabilities: {
          kubernetesNetworkPolicy: true,
          provider: "kubernetes",
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
  });

  describe("startServer - success auto redeploy", () => {
    // Auto redeploy fires when a catalog edit doesn't require new user
    // input — `cascadeReinstallForCatalog → autoReinstallServer →
    // McpServerRuntimeManager.restartServer(id) → startServer(mcpServer)`
    // (manager.ts:558). Crucially, `restartServer` calls `startServer`
    // with NO `environmentValues`, so startServer must reconstruct every
    // previously-supplied env value from persistent state alone.
    //
    // The 10 cases below cover the full env-var matrix:
    //   scope    : static / promptOnInstallation / promptOnPreset
    //   type     : plain_text / secret
    //   required : true / false   (only meaningful for prompted/preset;
    //                              for static the value is admin-set,
    //                              required has no runtime effect)
    //
    // The user report ("Not required prompted envs missing after auto
    // re-install") singled out the optional+plain+prompted cell — but
    // the bug actually drops every plain prompted/preset value
    // regardless of `required`. Per-row tests make it obvious which
    // cells are red without requiring readers to scan a giant diff.
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
      //     secret-typed prompted/preset value (the only thing that
      //     belongs in a Secret object — values referenced by
      //     secretKeyRef from the pod spec).
      //   - catalog row's presetFieldValues (catalogItem mock below)
      //     holds plain preset values (per-catalog source of truth).
      //   - mcp_server row's environmentValues (mcpServer mock below)
      //     holds plain `promptOnInstallation` values (per-install source
      //     of truth).
      const mockGetSecret = vi.fn().mockResolvedValue({
        secret: {
          USER_REQ_SECRET: "user-req-sec-stored",
          USER_OPT_SECRET: "user-opt-sec-stored",
          PRESET_REQ_SECRET: "preset-req-sec-stored",
          PRESET_OPT_SECRET: "preset-opt-sec-stored",
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
            // promptOnPreset × required × type
            {
              key: "PRESET_REQ_SECRET",
              type: "secret",
              promptOnPreset: true,
              required: true,
            },
            {
              key: "PRESET_OPT_SECRET",
              type: "secret",
              promptOnPreset: true,
              required: false,
            },
            {
              key: "PRESET_REQ_PLAIN",
              type: "plain_text",
              promptOnPreset: true,
              required: true,
            },
            {
              key: "PRESET_OPT_PLAIN",
              type: "plain_text",
              promptOnPreset: true,
              required: false,
            },
          ],
        },
        localConfigSecretId: null,
        // Plain preset values live on the catalog row, not the install bag.
        presetFieldValues: {
          PRESET_REQ_PLAIN: "preset-req-plain-stored",
          PRESET_OPT_PLAIN: "preset-opt-plain-stored",
        },
        presetSecretId: null,
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
      key                    | expected                        | via
      ${"STATIC_PLAIN"}      | ${undefined}                    | ${"bypasses env-values; flows via envDef.value"}
      ${"STATIC_SECRET"}     | ${"static-secret-from-catalog"} | ${"catalog static-secret merge (manager.ts:259-277)"}
      ${"USER_REQ_SECRET"}   | ${"user-req-sec-stored"}        | ${"install Secret bag (prompted+secret, required)"}
      ${"USER_OPT_SECRET"}   | ${"user-opt-sec-stored"}        | ${"install Secret bag (prompted+secret, optional)"}
      ${"USER_REQ_PLAIN"}    | ${"user-req-plain-stored"}      | ${"mcp_server.environmentValues overlay"}
      ${"USER_OPT_PLAIN"}    | ${"user-opt-plain-stored"}      | ${"mcp_server.environmentValues overlay"}
      ${"PRESET_REQ_SECRET"} | ${"preset-req-sec-stored"}      | ${"install Secret bag (preset+secret, required)"}
      ${"PRESET_OPT_SECRET"} | ${"preset-opt-sec-stored"}      | ${"install Secret bag (preset+secret, optional)"}
      ${"PRESET_REQ_PLAIN"}  | ${"preset-req-plain-stored"}    | ${"catalog.presetFieldValues overlay"}
      ${"PRESET_OPT_PLAIN"}  | ${"preset-opt-plain-stored"}    | ${"catalog.presetFieldValues overlay"}
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
      ],
    });
    (manager as unknown as { k8sApi: unknown }).k8sApi = {
      listNamespacedSecret: mockListSecrets,
    };

    const result = await manager.listDockerRegistrySecrets({ isAdmin: true });
    expect(result).toEqual([
      { name: "regcred-team-a" },
      { name: "regcred-team-b" },
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
    expect(result).toEqual([{ name: "regcred-team-a" }]);
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
    servers: Array<{ id: string; name: string; catalogId: string }>,
  ) {
    const castServers = servers.map((s) => ({
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
