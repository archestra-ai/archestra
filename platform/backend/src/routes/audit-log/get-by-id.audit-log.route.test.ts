/**
 * Contract: GET /api/audit-logs/:id
 * - Returns a single audit row by ID, strictly scoped to request.organizationId.
 * - 404 for an unknown id and for an id belonging to another organization.
 */

import { randomUUID } from "node:crypto";
import AuditLogModel from "@/models/audit-log";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

function seedRow(organizationId: string) {
  return AuditLogModel.create({
    actorId: null,
    actorType: "user",
    actorName: "Test Actor",
    actorEmail: "actor@example.com",
    action: "auth.signed_in",
    outcome: "success",
    occurredAt: new Date(),
    resourceType: null,
    resourceId: null,
    before: null,
    after: null,
    httpMethod: null,
    httpPath: "/api/auth/sign-in/email",
    httpRoute: null,
    httpStatus: null,
    sourceIp: null,
    userAgent: null,
    organizationId,
  });
}

describe("GET /api/audit-logs/:id", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();

    app = createFastifyInstance();

    // Simulate auth middleware: inject authenticated user + org.
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: auditLogRoutes } = await import("./audit-log.routes");
    await app.register(auditLogRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("returns the audit log event by id", async () => {
    const row = await seedRow(organizationId);

    const response = await app.inject({
      method: "GET",
      url: `/api/audit-logs/${row.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: row.id,
      organizationId,
      action: "auth.signed_in",
      outcome: "success",
      actorEmail: "actor@example.com",
    });
  });

  test("returns 404 for an unknown id", async () => {
    await seedRow(organizationId);

    const response = await app.inject({
      method: "GET",
      url: `/api/audit-logs/${randomUUID()}`,
    });

    expect(response.statusCode).toBe(404);
  });

  test("returns 404 for an id belonging to another organization", async ({
    makeOrganization,
  }) => {
    const otherOrg = await makeOrganization();
    const otherRow = await seedRow(otherOrg.id);

    const response = await app.inject({
      method: "GET",
      url: `/api/audit-logs/${otherRow.id}`,
    });

    expect(response.statusCode).toBe(404);
  });
});
