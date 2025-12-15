import * as fs from "node:fs";
import * as k8s from "@kubernetes/client-node";
import { vi } from "vitest";
import type * as originalConfigModule from "@/config";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { InternalMcpCatalogModel, McpServerModel } from "@/models";
import { secretManager } from "@/secretsmanager";
import K8sPod from "./k8s-pod";
import type { McpServer } from "@/types";
import { PassThrough } from "node:stream";

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
    Attach: vi.fn(),
    Log: vi.fn(),
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

vi.mock("@/models", () => ({
  InternalMcpCatalogModel: {
    findById: vi.fn(),
  },
  McpServerModel: {
    findAll: vi.fn(),
    findById: vi.fn(),
  },
}));

vi.mock("@/secretsmanager", () => ({
  secretManager: {
    getSecret: vi.fn(),
  },
}));

vi.mock("./k8s-pod", () => ({
  default: vi.fn(),
}));

describe("validateKubeconfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("should not throw when no path provided", async () => {
    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig(undefined)).not.toThrow();
  });

  test("should throw error when kubeconfig file does not exist", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("/nonexistent/path")).toThrow(
      /❌ Kubeconfig file not found/,
    );
  });

  test("should throw error when kubeconfig file cannot be parsed", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("invalid yaml content");
    const { validateKubeconfig } = await import("./manager");
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
    const { validateKubeconfig } = await import("./manager");
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
    const { validateKubeconfig } = await import("./manager");
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
    const { validateKubeconfig } = await import("./manager");
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
    const { validateKubeconfig } = await import("./manager");
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
    const { validateKubeconfig } = await import("./manager");
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
    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("/path")).not.toThrow();
  });
});

// --- McpServerRuntimeManager suite
describe("McpServerRuntimeManager", () => {
  describe("isEnabled", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
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

  describe("start", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
    });

    test("should throw error when k8sApi is not initialized", async () => {
      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {
          throw new Error("Failed to load");
        });

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      await expect(manager.start()).rejects.toThrow(
        "Kubernetes API client not initialized",
      );

      mockLoadFromDefault.mockRestore();
    });

    test("should initialize runtime and start all local servers", async () => {
      const mockListPods = vi.fn().mockResolvedValue({ body: { items: [] } });
      const mockK8sApi = {
        listNamespacedPod: mockListPods,
      } as unknown as k8s.CoreV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return {} as k8s.AppsV1Api;
        });

      const mockMcpServer: McpServer = {
        id: "test-server-id",
        name: "test-server",
        catalogId: "catalog-id",
        serverType: "local",
        secretId: null,
        ownerId: null,
        reinstallRequired: false,
        localInstallationStatus: "idle",
        localInstallationError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      const mockCatalogItem = {
        id: "catalog-id",
        serverType: "local",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
        },
      };

      vi.mocked(McpServerModel.findAll).mockResolvedValue([mockMcpServer]);
      vi.mocked(InternalMcpCatalogModel.findById).mockResolvedValue(
        mockCatalogItem as any,
      );

      const mockK8sPodInstance = {
        startOrCreatePod: vi.fn().mockResolvedValue(undefined),
        statusSummary: {
          state: "running",
          message: "Pod is running",
        },
      };

      vi.mocked(K8sPod).mockImplementation(() => mockK8sPodInstance as any);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      await manager.start();

      expect(mockListPods).toHaveBeenCalledWith({ namespace: "test-namespace" });
      expect(McpServerModel.findAll).toHaveBeenCalled();
      expect(InternalMcpCatalogModel.findById).toHaveBeenCalledWith(
        "catalog-id",
      );
      expect(mockK8sPodInstance.startOrCreatePod).toHaveBeenCalled();

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });

    test("should handle server start failures gracefully", async () => {
      const mockListPods = vi.fn().mockResolvedValue({ body: { items: [] } });
      const mockK8sApi = {
        listNamespacedPod: mockListPods,
      } as unknown as k8s.CoreV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return {} as k8s.AppsV1Api;
        });

      const mockMcpServer: McpServer = {
        id: "test-server-id",
        name: "test-server",
        catalogId: "catalog-id",
        serverType: "local",
        secretId: null,
        ownerId: null,
        reinstallRequired: false,
        localInstallationStatus: "idle",
        localInstallationError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      const mockCatalogItem = {
        id: "catalog-id",
        serverType: "local",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
        },
      };

      vi.mocked(McpServerModel.findAll).mockResolvedValue([mockMcpServer]);
      vi.mocked(InternalMcpCatalogModel.findById).mockResolvedValue(
        mockCatalogItem as any,
      );

      const mockK8sPodInstance = {
        startOrCreatePod: vi
          .fn()
          .mockRejectedValue(new Error("Failed to start pod")),
        statusSummary: {
          state: "failed",
          message: "Pod failed",
        },
      };

      vi.mocked(K8sPod).mockImplementation(() => mockK8sPodInstance as any);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      // Should not throw - failures are handled gracefully
      await manager.start();

      expect(mockK8sPodInstance.startOrCreatePod).toHaveBeenCalled();

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });

    test("should filter out remote servers", async () => {
      const mockListPods = vi.fn().mockResolvedValue({ body: { items: [] } });
      const mockK8sApi = {
        listNamespacedPod: mockListPods,
      } as unknown as k8s.CoreV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return {} as k8s.AppsV1Api;
        });

      const localServer: McpServer = {
        id: "local-server-id",
        name: "local-server",
        catalogId: "local-catalog-id",
        serverType: "local",
        secretId: null,
        ownerId: null,
        reinstallRequired: false,
        localInstallationStatus: "idle",
        localInstallationError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      const remoteServer: McpServer = {
        id: "remote-server-id",
        name: "remote-server",
        catalogId: "remote-catalog-id",
        serverType: "remote",
        secretId: null,
        ownerId: null,
        reinstallRequired: false,
        localInstallationStatus: "idle",
        localInstallationError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      vi.mocked(McpServerModel.findAll).mockResolvedValue([
        localServer,
        remoteServer,
      ]);
      vi.mocked(InternalMcpCatalogModel.findById).mockImplementation(
        async (id) => {
          if (id === "local-catalog-id") {
            return {
              id: "local-catalog-id",
              serverType: "local",
              localConfig: { command: "node" },
            } as any;
          }
          if (id === "remote-catalog-id") {
            return {
              id: "remote-catalog-id",
              serverType: "remote",
              localConfig: { command: "node" },
            } as any;
          }
          return null;
        },
      );

      const mockK8sPodInstance = {
        startOrCreatePod: vi.fn().mockResolvedValue(undefined),
        statusSummary: {
          state: "running",
          message: "Pod is running",
        },
      };

      vi.mocked(K8sPod).mockImplementation(() => mockK8sPodInstance as any);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      await manager.start();

      // Should only start local server
      expect(mockK8sPodInstance.startOrCreatePod).toHaveBeenCalledTimes(1);

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });
  });

  describe("startServer", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
    });

    test("should throw error when k8sApi is not initialized", async () => {
      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {
          throw new Error("Failed to load");
        });

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      const mockMcpServer: McpServer = {
        id: "test-server-id",
        name: "test-server",
        catalogId: null,
        secretId: null,
        ownerId: null,
        teamId: null,
        serverType: "local",
        reinstallRequired: false,
        localInstallationStatus: "idle",
        localInstallationError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      await expect(manager.startServer(mockMcpServer)).rejects.toThrow(
        "Kubernetes API client not initialized",
      );

      mockLoadFromDefault.mockRestore();
    });

    test("should start server and create K8s Secret if secretId exists", async () => {
      const mockK8sApi = {} as k8s.CoreV1Api;
      const mockK8sAppsApi = {} as k8s.AppsV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return mockK8sAppsApi;
        });

      const mockMcpServer: McpServer = {
        id: "test-server-id",
        name: "test-server",
        catalogId: "catalog-id",
        secretId: "secret-id",
        ownerId: null,
        reinstallRequired: false,
        localInstallationStatus: "idle",
        localInstallationError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      const mockCatalogItem = {
        id: "catalog-id",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
        },
      };

      vi.mocked(InternalMcpCatalogModel.findById).mockResolvedValue(
        mockCatalogItem as any,
      );

      const mockSecret = {
        secret: {
          API_KEY: "secret-value",
          DATABASE_URL: "postgres://localhost",
        },
      };

      vi.mocked(secretManager.getSecret).mockResolvedValue(mockSecret as any);

      const mockCreateK8sSecret = vi.fn().mockResolvedValue(undefined);
      const mockStartOrCreatePod = vi.fn().mockResolvedValue(undefined);

      const mockK8sPodInstance = {
        createK8sSecret: mockCreateK8sSecret,
        startOrCreatePod: mockStartOrCreatePod,
        statusSummary: {
          state: "running",
          message: "Pod is running",
        },
      };

      vi.mocked(K8sPod).mockImplementation(() => mockK8sPodInstance as any);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      await manager.startServer(mockMcpServer);

      expect(secretManager.getSecret).toHaveBeenCalledWith("secret-id");
      expect(mockCreateK8sSecret).toHaveBeenCalledWith({
        API_KEY: "secret-value",
        DATABASE_URL: "postgres://localhost",
      });
      expect(mockStartOrCreatePod).toHaveBeenCalled();

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });

    test("should register pod in map before starting", async () => {
      const mockK8sApi = {} as k8s.CoreV1Api;
      const mockK8sAppsApi = {} as k8s.AppsV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return mockK8sAppsApi;
        });

      const mockMcpServer: McpServer = {
        id: "test-server-id",
        name: "test-server",
        catalogId: null,
        secretId: null,
        ownerId: null,
        teamId: null,
        serverType: "local",
        reinstallRequired: false,
        localInstallationStatus: "idle",
        localInstallationError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      const mockStartOrCreatePod = vi.fn().mockResolvedValue(undefined);

      const mockK8sPodInstance = {
        startOrCreatePod: mockStartOrCreatePod,
        statusSummary: {
          state: "running",
          message: "Pod is running",
        },
      };

      vi.mocked(K8sPod).mockImplementation(() => mockK8sPodInstance as any);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      await manager.startServer(mockMcpServer);

      // Pod should be registered in map
      const pod = manager.getPod("test-server-id");
      expect(pod).toBeDefined();

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });
  });

  describe("stopServer", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
    });

    test("should stop server and delete from map", async () => {
      const mockK8sApi = {} as k8s.CoreV1Api;
      const mockK8sAppsApi = {} as k8s.AppsV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return mockK8sAppsApi;
        });

      const mockStopPod = vi.fn().mockResolvedValue(undefined);
      const mockDeleteK8sSecret = vi.fn().mockResolvedValue(undefined);

      const mockK8sPodInstance = {
        stopPod: mockStopPod,
        deleteK8sSecret: mockDeleteK8sSecret,
        statusSummary: {
          state: "not_created",
          message: "Pod not created",
        },
      };

      vi.mocked(K8sPod).mockImplementation(() => mockK8sPodInstance as any);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      const mockMcpServer: McpServer = {
        id: "test-server-id",
        name: "test-server",
        catalogId: null,
        secretId: null,
        ownerId: null,
        teamId: null,
        serverType: "local",
        reinstallRequired: false,
        localInstallationStatus: "idle",
        localInstallationError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      await manager.startServer(mockMcpServer);
      await manager.stopServer("test-server-id");

      expect(mockStopPod).toHaveBeenCalled();
      expect(mockDeleteK8sSecret).toHaveBeenCalled();
      expect(manager.getPod("test-server-id")).toBeUndefined();

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });

    test("should handle missing pod gracefully", async () => {
      const mockK8sApi = {} as k8s.CoreV1Api;
      const mockK8sAppsApi = {} as k8s.AppsV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return mockK8sAppsApi;
        });

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      // Should not throw when pod doesn't exist
      await expect(manager.stopServer("non-existent-id")).resolves.not.toThrow();

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });
  });

  describe("getPod", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
    });

    test("should return pod when it exists", async () => {
      const mockK8sApi = {} as k8s.CoreV1Api;
      const mockK8sAppsApi = {} as k8s.AppsV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return mockK8sAppsApi;
        });

      const mockK8sPodInstance = {
        startOrCreatePod: vi.fn().mockResolvedValue(undefined),
        statusSummary: {
          state: "running",
          message: "Pod is running",
        },
      };

      vi.mocked(K8sPod).mockImplementation(() => mockK8sPodInstance as any);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      const mockMcpServer: McpServer = {
        id: "test-server-id",
        name: "test-server",
        catalogId: null,
        secretId: null,
        ownerId: null,
        teamId: null,
        serverType: "local",
        reinstallRequired: false,
        localInstallationStatus: "idle",
        localInstallationError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      await manager.startServer(mockMcpServer);

      const pod = manager.getPod("test-server-id");
      expect(pod).toBeDefined();
      expect(pod).toBe(mockK8sPodInstance);

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });

    test("should return undefined when pod does not exist", async () => {
      const mockK8sApi = {} as k8s.CoreV1Api;
      const mockK8sAppsApi = {} as k8s.AppsV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return mockK8sAppsApi;
        });

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      const pod = manager.getPod("non-existent-id");
      expect(pod).toBeUndefined();

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });
  });

  describe("removeMcpServer", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
    });

    test("should remove server pod and delete from map", async () => {
      const mockK8sApi = {} as k8s.CoreV1Api;
      const mockK8sAppsApi = {} as k8s.AppsV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return mockK8sAppsApi;
        });

      const mockRemovePod = vi.fn().mockResolvedValue(undefined);

      const mockK8sPodInstance = {
        startOrCreatePod: vi.fn().mockResolvedValue(undefined),
        removePod: mockRemovePod,
        statusSummary: {
          state: "not_created",
          message: "Pod not created",
        },
      };

      vi.mocked(K8sPod).mockImplementation(() => mockK8sPodInstance as any);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      const mockMcpServer: McpServer = {
        id: "test-server-id",
        name: "test-server",
        catalogId: null,
        secretId: null,
        ownerId: null,
        teamId: null,
        serverType: "local",
        reinstallRequired: false,
        localInstallationStatus: "idle",
        localInstallationError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      await manager.startServer(mockMcpServer);
      await manager.removeMcpServer("test-server-id");

      expect(mockRemovePod).toHaveBeenCalled();
      expect(manager.getPod("test-server-id")).toBeUndefined();

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });

    test("should handle missing pod gracefully", async () => {
      const mockK8sApi = {} as k8s.CoreV1Api;
      const mockK8sAppsApi = {} as k8s.AppsV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return mockK8sAppsApi;
        });

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      // Should not throw when pod doesn't exist
      await expect(
        manager.removeMcpServer("non-existent-id"),
      ).resolves.not.toThrow();

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });
  });

  describe("restartServer", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    test("should restart server by stopping and starting again", async () => {
      const mockK8sApi = {} as k8s.CoreV1Api;
      const mockK8sAppsApi = {} as k8s.AppsV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return mockK8sAppsApi;
        });

      const mockMcpServer: McpServer = {
        id: "test-server-id",
        name: "test-server",
        catalogId: null,
        secretId: null,
        ownerId: null,
        teamId: null,
        serverType: "local",
        reinstallRequired: false,
        localInstallationStatus: "idle",
        localInstallationError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      vi.mocked(McpServerModel.findById).mockResolvedValue(mockMcpServer);

      const mockStopPod = vi.fn().mockResolvedValue(undefined);
      const mockDeleteK8sSecret = vi.fn().mockResolvedValue(undefined);
      const mockStartOrCreatePod = vi.fn().mockResolvedValue(undefined);

      const mockK8sPodInstance = {
        startOrCreatePod: mockStartOrCreatePod,
        stopPod: mockStopPod,
        deleteK8sSecret: mockDeleteK8sSecret,
        statusSummary: {
          state: "running",
          message: "Pod is running",
        },
      };

      vi.mocked(K8sPod).mockImplementation(() => mockK8sPodInstance as any);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      await manager.startServer(mockMcpServer);
      await manager.restartServer("test-server-id");

      expect(mockStopPod).toHaveBeenCalled();
      expect(mockDeleteK8sSecret).toHaveBeenCalled();
      expect(mockStartOrCreatePod).toHaveBeenCalledTimes(2); // Once for start, once for restart

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });

    test("should throw error when server not found in database", async () => {
      const mockK8sApi = {} as k8s.CoreV1Api;
      const mockK8sAppsApi = {} as k8s.AppsV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return mockK8sAppsApi;
        });

      vi.mocked(McpServerModel.findById).mockResolvedValue(null);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      await expect(manager.restartServer("non-existent-id")).rejects.toThrow(
        "MCP server with id non-existent-id not found",
      );

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });
  });

  describe("usesStreamableHttp", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
    });

    test("should return true when server uses streamable HTTP", async () => {
      const mockK8sApi = {} as k8s.CoreV1Api;
      const mockK8sAppsApi = {} as k8s.AppsV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return mockK8sAppsApi;
        });

      const mockUsesStreamableHttp = vi.fn().mockResolvedValue(true);

      const mockK8sPodInstance = {
        startOrCreatePod: vi.fn().mockResolvedValue(undefined),
        usesStreamableHttp: mockUsesStreamableHttp,
        statusSummary: {
          state: "running",
          message: "Pod is running",
        },
      };

      vi.mocked(K8sPod).mockImplementation(() => mockK8sPodInstance as any);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      const mockMcpServer: McpServer = {
        id: "test-server-id",
        name: "test-server",
        catalogId: null,
        secretId: null,
        ownerId: null,
        teamId: null,
        serverType: "local",
        reinstallRequired: false,
        localInstallationStatus: "idle",
        localInstallationError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      await manager.startServer(mockMcpServer);

      const result = await manager.usesStreamableHttp("test-server-id");
      expect(result).toBe(true);
      expect(mockUsesStreamableHttp).toHaveBeenCalled();

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });

    test("should return false when pod does not exist", async () => {
      const mockK8sApi = {} as k8s.CoreV1Api;
      const mockK8sAppsApi = {} as k8s.AppsV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return mockK8sAppsApi;
        });

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      const result = await manager.usesStreamableHttp("non-existent-id");
      expect(result).toBe(false);

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });
  });

  describe("getHttpEndpointUrl", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
    });

    test("should return HTTP endpoint URL when available", async () => {
      const mockK8sApi = {} as k8s.CoreV1Api;
      const mockK8sAppsApi = {} as k8s.AppsV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return mockK8sAppsApi;
        });

      const mockK8sPodInstance = {
        startOrCreatePod: vi.fn().mockResolvedValue(undefined),
        getHttpEndpointUrl: vi.fn().mockReturnValue("http://localhost:3000/mcp"),
        statusSummary: {
          state: "running",
          message: "Pod is running",
        },
      };

      vi.mocked(K8sPod).mockImplementation(() => mockK8sPodInstance as any);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      const mockMcpServer: McpServer = {
        id: "test-server-id",
        name: "test-server",
        catalogId: null,
        secretId: null,
        ownerId: null,
        teamId: null,
        serverType: "local",
        reinstallRequired: false,
        localInstallationStatus: "idle",
        localInstallationError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      await manager.startServer(mockMcpServer);

      const url = manager.getHttpEndpointUrl("test-server-id");
      expect(url).toBe("http://localhost:3000/mcp");

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });

    test("should return undefined when pod does not exist", async () => {
      const mockK8sApi = {} as k8s.CoreV1Api;
      const mockK8sAppsApi = {} as k8s.AppsV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return mockK8sAppsApi;
        });

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      const url = manager.getHttpEndpointUrl("non-existent-id");
      expect(url).toBeUndefined();

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });
  });

  describe("getMcpServerLogs", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
    });

    test("should return logs from pod", async () => {
      const mockK8sApi = {} as k8s.CoreV1Api;
      const mockK8sAppsApi = {} as k8s.AppsV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return mockK8sAppsApi;
        });

      const mockGetRecentLogs = vi
        .fn()
        .mockResolvedValue("log line 1\nlog line 2\nlog line 3");

      const mockK8sPodInstance = {
        startOrCreatePod: vi.fn().mockResolvedValue(undefined),
        getRecentLogs: mockGetRecentLogs,
        containerName: "mcp-test-server",
        statusSummary: {
          state: "running",
          message: "Pod is running",
        },
      };

      vi.mocked(K8sPod).mockImplementation(() => mockK8sPodInstance as any);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      const mockMcpServer: McpServer = {
        id: "test-server-id",
        name: "test-server",
        catalogId: null,
        secretId: null,
        ownerId: null,
        teamId: null,
        serverType: "local",
        reinstallRequired: false,
        localInstallationStatus: "idle",
        localInstallationError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      await manager.startServer(mockMcpServer);

      const logs = await manager.getMcpServerLogs("test-server-id", 50);

      expect(logs.logs).toBe("log line 1\nlog line 2\nlog line 3");
      expect(logs.containerName).toBe("mcp-test-server");
      expect(logs.namespace).toBe("test-namespace");
      expect(logs.command).toBe(
        "kubectl logs -n test-namespace mcp-test-server --tail=50",
      );
      expect(mockGetRecentLogs).toHaveBeenCalledWith(50);

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });

    test("should throw error when pod does not exist", async () => {
      const mockK8sApi = {} as k8s.CoreV1Api;
      const mockK8sAppsApi = {} as k8s.AppsV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return mockK8sAppsApi;
        });

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      await expect(
        manager.getMcpServerLogs("non-existent-id"),
      ).rejects.toThrow("Pod not found for MCP server non-existent-id");

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });
  });

  describe("streamMcpServerLogs", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
    });

    test("should stream logs from pod", async () => {
      const mockK8sApi = {} as k8s.CoreV1Api;
      const mockK8sAppsApi = {} as k8s.AppsV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return mockK8sAppsApi;
        });

      const mockStreamLogs = vi.fn().mockResolvedValue(undefined);

      const mockK8sPodInstance = {
        startOrCreatePod: vi.fn().mockResolvedValue(undefined),
        streamLogs: mockStreamLogs,
        statusSummary: {
          state: "running",
          message: "Pod is running",
        },
      };

      vi.mocked(K8sPod).mockImplementation(() => mockK8sPodInstance as any);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      const mockMcpServer: McpServer = {
        id: "test-server-id",
        name: "test-server",
        catalogId: null,
        secretId: null,
        ownerId: null,
        teamId: null,
        serverType: "local",
        reinstallRequired: false,
        localInstallationStatus: "idle",
        localInstallationError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      await manager.startServer(mockMcpServer);

      const responseStream = new PassThrough();
      await manager.streamMcpServerLogs("test-server-id", responseStream, 100);

      expect(mockStreamLogs).toHaveBeenCalledWith(responseStream, 100);

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });

    test("should throw error when pod does not exist", async () => {
      const mockK8sApi = {} as k8s.CoreV1Api;
      const mockK8sAppsApi = {} as k8s.AppsV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return mockK8sAppsApi;
        });

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      const responseStream = new PassThrough();

      await expect(
        manager.streamMcpServerLogs("non-existent-id", responseStream),
      ).rejects.toThrow("Pod not found for MCP server non-existent-id");

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });
  });

  describe("statusSummary", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
    });

    test("should return status summary with all pods", async () => {
      const mockK8sApi = {} as k8s.CoreV1Api;
      const mockK8sAppsApi = {} as k8s.AppsV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return mockK8sAppsApi;
        });

      const mockK8sPodInstance1 = {
        startOrCreatePod: vi.fn().mockResolvedValue(undefined),
        statusSummary: {
          state: "running",
          message: "Pod is running",
          podName: "mcp-server-1",
          namespace: "test-namespace",
        },
      };

      const mockK8sPodInstance2 = {
        startOrCreatePod: vi.fn().mockResolvedValue(undefined),
        statusSummary: {
          state: "pending",
          message: "Pod is starting",
          podName: "mcp-server-2",
          namespace: "test-namespace",
        },
      };

      let callCount = 0;
      vi.mocked(K8sPod).mockImplementation(() => {
        callCount++;
        return (callCount === 1
          ? mockK8sPodInstance1
          : mockK8sPodInstance2) as any;
      });

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      const mockMcpServer1: McpServer = {
        id: "server-1",
        name: "server-1",
        catalogId: null,
        secretId: null,
        ownerId: null,
        reinstallRequired: false,
        localInstallationStatus: "idle",
        localInstallationError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      const mockMcpServer2: McpServer = {
        id: "server-2",
        name: "server-2",
        catalogId: null,
        secretId: null,
        ownerId: null,
        reinstallRequired: false,
        localInstallationStatus: "idle",
        localInstallationError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      await manager.startServer(mockMcpServer1);
      await manager.startServer(mockMcpServer2);

      const summary = manager.statusSummary;

      expect(summary.status).toBe("running");
      expect(summary.mcpServers).toHaveProperty("server-1");
      expect(summary.mcpServers).toHaveProperty("server-2");
      expect(summary.mcpServers["server-1"]).toEqual(
        mockK8sPodInstance1.statusSummary,
      );
      expect(summary.mcpServers["server-2"]).toEqual(
        mockK8sPodInstance2.statusSummary,
      );

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });
  });

  describe("shutdown", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
    });

    test("should stop all pods and set status to stopped", async () => {
      const mockK8sApi = {} as k8s.CoreV1Api;
      const mockK8sAppsApi = {} as k8s.AppsV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return mockK8sAppsApi;
        });

      const mockStopPod = vi.fn().mockResolvedValue(undefined);
      const mockDeleteK8sSecret = vi.fn().mockResolvedValue(undefined);

      const mockK8sPodInstance1 = {
        startOrCreatePod: vi.fn().mockResolvedValue(undefined),
        stopPod: mockStopPod,
        deleteK8sSecret: mockDeleteK8sSecret,
        statusSummary: {
          state: "running",
          message: "Pod is running",
        },
      };

      const mockK8sPodInstance2 = {
        startOrCreatePod: vi.fn().mockResolvedValue(undefined),
        stopPod: mockStopPod,
        deleteK8sSecret: mockDeleteK8sSecret,
        statusSummary: {
          state: "running",
          message: "Pod is running",
        },
      };

      let callCount = 0;
      vi.mocked(K8sPod).mockImplementation(() => {
        callCount++;
        return (callCount === 1
          ? mockK8sPodInstance1
          : mockK8sPodInstance2) as any;
      });

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      const mockMcpServer1: McpServer = {
        id: "server-1",
        name: "server-1",
        catalogId: null,
        secretId: null,
        ownerId: null,
        reinstallRequired: false,
        localInstallationStatus: "idle",
        localInstallationError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      const mockMcpServer2: McpServer = {
        id: "server-2",
        name: "server-2",
        catalogId: null,
        secretId: null,
        ownerId: null,
        reinstallRequired: false,
        localInstallationStatus: "idle",
        localInstallationError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      await manager.startServer(mockMcpServer1);
      await manager.startServer(mockMcpServer2);

      await manager.shutdown();

      expect(manager.isEnabled).toBe(false);
      expect(mockStopPod).toHaveBeenCalledTimes(2);
      expect(mockDeleteK8sSecret).toHaveBeenCalledTimes(2);

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });

    test("should handle stop failures gracefully", async () => {
      const mockK8sApi = {} as k8s.CoreV1Api;
      const mockK8sAppsApi = {} as k8s.AppsV1Api;

      const mockLoadFromDefault = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromDefault")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockImplementation((apiType) => {
          if (apiType === k8s.CoreV1Api) {
            return mockK8sApi;
          }
          return mockK8sAppsApi;
        });

      const mockStopPod = vi
        .fn()
        .mockRejectedValue(new Error("Failed to stop pod"));
      const mockDeleteK8sSecret = vi.fn().mockResolvedValue(undefined);

      const mockK8sPodInstance = {
        startOrCreatePod: vi.fn().mockResolvedValue(undefined),
        stopPod: mockStopPod,
        deleteK8sSecret: mockDeleteK8sSecret,
        statusSummary: {
          state: "running",
          message: "Pod is running",
        },
      };

      vi.mocked(K8sPod).mockImplementation(() => mockK8sPodInstance as any);

      const { McpServerRuntimeManager } = await import("./manager");
      const manager = new McpServerRuntimeManager();

      const mockMcpServer: McpServer = {
        id: "test-server-id",
        name: "test-server",
        catalogId: null,
        secretId: null,
        ownerId: null,
        teamId: null,
        serverType: "local",
        reinstallRequired: false,
        localInstallationStatus: "idle",
        localInstallationError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      await manager.startServer(mockMcpServer);

      // Should not throw even if stop fails
      await expect(manager.shutdown()).resolves.not.toThrow();

      expect(manager.isEnabled).toBe(false);

      mockLoadFromDefault.mockRestore();
      mockMakeApiClient.mockRestore();
    });
  });
});
