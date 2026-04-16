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

describe("Internal MCP Catalog - Header User Config Routes", () => {
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

  test("rejects static sensitive header-mapped userConfig fields", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "header-create-route",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        userConfig: {
          access_token: {
            type: "string",
            title: "Access Token",
            description: "Static auth token",
            required: true,
            sensitive: true,
            headerName: "x-api-key",
            promptOnInstallation: false,
            default: "secret-token-123",
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

  test("creates a catalog item with static non-sensitive headers inline without creating a backing secret", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "header-inline-route",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        userConfig: {
          access_token: {
            type: "string",
            title: "Access Token",
            description: "Static non-sensitive auth token",
            required: true,
            sensitive: false,
            headerName: "x-api-key",
            promptOnInstallation: false,
            default: "header-inline-789",
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.localConfigSecretId).toBeNull();
    expect(body.userConfig.access_token.default).toBe("header-inline-789");
  });

  test("updates a static non-sensitive header while preserving existing secret-backed env values and inline non-sensitive headers", async ({
    makeSecret,
  }) => {
    const existingSecret = await makeSecret({
      name: "existing-header-secret",
      secret: {
        access_token: "persisted-secret-token",
      },
    });

    const catalog = await InternalMcpCatalogModel.create(
      {
        name: "header-update-route",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        localConfigSecretId: existingSecret.id,
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "API_SECRET",
              type: "secret",
              promptOnInstallation: false,
            },
          ],
        },
        userConfig: {
          access_token: {
            type: "string",
            title: "Access Token",
            description: "Static non-sensitive auth token",
            required: true,
            sensitive: false,
            headerName: "x-api-key",
            promptOnInstallation: false,
            default: "persisted-inline-token",
          },
        },
      },
      { organizationId, authorId: user.id },
    );

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        userConfig: {
          access_token: {
            type: "string",
            title: "Access Token",
            description: "Static non-sensitive auth token",
            required: true,
            sensitive: false,
            headerName: "x-api-key",
            promptOnInstallation: false,
            default: "updated-inline-token",
          },
          tenant_id: {
            type: "string",
            title: "Tenant ID",
            description: "Static non-sensitive tenant header",
            required: false,
            sensitive: false,
            headerName: "x-tenant-id",
            promptOnInstallation: false,
            default: "tenant-42",
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.userConfig.access_token.default).toBe("updated-inline-token");
    expect(body.userConfig.tenant_id.default).toBe("tenant-42");

    const storedSecret = await secretManager().getSecret(existingSecret.id);
    expect(storedSecret?.secret).toMatchObject({
      access_token: "persisted-secret-token",
    });
    expect(storedSecret?.secret).not.toHaveProperty("tenant_id");
  });

  test("rejects case-insensitive duplicate header names", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "duplicate-headers-route",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        userConfig: {
          first_header: {
            type: "string",
            title: "First Header",
            description: "First",
            required: false,
            sensitive: false,
            headerName: "X-Api-Key",
            promptOnInstallation: true,
          },
          second_header: {
            type: "string",
            title: "Second Header",
            description: "Second",
            required: false,
            sensitive: false,
            headerName: "x-api-key",
            promptOnInstallation: true,
          },
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        message: expect.stringContaining("Header name duplicates field"),
      },
    });
  });

  test("deletes the backing secret when deleting a catalog item with secret-backed local config", async ({
    makeSecret,
  }) => {
    const existingSecret = await makeSecret({
      name: "delete-header-secret",
      secret: {
        API_SECRET: "delete-me",
      },
    });

    const catalog = await InternalMcpCatalogModel.create(
      {
        name: "header-delete-route",
        serverType: "local",
        localConfigSecretId: existingSecret.id,
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "API_SECRET",
              type: "secret",
              promptOnInstallation: false,
            },
          ],
        },
      },
      { organizationId, authorId: user.id },
    );

    const response = await app.inject({
      method: "DELETE",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });

    const deletedSecret = await secretManager().getSecret(existingSecret.id);
    expect(deletedSecret).toBeNull();

    const deletedCatalog = await InternalMcpCatalogModel.findById(catalog.id, {
      expandSecrets: false,
    });
    expect(deletedCatalog).toBeNull();
  });
});
