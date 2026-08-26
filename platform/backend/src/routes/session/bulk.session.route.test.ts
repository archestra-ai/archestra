import { MAX_BULK_IDS } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import SessionModel from "@/models/session";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("DELETE /api/sessions/bulk", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;
  let currentSessionId: string;
  let authMethod: "session" | "apiKey";

  beforeEach(async ({ makeOrganization, makeSession, makeUser }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeUser();
    currentSessionId = (await makeSession(user.id)).id;
    authMethod = "session";

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, {
        organizationId,
        user,
        authMethod,
        sessionInfo: { id: currentSessionId, createdAt: new Date() },
      });
    });
    registerAuditLogHook(app);

    const { default: sessionRoutes } = await import("./session.routes");
    await app.register(sessionRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const bulkRevoke = (ids: unknown) =>
    app.inject({
      method: "DELETE",
      url: "/api/sessions/bulk",
      payload: { ids },
    });

  test("revokes owned non-current sessions in one outcome", async ({
    makeSession,
  }) => {
    const first = await makeSession(user.id);
    const second = await makeSession(user.id);
    const kept = await makeSession(user.id);

    const response = await bulkRevoke([first.id, second.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [
        { id: first.id, name: first.id },
        { id: second.id, name: second.id },
      ],
      failed: [],
    });
    expect(await SessionModel.getById(first.id)).toHaveLength(0);
    expect(await SessionModel.getById(second.id)).toHaveLength(0);
    expect(await SessionModel.getById(kept.id)).toHaveLength(1);
  });

  test("reports foreign and current sessions per item without revoking either", async ({
    makeSession,
    makeUser,
  }) => {
    const revocable = await makeSession(user.id);
    const foreign = await makeSession((await makeUser()).id);

    const response = await bulkRevoke([
      revocable.id,
      currentSessionId,
      foreign.id,
    ]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [{ id: revocable.id, name: revocable.id }],
      failed: [
        {
          id: currentSessionId,
          name: currentSessionId,
          error: "Current session cannot be revoked",
        },
        { id: foreign.id, name: null, error: "Session not found" },
      ],
    });
    expect(await SessionModel.getById(currentSessionId)).toHaveLength(1);
    expect(await SessionModel.getById(foreign.id)).toHaveLength(1);
  });

  test("rejects an empty or oversized batch", async () => {
    expect((await bulkRevoke([])).statusCode).toBe(400);
    expect((await bulkRevoke([""])).statusCode).toBe(400);
    expect(
      (
        await bulkRevoke(
          Array.from({ length: MAX_BULK_IDS + 1 }, () => crypto.randomUUID()),
        )
      ).statusCode,
    ).toBe(400);
  });

  test("requires an authoritative active cookie session", async () => {
    await SessionModel.deleteById(currentSessionId);

    expect((await bulkRevoke([crypto.randomUUID()])).statusCode).toBe(401);

    authMethod = "apiKey";
    expect((await bulkRevoke([crypto.randomUUID()])).statusCode).toBe(401);
  });

  test("reports a concurrent disappearance as a failure", async ({
    makeSession,
  }) => {
    const target = await makeSession(user.id);
    vi.spyOn(SessionModel, "deleteByIdsForUser").mockResolvedValue([]);

    const response = await bulkRevoke([target.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [],
      failed: [
        {
          id: target.id,
          name: target.id,
          error: "Could not revoke this session",
        },
      ],
    });
  });

  test("skips audit records when no session was revoked", async () => {
    expect((await bulkRevoke([currentSessionId])).statusCode).toBe(200);

    const rows = await db
      .select({ id: schema.auditLogsTable.id })
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.action, "auth.sessions_revoked"));
    expect(rows).toEqual([]);
  });

  test("writes one current-user audit record with ID-only snapshots", async ({
    makeSession,
  }) => {
    const target = await makeSession(user.id);

    expect((await bulkRevoke([target.id])).statusCode).toBe(200);

    const rows = await db
      .select({
        resourceType: schema.auditLogsTable.resourceType,
        resourceId: schema.auditLogsTable.resourceId,
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "auth.sessions_revoked"),
          eq(schema.auditLogsTable.organizationId, organizationId),
        ),
      );

    expect(rows).toEqual([
      {
        resourceType: "auth",
        resourceId: user.id,
        before: { sessionIds: [target.id] },
        after: { sessionIds: [] },
      },
    ]);
  });
});
