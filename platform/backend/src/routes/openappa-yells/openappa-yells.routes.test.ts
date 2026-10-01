import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
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

  test("downloads identical gzip bytes and keeps archives out of metadata", async () => {
    const yell = await record("Diagnostic report");
    const archive = gzipSync(JSON.stringify({ message: "A tool was blocked" }));
    expect(
      (await app.inject({ url: `/api/openappa/yells/${yell.id}/archive` }))
        .statusCode,
    ).toBe(404);
    await OpenAppaYellModel.storeArchive({
      id: yell.id,
      organizationId,
      archive,
    });
    const result = await app.inject({
      url: `/api/openappa/yells/${yell.id}/archive`,
    });
    expect(result.statusCode).toBe(200);
    expect(result.rawPayload).toEqual(archive);
    expect(result.headers["content-type"]).toBe("application/gzip");
    expect(result.headers["content-disposition"]).toContain(
      `openappa-yell-${yell.id}.json.gz`,
    );
    const metadata = (
      await app.inject({ url: `/api/openappa/yells/${yell.id}` })
    ).json();
    expect(metadata.hasArchive).toBe(true);
    expect(metadata).not.toHaveProperty("archive");
    expect(
      (await app.inject({ url: "/api/openappa/yells" })).json().data[0],
    ).not.toHaveProperty("archive");
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
    const yell = await record("Confidential report text", {
      callerId: "user:another-reporter",
    });
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

  test("a log reader can read all organization reports but cannot resolve them", async ({
    makeUser,
    makeMember,
    makeCustomRole,
    makeAgent,
  }) => {
    const role = await makeCustomRole(organizationId, {
      permission: { log: ["read"] },
    });
    const reporter = user;
    const other = await record("Shared report");
    await OpenAppaYellModel.storeArchive({
      id: other.id,
      organizationId,
      archive: gzipSync("private"),
    });
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: role.role });
    const own = await record("Own report");
    expect(
      (await app.inject({ url: `/api/openappa/yells/${other.id}/archive` }))
        .statusCode,
    ).toBe(200);
    const list = await app.inject({ url: "/api/openappa/yells" });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: own.id,
          caller: { id: user.id, name: user.name, email: user.email },
        }),
        expect.objectContaining({
          id: other.id,
          caller: {
            id: reporter.id,
            name: reporter.name,
            email: reporter.email,
          },
        }),
      ]),
    );
    expect(list.json().data).toHaveLength(2);
    expect(
      (await app.inject({ url: "/api/openappa/yells/summary" })).json(),
    ).toEqual({ unresolved: 2 });
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
    const sharedToolResult = await executeArchestraTool(
      "archestra__get_openappa_yell",
      { id: other.id },
      context,
    );
    expect(JSON.stringify(sharedToolResult.content)).toContain(other.message);
    expect(JSON.stringify(sharedToolResult.content)).toContain(reporter.name);
    expect(
      (await app.inject({ url: `/api/openappa/yells/${other.id}` })).statusCode,
    ).toBe(200);
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

  test("keeps reports with missing users and non-user callers visible", async () => {
    const missing = await record("Former user's report", {
      callerId: "user:deleted",
    });
    const system = await record("System report", {
      callerId: "system:gateway",
    });
    const list = (await app.inject({ url: "/api/openappa/yells" })).json();
    expect(list.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: missing.id, caller: null }),
        expect.objectContaining({ id: system.id, caller: null }),
      ]),
    );
  });

  test("identifies service-account callers within the report organization", async ({
    makeServiceAccount,
    makeOrganization,
  }) => {
    const account = await makeServiceAccount(organizationId, {
      name: "Report automation",
    });
    const otherAccount = await makeServiceAccount(
      (await makeOrganization()).id,
      { name: "Other automation" },
    );
    const yell = await record("Automated report", {
      callerId: `user:service-account:${account.id}`,
    });
    const foreign = await record("Unmatched caller", {
      callerId: `user:service-account:${otherAccount.id}`,
    });
    const list = (await app.inject({ url: "/api/openappa/yells" })).json();
    expect(list.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: yell.id,
          caller: {
            id: `service-account:${account.id}`,
            name: account.name,
            email: null,
            type: "service_account",
          },
        }),
        expect.objectContaining({ id: foreign.id, caller: null }),
      ]),
    );
    const detail = (
      await app.inject({ url: `/api/openappa/yells/${yell.id}` })
    ).json();
    expect(detail.caller).toEqual({
      id: `service-account:${account.id}`,
      name: account.name,
      email: null,
      type: "service_account",
    });
  });

  test("denies readers without log permission", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const yell = await record("Shared report");
    const role = await makeCustomRole(organizationId, {
      permission: { agent: ["read"] },
    });
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: role.role });
    for (const url of [
      "/api/openappa/yells",
      "/api/openappa/yells/summary",
      `/api/openappa/yells/${yell.id}`,
      `/api/openappa/yells/${yell.id}/archive`,
    ]) {
      expect((await app.inject({ url })).statusCode).toBe(403);
    }
  });

  test("does not disclose or mutate another organization's report", async ({
    makeOrganization,
  }) => {
    const yell = await record("Other organization", {
      organizationId: (await makeOrganization()).id,
    });
    await OpenAppaYellModel.storeArchive({
      id: yell.id,
      organizationId: yell.organizationId,
      archive: gzipSync("private"),
    });
    expect(
      (await app.inject({ url: `/api/openappa/yells/${yell.id}/archive` }))
        .statusCode,
    ).toBe(404);
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
