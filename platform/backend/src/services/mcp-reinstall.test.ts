import { vi } from "vitest";

// Mock dependencies before other imports
vi.mock("@/k8s/mcp-server-runtime", () => ({
  McpServerRuntimeManager: {
    restartServer: vi.fn(),
    getOrLoadDeployment: vi.fn(),
    reinstallSharedDeployment: vi.fn(),
  },
}));

vi.mock("@/websocket", () => ({
  broadcastMcpInstallationStatus: vi.fn(),
}));

import {
  CASCADE_SCENARIOS,
  CATALOG_SHAPES,
  isMetadataOnlyEdit,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { McpServerRuntimeManager } from "@/k8s/mcp-server-runtime";
import { McpServerModel, ToolModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { InternalMcpCatalog, McpServer } from "@/types";

// Re-fetch a server row after the code under test mutated it.
async function getServer(id: string): Promise<McpServer> {
  const [row] = await db
    .select()
    .from(schema.mcpServersTable)
    .where(eq(schema.mcpServersTable.id, id));
  return row as McpServer;
}

// Tools reconciled for a catalog (real ToolModel.syncToolsForCatalog writes).
async function getCatalogTools(catalogId: string) {
  return db
    .select()
    .from(schema.toolsTable)
    .where(eq(schema.toolsTable.catalogId, catalogId));
}

import {
  autoReinstallServer,
  onlyForwardCompatibleEnvDiff,
  reinstallMultitenantCatalog,
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
      userConfig: Record<
        string,
        { type: string; required?: boolean; headerName?: string }
      > = {},
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
        userConfig,
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

      test("returns true when a REQUIRED prompted env var is ADDED", () => {
        // Existing installs are missing a value they're now required to
        // provide → reinstall so the user can be re-prompted.
        const oldConfig = createLocalCatalog([]);
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

      test("returns false when an OPTIONAL prompted env var is ADDED", () => {
        // Schema-evolution: existing installs without the new optional
        // var are still valid. They can adopt it on the next manual
        // reinstall but shouldn't be force-flagged.
        const oldConfig = createLocalCatalog([]);
        const newConfig = createLocalCatalog([
          {
            key: "OPTIONAL_HINT",
            type: "plain_text" as const,
            promptOnInstallation: true,
            required: false,
          },
        ]);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
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

      test("returns true when a new REQUIRED prompted env var is ADDED to existing ones", () => {
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
            required: true,
          },
        ]);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(true);
      });

      test("returns false when an OPTIONAL prompted env var is ADDED to existing ones", () => {
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
            key: "NEW_OPTIONAL",
            type: "plain_text" as const,
            promptOnInstallation: true,
            required: false,
          },
        ]);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });

      test("returns true when prompted env var required flag flips false → true", () => {
        // An optional var becoming required invalidates installs that
        // didn't fill it.
        const oldConfig = createLocalCatalog([
          {
            key: "TOKEN",
            type: "secret" as const,
            promptOnInstallation: true,
            required: false,
          },
        ]);
        const newConfig = createLocalCatalog([
          {
            key: "TOKEN",
            type: "secret" as const,
            promptOnInstallation: true,
            required: true,
          },
        ]);

        expect(requiresNewUserInputForReinstall(oldConfig, newConfig)).toBe(
          true,
        );
      });

      test("returns false when prompted env var required flag flips true → false", () => {
        // A required var becoming optional doesn't invalidate any
        // existing install (the value they already provided is still
        // valid, it's just no longer mandatory).
        const oldConfig = createLocalCatalog([
          {
            key: "TOKEN",
            type: "secret" as const,
            promptOnInstallation: true,
            required: true,
          },
        ]);
        const newConfig = createLocalCatalog([
          {
            key: "TOKEN",
            type: "secret" as const,
            promptOnInstallation: true,
            required: false,
          },
        ]);

        expect(requiresNewUserInputForReinstall(oldConfig, newConfig)).toBe(
          false,
        );
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

      test("returns true when command or args change", () => {
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

        expect(result).toBe(true);
      });

      test("returns true when docker or transport config changes", () => {
        const oldConfig = {
          ...createLocalCatalog([]),
          localConfig: {
            command: "node",
            arguments: ["server.js"],
            dockerImage: "registry.example.com/mcp:1",
            transportType: "stdio",
            httpPort: undefined,
            httpPath: undefined,
            serviceAccount: "default",
            environment: [],
          },
        } as InternalMcpCatalog;
        const newConfig = {
          ...createLocalCatalog([]),
          localConfig: {
            command: "node",
            arguments: ["server.js"],
            dockerImage: "registry.example.com/mcp:2",
            transportType: "streamable-http",
            httpPort: 8080,
            httpPath: "/mcp",
            serviceAccount: "custom-sa",
            environment: [],
          },
        } as InternalMcpCatalog;

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(true);
      });

      test("returns false when docker image changes on a multi-tenant catalog (handled via catalogReinstallRequired)", () => {
        // Multi-tenant local catalogs route execution-config drift through
        // the catalog-level flag, not the per-install reinstall_required
        // flag — so this branch must NOT fire for them.
        const oldConfig = {
          ...createLocalCatalog([]),
          multitenant: true,
          localConfig: {
            command: "node",
            arguments: ["server.js"],
            dockerImage: "registry.example.com/mcp:1",
            transportType: "stdio",
            environment: [],
          },
        } as InternalMcpCatalog;
        const newConfig = {
          ...createLocalCatalog([]),
          multitenant: true,
          localConfig: {
            command: "node",
            arguments: ["server.js"],
            dockerImage: "registry.example.com/mcp:2",
            transportType: "stdio",
            environment: [],
          },
        } as InternalMcpCatalog;

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });

      test("returns true when a prompted env var is added on a multi-tenant catalog (still install-scope)", () => {
        // Multi-tenant gating is scoped to execution-config drift only —
        // prompted env vars are install-scope and still need per-tenant
        // input regardless of tenancy.
        const oldConfig = {
          ...createLocalCatalog([]),
          multitenant: true,
        } as InternalMcpCatalog;
        const newConfig = {
          ...createLocalCatalog([
            {
              key: "API_KEY",
              type: "secret",
              promptOnInstallation: true,
              required: true,
            },
          ]),
          multitenant: true,
        } as InternalMcpCatalog;

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(true);
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

      test("returns true when a required header userConfig field is ADDED", () => {
        const oldConfig = createLocalCatalog([], {});
        const newConfig = createLocalCatalog([], {
          db_url: {
            type: "string",
            required: true,
            headerName: "x-db-url",
          },
        });

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(true);
      });

      test("returns false when an OPTIONAL userConfig field is added", () => {
        const oldConfig = createLocalCatalog([], {});
        const newConfig = createLocalCatalog([], {
          tenant_id: {
            type: "string",
            required: false,
            headerName: "x-tenant-id",
          },
        });

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

      test("returns false when required userConfig field is fully REMOVED (auto path handles cleanup)", () => {
        // The field is gone, so there's nothing to re-prompt the user
        // for. The install's stored value becomes orphaned and the pod
        // needs to restart so the value stops being injected — but the
        // restart is the auto path's job (driven by
        // `userConfigChangedBreakingly`), not a re-prompt case.
        const oldConfig = createRemoteCatalog({
          field: { type: "string", required: true },
        });
        const newConfig = createRemoteCatalog({});

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });

      test("returns false when required userConfig field is DEMOTED to optional", () => {
        // Existing install supplied a value when the field was required.
        // After demotion the value is still accepted; no re-prompt
        // needed.
        const oldConfig = createRemoteCatalog({
          field: { type: "string", required: true },
        });
        const newConfig = createRemoteCatalog({
          field: { type: "string", required: false },
        });

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });

      test("returns true when optional userConfig field is PROMOTED to required", () => {
        // Existing install may have skipped the optional field; once
        // required, the install is missing a mandatory value and the
        // user must re-supply it.
        const oldConfig = createRemoteCatalog({
          field: { type: "string", required: false },
        });
        const newConfig = createRemoteCatalog({
          field: { type: "string", required: true },
        });

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

  describe("onlyForwardCompatibleEnvDiff", () => {
    const baseLocal = (
      environment: Array<{
        key: string;
        type: "plain_text" | "secret";
        promptOnInstallation: boolean;
        required?: boolean;
        mounted?: boolean;
      }>,
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
        userConfig: {},
      }) as InternalMcpCatalog;

    test("flipping `mounted` on an existing prompted env var returns false (pod restart needed, auto path)", () => {
      // Same key + type + required, only `mounted` flips.
      // `promptedEnvVarsChanged` is intentionally lenient here (no
      // re-prompt needed). The runtime check has to catch it so the
      // cascade fires via the auto path instead of silently skipping.
      const oldConfig = baseLocal([
        {
          key: "API_KEY",
          type: "secret",
          promptOnInstallation: true,
          required: false,
          mounted: false,
        },
      ]);
      const newConfig = baseLocal([
        {
          key: "API_KEY",
          type: "secret",
          promptOnInstallation: true,
          required: false,
          mounted: true,
        },
      ]);

      expect(onlyForwardCompatibleEnvDiff(oldConfig, newConfig)).toBe(false);
      // And NOT a re-prompt — the user already supplied the value.
      expect(requiresNewUserInputForReinstall(oldConfig, newConfig)).toBe(
        false,
      );
    });

    test("static header `default` value change returns false (pod restart needed, auto path)", () => {
      // `userConfigChangedBreakingly` would naively skip a `default`
      // change as cosmetic, but for a static header-mapped userConfig
      // entry (no install prompt) `default` IS the actual runtime
      // header value the form writes from the admin's input. A change
      // there must route through the auto path so pods restart and pick
      // up the new value — install owners don't need to re-supply
      // anything.
      const oldConfig = {
        ...baseLocal([]),
        userConfig: {
          header_x_region: {
            type: "string",
            title: "x-region",
            description: "",
            required: false,
            headerName: "x-region",
            sensitive: false,
            promptOnInstallation: false,
            default: "us-east-1",
          },
        },
      } as InternalMcpCatalog;
      const newConfig = {
        ...baseLocal([]),
        userConfig: {
          header_x_region: {
            type: "string",
            title: "x-region",
            description: "",
            required: false,
            headerName: "x-region",
            sensitive: false,
            promptOnInstallation: false,
            default: "eu-west-1",
          },
        },
      } as InternalMcpCatalog;

      expect(onlyForwardCompatibleEnvDiff(oldConfig, newConfig)).toBe(false);
      // Not a re-prompt — admin provides the value, install just needs
      // a restart to pick it up.
      expect(requiresNewUserInputForReinstall(oldConfig, newConfig)).toBe(
        false,
      );
    });

    test("prompted header `default` value change returns true (placeholder text, not runtime)", () => {
      // For a prompted header, `default` is just a placeholder shown
      // to the user at install time — they always supply their own
      // value. Changing the placeholder text is cosmetic and must NOT
      // trigger a cascade.
      const oldConfig = {
        ...baseLocal([]),
        userConfig: {
          header_x_api_key: {
            type: "string",
            title: "x-api-key",
            description: "",
            required: false,
            headerName: "x-api-key",
            sensitive: false,
            promptOnInstallation: true,
            default: "your-key-here",
          },
        },
      } as InternalMcpCatalog;
      const newConfig = {
        ...baseLocal([]),
        userConfig: {
          header_x_api_key: {
            type: "string",
            title: "x-api-key",
            description: "",
            required: false,
            headerName: "x-api-key",
            sensitive: false,
            promptOnInstallation: true,
            default: "your-api-key",
          },
        },
      } as InternalMcpCatalog;

      expect(onlyForwardCompatibleEnvDiff(oldConfig, newConfig)).toBe(true);
    });

    test("snapshot-shape asymmetry (toolCount present on one side) does not over-fire", () => {
      // When the parent PUT loop cascades to children, the old snapshot
      // comes from `findChildren()` (with `attachListMetadata` adding
      // `toolCount`) while the new snapshot comes from `update()`
      // (which doesn't). A naive whole-row stringify would diff on
      // these bookkeeping fields and over-fire for every parent edit.
      // The predicate's strip step must normalize them out.
      const oldWithListMetadata = {
        ...baseLocal([]),
        toolCount: 3,
        labels: [{ key: "env", value: "prod" }],
        teams: [],
      } as InternalMcpCatalog;
      const newWithoutListMetadata = {
        ...baseLocal([]),
        // No toolCount on the row returned by Model.update.
        labels: [{ key: "env", value: "prod" }],
        teams: [],
        authorName: "Alice",
      } as InternalMcpCatalog;

      expect(
        onlyForwardCompatibleEnvDiff(
          oldWithListMetadata,
          newWithoutListMetadata,
        ),
      ).toBe(true);
    });

    test("environment reassignment (environmentId change) returns false (pod must relocate)", () => {
      // The environment determines the deployment namespace, so a change
      // must route through the auto path and recreate the pod in the new
      // namespace. Regression: environmentId was missing from the
      // projection, so single-tenant reassignments were silently skipped
      // and the pod kept running in the old namespace.
      const oldConfig = {
        ...baseLocal([]),
        environmentId: "env-a",
      } as InternalMcpCatalog;
      const newConfig = {
        ...baseLocal([]),
        environmentId: "env-b",
      } as InternalMcpCatalog;

      expect(onlyForwardCompatibleEnvDiff(oldConfig, newConfig)).toBe(false);
    });

    test("assigning from default (null env) to an environment returns false", () => {
      const oldConfig = {
        ...baseLocal([]),
        environmentId: null,
      } as InternalMcpCatalog;
      const newConfig = {
        ...baseLocal([]),
        environmentId: "env-a",
      } as InternalMcpCatalog;

      expect(onlyForwardCompatibleEnvDiff(oldConfig, newConfig)).toBe(false);
    });

    test("unassigning an environment (back to default/null) returns false", () => {
      const oldConfig = {
        ...baseLocal([]),
        environmentId: "env-a",
      } as InternalMcpCatalog;
      const newConfig = {
        ...baseLocal([]),
        environmentId: null,
      } as InternalMcpCatalog;

      expect(onlyForwardCompatibleEnvDiff(oldConfig, newConfig)).toBe(false);
    });
  });

  describe("autoReinstallServer", () => {
    beforeEach(() => {
      // Restore boundary spies (getToolsFromServer, syncToolsForCatalog) between tests.
      vi.restoreAllMocks();
    });

    // Seeds a real local catalog + a real server row. serverType/reinstallRequired
    // are set via a follow-up update since the fixture doesn't expose them.
    const seed = async (
      fixtures: {
        makeInternalMcpCatalog: (
          o?: Record<string, unknown>,
        ) => Promise<InternalMcpCatalog>;
        makeMcpServer: (o?: Record<string, unknown>) => Promise<McpServer>;
      },
      opts: {
        catalogName: string;
        catalogServerType: "local" | "remote";
        serverName: string;
        serverType: "local" | "remote";
        scope?: "personal" | "team" | "org";
        ownerId?: string | null;
        teamId?: string | null;
      },
    ) => {
      const catalog = await fixtures.makeInternalMcpCatalog({
        name: opts.catalogName,
        serverType: opts.catalogServerType,
        ...(opts.catalogServerType === "local"
          ? { localConfig: { command: "npm", arguments: ["start"] } }
          : {}),
      });
      const created = await fixtures.makeMcpServer({
        catalogId: catalog.id,
        name: opts.serverName,
        scope: opts.scope ?? "personal",
        ownerId: opts.ownerId ?? null,
        teamId: opts.teamId ?? null,
      });
      await db
        .update(schema.mcpServersTable)
        .set({ serverType: opts.serverType, reinstallRequired: true })
        .where(eq(schema.mcpServersTable.id, created.id));
      const server = await getServer(created.id);
      return { catalog, server };
    };

    test("throws error when restartServer fails for local server", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
    }) => {
      const user = await makeUser();
      const { catalog, server } = await seed(
        { makeInternalMcpCatalog, makeMcpServer },
        {
          catalogName: "Test Catalog",
          catalogServerType: "local",
          // Name already matches the reconstructed form, so no rename happens.
          serverName: `Test Catalog-${user.id}`,
          serverType: "local",
          scope: "personal",
          ownerId: user.id,
        },
      );

      vi.mocked(McpServerRuntimeManager.restartServer).mockRejectedValue(
        new Error("K8s deployment failed"),
      );

      await expect(autoReinstallServer(server, catalog)).rejects.toThrow(
        "K8s deployment failed",
      );

      expect(McpServerRuntimeManager.restartServer).toHaveBeenCalledWith(
        server.id,
      );
      // Threw before clearing the flag → still required.
      expect((await getServer(server.id)).reinstallRequired).toBe(true);
    });

    test("throws error when getToolsFromServer fails", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const { catalog, server } = await seed(
        { makeInternalMcpCatalog, makeMcpServer },
        {
          catalogName: "Test Catalog",
          catalogServerType: "remote",
          serverName: "Test Catalog",
          serverType: "remote",
        },
      );

      vi.spyOn(McpServerModel, "getToolsFromServer").mockRejectedValue(
        new Error("Failed to fetch tools from MCP server"),
      );

      await expect(autoReinstallServer(server, catalog)).rejects.toThrow(
        "Failed to fetch tools from MCP server",
      );

      // Threw before completing → flag not cleared.
      expect((await getServer(server.id)).reinstallRequired).toBe(true);
    });

    test("throws error when syncToolsForCatalog fails", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const { catalog, server } = await seed(
        { makeInternalMcpCatalog, makeMcpServer },
        {
          catalogName: "Test Catalog",
          catalogServerType: "remote",
          serverName: "Test Catalog",
          serverType: "remote",
        },
      );

      vi.spyOn(McpServerModel, "getToolsFromServer").mockResolvedValue([
        { name: "test-tool", description: "A test tool", inputSchema: {} },
      ]);
      vi.spyOn(ToolModel, "syncToolsForCatalog").mockRejectedValue(
        new Error("Database constraint violation"),
      );

      await expect(autoReinstallServer(server, catalog)).rejects.toThrow(
        "Database constraint violation",
      );

      expect((await getServer(server.id)).reinstallRequired).toBe(true);
    });

    test("throws error when deployment waitForDeploymentReady times out", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
    }) => {
      const user = await makeUser();
      const { catalog, server } = await seed(
        { makeInternalMcpCatalog, makeMcpServer },
        {
          catalogName: "Test Catalog",
          catalogServerType: "local",
          serverName: `Test Catalog-${user.id}`,
          serverType: "local",
          scope: "personal",
          ownerId: user.id,
        },
      );

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

      expect((await getServer(server.id)).reinstallRequired).toBe(true);
    });

    test("succeeds for remote server - updates name and clears reinstall flag", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const { catalog, server } = await seed(
        { makeInternalMcpCatalog, makeMcpServer },
        {
          catalogName: "New Catalog Name",
          catalogServerType: "remote",
          serverName: "Old Catalog Name",
          serverType: "remote",
        },
      );

      vi.spyOn(McpServerModel, "getToolsFromServer").mockResolvedValue([
        { name: "test-tool", description: "A test tool", inputSchema: {} },
      ]);

      await autoReinstallServer(server, catalog);

      // Remote servers get the catalog name directly (no suffix), and the flag clears.
      const updated = await getServer(server.id);
      expect(updated.name).toBe("New Catalog Name");
      expect(updated.reinstallRequired).toBe(false);
    });

    test("reconstructs name with userId suffix when name already correct", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
    }) => {
      const user = await makeUser();
      const { catalog, server } = await seed(
        { makeInternalMcpCatalog, makeMcpServer },
        {
          catalogName: "microsoft__playwright-mcp",
          catalogServerType: "local",
          serverName: `microsoft__playwright-mcp-${user.id}`,
          serverType: "local",
          scope: "personal",
          ownerId: user.id,
        },
      );

      vi.mocked(McpServerRuntimeManager.restartServer).mockResolvedValue(
        undefined,
      );
      vi.mocked(McpServerRuntimeManager.getOrLoadDeployment).mockResolvedValue({
        waitForDeploymentReady: vi.fn().mockResolvedValue(undefined),
      } as never);
      vi.spyOn(McpServerModel, "getToolsFromServer").mockResolvedValue([
        { name: "tool1", description: "A tool", inputSchema: {} },
      ]);

      await autoReinstallServer(server, catalog);

      // Name already matches → not renamed; only the reinstall flag clears.
      const updated = await getServer(server.id);
      expect(updated.name).toBe(`microsoft__playwright-mcp-${user.id}`);
      expect(updated.reinstallRequired).toBe(false);
    });

    test("updates name with userId suffix when catalog is renamed", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
    }) => {
      const user = await makeUser();
      const { catalog, server } = await seed(
        { makeInternalMcpCatalog, makeMcpServer },
        {
          catalogName: "new-catalog-name",
          catalogServerType: "local",
          serverName: "old-catalog-name",
          serverType: "local",
          scope: "personal",
          ownerId: user.id,
        },
      );

      vi.mocked(McpServerRuntimeManager.restartServer).mockResolvedValue(
        undefined,
      );
      vi.mocked(McpServerRuntimeManager.getOrLoadDeployment).mockResolvedValue({
        waitForDeploymentReady: vi.fn().mockResolvedValue(undefined),
      } as never);
      vi.spyOn(McpServerModel, "getToolsFromServer").mockResolvedValue([
        { name: "tool1", description: "A tool", inputSchema: {} },
      ]);

      await autoReinstallServer(server, catalog);

      // Name reconstructed as `<catalog>-<ownerId>`, then flag cleared.
      const updated = await getServer(server.id);
      expect(updated.name).toBe(`new-catalog-name-${user.id}`);
      expect(updated.reinstallRequired).toBe(false);
    });

    test("updates name with teamId suffix for team servers on catalog rename", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id);
      const { catalog, server } = await seed(
        { makeInternalMcpCatalog, makeMcpServer },
        {
          catalogName: "new-name",
          catalogServerType: "local",
          serverName: "old-name",
          serverType: "local",
          scope: "team",
          ownerId: user.id,
          teamId: team.id,
        },
      );

      vi.mocked(McpServerRuntimeManager.restartServer).mockResolvedValue(
        undefined,
      );
      vi.mocked(McpServerRuntimeManager.getOrLoadDeployment).mockResolvedValue({
        waitForDeploymentReady: vi.fn().mockResolvedValue(undefined),
      } as never);
      vi.spyOn(McpServerModel, "getToolsFromServer").mockResolvedValue([]);

      await autoReinstallServer(server, catalog);

      // teamId takes precedence over ownerId for the suffix.
      expect((await getServer(server.id)).name).toBe(`new-name-${team.id}`);
    });

    test("fixes legacy server missing userId suffix", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
    }) => {
      const user = await makeUser();
      // Legacy server created before suffix logic was deployed (no suffix).
      const { catalog, server } = await seed(
        { makeInternalMcpCatalog, makeMcpServer },
        {
          catalogName: "microsoft__playwright-mcp",
          catalogServerType: "local",
          serverName: "microsoft__playwright-mcp",
          serverType: "local",
          scope: "personal",
          ownerId: user.id,
        },
      );

      vi.mocked(McpServerRuntimeManager.restartServer).mockResolvedValue(
        undefined,
      );
      vi.mocked(McpServerRuntimeManager.getOrLoadDeployment).mockResolvedValue({
        waitForDeploymentReady: vi.fn().mockResolvedValue(undefined),
      } as never);
      vi.spyOn(McpServerModel, "getToolsFromServer").mockResolvedValue([]);

      await autoReinstallServer(server, catalog);

      expect((await getServer(server.id)).name).toBe(
        `microsoft__playwright-mcp-${user.id}`,
      );
    });

    test("passes _meta and annotations as meta when syncing tools", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const { catalog, server } = await seed(
        { makeInternalMcpCatalog, makeMcpServer },
        {
          catalogName: "Test Catalog",
          catalogServerType: "remote",
          serverName: "Test Catalog",
          serverType: "remote",
        },
      );

      const toolMeta = { ui: { resourceUri: "mcp://app/view" } };
      const toolAnnotations = { readOnlyHint: true };

      vi.spyOn(McpServerModel, "getToolsFromServer").mockResolvedValue([
        {
          name: "ui-tool",
          description: "Tool with UI",
          inputSchema: {},
          _meta: toolMeta,
          annotations: toolAnnotations,
        },
      ]);

      await autoReinstallServer(server, catalog);

      // The reconciled tool row carries the combined meta payload.
      const [tool] = await getCatalogTools(catalog.id);
      expect(tool.meta).toEqual({
        _meta: toolMeta,
        annotations: toolAnnotations,
      });
    });

    test("succeeds for local server with full flow", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
    }) => {
      const user = await makeUser();
      const { catalog, server } = await seed(
        { makeInternalMcpCatalog, makeMcpServer },
        {
          catalogName: "Test Catalog",
          catalogServerType: "local",
          serverName: `Test Catalog-${user.id}`,
          serverType: "local",
          scope: "personal",
          ownerId: user.id,
        },
      );

      vi.mocked(McpServerRuntimeManager.restartServer).mockResolvedValue(
        undefined,
      );
      vi.mocked(McpServerRuntimeManager.getOrLoadDeployment).mockResolvedValue({
        waitForDeploymentReady: vi.fn().mockResolvedValue(undefined),
      } as never);
      vi.spyOn(McpServerModel, "getToolsFromServer").mockResolvedValue([
        { name: "tool1", description: "First tool", inputSchema: {} },
        { name: "tool2", description: "Second tool", inputSchema: {} },
      ]);

      await autoReinstallServer(server, catalog);

      expect(McpServerRuntimeManager.restartServer).toHaveBeenCalledWith(
        server.id,
      );

      // Both tools were reconciled into the tools table under the catalog.
      const tools = await getCatalogTools(catalog.id);
      const toolNames = tools.map((t) => t.name).sort();
      expect(toolNames).toEqual(
        [
          ToolModel.slugifyName("Test Catalog", "tool1"),
          ToolModel.slugifyName("Test Catalog", "tool2"),
        ].sort(),
      );

      // Name already correct → not renamed; the reinstall flag cleared.
      const updated = await getServer(server.id);
      expect(updated.name).toBe(`Test Catalog-${user.id}`);
      expect(updated.reinstallRequired).toBe(false);
    });
  });

  describe("reinstallMultitenantCatalog", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    test("Phase 2 tool-sync failure flags the install for retry", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      // Two tenants share the catalog. Pod recreate succeeds (Phase 1).
      // Tool fetch fails for tenantB only (Phase 2). We expect tenantB to
      // be flagged `reinstallRequired: true` so the per-install Reinstall
      // button surfaces; otherwise the tenant is stuck with only the red
      // error banner and no retry path.
      const catalog = await makeInternalMcpCatalog({
        name: "shared",
        serverType: "local",
        localConfig: { command: "npm", arguments: ["start"] },
      });
      await db
        .update(schema.internalMcpCatalogTable)
        .set({ catalogReinstallRequired: true })
        .where(eq(schema.internalMcpCatalogTable.id, catalog.id));

      const tenantA = await makeMcpServer({ catalogId: catalog.id });
      const tenantB = await makeMcpServer({ catalogId: catalog.id });

      vi.mocked(
        McpServerRuntimeManager.reinstallSharedDeployment,
      ).mockResolvedValue(undefined);
      vi.spyOn(McpServerModel, "getToolsFromServer").mockImplementation(
        async (server: McpServer) => {
          if (server.id === tenantB.id) {
            throw new Error("tool fetch boom");
          }
          return [];
        },
      );

      await reinstallMultitenantCatalog(catalog);

      // The failing tenant is flagged for retry so its per-install Reinstall
      // button surfaces (mcp-server-card.tsx gates on this flag).
      const failed = await getServer(tenantB.id);
      expect(failed.reinstallRequired).toBe(true);
      expect(failed.localInstallationStatus).toBe("error");

      // The successful tenant finished cleanly and is NOT flagged for retry.
      const ok = await getServer(tenantA.id);
      expect(ok.reinstallRequired).toBe(false);
      expect(ok.localInstallationStatus).toBe("success");

      // Phase 1 succeeded → the catalog-level flag is cleared.
      const [catalogRow] = await db
        .select()
        .from(schema.internalMcpCatalogTable)
        .where(eq(schema.internalMcpCatalogTable.id, catalog.id));
      expect(catalogRow.catalogReinstallRequired).toBe(false);
    });
  });
});

/**
 * Scenario-matrix sweep — runs every entry in `CASCADE_SCENARIOS` (the
 * shared cross-layer cascade behavior contract) against the backend's
 * cascade decision logic.
 *
 *   • Individual predicate checks — `isMetadataOnlyEdit`,
 *     `requiresNewUserInputForReinstall`. Catches algebra changes in a
 *     single predicate.
 *
 *   • Full-cascade-outcome — simulates the route's gate decision tree
 *     (`isMetadataOnlyEdit` → `onlyForwardCompatibleEnvDiff` →
 *     `requiresNewUserInputForReinstall` → auto), maps to a
 *     `CascadeOutcome`, and asserts it equals the scenario's intent.
 *     This is the authoritative end-to-end check the user actually
 *     experiences.
 *
 * Adding a scenario to `shared/cascade-scenarios.ts` automatically
 * extends both sweeps. Failures here mean the backend's behavior has
 * diverged from the contract — either the code needs a fix, or the
 * scenario's expectation needs an update with reviewer sign-off.
 */

/**
 * Pure simulator of `cascadeReinstallForCatalog`'s gate decision tree
 * (`backend/src/routes/internal-mcp-catalog.ts:1722-1739` at the time
 * of writing). Returns the cascade outcome a real catalog edit would
 * produce, without touching the DB, running setImmediate, or doing the
 * actual pod restart. Keep in sync with the route's gate or this test
 * will go quiet on real regressions.
 */
function simulateCascadeOutcome(
  prev: InternalMcpCatalog,
  next: InternalMcpCatalog,
): "skip" | "auto" | "manual" {
  if (
    isMetadataOnlyEdit(
      prev as unknown as Record<string, unknown>,
      next as unknown as Record<string, unknown>,
    )
  ) {
    return "skip";
  }
  if (onlyForwardCompatibleEnvDiff(prev, next)) {
    return "skip";
  }
  if (requiresNewUserInputForReinstall(prev, next)) {
    return "manual";
  }
  return "auto";
}

describe("cascade scenarios — backend predicate sweep", () => {
  test.each(CASCADE_SCENARIOS)("$id ($expected): $userAction", (scenario) => {
    const prev = CATALOG_SHAPES[
      scenario.shape
    ] as unknown as InternalMcpCatalog;
    const next = scenario.edit(
      CATALOG_SHAPES[scenario.shape],
    ) as unknown as InternalMcpCatalog;

    // 1. Shared predicate agreement (sanity — backend uses the same
    //    predicate the shared baseline test verifies).
    const isMetadataOnly = isMetadataOnlyEdit(
      prev as unknown as Record<string, unknown>,
      next as unknown as Record<string, unknown>,
    );
    const sharedExpected: Record<string, boolean> = {
      "metadata-only-diff": true,
      "non-metadata-diff": false,
      "no-diff": false,
    };
    expect(isMetadataOnly).toBe(sharedExpected[scenario.sharedPredicate]);

    // 2. Manual-vs-auto branch agreement (individual predicate level).
    const needsManual = requiresNewUserInputForReinstall(prev, next);
    const backendExpected =
      scenario.knownBackendOverride?.actual ?? scenario.expected;
    expect(needsManual).toBe(backendExpected === "manual");
  });
});

describe("cascade scenarios — backend full-outcome sweep", () => {
  test.each(
    CASCADE_SCENARIOS,
  )("$id full cascade decision ($expected): $userAction", (scenario) => {
    const prev = CATALOG_SHAPES[
      scenario.shape
    ] as unknown as InternalMcpCatalog;
    const next = scenario.edit(
      CATALOG_SHAPES[scenario.shape],
    ) as unknown as InternalMcpCatalog;
    const outcome = simulateCascadeOutcome(prev, next);
    const backendExpected =
      scenario.knownBackendOverride?.actual ?? scenario.expected;
    expect(outcome).toBe(backendExpected);
  });
});
