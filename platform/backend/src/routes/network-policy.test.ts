import type { RouteId } from "@shared";
import { requiredEndpointPermissionsMap } from "@shared/access-control";
import { type Mock, vi } from "vitest";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, describe, expect, test } from "@/test";
import { ApiError, type User } from "@/types";

vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

import { hasPermission } from "@/auth";
import { createEnvironment } from "@/services/environments/environment";

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

  const { default: networkPolicyRoutes } = await import("./network-policy");
  await app.register(networkPolicyRoutes);
  return app;
}

async function settleAuditWrites() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function getAuditRows(organizationId: string) {
  const { data } = await AuditLogModel.findPaginated({
    organizationId,
    resourceType: "networkPolicy",
    sortDirection: "asc",
    limit: 50,
    offset: 0,
  });
  return data;
}

describe("network policy routes", () => {
  let app: FastifyInstanceWithZod;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) await app.close();
  });

  test("admin can create, list, update, and delete a network policy", async ({
    makeOrganization,
    makeUser,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    const user = await makeUser();
    const organization = await makeOrganization();
    app = await buildApp(user, organization.id);

    const created = await app.inject({
      method: "POST",
      url: "/api/network-policies",
      payload: {
        name: "Package installs",
        description: "Allow package downloads",
        egressMode: "restricted",
        domainPreset: "package_managers",
        allowedDomains: ["api.example.com", "*.example.org"],
        allowedCidrs: ["203.0.113.0/24"],
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      name: "Package installs",
      description: "Allow package downloads",
      egressMode: "restricted",
      domainPreset: "package_managers",
      allowedDomains: ["api.example.com", "*.example.org"],
      allowedCidrs: ["203.0.113.0/24"],
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/network-policies",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);
    expect(listed.json()[0]).toMatchObject({
      id: created.json().id,
      references: {
        environments: 0,
        defaultEnvironments: 0,
      },
    });

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/network-policies/${created.json().id}`,
      payload: {
        name: "Dependency installs",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      name: "Dependency installs",
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/network-policies/${created.json().id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ success: true });

    await settleAuditWrites();
    const auditRows = await getAuditRows(organization.id);
    expect(auditRows).toHaveLength(3);
    expect(auditRows.map((row) => row.action)).toEqual([
      "networkPolicy.created",
      "networkPolicy.updated",
      "networkPolicy.deleted",
    ]);
    expect(auditRows.map((row) => row.resourceId)).toEqual([
      created.json().id,
      created.json().id,
      created.json().id,
    ]);
    expect(auditRows.every((row) => row.outcome === "success")).toBe(true);
    expect(auditRows[0].before).toBeNull();
    expect(auditRows[0].after).toMatchObject({
      id: created.json().id,
      name: "Package installs",
      domainPreset: "package_managers",
      allowedDomains: ["api.example.com", "*.example.org"],
      allowedCidrs: ["203.0.113.0/24"],
    });
    expect(auditRows[1].before).toMatchObject({
      id: created.json().id,
      name: "Package installs",
    });
    expect(auditRows[1].after).toMatchObject({
      id: created.json().id,
      name: "Dependency installs",
    });
    expect(auditRows[2].before).toMatchObject({
      id: created.json().id,
      name: "Dependency installs",
    });
    expect(auditRows[2].after).toBeNull();
  });

  test("requires networkPolicy create permission", async ({
    makeOrganization,
    makeUser,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({
      success: false,
      error: new Error("Forbidden"),
    });
    const user = await makeUser();
    const organization = await makeOrganization();
    app = await buildApp(user, organization.id);

    const response = await app.inject({
      method: "POST",
      url: "/api/network-policies",
      payload: { name: "No access" },
    });
    expect(response.statusCode).toBe(403);
    expect(mockHasPermission).toHaveBeenCalledWith(
      { networkPolicy: ["create"] },
      expect.any(Object),
    );
  });

  for (const [method, url, expectedPermission] of [
    ["GET", "/api/network-policies", { networkPolicy: ["read"] }],
    [
      "PATCH",
      "/api/network-policies/00000000-0000-0000-0000-000000000000",
      { networkPolicy: ["update"] },
    ],
    [
      "DELETE",
      "/api/network-policies/00000000-0000-0000-0000-000000000000",
      { networkPolicy: ["delete"] },
    ],
  ] as const) {
    test(`requires networkPolicy permission for ${method} ${url}`, async ({
      makeOrganization,
      makeUser,
    }) => {
      vi.clearAllMocks();
      mockHasPermission.mockResolvedValue({
        success: false,
        error: new Error("Forbidden"),
      });
      const user = await makeUser();
      const organization = await makeOrganization();
      app = await buildApp(user, organization.id);

      const response = await app.inject({
        method,
        url,
        payload: method === "PATCH" ? { name: "No access" } : undefined,
      });
      expect(response.statusCode).toBe(403);
      expect(mockHasPermission).toHaveBeenCalledWith(
        expectedPermission,
        expect.any(Object),
      );
    });
  }

  test("duplicate names return 409", async ({ makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    const user = await makeUser();
    const organization = await makeOrganization();
    app = await buildApp(user, organization.id);

    const first = await app.inject({
      method: "POST",
      url: "/api/network-policies",
      payload: { name: "Same name" },
    });
    expect(first.statusCode).toBe(200);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/network-policies",
      payload: { name: "Same name" },
    });
    expect(duplicate.statusCode).toBe(409);
  });

  test("invalid CIDR rules return 400", async ({
    makeOrganization,
    makeUser,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    const user = await makeUser();
    const organization = await makeOrganization();
    app = await buildApp(user, organization.id);

    const response = await app.inject({
      method: "POST",
      url: "/api/network-policies",
      payload: {
        name: "Invalid CIDR",
        allowedCidrs: ["not-a-cidr"],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  test("invalid domains return 400", async ({ makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    const user = await makeUser();
    const organization = await makeOrganization();
    app = await buildApp(user, organization.id);

    const response = await app.inject({
      method: "POST",
      url: "/api/network-policies",
      payload: {
        name: "Invalid domain",
        allowedDomains: ["https://example.com/path"],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  test("delete returns 409 while policy is assigned to an environment", async ({
    makeOrganization,
    makeUser,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    const user = await makeUser();
    const organization = await makeOrganization();
    app = await buildApp(user, organization.id);

    const created = await app.inject({
      method: "POST",
      url: "/api/network-policies",
      payload: { name: "Environment egress" },
    });
    expect(created.statusCode).toBe(200);
    const policyId = created.json().id as string;

    await createEnvironment({
      organizationId: organization.id,
      data: { name: "Sandbox", networkPolicyId: policyId },
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/network-policies",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()[0].references.environments).toBe(1);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/network-policies/${policyId}`,
    });
    expect(deleted.statusCode).toBe(409);
  });
});
