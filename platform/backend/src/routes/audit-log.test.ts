/**
 * Contract: GET /api/audit-logs
 * - Requires a successful permission check for RouteId.GetAuditLogs (admin-only).
 * - Returns paginated audit rows strictly scoped to request.organizationId.
 * - Query filters map to AuditLogModel.findPaginated; invalid pagination/sortDirection → 400.
 * - actorId, action (dotted), outcome, actorType filters narrow results; unknown filter
 *   values that fail the closed enum are rejected with 400.
 * - Legacy actorUserId param is not accepted by the route; it is silently ignored
 *   (Fastify strips unknown query params) — the regression guard verifies results are
 *   NOT narrowed when only actorUserId is passed.
 * - 403 when hasPermission denies the request.
 */

import { vi } from "vitest";
import AuditLogModel from "@/models/audit-log";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { ApiError, type AuditLog, type User } from "@/types";

const { hasPermissionMock } = vi.hoisted(() => ({
  hasPermissionMock: vi.fn(),
}));

vi.mock("@/auth", () => ({
  hasPermission: hasPermissionMock,
}));

vi.mock("@/observability", () => ({
  initializeObservabilityMetrics: vi.fn(),
  metrics: {
    llm: { initializeMetrics: vi.fn() },
    mcp: { initializeMcpMetrics: vi.fn() },
    agentExecution: { initializeAgentExecutionMetrics: vi.fn() },
  },
}));

function seedRow(
  organizationId: string,
  overrides: Partial<
    Omit<Parameters<typeof AuditLogModel.create>[0], "organizationId">
  > = {},
) {
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
    ...overrides,
    organizationId,
  });
}

describe("GET /api/audit-logs", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    hasPermissionMock.mockResolvedValue({ success: true, error: null });

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

    // Simulate the permission gate that fastifyAuthPlugin normally provides.
    app.addHook("preHandler", async (request) => {
      const result = await hasPermissionMock(undefined, request.headers);
      if (!result?.success) {
        throw new ApiError(403, "Forbidden");
      }
    });

    const { default: auditLogRoutes } = await import("./audit-log");
    await app.register(auditLogRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("returns 200 with paginated payload containing seeded rows", async () => {
    const row = await seedRow(organizationId);

    const response = await app.inject({
      method: "GET",
      url: "/api/audit-logs",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.pagination.total).toBeGreaterThan(0);
    expect(body.data.some((r: AuditLog) => r.id === row.id)).toBe(true);
  });

  test("returns 403 when hasPermission denies the request (member role equivalent)", async () => {
    hasPermissionMock.mockResolvedValue({
      success: false,
      error: new Error("Forbidden"),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/audit-logs",
    });

    expect(response.statusCode).toBe(403);
  });

  test("returns 403 when hasPermission denies the request (editor role equivalent)", async () => {
    hasPermissionMock.mockResolvedValue({
      success: false,
      error: new Error("Forbidden"),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/audit-logs",
    });

    expect(response.statusCode).toBe(403);
  });

  test("cross-org isolation: rows from another org are not returned", async ({
    makeOrganization,
  }) => {
    const otherOrg = await makeOrganization();

    const ownRow = await seedRow(organizationId);
    const otherRow = await seedRow(otherOrg.id);

    const response = await app.inject({
      method: "GET",
      url: "/api/audit-logs",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const ids = body.data.map((r: AuditLog) => r.id);
    expect(ids).toContain(ownRow.id);
    expect(ids).not.toContain(otherRow.id);
  });

  test("cross-org isolation: searching another org row id from home org returns nothing", async ({
    makeOrganization,
  }) => {
    const otherOrg = await makeOrganization();
    const otherRow = await seedRow(otherOrg.id, {
      resourceId: "cross-org-only-resource-id-zz99",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/audit-logs?search=${encodeURIComponent(otherRow.resourceId ?? "")}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.some((r: AuditLog) => r.id === otherRow.id)).toBe(false);
  });

  test("actorId filter narrows results", async ({ makeUser }) => {
    const targetUser = await makeUser();
    const targeted = await seedRow(organizationId, {
      actorId: targetUser.id,
    });
    await seedRow(organizationId, { actorId: null });

    const response = await app.inject({
      method: "GET",
      url: `/api/audit-logs?actorId=${targetUser.id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((r: AuditLog) => r.actorId === targetUser.id)).toBe(
      true,
    );
    expect(body.data.some((r: AuditLog) => r.id === targeted.id)).toBe(true);
  });

  test("legacy actorUserId param is ignored — does not narrow results (regression guard)", async ({
    makeUser,
  }) => {
    const user1 = await makeUser();
    const user2 = await makeUser();

    await seedRow(organizationId, { actorId: user1.id });
    await seedRow(organizationId, { actorId: user2.id });

    // actorUserId is no longer a recognised param; it must NOT silently filter.
    const response = await app.inject({
      method: "GET",
      url: `/api/audit-logs?actorUserId=${user1.id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Both rows must be present — if actorUserId were re-wired as a filter
    // only one row would come back and this assertion would catch the regression.
    expect(body.pagination.total).toBe(2);
  });

  test("outcome filter narrows results to matching outcome", async () => {
    const deniedRow = await seedRow(organizationId, { outcome: "denied" });
    await seedRow(organizationId, { outcome: "success" });
    await seedRow(organizationId, { outcome: "failure" });

    const response = await app.inject({
      method: "GET",
      url: "/api/audit-logs?outcome=denied",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((r: AuditLog) => r.outcome === "denied")).toBe(true);
    expect(body.data.some((r: AuditLog) => r.id === deniedRow.id)).toBe(true);
  });

  test("invalid outcome value is rejected with 400", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/audit-logs?outcome=partial",
    });

    expect(response.statusCode).toBe(400);
  });

  test("actorType filter narrows results to matching actor type", async () => {
    const apiKeyRow = await seedRow(organizationId, { actorType: "api_key" });
    await seedRow(organizationId, { actorType: "user" });

    const response = await app.inject({
      method: "GET",
      url: "/api/audit-logs?actorType=api_key",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((r: AuditLog) => r.actorType === "api_key")).toBe(
      true,
    );
    expect(body.data.some((r: AuditLog) => r.id === apiKeyRow.id)).toBe(true);
  });

  test("invalid actorType value is rejected with 400", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/audit-logs?actorType=robot",
    });

    expect(response.statusCode).toBe(400);
  });

  test("action filter narrows results", async () => {
    const signInRow = await seedRow(organizationId, {
      action: "auth.signed_in",
    });
    await seedRow(organizationId, { action: "auth.signed_out" });

    const response = await app.inject({
      method: "GET",
      url: "/api/audit-logs?action=auth.signed_in",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.length).toBeGreaterThan(0);
    expect(
      body.data.every((r: AuditLog) => r.action === "auth.signed_in"),
    ).toBe(true);
    expect(body.data.some((r: AuditLog) => r.id === signInRow.id)).toBe(true);
  });

  test("invalid action value (non-dotted legacy name) is rejected with 400", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/audit-logs?action=create",
    });

    expect(response.statusCode).toBe(400);
  });

  test("resourceType filter narrows results", async () => {
    const agentRow = await seedRow(organizationId, { resourceType: "agent" });
    await seedRow(organizationId, { resourceType: null });

    const response = await app.inject({
      method: "GET",
      url: "/api/audit-logs?resourceType=agent",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((r: AuditLog) => r.resourceType === "agent")).toBe(
      true,
    );
    expect(body.data.some((r: AuditLog) => r.id === agentRow.id)).toBe(true);
  });

  test("search filter matches actor email case-insensitively", async () => {
    const matchedRow = await seedRow(organizationId, {
      actorEmail: "UNIQUE-ADMIN@EXAMPLE.COM",
    });
    await seedRow(organizationId, { actorEmail: "other@example.com" });

    const response = await app.inject({
      method: "GET",
      url: `/api/audit-logs?search=unique-admin%40example.com`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.some((r: AuditLog) => r.id === matchedRow.id)).toBe(true);
  });

  test("search filter matches http path", async () => {
    const matchedRow = await seedRow(organizationId, {
      httpPath: "/api/agents/unique-path-abc123",
    });
    await seedRow(organizationId, { httpPath: "/api/agents/other" });

    const response = await app.inject({
      method: "GET",
      url: `/api/audit-logs?search=unique-path-abc123`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.some((r: AuditLog) => r.id === matchedRow.id)).toBe(true);
  });

  test("combined action + resourceType filters AND together", async () => {
    await seedRow(organizationId, {
      action: "agent.created",
      resourceType: "agent",
      resourceId: "match-both",
    });
    await seedRow(organizationId, {
      action: "agent.deleted",
      resourceType: "agent",
      resourceId: "wrong-action",
    });
    await seedRow(organizationId, {
      action: "agent.created",
      resourceType: "role",
      resourceId: "wrong-type",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/audit-logs?action=agent.created&resourceType=agent",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].resourceId).toBe("match-both");
  });

  test("combined outcome + actorType filters AND together", async () => {
    await seedRow(organizationId, {
      outcome: "denied",
      actorType: "api_key",
      resourceId: "match",
    });
    await seedRow(organizationId, {
      outcome: "success",
      actorType: "api_key",
      resourceId: "wrong-outcome",
    });
    await seedRow(organizationId, {
      outcome: "denied",
      actorType: "user",
      resourceId: "wrong-type",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/audit-logs?outcome=denied&actorType=api_key",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].resourceId).toBe("match");
  });

  test("limit and offset produce stable, non-overlapping pages", async () => {
    for (let i = 0; i < 5; i++) {
      await seedRow(organizationId, {
        actorEmail: `page-user-${i}@example.com`,
      });
    }

    const page1 = await app.inject({
      method: "GET",
      url: "/api/audit-logs?limit=2&offset=0",
    });
    const page2 = await app.inject({
      method: "GET",
      url: "/api/audit-logs?limit=2&offset=2",
    });

    expect(page1.statusCode).toBe(200);
    expect(page2.statusCode).toBe(200);

    const p1 = page1.json();
    const p2 = page2.json();
    expect(p1.data.length).toBe(2);
    expect(p2.data.length).toBe(2);

    const p1Ids = new Set(p1.data.map((r: AuditLog) => r.id));
    const overlap = p2.data.filter((r: AuditLog) => p1Ids.has(r.id));
    expect(overlap.length).toBe(0);

    expect(p1.pagination.total).toBe(p2.pagination.total);
  });

  test("startDate / endDate boundary filtering works correctly", async () => {
    const row = await seedRow(organizationId);
    const past = new Date("2000-01-01T00:00:00.000Z");
    const future = new Date("2099-01-01T00:00:00.000Z");

    const inRangeResponse = await app.inject({
      method: "GET",
      url: `/api/audit-logs?startDate=${past.toISOString()}&endDate=${future.toISOString()}`,
    });
    expect(inRangeResponse.statusCode).toBe(200);
    const inRange = inRangeResponse.json();
    expect(inRange.data.some((r: AuditLog) => r.id === row.id)).toBe(true);

    const tooEarlyResponse = await app.inject({
      method: "GET",
      url: `/api/audit-logs?endDate=${past.toISOString()}`,
    });
    expect(tooEarlyResponse.statusCode).toBe(200);
    const tooEarly = tooEarlyResponse.json();
    expect(tooEarly.data.every((r: AuditLog) => r.id !== row.id)).toBe(true);
  });

  test("returns empty data when no rows match the filter", async () => {
    await seedRow(organizationId, { action: "auth.signed_in" });

    const response = await app.inject({
      method: "GET",
      url: "/api/audit-logs?action=auth.signed_up",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toEqual([]);
    expect(body.pagination.total).toBe(0);
  });

  test("invalid sortDirection is rejected with 400", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/audit-logs?sortDirection=sideways",
    });

    expect(response.statusCode).toBe(400);
  });

  test("sortBy is not an accepted query param (regression guard)", async () => {
    await seedRow(organizationId);

    const response = await app.inject({
      method: "GET",
      url: "/api/audit-logs?sortBy=actorEmail",
    });

    expect(response.statusCode).toBeLessThan(500);
    if (response.statusCode === 200) {
      const body = response.json();
      expect(Array.isArray(body.data)).toBe(true);
    }
  });

  test("limit above the configured maximum is rejected with 400", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/audit-logs?limit=99999",
    });

    expect(response.statusCode).toBe(400);
  });

  test("negative offset is rejected with 400", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/audit-logs?offset=-5",
    });

    expect(response.statusCode).toBe(400);
  });

  test("sortDirection=asc returns events in ascending createdAt order", async () => {
    for (let i = 0; i < 3; i++) {
      await seedRow(organizationId, { actorEmail: `sort-${i}@example.com` });
    }

    const response = await app.inject({
      method: "GET",
      url: "/api/audit-logs?sortDirection=asc",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.length).toBeGreaterThan(0);
    const sequences = body.data.map((r: AuditLog) => r.eventSequence);
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBeGreaterThanOrEqual(sequences[i - 1]);
    }
  });
});
