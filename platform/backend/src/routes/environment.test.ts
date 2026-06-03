import type { RouteId } from "@shared";
import { requiredEndpointPermissionsMap } from "@shared/access-control";
import { type Mock, vi } from "vitest";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, describe, expect, test } from "@/test";
import { ApiError, type User } from "@/types";

// Mirrors the harness in mcp-preset-entry.validation-regex.test.ts: the route
// plugin is registered on its own, with `user`/`organizationId` injected via an
// onRequest hook and `hasPermission` mocked. To exercise the real route ->
// permission map wiring (and a genuine 403 for a non-permitted member), the hook
// replicates the middleware's authorization gate using the actual
// requiredEndpointPermissionsMap.
vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

// Keep the K8s runtime ENABLED but stub the actual cluster calls, so the route
// exercises its real namespace-validation branch without depending on whether
// the machine running the test has a reachable kubeconfig (it does locally, not
// in CI). validateNamespace resolves → the namespace is treated as valid.
vi.mock("@/k8s/mcp-server-runtime/manager", () => ({
  default: {
    isEnabled: true,
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

async function settleAuditWrites() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function getAuditRows(organizationId: string) {
  const { data } = await AuditLogModel.findPaginated({
    organizationId,
    resourceType: "environment",
    sortDirection: "asc",
    limit: 50,
    offset: 0,
  });
  return data;
}

describe("environment routes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) await app.close();
  });

  test("admin can create, list, update, and delete an environment", async ({
    makeUser,
    makeOrganization,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    const user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    app = await buildApp(user, organizationId);

    const created = await app.inject({
      method: "POST",
      url: "/api/environments",
      payload: { name: "Production", namespace: "prod" },
    });
    expect(created.statusCode).toBe(200);
    const env = created.json();
    expect(env.name).toBe("Production");
    expect(env.namespace).toBe("prod");

    const list = await app.inject({
      method: "GET",
      url: "/api/environments",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().environments).toHaveLength(1);
    expect(list.json().environments[0].assignedCatalogCount).toBe(0);
    expect(list.json().defaultAssignedCatalogCount).toBe(0);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/environments/${env.id}`,
      payload: { name: "Production EU", namespace: "prod-eu" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().namespace).toBe("prod-eu");
    expect(updated.json().name).toBe("Production EU");

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/environments/${env.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().success).toBe(true);

    await settleAuditWrites();
    const auditRows = await getAuditRows(organizationId);
    expect(auditRows).toHaveLength(3);
    expect(auditRows.map((row) => row.action)).toEqual([
      "environment.created",
      "environment.updated",
      "environment.deleted",
    ]);
    expect(auditRows.map((row) => row.resourceId)).toEqual([
      env.id,
      env.id,
      env.id,
    ]);
    expect(auditRows.every((row) => row.outcome === "success")).toBe(true);
    expect(auditRows[0].before).toBeNull();
    expect(auditRows[0].after).toMatchObject({
      id: env.id,
      name: "Production",
      namespace: "prod",
    });
    expect(auditRows[1].before).toMatchObject({
      id: env.id,
      name: "Production",
      namespace: "prod",
    });
    expect(auditRows[1].after).toMatchObject({
      id: env.id,
      name: "Production EU",
      namespace: "prod-eu",
    });
    expect(auditRows[2].before).toMatchObject({
      id: env.id,
      name: "Production EU",
      namespace: "prod-eu",
    });
    expect(auditRows[2].after).toBeNull();
  });

  test("can create and update an environment network egress policy", async ({
    makeUser,
    makeOrganization,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    const user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    app = await buildApp(user, organizationId);
    const policy = {
      egressMode: "restricted",
      domainPreset: "package_managers",
      allowedDomains: ["registry.npmjs.org"],
      allowedCidrs: ["203.0.113.0/24"],
    };

    const created = await app.inject({
      method: "POST",
      url: "/api/environments",
      payload: { name: "Sandbox", networkPolicy: policy },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().networkPolicy).toEqual(policy);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/environments/${created.json().id}`,
      payload: { networkPolicy: null },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().networkPolicy).toBeNull();
  });

  test("member without environment:admin is forbidden from creating", async ({
    makeUser,
    makeOrganization,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({
      success: false,
      error: new Error("Forbidden"),
    });
    const user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    app = await buildApp(user, organizationId);

    const res = await app.inject({
      method: "POST",
      url: "/api/environments",
      payload: { name: "Nope" },
    });
    expect(res.statusCode).toBe(403);
  });

  test("duplicate name returns 409", async ({ makeUser, makeOrganization }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    const user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    app = await buildApp(user, organizationId);

    const payload = { name: "Staging" };
    const first = await app.inject({
      method: "POST",
      url: "/api/environments",
      payload,
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: "/api/environments",
      payload,
    });
    expect(second.statusCode).toBe(409);
  });
});
