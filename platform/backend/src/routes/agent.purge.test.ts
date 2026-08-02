import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { AgentModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import agentRoutes from "./agent";

// Purge mutates state and must produce an audit record, so this uses the full
// audit-hook harness. The per-type `admin` gate resolves from real member
// roles in the database, so the non-admin case runs with a plain member.
describe("DELETE /api/agents/:id/permanent", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    await app.register(agentRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  const purge = (id: string) =>
    app.inject({ method: "DELETE", url: `/api/agents/${id}/permanent` });

  test("permanently deletes a soft-deleted agent and audits identity-only", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId });
    await AgentModel.delete(agent.id);

    const response = await purge(agent.id);
    expect(response.statusCode).toBe(200);

    expect(
      await AgentModel.findDeletedByIdForOrganization(agent.id, organizationId),
    ).toBeNull();

    await vi.waitFor(async () => {
      const rows = await db
        .select({
          action: schema.auditLogsTable.action,
          resourceType: schema.auditLogsTable.resourceType,
          before: schema.auditLogsTable.before,
          after: schema.auditLogsTable.after,
        })
        .from(schema.auditLogsTable)
        .where(
          and(
            eq(schema.auditLogsTable.action, "agent.purged"),
            eq(schema.auditLogsTable.resourceId, agent.id),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "agent.purged",
        resourceType: "agent",
        after: null,
      });
      // Identity-only `before` — never a full copy of purged content.
      expect(rows[0].before).toMatchObject({
        id: agent.id,
        name: agent.name,
        deletedAt: expect.any(String),
      });
      expect(
        Object.keys(rows[0].before as Record<string, unknown>).sort(),
      ).toEqual(["agentType", "deletedAt", "id", "name"]);
    });
  });

  test("404 for an active agent — purge is a trash action, never a shortcut", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId });
    expect((await purge(agent.id)).statusCode).toBe(404);

    const [row] = await db
      .select()
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.id, agent.id));
    expect(row?.deletedAt).toBeNull();
  });

  test("404 for a caller without per-type admin — the row survives", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent({ organizationId });
    await AgentModel.delete(agent.id);

    const member = await makeUser();
    await makeMember(member.id, organizationId);
    user = member;

    expect((await purge(agent.id)).statusCode).toBe(404);
    expect(
      await AgentModel.findDeletedByIdForOrganization(agent.id, organizationId),
    ).not.toBeNull();
  });
});
