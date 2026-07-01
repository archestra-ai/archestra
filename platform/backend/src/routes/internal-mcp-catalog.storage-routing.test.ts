import { type Mock, vi } from "vitest";
import { InternalMcpCatalogModel } from "@/models";
import { secretManager } from "@/secrets-manager";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

/**
 * Storage-routing matrix: confirms which values land in jsonb columns vs. the
 * `secret` table for every combination of (env vs header) × (static / per-user)
 * × (secret / non-secret).
 *
 * Conventions:
 *   - "env" = `localConfig.environment[i]` (key flag: `type === "secret"`).
 *   - "header" = `userConfig[field]` with `headerName` set (key flag: `sensitive`).
 *   - Static = `promptOnInstallation: false`.
 *   - Per-user = `promptOnInstallation: true`.
 */
describe("Internal MCP Catalog - Storage Routing", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: routes } = await import("./internal-mcp-catalog");
    await app.register(routes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  // ===========================================================================
  // ENV VARS — localConfig.environment[]
  // ===========================================================================

  describe("env vars", () => {
    test("static + non-secret → inline in local_config jsonb, no secret row", async () => {
      const created = await createCatalog({
        name: "env-static-plain",
        serverType: "local",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "LOG_LEVEL",
              type: "plain_text",
              promptOnInstallation: false,
              value: "debug",
            },
          ],
        },
      });

      const row = await loadRaw(created.id);
      expect(row.localConfigSecretId).toBeNull();
      expect(row.localConfig?.environment?.[0]).toMatchObject({
        key: "LOG_LEVEL",
        type: "plain_text",
        value: "debug",
      });
    });

    test("static + secret → value stripped from jsonb, stored in localConfigSecret", async () => {
      const created = await createCatalog({
        name: "env-static-secret",
        serverType: "local",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "API_KEY",
              type: "secret",
              promptOnInstallation: false,
              value: "super-secret-value",
            },
          ],
        },
      });

      const row = await loadRaw(created.id);
      const { localConfigSecretId } = row;
      if (!localConfigSecretId) throw new Error("expected localConfigSecretId");
      expect(row.localConfig?.environment?.[0].value).toBeUndefined();

      const bag = await secretManager().getSecret(localConfigSecretId);
      expect(bag?.secret).toEqual({ API_KEY: "super-secret-value" });
    });

    test("per-user (prompt on installation) + secret → catalog row carries the schema only, no value anywhere", async () => {
      const created = await createCatalog({
        name: "env-per-user-secret",
        serverType: "local",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "USER_TOKEN",
              type: "secret",
              promptOnInstallation: true,
              required: true,
            },
          ],
        },
      });

      const row = await loadRaw(created.id);
      expect(row.localConfigSecretId).toBeNull();
      expect(row.localConfig?.environment?.[0]).toMatchObject({
        key: "USER_TOKEN",
        type: "secret",
        promptOnInstallation: true,
      });
      expect(row.localConfig?.environment?.[0].value).toBeUndefined();
    });

    test("per-user + non-secret → catalog row carries the schema only, no value anywhere", async () => {
      const created = await createCatalog({
        name: "env-per-user-plain",
        serverType: "local",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "WORKSPACE",
              type: "plain_text",
              promptOnInstallation: true,
              required: true,
            },
          ],
        },
      });

      const row = await loadRaw(created.id);
      expect(row.localConfigSecretId).toBeNull();
      expect(row.localConfig?.environment?.[0].value).toBeUndefined();
    });
  });

  // ===========================================================================
  // HEADERS — userConfig[field] with headerName
  // ===========================================================================

  describe("headers", () => {
    test("static + non-sensitive → inline in user_config jsonb default, no secret row", async () => {
      const created = await createCatalog({
        name: "header-static-plain",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        userConfig: {
          tenant_id: {
            type: "string",
            title: "Tenant",
            description: "Tenant header",
            required: false,
            sensitive: false,
            headerName: "x-tenant-id",
            promptOnInstallation: false,
            default: "tenant-42",
          },
        },
      });

      const row = await loadRaw(created.id);
      expect(row.clientSecretId).toBeNull();
      expect(row.localConfigSecretId).toBeNull();
      expect(row.userConfig?.tenant_id.default).toBe("tenant-42");
    });

    test("static + sensitive → rejected at validation (sensitive static header is not allowed)", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog",
        payload: {
          name: "header-static-sensitive",
          serverType: "remote",
          serverUrl: "https://example.com/mcp",
          userConfig: {
            api_key: {
              type: "string",
              title: "API Key",
              description: "Static sensitive",
              required: true,
              sensitive: true,
              headerName: "x-api-key",
              promptOnInstallation: false,
              default: "should-be-rejected",
            },
          },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          message: expect.stringContaining(
            "Static header-mapped userConfig fields cannot be marked sensitive",
          ),
        },
      });
    });

    test("per-user + sensitive → catalog row carries the schema only, no value anywhere", async () => {
      const created = await createCatalog({
        name: "header-per-user-sensitive",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        userConfig: {
          access_token: {
            type: "string",
            title: "Access Token",
            description: "Per-caller token",
            required: true,
            sensitive: true,
            headerName: "authorization",
            promptOnInstallation: true,
          },
        },
      });

      const row = await loadRaw(created.id);
      expect(row.clientSecretId).toBeNull();
      expect(row.localConfigSecretId).toBeNull();
      expect(row.userConfig?.access_token).toMatchObject({
        sensitive: true,
        headerName: "authorization",
        promptOnInstallation: true,
      });
      expect(row.userConfig?.access_token.default).toBeUndefined();
    });

    test("per-user + non-sensitive → catalog row carries the schema only, no value anywhere", async () => {
      const created = await createCatalog({
        name: "header-per-user-plain",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        userConfig: {
          tenant_id: {
            type: "string",
            title: "Tenant",
            description: "Per-caller tenant",
            required: false,
            sensitive: false,
            headerName: "x-tenant-id",
            promptOnInstallation: true,
          },
        },
      });

      const row = await loadRaw(created.id);
      expect(row.localConfigSecretId).toBeNull();
      expect(row.userConfig?.tenant_id.default).toBeUndefined();
    });
  });

  // ===========================================================================
  // Helpers
  // ===========================================================================

  async function createCatalog(payload: Record<string, unknown>): Promise<{
    id: string;
  }> {
    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload,
    });
    if (response.statusCode !== 200) {
      throw new Error(
        `createCatalog failed: ${response.statusCode} ${response.body}`,
      );
    }
    return response.json();
  }

  async function loadRaw(id: string) {
    const row = await InternalMcpCatalogModel.findById(id, {
      expandSecrets: false,
      userId: user.id,
      isAdmin: true,
      organizationId,
    });
    if (!row) throw new Error(`row ${id} not found`);
    return row;
  }
});
