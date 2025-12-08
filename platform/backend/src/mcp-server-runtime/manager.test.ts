import { vi } from "vitest";
import { describe, expect, test, beforeEach } from "@/test";

// Mock fs module before importing manager
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Tests that match the actual manager.ts implementation
describe("validateKubeconfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("should not validate when no path provided", async () => {
    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig(undefined)).not.toThrow();
  });

  test("should throw error when kubeconfig file does not exist", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("/nonexistent/path")).toThrow();
  });

  test("should throw error when kubeconfig file cannot be parsed", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("invalid yaml content");

    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("/path")).toThrow();
  });

  test("should throw error when clusters field is missing", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      contexts: [],
      users: []
    }));

    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("/path")).toThrow();
  });

  test("should throw error when clusters[0] is missing", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      clusters: [],
      contexts: [],
      users: []
    }));

    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("/path")).toThrow();
  });

  test("should throw error when cluster fields are missing", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      clusters: [{}],
      contexts: [],
      users: []
    }));

    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("/path")).toThrow();
  });

  test("should throw error when contexts field is missing", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      clusters: [{ cluster: { server: "https://test.com", name: "test" } }],
      users: []
    }));

    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("/path")).toThrow();
  });

  test("should throw error when users field is missing", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      clusters: [{ cluster: { server: "https://test.com", name: "test" } }],
      contexts: []
    }));

    const { validateKubeconfig } = await import("./manager");
    expect(() => validateKubeconfig("/path")).toThrow();
  });

  test("should not throw error when kubeconfig is valid", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      clusters: [{ cluster: { server: "https://test.com", name: "test" }, name: "test" }],
      contexts: [{ name: "test", context: { cluster: "test", user: "test" } }],
      users: [{ name: "test", user: {} }]
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
