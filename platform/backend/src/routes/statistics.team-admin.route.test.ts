import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import statisticsRoutes from "./statistics";

describe("team admin cost access", () => {
  let app: FastifyInstanceWithZod;
  let caller: User;
  let organizationId: string;
  let authMethod: "session" | "api_key";
  let teams: Record<"parent" | "child" | "other", string>;

  beforeEach(
    async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeTeam,
      makeTeamMember,
      makeAgent,
      makeInteraction,
    }) => {
      authMethod = "session";
      organizationId = (await makeOrganization()).id;
      const lead = await makeUser();
      const childMember = await makeUser();
      const outsider = await makeUser();
      for (const user of [lead, childMember, outsider])
        await makeMember(user.id, organizationId, { role: "member" });
      caller = lead;

      const parent = await makeTeam(organizationId, lead.id);
      const child = await makeTeam(organizationId, lead.id, {
        parentId: parent.id,
      });
      const other = await makeTeam(organizationId, outsider.id);
      teams = { parent: parent.id, child: child.id, other: other.id };
      await makeTeamMember(parent.id, lead.id, { role: "admin" });
      await makeTeamMember(child.id, childMember.id);
      await makeTeamMember(other.id, outsider.id);

      const parentAgent = await makeAgent({
        organizationId,
        access: { teams: [parent.id] },
      });
      const sharedAgent = await makeAgent({
        organizationId,
        access: { teams: [parent.id, other.id] },
      });
      const otherAgent = await makeAgent({
        organizationId,
        access: { teams: [other.id] },
      });
      for (const [agentId, userId, billingTeamId, cost] of [
        // A child-team member through an agent shared with the parent team.
        [parentAgent.id, childMember.id, null, "1"],
        // An outsider through an agent the parent team also shares.
        [sharedAgent.id, outsider.id, null, "10"],
        // A credential billed to the child team.
        [otherAgent.id, childMember.id, child.id, "2"],
        // A credential billed to another team overrides the agent's teams.
        [parentAgent.id, childMember.id, other.id, "20"],
        [otherAgent.id, outsider.id, null, "40"],
      ] as const) {
        await makeInteraction(agentId, {
          userId,
          billingTeamId,
          cost,
          baselineCost: cost,
          billingMode: "metered",
        });
      }

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        Object.assign(request, { user: caller, organizationId, authMethod });
      });
      await app.register(statisticsRoutes);
    },
  );
  afterEach(async () => {
    await app.close();
  });

  test("counts only the requests the administered teams' limits charge", async () => {
    const costs = await app.inject({
      method: "GET",
      url: "/api/statistics/costs?timeframe=24h",
    });
    expect(costs.statusCode, costs.body).toBe(200);
    expect(costs.json().costSavings.totalActualCost).toBeCloseTo(3);
    expect(costs.json().activeUsers).toBe(1);

    const byTeam = await app.inject({
      method: "GET",
      url: "/api/statistics/teams?timeframe=24h",
    });
    expect(byTeam.statusCode, byTeam.body).toBe(200);
    expect(costByTeam(byTeam.json())).toEqual({
      // The parent's limit counts its own agents and its sub-team's billing.
      [teams.parent]: 3,
      [teams.child]: 2,
    });

    const childOnly = await app.inject({
      method: "GET",
      url: `/api/statistics/costs?timeframe=24h&teamId=${teams.child}`,
    });
    expect(childOnly.statusCode, childOnly.body).toBe(200);
    expect(childOnly.json().costSavings.totalActualCost).toBeCloseTo(2);
  });

  test("rejects another team, non-admins and non-session callers", async ({
    makeUser,
    makeMember,
  }) => {
    for (const route of ["costs", "teams"]) {
      const otherTeam = await app.inject({
        method: "GET",
        url: `/api/statistics/${route}?timeframe=24h&teamId=${teams.other}`,
      });
      expect(otherTeam.statusCode, otherTeam.body).toBe(403);
    }

    authMethod = "api_key";
    const apiKey = await app.inject({
      method: "GET",
      url: "/api/statistics/costs?timeframe=24h",
    });
    expect(apiKey.statusCode, apiKey.body).toBe(403);

    authMethod = "session";
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: "member" });
    for (const route of ["costs", "teams"]) {
      const member = await app.inject({
        method: "GET",
        url: `/api/statistics/${route}?timeframe=24h`,
      });
      expect(member.statusCode, member.body).toBe(403);
    }
  });

  test("scopes a team admin of a deep team hierarchy", async ({
    makeTeam,
    makeTeamMember,
    makeAgent,
    makeInteraction,
  }) => {
    // Every team covers each descendant: 300 nested teams make about 45,000
    // (team, descendant) pairs, more than one statement can bind as values.
    const root = await makeTeam(organizationId, caller.id);
    await makeTeamMember(root.id, caller.id, { role: "admin" });
    let deepest = root;
    for (let depth = 1; depth < 300; depth++)
      deepest = await makeTeam(organizationId, caller.id, {
        parentId: deepest.id,
      });
    const agent = await makeAgent({ organizationId });
    await makeInteraction(agent.id, {
      userId: caller.id,
      billingTeamId: deepest.id,
      cost: "5",
      baselineCost: "5",
      billingMode: "metered",
    });

    const costs = await app.inject({
      method: "GET",
      url: `/api/statistics/costs?timeframe=24h&teamId=${root.id}`,
    });
    expect(costs.statusCode, costs.body).toBe(200);
    expect(costs.json().costSavings.totalActualCost).toBeCloseTo(5);

    const byTeam = await app.inject({
      method: "GET",
      url: "/api/statistics/teams?timeframe=24h",
    });
    expect(byTeam.statusCode, byTeam.body).toBe(200);
    expect(costByTeam(byTeam.json())[root.id]).toBeCloseTo(5);
  });

  test("an organization cost reader keeps the organization-wide view", async ({
    makeUser,
    makeMember,
  }) => {
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: "admin" });
    const costs = await app.inject({
      method: "GET",
      url: "/api/statistics/costs?timeframe=24h",
    });
    expect(costs.statusCode, costs.body).toBe(200);
    expect(costs.json().costSavings.totalActualCost).toBeCloseTo(73);

    const byTeam = await app.inject({
      method: "GET",
      url: "/api/statistics/teams?timeframe=24h",
    });
    expect(byTeam.statusCode, byTeam.body).toBe(200);
    // Organization reporting still counts a request for every team its agent
    // is shared with, and a billing team alone.
    expect(costByTeam(byTeam.json())).toEqual({
      [teams.parent]: 11,
      [teams.child]: 2,
      [teams.other]: 70,
    });
  });
});

function costByTeam(rows: Array<{ teamId: string; cost: number }>) {
  return Object.fromEntries(rows.map((row) => [row.teamId, row.cost]));
}
