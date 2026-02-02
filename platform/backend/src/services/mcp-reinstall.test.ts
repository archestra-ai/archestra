import { vi } from "vitest";

// Mock dependencies before other imports
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

import { McpServerRuntimeManager } from "@/mcp-server-runtime";
import { McpServerModel, ToolModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { InternalMcpCatalog, McpServer } from "@/types";
import {
  autoReinstallServer,
  requiresNewUserInputForReinstall,
} from "./mcp-reinstall";

describe("mcp-reinstall", () => {
  describe("requiresNewUserInputForReinstall", () => {
    // Helper to create a minimal local catalog item
    const createLocalCatalog = (
      environment: Array<{
        key: string;
        type: "plain_text" | "secret";
        promptOnInstallation: boolean;
        required?: boolean;
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

      test("returns true when prompted env var is ADDED", () => {
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

      test("returns false when prompted env var is UNCHANGED", () => {
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

        expect(result).toBe(false);
      });

      test("returns true when new prompted env var is ADDED to existing ones", () => {
        const oldConfig = createLocalCatalog([
          {
            key: "API_KEY",
            type: "secret" as const,
            promptOnInstallation: true,
          },
        ]);
        const newConfig = createLocalCatalog([
          {
            key: "API_KEY",
            type: "secret" as const,
            promptOnInstallation: true,
          },
          {
            key: "NEW_SECRET",
            type: "secret" as const,
            promptOnInstallation: true,
          },
        ]);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(true);
      });

      test("returns true when prompted env var is REMOVED", () => {
        const oldConfig = createLocalCatalog([
          {
            key: "API_KEY",
            type: "secret" as const,
            promptOnInstallation: true,
          },
        ]);
        const newConfig = createLocalCatalog([]);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(true);
      });

      test("returns true when prompted env var TYPE changes", () => {
        const oldConfig = createLocalCatalog([
          {
            key: "CONFIG_VAR",
            type: "plain_text" as const,
            promptOnInstallation: true,
          },
        ]);
        const newConfig = createLocalCatalog([
          {
            key: "CONFIG_VAR",
            type: "secret" as const,
            promptOnInstallation: true,
          },
        ]);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(true);
      });

      test("returns true when prompted env var REQUIRED status changes", () => {
        const oldConfig = createLocalCatalog([
          {
            key: "API_KEY",
            type: "secret" as const,
            promptOnInstallation: true,
            required: false,
          },
        ]);
        const newConfig = createLocalCatalog([
          {
            key: "API_KEY",
            type: "secret" as const,
            promptOnInstallation: true,
            required: true,
          },
        ]);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(true);
      });

      test("returns true when server NAME changes (even with no prompted env vars)", () => {
        const oldConfig = {
          ...createLocalCatalog([]),
          name: "Old Server Name",
        };
        const newConfig = {
          ...createLocalCatalog([]),
          name: "New Server Name",
        };

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(true);
      });

      test("returns true when server NAME changes (with existing prompted env vars)", () => {
        const envVars = [
          {
            key: "API_KEY",
            type: "secret" as const,
            promptOnInstallation: true,
          },
        ];
        const oldConfig = {
          ...createLocalCatalog(envVars),
          name: "Old Server Name",
        };
        const newConfig = {
          ...createLocalCatalog(envVars),
          name: "New Server Name",
        };

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(true);
      });

      test("returns false when only non-prompted config changes (command/args)", () => {
        const envVars = [
          {
            key: "API_KEY",
            type: "secret" as const,
            promptOnInstallation: true,
          },
        ];
        const oldConfig = {
          ...createLocalCatalog(envVars),
          localConfig: {
            command: "npm",
            arguments: ["start"],
            environment: envVars,
          },
        } as InternalMcpCatalog;
        const newConfig = {
          ...createLocalCatalog(envVars),
          localConfig: {
            command: "node",
            arguments: ["index.js", "--verbose"],
            environment: envVars,
          },
        } as InternalMcpCatalog;

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });

      test("returns false when only non-prompted env vars are added", () => {
        const oldEnvVars = [
          {
            key: "API_KEY",
            type: "secret" as const,
            promptOnInstallation: true,
          },
        ];
        const newEnvVars = [
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
        ];
        const oldConfig = createLocalCatalog(oldEnvVars);
        const newConfig = createLocalCatalog(newEnvVars);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });

      test("returns false when only non-prompted env vars are removed", () => {
        const oldEnvVars = [
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
        ];
        const newEnvVars = [
          {
            key: "API_KEY",
            type: "secret" as const,
            promptOnInstallation: true,
          },
        ];
        const oldConfig = createLocalCatalog(oldEnvVars);
        const newConfig = createLocalCatalog(newEnvVars);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });

      test("handles missing localConfig.environment gracefully", () => {
        const oldConfig = {
          id: "test-id",
          name: "Test Server",
          serverType: "local",
          localConfig: {},
        } as InternalMcpCatalog;
        const newConfig = {
          id: "test-id",
          name: "Test Server",
          serverType: "local",
          localConfig: {},
        } as InternalMcpCatalog;

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });

      test("handles null localConfig gracefully", () => {
        const oldConfig = {
          id: "test-id",
          name: "Test Server",
          serverType: "local",
          localConfig: null,
        } as InternalMcpCatalog;
        const newConfig = {
          id: "test-id",
          name: "Test Server",
          serverType: "local",
          localConfig: null,
        } as InternalMcpCatalog;

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

      test("returns false when only name changes (no auth config)", () => {
        const oldConfig = { ...createRemoteCatalog({}), name: "Old Name" };
        const newConfig = { ...createRemoteCatalog({}), name: "New Name" };

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });

      test("returns false when only name changes (with existing OAuth)", () => {
        const oauthConfig = { authorizationUrl: "https://example.com/auth" };
        const oldConfig = {
          ...createRemoteCatalog({}, oauthConfig),
          name: "Old Name",
        };
        const newConfig = {
          ...createRemoteCatalog({}, oauthConfig),
          name: "New Name",
        };

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });

      test("returns false when only name changes (with existing required userConfig)", () => {
        const config = { field: { type: "string", required: true } };
        const oldConfig = { ...createRemoteCatalog(config), name: "Old Name" };
        const newConfig = { ...createRemoteCatalog(config), name: "New Name" };

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });

      test("returns true when required userConfig field is ADDED", () => {
        const oldConfig = createRemoteCatalog({});
        const newConfig = createRemoteCatalog({
          field: { type: "string", required: true },
        });

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(true);
      });

      test("returns false when required userConfig is UNCHANGED", () => {
        const config = { field: { type: "string", required: true } };
        const oldConfig = createRemoteCatalog(config);
        const newConfig = createRemoteCatalog(config);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });

      test("returns true when required userConfig field is REMOVED", () => {
        const oldConfig = createRemoteCatalog({
          field: { type: "string", required: true },
        });
        const newConfig = createRemoteCatalog({});

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(true);
      });

      test("returns true when required userConfig field TYPE changes", () => {
        const oldConfig = createRemoteCatalog({
          field: { type: "string", required: true },
        });
        const newConfig = createRemoteCatalog({
          field: { type: "number", required: true },
        });

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(true);
      });

      test("returns true when OAuth config is ADDED", () => {
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

      test("returns false when OAuth config is UNCHANGED", () => {
        const oauthConfig = { authorizationUrl: "https://example.com/auth" };
        const oldConfig = createRemoteCatalog({}, oauthConfig);
        const newConfig = createRemoteCatalog({}, oauthConfig);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });

      test("returns true when OAuth config is REMOVED", () => {
        const oauthConfig = { authorizationUrl: "https://example.com/auth" };
        const oldConfig = createRemoteCatalog({}, oauthConfig);
        const newConfig = createRemoteCatalog({}, null);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(true);
      });

      test("returns false when only optional userConfig is added (with existing required)", () => {
        const oldConfig = createRemoteCatalog({
          requiredField: { type: "string", required: true },
        });
        const newConfig = createRemoteCatalog({
          requiredField: { type: "string", required: true },
          optionalField: { type: "string", required: false },
        });

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });

      test("handles null userConfig gracefully", () => {
        const oldConfig = {
          id: "test-id",
          name: "Test Server",
          serverType: "remote",
          userConfig: null,
          oauthConfig: null,
        } as InternalMcpCatalog;
        const newConfig = {
          id: "test-id",
          name: "Test Server",
          serverType: "remote",
          userConfig: null,
          oauthConfig: null,
        } as InternalMcpCatalog;

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
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
    const createServer = (overrides: Partial<McpServer> = {}): McpServer =>
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

      // Verify server name and reinstall flag were updated
      expect(McpServerModel.update).toHaveBeenCalledWith(server.id, {
        name: catalog.name,
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

      // Verify server name and reinstall flag were updated
      expect(McpServerModel.update).toHaveBeenCalledWith(server.id, {
        name: catalog.name,
        reinstallRequired: false,
      });
    });
  });
});
