import { describe, expect, test } from "@/test";
import type { InternalMcpCatalog } from "@/types";
import { requiresNewUserInputForReinstall } from "./mcp-reinstall";

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
      test("returns false when no prompted env vars exist", () => {
        const oldConfig = createLocalCatalog([]);
        const newConfig = createLocalCatalog([]);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });

      test("returns false when prompted env vars are unchanged", () => {
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

      test("returns true when new prompted env var is added", () => {
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
            key: "NEW_KEY",
            type: "secret" as const,
            promptOnInstallation: true,
          },
        ]);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(true);
      });

      test("returns false when non-prompted env var is added", () => {
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
            key: "NEW_KEY",
            type: "plain_text" as const,
            promptOnInstallation: false,
          },
        ]);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });

      test("returns false when prompted env var is removed", () => {
        const oldConfig = createLocalCatalog([
          {
            key: "API_KEY",
            type: "secret" as const,
            promptOnInstallation: true,
          },
          {
            key: "OLD_KEY",
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
        ]);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });
    });

    describe("remote servers", () => {
      test("returns false when no user config exists", () => {
        const oldConfig = createRemoteCatalog({});
        const newConfig = createRemoteCatalog({});

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });

      test("returns false when user config is unchanged", () => {
        const config = { field: { type: "string", required: true } };
        const oldConfig = createRemoteCatalog(config);
        const newConfig = createRemoteCatalog(config);

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });

      test("returns true when new required user config field is added", () => {
        const oldConfig = createRemoteCatalog({
          existing: { type: "string", required: true },
        });
        const newConfig = createRemoteCatalog({
          existing: { type: "string", required: true },
          newField: { type: "string", required: true },
        });

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(true);
      });

      test("returns false when new optional user config field is added", () => {
        const oldConfig = createRemoteCatalog({
          existing: { type: "string", required: true },
        });
        const newConfig = createRemoteCatalog({
          existing: { type: "string", required: true },
          newField: { type: "string", required: false },
        });

        const result = requiresNewUserInputForReinstall(oldConfig, newConfig);

        expect(result).toBe(false);
      });

      test("returns true when OAuth config is added", () => {
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

      test("returns false when OAuth config already existed", () => {
        const oauthConfig = { authorizationUrl: "https://example.com/auth" };
        const oldConfig = createRemoteCatalog({}, oauthConfig);
        const newConfig = createRemoteCatalog({}, oauthConfig);

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
});
