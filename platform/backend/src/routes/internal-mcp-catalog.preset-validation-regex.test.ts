import { type Mock, vi } from "vitest";
import { InternalMcpCatalogModel, McpPresetEntryModel } from "@/models";
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
 * Enforcement coverage for the preset (named entry) admin-edit path:
 *   POST   /api/internal_mcp_catalog/:parentId/children                — first-time configure
 *   PATCH  /api/internal_mcp_catalog/:parentId/children/:childId       — edit existing preset
 *
 * Symmetric to `internal-mcp-catalog.parent-default-validation-regex.test.ts`
 * (which covers the Default-row path via the parent PUT route) and to
 * `mcp-server.install-validation-regex.test.ts` (the install path). Together
 * the three files exercise the regex check across all three configuration
 * surfaces (Preset / MCP installation / Default preset) × all three field
 * shapes (plain env / secret env / header).
 */
describe("Catalog preset routes — entry validation regex enforcement", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeUser, makeOrganization }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
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
  // POST /:parentId/children — first-time configure
  // ===========================================================================

  test("POST /children rejects PLAIN env value violating entry regex", async ({
    makeInternalMcpCatalog,
  }) => {
    const entry = await McpPresetEntryModel.create({
      organizationId,
      name: "context7",
      validationRegex: "^https://",
    });

    const parent = await makeInternalMcpCatalog({
      organizationId,
      name: "preset-plain-env",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "API_URL",
            type: "plain_text",
            promptOnInstallation: false,
            promptOnPreset: true,
            required: false,
          },
        ],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${parent.id}/children`,
      payload: {
        presetEntryId: entry.id,
        presetFieldValues: { API_URL: "ftp://nope" },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/"API_URL".*"context7"/);
  });

  test("POST /children rejects SECRET env value violating entry regex", async ({
    makeInternalMcpCatalog,
  }) => {
    const entry = await McpPresetEntryModel.create({
      organizationId,
      name: "context7",
      validationRegex: "^sk-",
    });

    const parent = await makeInternalMcpCatalog({
      organizationId,
      name: "preset-secret-env",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "API_TOKEN",
            type: "secret",
            promptOnInstallation: false,
            promptOnPreset: true,
            required: false,
          },
        ],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${parent.id}/children`,
      payload: {
        presetEntryId: entry.id,
        presetFieldValues: { API_TOKEN: "not-a-real-token" },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/"API_TOKEN".*"context7"/);
  });

  test("POST /children rejects HEADER (userConfig) value violating entry regex", async ({
    makeInternalMcpCatalog,
  }) => {
    const entry = await McpPresetEntryModel.create({
      organizationId,
      name: "context7",
      validationRegex: "^acme-",
    });

    const parent = await makeInternalMcpCatalog({
      organizationId,
      name: "preset-header",
      serverType: "remote",
      serverUrl: "https://api.example.com/mcp/",
      userConfig: {
        tenant_id: {
          type: "string",
          title: "Tenant",
          description: "Per-caller tenant",
          required: true,
          sensitive: false,
          headerName: "x-tenant-id",
          promptOnPreset: true,
        },
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${parent.id}/children`,
      payload: {
        presetEntryId: entry.id,
        presetFieldValues: { tenant_id: "other-tenant" },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/"tenant_id".*"context7"/);
  });

  test("POST /children accepts matching values (positive path)", async ({
    makeInternalMcpCatalog,
  }) => {
    const entry = await McpPresetEntryModel.create({
      organizationId,
      name: "context7",
      validationRegex: "^https://",
    });

    const parent = await makeInternalMcpCatalog({
      organizationId,
      name: "preset-positive",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "API_URL",
            type: "plain_text",
            promptOnInstallation: false,
            promptOnPreset: true,
            required: false,
          },
        ],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${parent.id}/children`,
      payload: {
        presetEntryId: entry.id,
        presetFieldValues: { API_URL: "https://api.example.com" },
      },
    });

    expect(res.statusCode).toBe(200);
  });

  // ===========================================================================
  // PATCH /:parentId/children/:childId — edit existing preset
  // ===========================================================================

  test("PATCH /children/:id rejects PLAIN env value violating entry regex", async ({
    makeInternalMcpCatalog,
  }) => {
    const entry = await McpPresetEntryModel.create({
      organizationId,
      name: "context7",
      validationRegex: "^https://",
    });

    const parent = await makeInternalMcpCatalog({
      organizationId,
      name: "preset-patch-plain-env",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "API_URL",
            type: "plain_text",
            promptOnInstallation: false,
            promptOnPreset: true,
            required: false,
          },
        ],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });

    const child = await InternalMcpCatalogModel.create(
      {
        name: `${parent.name}-context7`,
        childName: "context7",
        serverType: parent.serverType,
        localConfig: parent.localConfig,
        presetEntryId: entry.id,
        parentCatalogItemId: parent.id,
        scope: parent.scope,
      },
      { organizationId, authorId: user.id },
    );

    const res = await app.inject({
      method: "PATCH",
      url: `/api/internal_mcp_catalog/${parent.id}/children/${child.id}`,
      payload: { presetFieldValues: { API_URL: "ftp://nope" } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/"API_URL".*"context7"/);
  });

  test("PATCH /children/:id rejects SECRET env value violating entry regex", async ({
    makeInternalMcpCatalog,
  }) => {
    const entry = await McpPresetEntryModel.create({
      organizationId,
      name: "context7",
      validationRegex: "^sk-",
    });

    const parent = await makeInternalMcpCatalog({
      organizationId,
      name: "preset-patch-secret-env",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "API_TOKEN",
            type: "secret",
            promptOnInstallation: false,
            promptOnPreset: true,
            required: false,
          },
        ],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });

    const child = await InternalMcpCatalogModel.create(
      {
        name: `${parent.name}-context7`,
        childName: "context7",
        serverType: parent.serverType,
        localConfig: parent.localConfig,
        presetEntryId: entry.id,
        parentCatalogItemId: parent.id,
        scope: parent.scope,
      },
      { organizationId, authorId: user.id },
    );

    const res = await app.inject({
      method: "PATCH",
      url: `/api/internal_mcp_catalog/${parent.id}/children/${child.id}`,
      payload: { presetFieldValues: { API_TOKEN: "not-a-real-token" } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/"API_TOKEN".*"context7"/);
  });

  test("PATCH /children/:id rejects HEADER (userConfig) value violating entry regex", async ({
    makeInternalMcpCatalog,
  }) => {
    const entry = await McpPresetEntryModel.create({
      organizationId,
      name: "context7",
      validationRegex: "^acme-",
    });

    const parent = await makeInternalMcpCatalog({
      organizationId,
      name: "preset-patch-header",
      serverType: "remote",
      serverUrl: "https://api.example.com/mcp/",
      userConfig: {
        tenant_id: {
          type: "string",
          title: "Tenant",
          description: "Per-caller tenant",
          required: true,
          sensitive: false,
          headerName: "x-tenant-id",
          promptOnPreset: true,
        },
      },
    });

    const child = await InternalMcpCatalogModel.create(
      {
        name: `${parent.name}-context7`,
        childName: "context7",
        serverType: parent.serverType,
        serverUrl: parent.serverUrl,
        userConfig: parent.userConfig,
        presetEntryId: entry.id,
        parentCatalogItemId: parent.id,
        scope: parent.scope,
      },
      { organizationId, authorId: user.id },
    );

    const res = await app.inject({
      method: "PATCH",
      url: `/api/internal_mcp_catalog/${parent.id}/children/${child.id}`,
      payload: { presetFieldValues: { tenant_id: "other-tenant" } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/"tenant_id".*"context7"/);
  });

  test("PATCH /children/:id accepts matching values (positive path)", async ({
    makeInternalMcpCatalog,
  }) => {
    const entry = await McpPresetEntryModel.create({
      organizationId,
      name: "context7",
      validationRegex: "^https://",
    });

    const parent = await makeInternalMcpCatalog({
      organizationId,
      name: "preset-patch-positive",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "API_URL",
            type: "plain_text",
            promptOnInstallation: false,
            promptOnPreset: true,
            required: false,
          },
        ],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });

    const child = await InternalMcpCatalogModel.create(
      {
        name: `${parent.name}-context7`,
        childName: "context7",
        serverType: parent.serverType,
        localConfig: parent.localConfig,
        presetEntryId: entry.id,
        parentCatalogItemId: parent.id,
        scope: parent.scope,
      },
      { organizationId, authorId: user.id },
    );

    const res = await app.inject({
      method: "PATCH",
      url: `/api/internal_mcp_catalog/${parent.id}/children/${child.id}`,
      payload: { presetFieldValues: { API_URL: "https://api.example.com" } },
    });

    expect(res.statusCode).toBe(200);
  });
});
