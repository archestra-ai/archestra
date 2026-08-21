import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
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

/**
 * Route-level coverage for `PATCH /api/agents/bulk` and
 * `DELETE /api/agents/bulk`.
 *
 * These are the reference tests for the whole bulk family, so they pin the
 * parts of the contract every resource shares — partial success, the
 * organization fence, deduplication, the request-level 400s, one audit record
 * per batch — as well as the agent-specific refusals.
 */
describe("agents bulk routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    await app.register(agentRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const bulkDelete = (ids: unknown) =>
    app.inject({ method: "DELETE", url: "/api/agents/bulk", payload: { ids } });

  const bulkPatch = (payload: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: "/api/agents/bulk", payload });

  const auditRows = (action: string) =>
    db
      .select({
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
        resourceType: schema.auditLogsTable.resourceType,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, action),
          eq(schema.auditLogsTable.organizationId, organizationId),
        ),
      );

  describe("DELETE /api/agents/bulk", () => {
    test("soft-deletes every named agent and leaves the rest alone", async ({
      makeAgent,
    }) => {
      const first = await makeAgent({ organizationId, name: "bulk-del-a" });
      const second = await makeAgent({ organizationId, name: "bulk-del-b" });
      const kept = await makeAgent({ organizationId, name: "bulk-del-kept" });

      const response = await bulkDelete([first.id, second.id]);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        succeeded: [
          { id: first.id, name: "bulk-del-a" },
          { id: second.id, name: "bulk-del-b" },
        ],
        failed: [],
      });

      expect(await AgentModel.findById(first.id, user.id, true)).toBeNull();
      expect(await AgentModel.findById(second.id, user.id, true)).toBeNull();
      expect(await AgentModel.findById(kept.id, user.id, true)).not.toBeNull();
    });

    /**
     * The DELETE-with-body shape has no other precedent in this API, so this
     * pins that the body actually reaches the handler rather than being
     * dropped somewhere in the request pipeline.
     */
    test("reads its ids from the request body", async ({ makeAgent }) => {
      const agent = await makeAgent({ organizationId, name: "body-carried" });

      const response = await bulkDelete([agent.id]);

      expect(response.statusCode).toBe(200);
      expect(response.json().succeeded).toEqual([
        { id: agent.id, name: "body-carried" },
      ]);
    });

    test("collapses duplicate ids into one outcome entry", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ organizationId, name: "bulk-dupe" });

      const response = await bulkDelete([agent.id, agent.id, agent.id]);

      expect(response.statusCode).toBe(200);
      expect(response.json().succeeded).toEqual([
        { id: agent.id, name: "bulk-dupe" },
      ]);
    });

    test("reports an agent from another organization as not found, and still deletes the rest", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const mine = await makeAgent({ organizationId, name: "mine" });
      const foreign = await makeAgent({
        organizationId: (await makeOrganization()).id,
        name: "theirs",
      });

      const response = await bulkDelete([mine.id, foreign.id]);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        succeeded: [{ id: mine.id, name: "mine" }],
        failed: [{ id: foreign.id, name: null, error: "Agent not found" }],
      });
      // The fence is the point: the foreign agent must survive untouched.
      expect(
        await AgentModel.findById(foreign.id, user.id, true),
      ).not.toBeNull();
    });

    test("reports an unknown id as not found without failing the batch", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ organizationId, name: "known" });
      const missing = crypto.randomUUID();

      const response = await bulkDelete([missing, agent.id]);

      expect(response.statusCode).toBe(200);
      expect(response.json().succeeded).toEqual([
        { id: agent.id, name: "known" },
      ]);
      expect(response.json().failed).toEqual([
        { id: missing, name: null, error: "Agent not found" },
      ]);
    });

    test("refuses a personal MCP gateway but deletes the rest of the batch", async ({
      makeAgent,
    }) => {
      const gateway = await makeAgent({
        organizationId,
        name: "my-gateway",
        agentType: "mcp_gateway",
        isPersonalGateway: true,
        authorId: user.id,
        scope: "personal",
      });
      const ordinary = await makeAgent({ organizationId, name: "ordinary" });

      const response = await bulkDelete([gateway.id, ordinary.id]);

      expect(response.statusCode).toBe(200);
      expect(response.json().succeeded).toEqual([
        { id: ordinary.id, name: "ordinary" },
      ]);
      expect(response.json().failed).toEqual([
        {
          id: gateway.id,
          name: "my-gateway",
          error: "Personal MCP gateways cannot be deleted.",
        },
      ]);
      expect(
        await AgentModel.findById(gateway.id, user.id, true),
      ).not.toBeNull();
    });

    test("rejects an empty batch without touching anything", async () => {
      expect((await bulkDelete([])).statusCode).toBe(400);
    });

    test("rejects a batch over the cap", async () => {
      const ids = Array.from({ length: 501 }, () => crypto.randomUUID());
      expect((await bulkDelete(ids)).statusCode).toBe(400);
    });

    test("writes one audit record covering the whole batch", async ({
      makeAgent,
    }) => {
      const first = await makeAgent({ organizationId, name: "audited-a" });
      const second = await makeAgent({ organizationId, name: "audited-b" });

      expect((await bulkDelete([first.id, second.id])).statusCode).toBe(200);

      const rows = await auditRows("agent.bulk_deleted");
      expect(rows).toHaveLength(1);
      expect(rows[0].resourceType).toBe("agent");
      // The diff is the record's whole value here: before says the agents were
      // live, after says the batch removed them.
      expect(rows[0].before).toMatchObject({
        agents: expect.arrayContaining([
          expect.objectContaining({ id: first.id, deleted: false }),
          expect.objectContaining({ id: second.id, deleted: false }),
        ]),
      });
      expect(rows[0].after).toMatchObject({
        agents: expect.arrayContaining([
          expect.objectContaining({ id: first.id, deleted: true }),
          expect.objectContaining({ id: second.id, deleted: true }),
        ]),
      });
    });
  });

  describe("PATCH /api/agents/bulk", () => {
    test("moves every agent in the batch to one scope", async ({
      makeAgent,
      makeTeam,
    }) => {
      const team = await makeTeam(organizationId, user.id, { name: "Design" });
      const first = await makeAgent({ organizationId, name: "vis-a" });
      const second = await makeAgent({ organizationId, name: "vis-b" });

      const response = await bulkPatch({
        ids: [first.id, second.id],
        scope: "team",
        teams: [team.id],
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().failed).toEqual([]);
      for (const id of [first.id, second.id]) {
        const agent = await AgentModel.findById(id, user.id, true);
        expect(agent?.scope).toBe("team");
        expect(agent?.teams.map((t: { id: string }) => t.id)).toEqual([
          team.id,
        ]);
      }
    });

    test("rejects team scope with no teams, changing nothing", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({
        organizationId,
        name: "stays-org",
        scope: "org",
      });

      const response = await bulkPatch({
        ids: [agent.id],
        scope: "team",
        teams: [],
      });

      expect(response.statusCode).toBe(400);
      expect((await AgentModel.findById(agent.id, user.id, true))?.scope).toBe(
        "org",
      );
    });

    test("refuses to make a shared agent personal, and says why", async ({
      makeAgent,
    }) => {
      const shared = await makeAgent({
        organizationId,
        name: "shared",
        scope: "org",
        authorId: user.id,
      });

      const response = await bulkPatch({
        ids: [shared.id],
        scope: "personal",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().succeeded).toEqual([]);
      expect(response.json().failed).toEqual([
        {
          id: shared.id,
          name: "shared",
          error: "Shared agents cannot be made personal",
        },
      ]);
      expect((await AgentModel.findById(shared.id, user.id, true))?.scope).toBe(
        "org",
      );
    });

    test("leaves an agent already in the requested state alone", async ({
      makeAgent,
      makeTeam,
    }) => {
      const team = await makeTeam(organizationId, user.id, { name: "Ops" });
      const agent = await makeAgent({
        organizationId,
        name: "already-team",
        scope: "team",
        teams: [team.id],
      });

      const response = await bulkPatch({
        ids: [agent.id],
        scope: "team",
        teams: [team.id],
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().succeeded).toEqual([
        { id: agent.id, name: "already-team" },
      ]);
    });

    test("reports a foreign-organization id as not found", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const foreign = await makeAgent({
        organizationId: (await makeOrganization()).id,
        name: "theirs",
        scope: "org",
      });

      const response = await bulkPatch({ ids: [foreign.id], scope: "org" });

      expect(response.statusCode).toBe(200);
      expect(response.json().failed).toEqual([
        { id: foreign.id, name: null, error: "Agent not found" },
      ]);
    });

    test("writes one audit record whose diff shows the scope move", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({
        organizationId,
        name: "audited-vis",
        scope: "org",
        authorId: user.id,
      });

      expect(
        (await bulkPatch({ ids: [agent.id], scope: "org" })).statusCode,
      ).toBe(200);

      const rows = await auditRows("agent.bulk_updated");
      expect(rows).toHaveLength(1);
      expect(rows[0].resourceType).toBe("agent");
      expect(rows[0].before).toMatchObject({
        agents: [expect.objectContaining({ id: agent.id, scope: "org" })],
      });
    });
  });

  describe("as a non-admin member", () => {
    let member: User;

    beforeEach(async ({ makeUser, makeMember }) => {
      member = await makeUser({ email: "member@bulk.test" });
      await makeMember(member.id, organizationId, { role: MEMBER_ROLE_NAME });
      // Re-point the injected identity at the member for this block.
      app.addHook("onRequest", async (request) => {
        Object.assign(request, { user: member, organizationId });
      });
    });

    test("cannot widen agents to org scope, and nothing moves", async ({
      makeAgent,
    }) => {
      const own = await makeAgent({
        organizationId,
        name: "members-own",
        scope: "personal",
        authorId: member.id,
      });

      const response = await bulkPatch({ ids: [own.id], scope: "org" });

      expect(response.statusCode).toBe(200);
      expect(response.json().succeeded).toEqual([]);
      expect(response.json().failed).toEqual([
        {
          id: own.id,
          name: "members-own",
          error: "Only admins can set scope to org",
        },
      ]);
      expect((await AgentModel.findById(own.id, member.id, true))?.scope).toBe(
        "personal",
      );
    });

    test("cannot delete an agent belonging to someone else", async ({
      makeAgent,
      makeUser,
    }) => {
      const other = await makeUser({ email: "other@bulk.test" });
      const theirs = await makeAgent({
        organizationId,
        name: "not-mine",
        scope: "personal",
        authorId: other.id,
      });

      const response = await bulkDelete([theirs.id]);

      expect(response.statusCode).toBe(200);
      expect(response.json().succeeded).toEqual([]);
      expect(response.json().failed).toHaveLength(1);
      expect(
        await AgentModel.findById(theirs.id, other.id, true),
      ).not.toBeNull();
    });
  });
});
