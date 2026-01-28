import { McpServerRuntimeManager } from "@/mcp-server-runtime";
import { McpServerModel, ToolModel } from "@/models";
import { beforeEach, describe, expect, test, vi } from "@/test";
import type { InternalMcpCatalog, McpServer } from "@/types";
import {
  autoReinstallServer,
  requiresNewUserInputForReinstall,
} from "./mcp-reinstall";

// Mock dependencies
vi.mock("@/mcp-server-runtime", () => ({
  McpServerRuntimeManager: {
    restartServer: vi.fn(),
    getOrLoadDeployment: vi.fn(),
  },
}));

vi.mock("@/models", () => ({
  McpServerModel: {
    getToolsFromServer: vi.fn(),
    update: vi.fn(),
  },
  ToolModel: {
    slugifyName: vi.fn((prefix, name) => `${prefix}__${name}`),
    syncToolsForCatalog: vi.fn(),
  },
}));

describe("mcp-reinstall", () => {
  describe("requiresNewUserInputForReinstall", () => {
    // Helper to create a minimal local catalog item
    const createLocalCatalog = (
      environment: Array<{
        key: string;
        type: "plain_text" | "secret";
        promptOnInstallation: boolean;
      }> = [],
    ): InternalMcpCatalog =>
      ({
        id: "test-id",
        name: "Test Server",
        serverType: "local",
        localConfig: {
          command: "npm",
          arguments: ["start"],
          environment,
        },
      }) as InternalMcpCatalog;

    // Helper to create a minimal remote catalog item
    const createRemoteCatalog = (
      userConfig: Record<string, { type: string; required?: boolean }> = {},
      oauthConfig: object | null = null,
    ): InternalMcpCatalog =>
      ({
        id: "test-id",
        name: "Test Server",
        serverType: "remote",
        userConfig,
        oauthConfig,
      }) as InternalMcpCatalog;

    describe("local servers", () => {
      test("returns false when no env vars exist", () => {
        const oldConfig = createLocalCatalog([]);
        const newConfig = createLocalCatalog([]);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });

      test("returns false when only non-prompted env vars exist", () => {
        const oldConfig = createLocalCatalog([]);
        const newConfig = createLocalCatalog([
          {
            key: "STATIC_VAR",
            type: "plain_text" as const,
            promptOnInstallation: false,
          },
        ]);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });

      test("returns true when ANY prompted env var exists", () => {
        const oldConfig = createLocalCatalog([]);
        const newConfig = createLocalCatalog([
          {
            key: "API_KEY",
            type: "secret" as const,
            promptOnInstallation: true,
          },
        ]);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(true);
      });

      test("returns true when prompted env var exists (even if unchanged)", () => {
        const envVars = [
          {
            key: "API_KEY",
            type: "secret" as const,
            promptOnInstallation: true,
          },
        ];
        const oldConfig = createLocalCatalog(envVars);
        const newConfig = createLocalCatalog(envVars);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(true);
      });

      test("returns true when mix of prompted and non-prompted env vars exist", () => {
        const oldConfig = createLocalCatalog([]);
        const newConfig = createLocalCatalog([
          {
            key: "API_KEY",
            type: "secret" as const,
            promptOnInstallation: true,
          },
          {
            key: "STATIC_VAR",
            type: "plain_text" as const,
            promptOnInstallation: false,
          },
        ]);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(true);
      });

      test("returns false when prompted env var is removed and no prompted vars remain", () => {
        const oldConfig = createLocalCatalog([
          {
            key: "API_KEY",
            type: "secret" as const,
            promptOnInstallation: true,
          },
        ]);
        const newConfig = createLocalCatalog([]);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });
    });

    describe("remote servers", () => {
      test("returns false when no user config and no OAuth exists", () => {
        const oldConfig = createRemoteCatalog({});
        const newConfig = createRemoteCatalog({});

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });

      test("returns false when only optional user config exists", () => {
        const oldConfig = createRemoteCatalog({});
        const newConfig = createRemoteCatalog({
          optionalField: { type: "string", required: false },
        });

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });

      test("returns true when ANY required user config field exists", () => {
        const oldConfig = createRemoteCatalog({});
        const newConfig = createRemoteCatalog({
          field: { type: "string", required: true },
        });

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(true);
      });

      test("returns true when required user config exists (even if unchanged)", () => {
        const config = { field: { type: "string", required: true } };
        const oldConfig = createRemoteCatalog(config);
        const newConfig = createRemoteCatalog(config);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(true);
      });

      test("returns true when OAuth config exists", () => {
        const oldConfig = createRemoteCatalog({}, null);
        const newConfig = createRemoteCatalog(
          {},
          {
            authorizationUrl: "https://example.com/auth",
          },
        );

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(true);
      });

      test("returns true when OAuth config exists (even if unchanged)", () => {
        const oauthConfig = { authorizationUrl: "https://example.com/auth" };
        const oldConfig = createRemoteCatalog({}, oauthConfig);
        const newConfig = createRemoteCatalog({}, oauthConfig);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(true);
      });
    });

    describe("builtin servers", () => {
      test("returns false for builtin servers", () => {
        const oldConfig = { serverType: "builtin" } as InternalMcpCatalog;
        const newConfig = { serverType: "builtin" } as InternalMcpCatalog;

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });
    });
  });

  describe("autoReinstallServer", () => {
    // Helper to create a minimal server
    const createServer = (
      overrides: Partial<McpServer> = {},
    ): McpServer =>
      ({
        id: "server-123",
        name: "Test Server",
        ownerId: "user-123",
        catalogId: "catalog-123",
        serverType: "local",
        ...overrides,
      }) as McpServer;

    // Helper to create a minimal catalog item
    const createCatalog = (
      overrides: Partial<InternalMcpCatalog> = {},
    ): InternalMcpCatalog =>
      ({
        id: "catalog-123",
        name: "Test Catalog",
        serverType: "local",
        localConfig: {
          command: "npm",
          arguments: ["start"],
        },
        ...overrides,
      }) as InternalMcpCatalog;

    beforeEach(() => {
      vi.clearAllMocks();
    });

    test("throws error when restartServer fails for local server", async () => {
      const server = createServer({ serverType: "local" });
      const catalog = createCatalog({ serverType: "local" });

      vi.mocked(McpServerRuntimeManager.restartServer).mockRejectedValue(
        new Error("K8s deployment failed"),
      );

      await expect(autoReinstallServer(server, catalog)).rejects.toThrow(
        "K8s deployment failed",
      );

      // Verify restartServer was called
      expect(McpServerRuntimeManager.restartServer).toHaveBeenCalledWith(
        server.id,
      );

      // Verify update was NOT called since we threw before getting there
      expect(McpServerModel.update).not.toHaveBeenCalled();
    });

    test("throws error when getToolsFromServer fails", async () => {
      const server = createServer({ serverType: "remote" });
      const catalog = createCatalog({ serverType: "remote" });

      vi.mocked(McpServerModel.getToolsFromServer).mockRejectedValue(
        new Error("Failed to fetch tools from MCP server"),
      );

      await expect(autoReinstallServer(server, catalog)).rejects.toThrow(
        "Failed to fetch tools from MCP server",
      );

      // Verify update was NOT called since we threw before completing
      expect(McpServerModel.update).not.toHaveBeenCalled();
    });

    test("throws error when syncToolsForCatalog fails", async () => {
      const server = createServer({ serverType: "remote" });
      const catalog = createCatalog({ serverType: "remote" });

      vi.mocked(McpServerModel.getToolsFromServer).mockResolvedValue([
        { name: "test-tool", description: "A test tool", inputSchema: {} },
      ]);
      vi.mocked(ToolModel.syncToolsForCatalog).mockRejectedValue(
        new Error("Database constraint violation"),
      );

      await expect(autoReinstallServer(server, catalog)).rejects.toThrow(
        "Database constraint violation",
      );

      // Verify update was NOT called since we threw before completing
      expect(McpServerModel.update).not.toHaveBeenCalled();
    });

    test("throws error when deployment waitForDeploymentReady times out", async () => {
      const server = createServer({ serverType: "local" });
      const catalog = createCatalog({ serverType: "local" });

      vi.mocked(McpServerRuntimeManager.restartServer).mockResolvedValue(
        undefined,
      );
      vi.mocked(McpServerRuntimeManager.getOrLoadDeployment).mockResolvedValue({
        waitForDeploymentReady: vi
          .fn()
          .mockRejectedValue(new Error("Deployment timeout")),
      } as never);

      await expect(autoReinstallServer(server, catalog)).rejects.toThrow(
        "Deployment timeout",
      );

      // Verify update was NOT called since we threw before completing
      expect(McpServerModel.update).not.toHaveBeenCalled();
    });

    test("succeeds for remote server and clears reinstall flag", async () => {
      const server = createServer({ serverType: "remote" });
      const catalog = createCatalog({ serverType: "remote" });

      vi.mocked(McpServerModel.getToolsFromServer).mockResolvedValue([
        { name: "test-tool", description: "A test tool", inputSchema: {} },
      ]);
      vi.mocked(ToolModel.syncToolsForCatalog).mockResolvedValue({
        created: [],
        updated: [],
        unchanged: [],
        deleted: [],
      });
      vi.mocked(McpServerModel.update).mockResolvedValue({} as McpServer);

      await autoReinstallServer(server, catalog);

      // Verify reinstall flag was cleared
      expect(McpServerModel.update).toHaveBeenCalledWith(server.id, {
        reinstallRequired: false,
      });
    });

    test("succeeds for local server with full flow", async () => {
      const server = createServer({ serverType: "local" });
      const catalog = createCatalog({ serverType: "local" });

      vi.mocked(McpServerRuntimeManager.restartServer).mockResolvedValue(
        undefined,
      );
      vi.mocked(McpServerRuntimeManager.getOrLoadDeployment).mockResolvedValue({
        waitForDeploymentReady: vi.fn().mockResolvedValue(undefined),
      } as never);
      vi.mocked(McpServerModel.getToolsFromServer).mockResolvedValue([
        { name: "tool1", description: "First tool", inputSchema: {} },
        { name: "tool2", description: "Second tool", inputSchema: {} },
      ]);
      vi.mocked(ToolModel.syncToolsForCatalog).mockResolvedValue({
        created: [{ id: "new-tool" }],
        updated: [{ id: "existing-tool" }],
        unchanged: [],
        deleted: [],
      } as never);
      vi.mocked(McpServerModel.update).mockResolvedValue({} as McpServer);

      await autoReinstallServer(server, catalog);

      // Verify restart was called
      expect(McpServerRuntimeManager.restartServer).toHaveBeenCalledWith(
        server.id,
      );

      // Verify tools were synced with correct data
      expect(ToolModel.syncToolsForCatalog).toHaveBeenCalledWith([
        expect.objectContaining({
          name: "Test Catalog__tool1",
          catalogId: catalog.id,
          mcpServerId: server.id,
          rawToolName: "tool1",
        }),
        expect.objectContaining({
          name: "Test Catalog__tool2",
          catalogId: catalog.id,
          mcpServerId: server.id,
          rawToolName: "tool2",
        }),
      ]);

      // Verify reinstall flag was cleared
      expect(McpServerModel.update).toHaveBeenCalledWith(server.id, {
        reinstallRequired: false,
      });
    });
  });
});
