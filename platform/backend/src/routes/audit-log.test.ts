import { vi } from "vitest";
import AuditLogModel from "@/models/audit-log";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { AuditLog, User } from "@/types";

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
    actorUserId: null,
    actorName: "Test Actor",
    actorEmail: "actor@example.com",
    action: "sign_in",
    resourceType: "auth",
    resourceId: null,
    priorState: null,
    postState: null,
    httpMethod: null,
    httpPath: "/api/auth/sign-in/email",
    httpRoute: null,
    httpStatus: null,
    ipAddress: null,
    userAgent: null,
    ...overrides,
    organizationId,
  });
}

describe("GET /api/audit-logs", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeAdmin }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeAdmin();

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          organizationId: string;
          user: User;
        }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
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

  test("actorUserId filter narrows results", async ({ makeUser }) => {
    const targetUser = await makeUser();
    const targeted = await seedRow(organizationId, {
      actorUserId: targetUser.id,
    });
    await seedRow(organizationId, { actorUserId: null });

    const response = await app.inject({
      method: "GET",
      url: `/api/audit-logs?actorUserId=${targetUser.id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.length).toBeGreaterThan(0);
    expect(
      body.data.every((r: AuditLog) => r.actorUserId === targetUser.id),
    ).toBe(true);
    expect(body.data.some((r: AuditLog) => r.id === targeted.id)).toBe(true);
  });

  test("action filter narrows results", async () => {
    const signInRow = await seedRow(organizationId, { action: "sign_in" });
    await seedRow(organizationId, { action: "sign_out" });

    const response = await app.inject({
      method: "GET",
      url: "/api/audit-logs?action=sign_in",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((r: AuditLog) => r.action === "sign_in")).toBe(true);
    expect(body.data.some((r: AuditLog) => r.id === signInRow.id)).toBe(true);
  });

  test("resourceType filter narrows results", async () => {
    const agentRow = await seedRow(organizationId, { resourceType: "agent" });
    await seedRow(organizationId, { resourceType: "auth" });

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
    await seedRow(organizationId, { action: "sign_in" });

    const response = await app.inject({
      method: "GET",
      url: "/api/audit-logs?action=sign_up",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toEqual([]);
    expect(body.pagination.total).toBe(0);
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
    const timestamps = body.data.map((r: AuditLog) =>
      new Date(r.createdAt).getTime(),
    );
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
    }
  });
});
