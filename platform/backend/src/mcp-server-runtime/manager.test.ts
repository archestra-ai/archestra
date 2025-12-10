import { vi } from "vitest";
import * as fs from "node:fs";
import type * as originalConfigModule from "@/config";
import { beforeEach, describe, expect, test } from "@/test";

// Mock fs module first
vi.mock("node:fs");

// Mock @kubernetes/client-node
vi.mock("@kubernetes/client-node", () => {
  class MockKubeConfig {
    clusters: any[] = [];
    contexts: any[] = [];
    users: any[] = [];
    
    loadFromString(content: string) {
      try {
        const parsed = JSON.parse(content);
        // Simulate the real KubeConfig behavior: populate arrays from parsed content
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

vi.mock("@/models/internal-mcp-catalog", () => ({
  default: {},
}));

vi.mock("@/models/mcp-server", () => ({
  default: {},
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
      /❌ Kubeconfig file not found/
    );
  });

  test("should throw error when kubeconfig file cannot be parsed", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("invalid yaml content");

    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("/path")).toThrow(
      /❌ Malformed kubeconfig: could not parse YAML/
    );
  });

  test("should throw error when clusters field is missing", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      contexts: [],
      users: []
    }));

    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("/path")).toThrow(
      /❌ Invalid kubeconfig: clusters section missing/
    );
  });

  test("should throw error when clusters[0] is missing", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      clusters: [],
      contexts: [],
      users: []
    }));

    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("/path")).toThrow(
      /❌ Invalid kubeconfig: clusters section missing/
    );
  });

  test("should throw error when cluster name or server is missing", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      clusters: [{}],
      contexts: [{ name: "test" }],
      users: [{ name: "test" }]
    }));

    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("/path")).toThrow(
      /❌ Invalid kubeconfig: cluster entry is missing required fields/
    );
  });

  test("should throw error when contexts field is missing", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      clusters: [{ name: "test", server: "https://test.com" }],
      contexts: [],
      users: [{ name: "test" }]
    }));

    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("/path")).toThrow(
      /❌ Invalid kubeconfig: contexts section missing/
    );
  });

  test("should throw error when users field is missing", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      clusters: [{ name: "test", server: "https://test.com" }],
      contexts: [{ name: "test" }],
      users: []
    }));

    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("/path")).toThrow(
      /❌ Invalid kubeconfig: users section missing/
    );
  });

  test("should not throw error when kubeconfig is valid", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      clusters: [{ name: "test", server: "https://test.com" }],
      contexts: [{ name: "test" }],
      users: [{ name: "test" }]
    }));

    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("/path")).not.toThrow();
  });
});

describe("McpServerRuntimeManager", () => {
  test("should export McpServerRuntimeManager class", async () => {
    const { McpServerRuntimeManager } = await import("./manager");
    expect(McpServerRuntimeManager).toBeDefined();
    expect(typeof McpServerRuntimeManager).toBe("function");
  });

  test("should have isEnabled property on prototype", async () => {
    const { McpServerRuntimeManager } = await import("./manager");
    expect(McpServerRuntimeManager.prototype.isEnabled).toBeDefined();
  });

  test("should export default instance", async () => {
    const manager = await import("./manager");
    expect(manager.default).toBeDefined();
  });
});


