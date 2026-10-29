/**
 * Contract: GET /api/audit-logs/resources
 * - Same permission as GET /api/audit-logs (auditLog:read).
 * - One option per resource of a pickable type that has audit events, named
 *   from its latest named event; other types and other organizations' events
 *   are not offered.
 * - `search` matches the name case-insensitively and literally; `resourceId`
 *   returns just that resource; `limit` bounds the page.
 * - Without auditLog:admin only resources from the caller's own events are
 *   offered.
 */

import { RouteId } from "@archestra/shared";
import { requiredEndpointPermissionsMap } from "@archestra/shared/access-control";
import { vi } from "vitest";
import { betterAuth, hasPermission } from "@/auth";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { MemberModel } from "@/models";
import AuditLogModel from "@/models/audit-log";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { ApiError, type User } from "@/types";

describe("GET /api/audit-logs/resources", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  const seed = (params: {
    organizationId?: string;
    resourceType: string;
    resourceId: string;
    resourceName: string | null;
    actorId?: string | null;
  }) =>
    AuditLogModel.create({
      organizationId: params.organizationId ?? organizationId,
      actorId: params.actorId ?? null,
      actorType: "user",
      actorName: "Test Actor",
      actorEmail: "actor@example.com",
      action: `${params.resourceType}.updated`,
      outcome: "success",
      occurredAt: new Date(),
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      resourceName: params.resourceName,
      before: null,
      after: null,
      httpMethod: "PATCH",
      httpPath: "/api/resource",
      httpRoute: null,
      httpStatus: 200,
      sourceIp: null,
      userAgent: null,
    } as Parameters<typeof AuditLogModel.create>[0]);

  const list = async (query = "") => {
    const response = await app.inject({
      method: "GET",
      url: `/api/audit-logs/resources${query}`,
    });
    return response;
  };

  beforeEach(async ({ makeMember, makeOrganization, makeUser }) => {
    vi.spyOn(betterAuth.api, "getSession").mockImplementation(
      async () => ({ user: { id: user.id } }) as never,
    );
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });
    app.addHook("preHandler", async (request) => {
      const result = await hasPermission(
        requiredEndpointPermissionsMap[RouteId.GetAuditLogResources] ?? {},
        request.headers,
      );
      if (!result.success) throw new ApiError(403, "Forbidden");
    });
    const { default: auditLogRoutes } = await import("./audit-log.routes");
    await app.register(auditLogRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("offers each audited resource once, named from its latest named event", async ({
    makeOrganization,
  }) => {
    await seed({
      resourceType: "agent",
      resourceId: "a1",
      resourceName: "Old",
    });
    await seed({
      resourceType: "agent",
      resourceId: "a1",
      resourceName: "New",
    });
    await seed({ resourceType: "agent", resourceId: "a1", resourceName: null });
    await seed({ resourceType: "team", resourceId: "t1", resourceName: "Ops" });
    // Not a pickable type, and another organization's resource.
    await seed({ resourceType: "user", resourceId: "u1", resourceName: "Ann" });
    const other = await makeOrganization();
    await seed({
      organizationId: other.id,
      resourceType: "agent",
      resourceId: "a2",
      resourceName: "Elsewhere",
    });

    const response = await list();

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      { resourceType: "agent", resourceId: "a1", name: "New" },
      { resourceType: "team", resourceId: "t1", name: "Ops" },
    ]);
  });

  test("searches names literally and case-insensitively, looks up one resource, and bounds the page", async () => {
    await seed({
      resourceType: "skill",
      resourceId: "s1",
      resourceName: "Deploy 100% safe",
    });
    await seed({
      resourceType: "skill",
      resourceId: "s2",
      resourceName: "Deploy 1000 safe",
    });
    await seed({
      resourceType: "role",
      resourceId: "r1",
      resourceName: "Reviewer",
    });

    expect((await list("?search=100%25")).json().data).toEqual([
      { resourceType: "skill", resourceId: "s1", name: "Deploy 100% safe" },
    ]);
    expect(
      (await list("?search=DEPLOY"))
        .json()
        .data.map((option: { resourceId: string }) => option.resourceId),
    ).toEqual(["s1", "s2"]);
    expect((await list("?resourceId=r1")).json().data).toEqual([
      { resourceType: "role", resourceId: "r1", name: "Reviewer" },
    ]);
    expect((await list("?limit=1")).json().data).toHaveLength(1);
    expect((await list("?limit=101")).statusCode).toBe(400);
  });

  test("without auditLog:admin only resources from the caller's own events are offered", async ({
    makeUser,
  }) => {
    const other = await makeUser();
    await seed({
      resourceType: "agent",
      resourceId: "mine",
      resourceName: "Mine",
      actorId: user.id,
    });
    await seed({
      resourceType: "agent",
      resourceId: "theirs",
      resourceName: "Theirs",
      actorId: other.id,
    });
    await MemberModel.updateRole(user.id, organizationId, "platform_admin");

    expect((await list()).json().data).toEqual([
      { resourceType: "agent", resourceId: "mine", name: "Mine" },
    ]);
  });

  test("returns 403 for the member role, like the audit log itself", async () => {
    await MemberModel.updateRole(user.id, organizationId, "member");

    expect((await list()).statusCode).toBe(403);
  });
});
