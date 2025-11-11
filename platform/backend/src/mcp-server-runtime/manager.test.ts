import { beforeEach, describe, expect, test, vi } from "vitest";
import * as k8s from "@kubernetes/client-node";

// Mock the dependencies before importing the manager
vi.mock("@/config", () => ({
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

vi.mock("@/logging", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@/models/internal-mcp-catalog", () => ({
  default: {},
}));

vi.mock("@/models/mcp-server", () => ({
  default: {},
}));

vi.mock("./k8s-pod", () => ({
  default: vi.fn(),
}));

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

      // isEnabled should be false when config fails to load
      expect(McpServerRuntimeManager.isEnabled).toBe(false);

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
        .mockReturnValue({} as any);

      // Dynamically import to get a fresh instance
      const { McpServerRuntimeManager } = await import("./manager");

      // isEnabled should be true when config loads successfully
      expect(McpServerRuntimeManager.isEnabled).toBe(true);

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
        .mockReturnValue({} as any);

      // Dynamically import to get a fresh instance
      const { McpServerRuntimeManager } = await import("./manager");

      // Should be enabled initially
      expect(McpServerRuntimeManager.isEnabled).toBe(true);

      // Shutdown the runtime
      await McpServerRuntimeManager.shutdown();

      // Should be disabled after shutdown
      expect(McpServerRuntimeManager.isEnabled).toBe(false);

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
        .mockReturnValue({} as any);

      const { McpServerRuntimeManager } = await import("./manager");

      // Status should be not_initialized (not error), so isEnabled should be true
      expect(McpServerRuntimeManager.isEnabled).toBe(true);

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

      // Status should be error, so isEnabled should be false
      expect(McpServerRuntimeManager.isEnabled).toBe(false);

      mockLoadFromDefault.mockRestore();
    });
  });
});
