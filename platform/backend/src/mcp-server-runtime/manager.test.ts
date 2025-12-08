import * as k8s from "@kubernetes/client-node";
import { vi } from "vitest";
import type * as originalConfigModule from "@/config";
import { beforeEach, describe, expect, test } from "@/test";

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

vi.mock("./k8s-pod", () => ({
  default: vi.fn(),
}));

// Mock fs module
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

describe("validateKubeconfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  test("should throw error when kubeconfig env var is not set", async () => {
    // Mock config to return undefined kubeconfig
    vi.doMock("@/config", () => ({
      default: {
        orchestrator: {
          kubernetes: {
            namespace: "test-namespace",
            kubeconfig: undefined,
            loadKubeconfigFromCurrentCluster: false,
          },
        },
      },
    }));

    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("")).toThrow(
      "No kubeconfig path or content provided. MCP Orchestrator cannot start. " +
      "See documentation: https://archestra.ai/docs/kubeconfig-setup"
    );
  });

  test("should throw error when kubeconfig file does not exist", async () => {
    const fs = await import("node:fs");

    // Mock fs.existsSync to return false
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("/path/to/nonexistent/kubeconfig")).toThrow(
      "Kubeconfig file not found at /path/to/nonexistent/kubeconfig. " +
      "See documentation: https://archestra.ai/docs/kubeconfig-setup"
    );
  });

  test("should throw error when kubeconfig file cannot be parsed", async () => {
    const fs = await import("node:fs");

    // Mock fs.existsSync to return true
    vi.mocked(fs.existsSync).mockReturnValue(true);
    // Mock fs.readFileSync to return invalid content
    vi.mocked(fs.readFileSync).mockReturnValue("invalid content that is neither JSON nor YAML");

    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("/path/to/kubeconfig")).toThrow(
      "Malformed kubeconfig: File cannot be parsed as YAML or JSON. " +
      "See documentation: https://archestra.ai/docs/kubeconfig-setup"
    );
  });

  test("should throw error when clusters field is missing", async () => {
    const fs = await import("node:fs");

    // Mock config to return a kubeconfig path
    vi.doMock("@/config", () => ({
      default: {
        orchestrator: {
          kubernetes: {
            namespace: "test-namespace",
            kubeconfig: "/path/to/kubeconfig",
            loadKubeconfigFromCurrentCluster: false,
          },
        },
      },
    }));

    // Mock fs.existsSync to return true
    vi.mocked(fs.existsSync).mockReturnValue(true);
    // Mock fs.readFileSync to return JSON content without clusters
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      contexts: [],
      users: []
    }));

    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("/path/to/kubeconfig")).toThrow(
      "Invalid kubeconfig: 'clusters' field missing. " +
      "See documentation: https://archestra.ai/docs/kubeconfig-setup"
    );
  });

  test("should throw error when clusters[0].cluster is missing", async () => {
    const fs = await import("node:fs");

    // Mock config to return a kubeconfig path
    vi.doMock("@/config", () => ({
      default: {
        orchestrator: {
          kubernetes: {
            namespace: "test-namespace",
            kubeconfig: "/path/to/kubeconfig",
            loadKubeconfigFromCurrentCluster: false,
          },
        },
      },
    }));

    // Mock fs.existsSync to return true
    vi.mocked(fs.existsSync).mockReturnValue(true);
    // Mock fs.readFileSync to return JSON content with clusters but no cluster[0].cluster
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      clusters: [{}], // Missing cluster subfield
      contexts: [],
      users: []
    }));

    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("/path/to/kubeconfig")).toThrow(
      "Invalid kubeconfig: 'clusters[0].cluster' is missing. " +
      "See documentation: https://archestra.ai/docs/kubeconfig-setup"
    );
  });

  test("should throw error when contexts field is missing", async () => {
    const fs = await import("node:fs");

    // Mock config to return a kubeconfig path
    vi.doMock("@/config", () => ({
      default: {
        orchestrator: {
          kubernetes: {
            namespace: "test-namespace",
            kubeconfig: "/path/to/kubeconfig",
            loadKubeconfigFromCurrentCluster: false,
          },
        },
      },
    }));

    // Mock fs.existsSync to return true
    vi.mocked(fs.existsSync).mockReturnValue(true);
    // Mock fs.readFileSync to return JSON content without contexts
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      clusters: [{ cluster: { server: "https://example.com" } }],
      users: []
    }));

    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("/path/to/kubeconfig")).toThrow(
      "Invalid kubeconfig: 'contexts' field missing. " +
      "See documentation: https://archestra.ai/docs/kubeconfig-setup"
    );
  });

  test("should throw error when users field is missing", async () => {
    const fs = await import("node:fs");

    // Mock config to return a kubeconfig path
    vi.doMock("@/config", () => ({
      default: {
        orchestrator: {
          kubernetes: {
            namespace: "test-namespace",
            kubeconfig: "/path/to/kubeconfig",
            loadKubeconfigFromCurrentCluster: false,
          },
        },
      },
    }));

    // Mock fs.existsSync to return true
    vi.mocked(fs.existsSync).mockReturnValue(true);
    // Mock fs.readFileSync to return JSON content without users
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      clusters: [{ cluster: { server: "https://example.com" } }],
      contexts: []
    }));

    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("/path/to/kubeconfig")).toThrow(
      "Invalid kubeconfig: 'users' field missing. " +
      "See documentation: https://archestra.ai/docs/kubeconfig-setup"
    );
  });

  test("should not throw error when kubeconfig is valid", async () => {
    const fs = await import("node:fs");

    // Mock config to return a kubeconfig path
    vi.doMock("@/config", () => ({
      default: {
        orchestrator: {
          kubernetes: {
            namespace: "test-namespace",
            kubeconfig: "/path/to/kubeconfig",
            loadKubeconfigFromCurrentCluster: false,
          },
        },
      },
    }));

    // Mock fs.existsSync to return true
    vi.mocked(fs.existsSync).mockReturnValue(true);
    // Mock fs.readFileSync to return valid JSON content
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      clusters: [{ cluster: { server: "https://example.com" } }],
      contexts: [],
      users: []
    }));

    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("/path/to/kubeconfig")).not.toThrow();
  });
});

describe("McpServerRuntimeManager", () => {
  describe("constructor", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
    });

    test("should throw error during construction when kubeconfig validation fails", async () => {
      // Mock config to return undefined kubeconfig (validation will fail)
      vi.doMock("@/config", () => ({
        default: {
          orchestrator: {
            kubernetes: {
              namespace: "test-namespace",
              kubeconfig: undefined,
              loadKubeconfigFromCurrentCluster: false,
            },
          },
        },
      }));

      const { McpServerRuntimeManager } = await import("./manager");
      expect(() => new McpServerRuntimeManager()).toThrow(
        "No kubeconfig path or content provided. MCP Orchestrator cannot start. " +
        "See documentation: https://archestra.ai/docs/kubeconfig-setup"
      );
    });

    test("should not validate kubeconfig when loadKubeconfigFromCurrentCluster is true", async () => {
      // Mock config to return loadKubeconfigFromCurrentCluster: true
      vi.doMock("@/config", () => ({
        default: {
          orchestrator: {
            kubernetes: {
              namespace: "test-namespace",
              kubeconfig: undefined, // kubeconfig is undefined but validation should be skipped
              loadKubeconfigFromCurrentCluster: true,
            },
          },
        },
      }));

      // Mock successful cluster loading
      const mockLoadFromCluster = vi
        .spyOn(k8s.KubeConfig.prototype, "loadFromCluster")
        .mockImplementation(() => {});

      const mockMakeApiClient = vi
        .spyOn(k8s.KubeConfig.prototype, "makeApiClient")
        .mockReturnValue({} as k8s.CoreV1Api);

      const { McpServerRuntimeManager } = await import("./manager");
      expect(() => new McpServerRuntimeManager()).not.toThrow();

      mockLoadFromCluster.mockRestore();
      mockMakeApiClient.mockRestore();
    });
  });

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
});
