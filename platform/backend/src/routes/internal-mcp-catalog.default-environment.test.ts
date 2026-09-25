import { type Mock, vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { EnvironmentResourceDefaultModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  createRestrictedEnvironment,
  grantEnvironmentUse,
} from "@/test/environments";
import type { User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";
import { createEnvironment } from "@/services/environments/environment";

const mockHasPermission = hasPermission as Mock;

/**
 * POST /api/internal_mcp_catalog binds a new catalog item to the org's
 * configured landing environment for MCP servers when the caller does not name
 * one. Every role probe is granted; whether the caller may deploy into an
 * environment is a `use` grant on it, so a restricted default is exercised by
 * granting or withholding that.
 */
describe("Internal MCP Catalog - configured default environment", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId);

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
    const locked = await createRestrictedEnvironment({
      organizationId,
      data: { name: "Locked" },
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
    const locked = await createRestrictedEnvironment({
      organizationId,
      data: { name: "Locked" },
    });
    await grantEnvironmentUse({
      organizationId,
      environmentId: locked.id,
      userId: user.id,
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
