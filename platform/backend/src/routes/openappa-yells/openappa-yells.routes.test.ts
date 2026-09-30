import { randomUUID } from "node:crypto";
import { ADMIN_ROLE_NAME, RouteId } from "@archestra/shared";
import { requiredEndpointPermissionsMap } from "@archestra/shared/access-control";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { executeArchestraTool } from "@/archestra-mcp-server";
import { hasPermission } from "@/auth";
import config from "@/config";
import db, { schema } from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import OpenAppaYellModel from "@/models/openappa-yell";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { ApiError, type User } from "@/types";
import routes from "./openappa-yells.routes";

describe("OpenAPPA yells", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;
  let originalEnabled: boolean;
  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    originalEnabled = config.openappa.enabled;
    config.openappa.enabled = true;
    organizationId = (await makeOrganization()).id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    app.addHook("preHandler", async (request) => {
      const operation =
        request.method === "PATCH"
          ? RouteId.UpdateOpenAppaYell
          : RouteId.GetOpenAppaYells;
      const required = requiredEndpointPermissionsMap[operation];
      if (!required) throw new ApiError(403, "Unknown route");
      const { success } = await hasPermission(
        required,
        request.headers,
        undefined,
        { userId: user.id, organizationId },
      );
      if (!success) throw new ApiError(403, "Forbidden");
    });
    registerAuditLogHook(app);
    await app.register(routes);
  });
  afterEach(async () => {
    config.openappa.enabled = originalEnabled;
    await app.close();
  });
  const record = (
    message: string,
    overrides: { organizationId?: string; callerId?: string } = {},
  ) =>
    OpenAppaYellModel.record({
      organizationId,
      callerId: `user:${user.id}`,
      sessionId: randomUUID(),
      toolCallId: randomUUID(),
      message,
      withTrajectory: false,
      ...overrides,
    });

  test("lists and counts only the active organization's reports and paginates search", async ({
    makeOrganization,
  }) => {
    const first = await record("Mailbox block");
    const second = await record("Mailbox remedy");
    await record("Other issue");
    await record("Mailbox private", {
      organizationId: (await makeOrganization()).id,
    });
    const response = await app.inject({
      url: "/api/openappa/yells?search=Mailbox&limit=1",
    });
    expect(response.statusCode).toBe(200);
    const page = response.json();
    expect(page.data).toHaveLength(1);
    expect(page.pagination.hasNext).toBe(true);
    const next = await app.inject({
      url: `/api/openappa/yells?search=Mailbox&limit=1&cursor=${encodeURIComponent(page.pagination.nextCursor)}`,
    });
    expect([page.data[0].id, next.json().data[0].id].sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(next.json().pagination.hasNext).toBe(false);
    expect(
      (await app.inject({ url: "/api/openappa/yells/summary" })).json(),
    ).toEqual({ unresolved: 3 });
  });

  test("resolves and reopens reports with a non-secret audit diff", async () => {
    const yell = await record("Confidential report text");
    const response = await app.inject({
      method: "PATCH",
      url: `/api/openappa/yells/${yell.id}`,
      payload: { resolved: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      resolvedBy: user.id,
      resolvedAt: expect.any(String),
    });
    expect(
      (await app.inject({ url: "/api/openappa/yells/summary" })).json(),
    ).toEqual({ unresolved: 0 });
    expect(
      (await app.inject({ url: "/api/openappa/yells?status=resolved" })).json()
        .data,
    ).toHaveLength(1);
    await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(schema.auditLogsTable)
        .where(eq(schema.auditLogsTable.resourceId, yell.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "openappaYell.updated",
        before: { resolvedAt: null, resolvedBy: null },
        after: { resolvedAt: expect.any(String), resolvedBy: user.id },
      });
      expect(JSON.stringify(rows)).not.toContain(yell.message);
    });
    const reopened = await app.inject({
      method: "PATCH",
      url: `/api/openappa/yells/${yell.id}`,
      payload: { resolved: false },
    });
    expect(reopened.json()).toMatchObject({
      resolvedAt: null,
      resolvedBy: null,
    });
    expect(
      (await app.inject({ url: "/api/openappa/yells/summary" })).json(),
    ).toEqual({ unresolved: 1 });
  });

  test("a log reader cannot read another caller's report or resolve it", async ({
    makeUser,
    makeMember,
    makeCustomRole,
    makeAgent,
  }) => {
    const role = await makeCustomRole(organizationId, {
      permission: { log: ["read"] },
    });
    const other = await record("Private report");
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: role.role });
    const own = await record("Own report");
    const list = await app.inject({ url: "/api/openappa/yells" });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.map((row: { id: string }) => row.id)).toEqual([
      own.id,
    ]);
    const agent = await makeAgent({ organizationId, accessAllTools: true });
    const context = {
      agent,
      agentId: agent.id,
      organizationId,
      userId: user.id,
    };
    const toolResult = await executeArchestraTool(
      "archestra__get_openappa_yell",
      { id: own.id },
      context,
    );
    expect(JSON.stringify(toolResult.content)).toContain(own.message);
    await expect(
      executeArchestraTool(
        "archestra__get_openappa_yell",
        { id: other.id },
        context,
      ),
    ).rejects.toThrow("Yell not found");
    expect(
      (await app.inject({ url: `/api/openappa/yells/${other.id}` })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/openappa/yells/${other.id}`,
          payload: { resolved: true },
        })
      ).statusCode,
    ).toBe(403);
  });

  test("does not disclose or mutate another organization's report", async ({
    makeOrganization,
  }) => {
    const yell = await record("Other organization", {
      organizationId: (await makeOrganization()).id,
    });
    expect(
      (await app.inject({ url: `/api/openappa/yells/${yell.id}` })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/openappa/yells/${yell.id}`,
          payload: { resolved: true },
        })
      ).statusCode,
    ).toBe(404);
  });
});
