import { ADMIN_ROLE_NAME, PLATFORM_ADMIN_ROLE_NAME } from "@archestra/shared";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { AgentModel, MemberModel, OrganizationModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { AuditEventName, User } from "@/types";

/**
 * `DELETE /api/agents/:id/permanent` — destroying an agent already in the
 * trash. Runs against real RBAC (no `@/auth` mock) because the access rule is
 * the interesting part: a built-in admin ROLE, which no agent permission —
 * `agent:admin` included — can stand in for.
 */
describe("DELETE /api/agents/:id/permanent", () => {
  let app: FastifyInstanceWithZod;
  let admin: User;
  let organizationId: string;

  async function createAppForUser(user: User) {
    const instance = createFastifyInstance();
    instance.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(instance);
    const { default: agentRoutes } = await import("./agent");
    await instance.register(agentRoutes);
    return instance;
  }

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    app = await createAppForUser(admin);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const purge = (id: string, instance: FastifyInstanceWithZod = app) =>
    instance.inject({ method: "DELETE", url: `/api/agents/${id}/permanent` });

  const agentRows = (id: string) =>
    db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.id, id));

  test("destroys a trashed agent and its scheduled runs, detaching its history", async ({
    makeAgent,
    makeInteraction,
    makeScheduleTrigger,
    makeUser,
  }) => {
    const agent = await makeAgent({ organizationId, agentType: "llm_proxy" });
    const interaction = await makeInteraction(agent.id);
    const trigger = await makeScheduleTrigger({
      organizationId,
      actorUserId: admin.id,
      agentId: agent.id,
    });
    const chatter = await makeUser({ email: "chatter@test.com" });
    const conversation = await db
      .insert(schema.conversationsTable)
      .values({
        organizationId,
        userId: chatter.id,
        agentId: agent.id,
        title: "a chat with the proxy",
      })
      .returning();

    await AgentModel.delete(agent.id);
    const response = await purge(agent.id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });

    expect(await agentRows(agent.id)).toHaveLength(0);

    // Scheduled runs go with it.
    const triggers = await db
      .select({ id: schema.scheduleTriggersTable.id })
      .from(schema.scheduleTriggersTable)
      .where(eq(schema.scheduleTriggersTable.id, trigger.id));
    expect(triggers).toHaveLength(0);

    // Usage rows and conversations SURVIVE, detached. This is the whole point
    // of the SET NULL columns: purging an agent must not destroy the
    // organization's billing history or its members' chats.
    const usage = await db
      .select({
        id: schema.interactionsTable.id,
        profileId: schema.interactionsTable.profileId,
      })
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.id, interaction.id));
    expect(usage).toHaveLength(1);
    expect(usage[0].profileId).toBeNull();

    const chats = await db
      .select({
        id: schema.conversationsTable.id,
        agentId: schema.conversationsTable.agentId,
      })
      .from(schema.conversationsTable)
      .where(eq(schema.conversationsTable.id, conversation[0].id));
    expect(chats).toHaveLength(1);
    expect(chats[0].agentId).toBeNull();
  });

  test("clears the agent from organization, /connection, and member defaults", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId, agentType: "mcp_gateway" });

    await OrganizationModel.patch(organizationId, {
      defaultAgentId: agent.id,
      connectionDefaultMcpGatewayId: agent.id,
    });
    await MemberModel.setDefaultAgent(admin.id, organizationId, agent.id);

    await AgentModel.delete(agent.id);
    expect((await purge(agent.id)).statusCode).toBe(200);

    // These four columns carry ON DELETE SET NULL constraints that exist in the
    // database but NOT in the Drizzle schema — declaring them there would make
    // organization -> agent -> organization circular for the type checker. So
    // nothing in application code clears them, and only a test proves they are
    // actually cleared rather than left dangling at a destroyed id.
    const org = await OrganizationModel.getById(organizationId);
    expect(org?.defaultAgentId).toBeNull();
    expect(org?.connectionDefaultMcpGatewayId).toBeNull();
    expect(
      await MemberModel.getDefaultAgentId(admin.id, organizationId),
    ).toBeNull();
  });

  test("404s for an agent that is still live", async ({ makeAgent }) => {
    const agent = await makeAgent({ organizationId });

    const response = await purge(agent.id);
    expect(response.statusCode).toBe(404);
    expect(await agentRows(agent.id)).toHaveLength(1);
  });

  test("404s for an unknown id", async () => {
    expect((await purge(crypto.randomUUID())).statusCode).toBe(404);
  });

  test("404s across organizations", async ({
    makeAgent,
    makeMember,
    makeOrganization,
  }) => {
    const agent = await makeAgent({ organizationId });
    await AgentModel.delete(agent.id);

    // A global admin of the OTHER org: the refusal has to come from org
    // scoping, not from the caller having lost their admin role along the way.
    organizationId = (await makeOrganization()).id;
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });

    expect((await purge(agent.id)).statusCode).toBe(404);
    expect(await agentRows(agent.id)).toHaveLength(1);
  });

  test("404s for a custom role holding admin on every agent type", async ({
    makeAgent,
    makeUser,
    makeCustomRole,
    makeMember,
  }) => {
    const gateway = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
    });
    await AgentModel.delete(gateway.id);

    // The broadest agent role RBAC can express — every action on every agent
    // type — and it still stops at the trash. Permanent deletion is not a
    // permission anyone can be granted; it takes a built-in admin role.
    await makeCustomRole(organizationId, {
      role: "agent_superuser",
      permission: {
        agent: ["read", "create", "update", "delete", "team-admin", "admin"],
        mcpGateway: [
          "read",
          "create",
          "update",
          "delete",
          "team-admin",
          "admin",
        ],
        llmProxy: ["read", "create", "update", "delete", "team-admin", "admin"],
      },
    });
    const superuser = await makeUser({ email: "agent-superuser@test.com" });
    await makeMember(superuser.id, organizationId, { role: "agent_superuser" });
    const superuserApp = await createAppForUser(superuser);

    try {
      const response = await purge(gateway.id, superuserApp);
      expect(response.statusCode).toBe(404);
      expect(await agentRows(gateway.id)).toHaveLength(1);
    } finally {
      await superuserApp.close();
    }
  });

  test("a platform admin can purge", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent({ organizationId, agentType: "agent" });
    await AgentModel.delete(agent.id);

    const platformAdmin = await makeUser({ email: "platform-admin@test.com" });
    await makeMember(platformAdmin.id, organizationId, {
      role: PLATFORM_ADMIN_ROLE_NAME,
    });
    const platformAdminApp = await createAppForUser(platformAdmin);

    try {
      expect((await purge(agent.id, platformAdminApp)).statusCode).toBe(200);
      expect(await agentRows(agent.id)).toHaveLength(0);
    } finally {
      await platformAdminApp.close();
    }
  });

  test("a restore that lands first wins, and the agent survives", async ({
    makeAgent,
    makeInteraction,
  }) => {
    const agent = await makeAgent({ organizationId, agentType: "llm_proxy" });
    const interaction = await makeInteraction(agent.id);
    await AgentModel.delete(agent.id);

    expect(await AgentModel.restore(agent.id)).toBe(true);

    // Nothing left in the trash to take, so the purge reports 404 — and because
    // the detach rides the same transaction as the delete, the restored agent
    // keeps its usage history rather than being left half-detached.
    expect((await purge(agent.id)).statusCode).toBe(404);
    expect(await agentRows(agent.id)).toHaveLength(1);

    const usage = await db
      .select({ profileId: schema.interactionsTable.profileId })
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.id, interaction.id));
    expect(usage[0].profileId).toBe(agent.id);
  });

  test("is audited by identity only, with no copy of the configuration", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      name: "Audited Proxy",
      agentType: "llm_proxy",
    });
    await AgentModel.delete(agent.id);
    expect((await purge(agent.id)).statusCode).toBe(200);

    const rows = await auditRowsFor(agent.id, "agent.purged");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "agent.purged",
      resourceType: "agent",
      resourceId: agent.id,
      resourceName: "Audited Proxy",
    });
    // Identity and nothing more. Without its own registry entry this route
    // would walk up to `/api/agents/:id` and be logged as `agent.deleted` with
    // that route's FULL snapshot attached — a preserved copy of exactly the
    // configuration the caller asked to destroy. `deletedAt` rides along as
    // lifecycle metadata, not content: it is how long the agent sat in the
    // trash, which is the retention sweep's whole reason for taking it.
    expect(rows[0].before).toEqual({
      id: agent.id,
      name: "Audited Proxy",
      agentType: "llm_proxy",
      deletedAt: expect.any(String),
    });
    expect(rows[0].after).toBeNull();
  });

  const selectAuditRows = (resourceId: string) =>
    db
      .select({
        action: schema.auditLogsTable.action,
        resourceType: schema.auditLogsTable.resourceType,
        resourceId: schema.auditLogsTable.resourceId,
        resourceName: schema.auditLogsTable.resourceName,
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.resourceId, resourceId));

  /** Audit rows are written fire-and-forget, so poll rather than assert once. */
  const auditRowsFor = async (resourceId: string, action: AuditEventName) => {
    await vi.waitFor(async () => {
      const rows = await selectAuditRows(resourceId);
      expect(rows.some((row) => row.action === action)).toBe(true);
    });
    return (await selectAuditRows(resourceId)).filter(
      (row) => row.action === action,
    );
  };
});
