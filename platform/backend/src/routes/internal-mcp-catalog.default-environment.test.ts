import type { Permissions } from "@archestra/shared";
import { type Mock, vi } from "vitest";
import { EnvironmentResourceDefaultModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";
import { createEnvironment } from "@/services/environments/environment";

const mockHasPermission = hasPermission as Mock;

/**
 * POST /api/internal_mcp_catalog binds a new catalog item to the org's
 * configured landing environment for MCP servers when the caller does not name
 * one. Harness mirrors internal-mcp-catalog.restricted-environment.test.ts: the
 * `mcpRegistry:deploy-to-restricted` probe answers from a per-test flag so the
 * restricted-default fallback can be exercised; every other probe is granted.
 */
describe("Internal MCP Catalog - configured default environment", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let canDeployToRestricted: boolean;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    canDeployToRestricted = false;
    mockHasPermission.mockImplementation(async (permissions: Permissions) => {
      if (permissions.mcpRegistry?.includes("deploy-to-restricted")) {
        return { success: canDeployToRestricted, error: null };
      }
      return { success: true, error: null };
    });

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

  function createBody(environmentId?: string | null) {
    return {
      name: `default-env-${crypto.randomUUID().slice(0, 8)}`,
      serverType: "remote" as const,
      serverUrl: "https://example.com/mcp",
      ...(environmentId !== undefined ? { environmentId } : {}),
    };
  }

  test("an omitted environment lands in the configured default", async () => {
    const explore = await createEnvironment({
      organizationId,
      data: { name: "Explore" },
    });
    await EnvironmentResourceDefaultModel.setForResource({
      organizationId,
      resource: "mcpRegistry",
      environmentId: explore.id,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: createBody(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBe(explore.id);
  });

  test("an explicit null still means the default environment", async () => {
    const explore = await createEnvironment({
      organizationId,
      data: { name: "Explore" },
    });
    await EnvironmentResourceDefaultModel.setForResource({
      organizationId,
      resource: "mcpRegistry",
      environmentId: explore.id,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: createBody(null),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBeNull();
  });

  test("an explicitly named environment wins over the configured default", async () => {
    const explore = await createEnvironment({
      organizationId,
      data: { name: "Explore" },
    });
    const staging = await createEnvironment({
      organizationId,
      data: { name: "Staging" },
    });
    await EnvironmentResourceDefaultModel.setForResource({
      organizationId,
      resource: "mcpRegistry",
      environmentId: explore.id,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: createBody(staging.id),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBe(staging.id);
  });

  test("a default pointing at another kind's environment does not leak across kinds", async () => {
    const launch = await createEnvironment({
      organizationId,
      data: { name: "Launch" },
    });
    await EnvironmentResourceDefaultModel.setForResource({
      organizationId,
      resource: "app",
      environmentId: launch.id,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: createBody(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBeNull();
  });

  test("a restricted default the caller may not deploy to falls back to the default environment", async () => {
    canDeployToRestricted = false;
    const locked = await createEnvironment({
      organizationId,
      data: { name: "Locked", restricted: true },
    });
    await EnvironmentResourceDefaultModel.setForResource({
      organizationId,
      resource: "mcpRegistry",
      environmentId: locked.id,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: createBody(),
    });

    // The create is not refused — it just lands where the caller is allowed.
    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBeNull();
  });

  test("a restricted default applies for a caller who may deploy there", async () => {
    canDeployToRestricted = true;
    const locked = await createEnvironment({
      organizationId,
      data: { name: "Locked", restricted: true },
    });
    await EnvironmentResourceDefaultModel.setForResource({
      organizationId,
      resource: "mcpRegistry",
      environmentId: locked.id,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: createBody(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBe(locked.id);
  });
});
