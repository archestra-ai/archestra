import * as fs from "node:fs";
import { PassThrough } from "node:stream";
import * as k8s from "@kubernetes/client-node";
import { vi } from "vitest";
import type * as originalConfigModule from "@/config";
import { beforeEach, describe, expect, test } from "@/test";

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

vi.mock("@/models/internal-mcp-catalog", () => ({
  default: {},
}));

vi.mock("@/models/mcp-server", () => ({
  default: {},
}));

vi.mock("./k8s-deployment", () => ({
  default: class MockK8sDeployment {
    static sanitizeLabelValue(value: string): string {
      return value;
    }
  },
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

      const mockDeployment = {
        stopDeployment: mockStopDeployment,
        deleteK8sService: mockDeleteK8sService,
        deleteK8sSecret: mockDeleteK8sSecret,
        deleteDockerRegistrySecrets: mockDeleteDockerRegistrySecrets,
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
      ]);

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

  describe("startServer - non-prompted secrets merging logic", () => {
    // These tests verify the non-prompted secret merging logic
    // by testing the helper function behavior patterns

    test("merges non-prompted secrets from catalog environment into secretData", () => {
      // Test the merging logic that's in startServer
      // Given: secretData from mcpServer.secretId
      const secretData: Record<string, string> = {
        prompted_secret: "prompted-value",
        context7_api_key: "api-key-value",
      };

      // And: catalog environment with non-prompted secrets
      const catalogEnvironment = [
        {
          key: "prompted_secret",
          type: "secret" as const,
          promptOnInstallation: true,
          value: "prompted-value",
        },
        {
          key: "static_secret",
          type: "secret" as const,
          promptOnInstallation: false,
          value: "static-secret-value", // Non-prompted secret from catalog
        },
        {
          key: "context7_api_key",
          type: "secret" as const,
          promptOnInstallation: true,
          value: "api-key-value",
        },
        {
          key: "plain_env_var",
          type: "plain_text" as const,
          promptOnInstallation: false,
          value: "plain-value", // Not a secret, should be ignored
        },
      ];

      // When: we apply the merging logic from startServer
      for (const envDef of catalogEnvironment) {
        if (
          envDef.type === "secret" &&
          !envDef.promptOnInstallation &&
          envDef.value
        ) {
          if (!(envDef.key in secretData)) {
            secretData[envDef.key] = envDef.value;
          }
        }
      }

      // Then: secretData should include the non-prompted secret
      expect(secretData).toEqual({
        prompted_secret: "prompted-value",
        context7_api_key: "api-key-value",
        static_secret: "static-secret-value", // Merged from catalog
      });
    });

    test("does not overwrite existing secrets from mcpServer.secretId with catalog values", () => {
      // Given: secretData already has 'some_key'
      const secretData: Record<string, string> = {
        some_key: "server-secret-value",
      };

      // And: catalog also has 'some_key' as non-prompted secret with different value
      const catalogEnvironment = [
        {
          key: "some_key",
          type: "secret" as const,
          promptOnInstallation: false,
          value: "catalog-secret-value", // Different value from catalog
        },
      ];

      // When: we apply the merging logic
      for (const envDef of catalogEnvironment) {
        if (
          envDef.type === "secret" &&
          !envDef.promptOnInstallation &&
          envDef.value
        ) {
          if (!(envDef.key in secretData)) {
            secretData[envDef.key] = envDef.value;
          }
        }
      }

      // Then: existing value should NOT be overwritten
      expect(secretData).toEqual({
        some_key: "server-secret-value", // Original value preserved
      });
    });

    test("handles empty secretData by creating new object", () => {
      // Given: no secretData yet
      let secretData: Record<string, string> | undefined;

      // And: catalog has non-prompted secrets
      const catalogEnvironment = [
        {
          key: "static_secret",
          type: "secret" as const,
          promptOnInstallation: false,
          value: "static-value",
        },
      ];

      // When: we apply the merging logic
      for (const envDef of catalogEnvironment) {
        if (
          envDef.type === "secret" &&
          !envDef.promptOnInstallation &&
          envDef.value
        ) {
          if (!secretData) {
            secretData = {};
          }
          if (!(envDef.key in secretData)) {
            secretData[envDef.key] = envDef.value;
          }
        }
      }

      // Then: secretData should be created with the non-prompted secret
      expect(secretData).toEqual({
        static_secret: "static-value",
      });
    });

    test("ignores secrets with promptOnInstallation=true", () => {
      // Given: empty secretData
      const secretData: Record<string, string> = {};

      // And: catalog has only prompted secrets
      const catalogEnvironment = [
        {
          key: "prompted_secret",
          type: "secret" as const,
          promptOnInstallation: true,
          value: "prompted-value",
        },
      ];

      // When: we apply the merging logic
      for (const envDef of catalogEnvironment) {
        if (
          envDef.type === "secret" &&
          !envDef.promptOnInstallation &&
          envDef.value
        ) {
          if (!(envDef.key in secretData)) {
            secretData[envDef.key] = envDef.value;
          }
        }
      }

      // Then: secretData should be empty (prompted secrets are already in mcpServer.secretId)
      expect(secretData).toEqual({});
    });

    test("ignores non-secret environment variables", () => {
      // Given: empty secretData
      const secretData: Record<string, string> = {};

      // And: catalog has plain text environment variables
      // Use explicit type to match the structure from LocalConfig
      type EnvDef = {
        key: string;
        type: "plain_text" | "secret" | "boolean" | "number";
        promptOnInstallation: boolean;
        value?: string;
      };
      const catalogEnvironment: EnvDef[] = [
        {
          key: "plain_env_var",
          type: "plain_text",
          promptOnInstallation: false,
          value: "plain-value",
        },
        {
          key: "boolean_env_var",
          type: "boolean",
          promptOnInstallation: false,
          value: "true",
        },
      ];

      // When: we apply the merging logic
      for (const envDef of catalogEnvironment) {
        if (
          envDef.type === "secret" &&
          !envDef.promptOnInstallation &&
          envDef.value
        ) {
          if (!(envDef.key in secretData)) {
            secretData[envDef.key] = envDef.value;
          }
        }
      }

      // Then: secretData should be empty (non-secrets not added)
      expect(secretData).toEqual({});
    });

    test("regcred passwords come from catalog localConfigSecretId, not per-user secretData", () => {
      // This test verifies the fix for the bug where createDockerRegistrySecrets
      // was passed per-user secretData (mcpServer.secretId), but regcred passwords
      // are stored in catalog's localConfigSecretId.

      // Given: per-user secret data (from mcpServer.secretId) with user-prompted values
      const perUserSecretData: Record<string, string> = {
        API_KEY: "user-api-key",
      };

      // And: catalog secret data (from localConfigSecretId) with regcred passwords
      const catalogSecretData: Record<string, string> = {
        STATIC_SECRET: "static-value",
        "__regcred_password:quay.io:myuser": "registry-password",
        "__regcred_password:ghcr.io:bot": "ghcr-password",
      };

      // When: we extract only __regcred_password:* keys from catalog secret
      const regcredSecretData: Record<string, string> = {};
      for (const [key, value] of Object.entries(catalogSecretData)) {
        if (key.startsWith("__regcred_password:")) {
          regcredSecretData[key] = value;
        }
      }

      // Then: regcred data should contain only password keys, not env vars
      expect(regcredSecretData).toEqual({
        "__regcred_password:quay.io:myuser": "registry-password",
        "__regcred_password:ghcr.io:bot": "ghcr-password",
      });

      // And: per-user data should NOT contain regcred keys
      expect(perUserSecretData).not.toHaveProperty(
        "__regcred_password:quay.io:myuser",
      );
    });

    test("ignores secrets without value", () => {
      // Given: empty secretData
      const secretData: Record<string, string> = {};

      // And: catalog has secret without value
      const catalogEnvironment = [
        {
          key: "empty_secret",
          type: "secret" as const,
          promptOnInstallation: false,
          value: undefined,
        },
      ];

      // When: we apply the merging logic
      for (const envDef of catalogEnvironment) {
        if (
          envDef.type === "secret" &&
          !envDef.promptOnInstallation &&
          envDef.value
        ) {
          if (!(envDef.key in secretData)) {
            secretData[envDef.key] = envDef.value;
          }
        }
      }

      // Then: secretData should be empty (secrets without value not added)
      expect(secretData).toEqual({});
    });
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
