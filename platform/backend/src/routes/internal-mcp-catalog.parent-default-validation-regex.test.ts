import { type Mock, vi } from "vitest";
import { OrganizationModel } from "@/models";
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
 * Pins the symmetric backend gap-fix: when an admin (or anyone with API
 * access) writes default-scoped `presetFieldValues` directly via the parent
 * PUT route, the org-wide `presetEntityDefaultValidationRegex` must reject
 * mismatched values — not just the inline frontend guard.
 */
describe("PUT /api/internal_mcp_catalog/:id — default validation regex", () => {
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

  test("rejects parent PUT with default presetFieldValues that violate the org default regex", async ({
    makeInternalMcpCatalog,
  }) => {
    await OrganizationModel.patch(organizationId, {
      presetEntityDefaultValidationRegex: "^(?!.*world).*$",
      presetEntityDefaultLabel: "Default",
    });

    const parent = await makeInternalMcpCatalog({
      organizationId,
      name: "parent-default-regex",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "test",
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
      method: "PUT",
      url: `/api/internal_mcp_catalog/${parent.id}`,
      payload: {
        ...parent,
        presetFieldValues: { test: "world" },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/"test".*"Default"/);
  });

  test("accepts the same PUT when the value passes the regex", async ({
    makeInternalMcpCatalog,
  }) => {
    await OrganizationModel.patch(organizationId, {
      presetEntityDefaultValidationRegex: "^(?!.*world).*$",
    });

    const parent = await makeInternalMcpCatalog({
      organizationId,
      name: "parent-default-regex-pass",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "test",
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
      method: "PUT",
      url: `/api/internal_mcp_catalog/${parent.id}`,
      payload: {
        ...parent,
        presetFieldValues: { test: "hello" },
      },
    });

    expect(res.statusCode).toBe(200);
  });

  test("accepts the PUT when the org has no default regex set", async ({
    makeInternalMcpCatalog,
  }) => {
    const parent = await makeInternalMcpCatalog({
      organizationId,
      name: "parent-no-regex",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "test",
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
      method: "PUT",
      url: `/api/internal_mcp_catalog/${parent.id}`,
      payload: {
        ...parent,
        presetFieldValues: { test: "world" },
      },
    });

    expect(res.statusCode).toBe(200);
  });

  test("rejects parent PUT with default presetFieldValues for a SECRET env that violates the regex", async ({
    makeInternalMcpCatalog,
  }) => {
    await OrganizationModel.patch(organizationId, {
      presetEntityDefaultValidationRegex: "^sk-",
      presetEntityDefaultLabel: "Default",
    });

    const parent = await makeInternalMcpCatalog({
      organizationId,
      name: "parent-default-secret-regex",
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
      method: "PUT",
      url: `/api/internal_mcp_catalog/${parent.id}`,
      payload: {
        ...parent,
        presetFieldValues: { API_TOKEN: "not-a-real-token" },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/"API_TOKEN".*"Default"/);
  });

  test("rejects parent PUT with default presetFieldValues for a HEADER (userConfig) that violates the regex", async ({
    makeInternalMcpCatalog,
  }) => {
    await OrganizationModel.patch(organizationId, {
      presetEntityDefaultValidationRegex: "^acme-",
      presetEntityDefaultLabel: "Default",
    });

    const parent = await makeInternalMcpCatalog({
      organizationId,
      name: "parent-default-header-regex",
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
      method: "PUT",
      url: `/api/internal_mcp_catalog/${parent.id}`,
      payload: {
        ...parent,
        presetFieldValues: { tenant_id: "other-tenant" },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/"tenant_id".*"Default"/);
  });
});
