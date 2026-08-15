import type { RouteId } from "@archestra/shared";
import { requiredEndpointPermissionsMap } from "@archestra/shared/access-control";
import { type Mock, vi } from "vitest";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, describe, expect, test } from "@/test";
import { ApiError, type User } from "@/types";

// Same harness as environment.test.ts: the route plugin is registered on its
// own with `user`/`organizationId` injected, and the middleware's authorization
// gate replicated from the real requiredEndpointPermissionsMap.
vi.mock("@/auth");

vi.mock("@/k8s/mcp-server-runtime/manager", () => ({
  default: {
    isEnabled: false,
    validateNamespace: vi.fn().mockResolvedValue(undefined),
    getOrLoadDeployment: vi.fn().mockResolvedValue(undefined),
    restartServer: vi.fn().mockResolvedValue(undefined),
    reinstallSharedDeployment: vi.fn().mockResolvedValue(undefined),
  },
}));

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

async function buildApp(user: User, organizationId: string) {
  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    (request as typeof request & { user: unknown }).user = user;
    (request as typeof request & { organizationId: string }).organizationId =
      organizationId;

    const routeId = request.routeOptions.schema?.operationId as
      | RouteId
      | undefined;
    const requiredPermissions = routeId
      ? requiredEndpointPermissionsMap[routeId]
      : undefined;
    if (requiredPermissions && Object.keys(requiredPermissions).length > 0) {
      const result = await hasPermission(requiredPermissions, request.headers);
      if (!result.success) {
        throw new ApiError(403, "Forbidden");
      }
    }
  });
  registerAuditLogHook(app);

  const { default: environmentRoutes } = await import("./environment");
  await app.register(environmentRoutes);
  return app;
}

async function createEnvironment(app: FastifyInstanceWithZod, name: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/environments",
    payload: { name },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

describe("environment resource defaults", () => {
  let app: FastifyInstanceWithZod;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) await app.close();
  });

  test("every resource kind starts on the default environment", async ({
    makeUser,
    makeOrganization,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    app = await buildApp(await makeUser(), (await makeOrganization()).id);

    const list = await app.inject({ method: "GET", url: "/api/environments" });
    expect(list.statusCode).toBe(200);
    expect(list.json().resourceDefaults).toEqual({
      mcpRegistry: null,
      app: null,
      agent: null,
      mcpGateway: null,
      llmProxy: null,
      knowledgeSource: null,
    });
  });

  test("points each kind at its own environment and leaves the others alone", async ({
    makeUser,
    makeOrganization,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    app = await buildApp(await makeUser(), (await makeOrganization()).id);

    const explore = await createEnvironment(app, "Explore");
    const launch = await createEnvironment(app, "Launch");

    const updated = await app.inject({
      method: "PUT",
      url: "/api/environments/defaults",
      payload: { mcpRegistry: explore.id, app: launch.id },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      mcpRegistry: explore.id,
      app: launch.id,
      agent: null,
    });

    const list = await app.inject({ method: "GET", url: "/api/environments" });
    expect(list.json().resourceDefaults.mcpRegistry).toBe(explore.id);
    expect(list.json().resourceDefaults.app).toBe(launch.id);
  });

  test("an omitted kind is untouched and an explicit null resets it", async ({
    makeUser,
    makeOrganization,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    app = await buildApp(await makeUser(), (await makeOrganization()).id);

    const explore = await createEnvironment(app, "Explore");
    await app.inject({
      method: "PUT",
      url: "/api/environments/defaults",
      payload: { mcpRegistry: explore.id, agent: explore.id },
    });

    // Only `agent` is named, so `mcpRegistry` keeps its value.
    const partial = await app.inject({
      method: "PUT",
      url: "/api/environments/defaults",
      payload: { agent: null },
    });
    expect(partial.statusCode).toBe(200);
    expect(partial.json().mcpRegistry).toBe(explore.id);
    expect(partial.json().agent).toBeNull();
  });

  test("deleting an environment drops it as a default", async ({
    makeUser,
    makeOrganization,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    app = await buildApp(await makeUser(), (await makeOrganization()).id);

    const explore = await createEnvironment(app, "Explore");
    await app.inject({
      method: "PUT",
      url: "/api/environments/defaults",
      payload: { mcpRegistry: explore.id },
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/environments/${explore.id}`,
    });
    expect(deleted.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/api/environments" });
    expect(list.json().resourceDefaults.mcpRegistry).toBeNull();
  });

  test("rejects an environment from another organization", async ({
    makeUser,
    makeOrganization,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    const otherOrgApp = await buildApp(
      await makeUser(),
      (await makeOrganization()).id,
    );
    const foreign = await createEnvironment(otherOrgApp, "Foreign");
    await otherOrgApp.close();

    app = await buildApp(await makeUser(), (await makeOrganization()).id);
    const response = await app.inject({
      method: "PUT",
      url: "/api/environments/defaults",
      payload: { mcpRegistry: foreign.id },
    });
    expect(response.statusCode).toBe(404);

    const list = await app.inject({ method: "GET", url: "/api/environments" });
    expect(list.json().resourceDefaults.mcpRegistry).toBeNull();
  });

  test("a member without environment:update is refused", async ({
    makeUser,
    makeOrganization,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockImplementation(
      async (permissions: Record<string, string[]>) => ({
        success: !permissions.environment?.includes("update"),
        error: null,
      }),
    );
    app = await buildApp(await makeUser(), (await makeOrganization()).id);

    const response = await app.inject({
      method: "PUT",
      url: "/api/environments/defaults",
      payload: { mcpRegistry: null },
    });
    expect(response.statusCode).toBe(403);
  });

  test("audits the change with a before/after diff of the whole map", async ({
    makeUser,
    makeOrganization,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    const organization = await makeOrganization();
    app = await buildApp(await makeUser(), organization.id);

    const explore = await createEnvironment(app, "Explore");
    await app.inject({
      method: "PUT",
      url: "/api/environments/defaults",
      payload: { mcpRegistry: explore.id },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const { data: rows } = await AuditLogModel.findPaginated({
      organizationId: organization.id,
      resourceType: "environment",
      sortDirection: "asc",
      limit: 50,
      offset: 0,
    });
    const defaultsRow = rows.find(
      (row) => row.resourceId === organization.id && row.action === "environment.updated",
    );
    expect(defaultsRow).toBeDefined();
    expect(defaultsRow?.outcome).toBe("success");
    expect(defaultsRow?.before).toMatchObject({ mcpRegistry: null });
    expect(defaultsRow?.after).toMatchObject({ mcpRegistry: explore.id });
  });
});
