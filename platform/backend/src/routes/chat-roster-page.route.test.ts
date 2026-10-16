import { BUILT_IN_AGENT_IDS } from "@archestra/shared";
import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import agentRoutes from "./agent";

describe("bounded chat roster", () => {
  const ctx = useRouteTestApp(agentRoutes);
  const get = async (url: string) => {
    const response = await ctx.app.inject({ method: "GET", url });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };
  test("bootstraps only fallback categories while explicit references keep normal chat access", async ({
    makeMember,
    makeUser,
    makeOrganization,
    makeAgent,
    makeTeam,
    makeTeamMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const other = await makeUser();
    await makeMember(other.id, ctx.organizationId);
    const own = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      access: "personal",
      name: "Own",
      description: "Needle match",
    });
    const organization = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      access: "org",
      name: "Organization",
    });
    const team = await makeTeam(ctx.organizationId, ctx.user.id, {
      name: "Chat team",
    });
    await makeTeamMember(team.id, ctx.user.id);
    const teamAgent = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: "Z Shared Team",
      access: { teams: [team.id] },
    });
    await db
      .update(schema.agentsTable)
      .set({ createdAt: new Date("2000-01-01T00:00:00Z") })
      .where(eq(schema.agentsTable.id, teamAgent.id));
    const hidden = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: other.id,
      agentType: "agent",
      access: "personal",
      name: "Oversight",
    });
    const shared = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: other.id,
      agentType: "agent",
      access: { users: [ctx.user.id] },
      name: "Shared",
      description: "Needle match",
    });
    const system = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG },
      access: "org",
    });
    const compaction = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.CONTEXT_COMPACTION },
      access: "org",
    });
    const foreign = await makeOrganization();
    const foreignAgent = await makeAgent({
      organizationId: foreign.id,
      agentType: "agent",
      access: "org",
    });
    for (const [agent, year] of [
      [shared, 2001],
      [own, 2002],
      [organization, 2003],
      [hidden, 2004],
    ] as const)
      await db
        .update(schema.agentsTable)
        .set({ createdAt: new Date(`${year}-01-01T00:00:00Z`) })
        .where(eq(schema.agentsTable.id, agent.id));
    const previous = config.openappa.enabled;
    config.openappa.enabled = true;
    try {
      const legacy = await get("/api/agents/chat-roster");
      expect(legacy.map((agent: { id: string }) => agent.id)).toContain(
        hidden.id,
      );
      const bootstrap = await get("/api/agents/chat-roster?bootstrap=true");
      expect(bootstrap.map((agent: { id: string }) => agent.id)).toEqual([
        own.id,
        organization.id,
        system.id,
      ]);
      expect(bootstrap).toEqual(
        [own, organization, system].map((agent) =>
          legacy.find((row: { id: string }) => row.id === agent.id),
        ),
      );
      const explicit = await get(
        `/api/agents/chat-roster?ids=${hidden.id},${system.id},${foreignAgent.id}&bootstrap=true`,
      );
      expect(explicit.map((agent: { id: string }) => agent.id).sort()).toEqual(
        [hidden.id, system.id].sort(),
      );
      const rows = [];
      let cursor: string | null = null;
      do {
        const page = await get(
          `/api/agents/chat-roster/page?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        expect(page.data.length).toBeLessThanOrEqual(1);
        rows.push(...page.data);
        cursor = page.pagination.nextCursor;
      } while (cursor);
      expect(rows.map((row) => row.id)).toEqual([
        own.id,
        teamAgent.id,
        organization.id,
      ]);
      expect(rows.map((row) => row.id)).not.toContain(compaction.id);
      expect(
        (
          await get("/api/agents/chat-roster/page?search=Needle%20match")
        ).data.map((row: { id: string }) => row.id),
      ).toEqual([own.id]);
      const oversized = await ctx.app.inject({
        method: "GET",
        url: `/api/agents/chat-roster?ids=${Array.from({ length: 101 }, () => own.id).join(",")}`,
      });
      expect(oversized.statusCode).toBe(400);
    } finally {
      config.openappa.enabled = previous;
    }
  });
  test("bootstrap deduplicates one fallback and never grants foreign or inaccessible IDs", async ({
    makeMember,
    makeUser,
    makeAgent,
    makeOrganization,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const own = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      access: "personal",
    });
    const other = await makeUser();
    await makeMember(other.id, ctx.organizationId);
    const inaccessible = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: other.id,
      agentType: "agent",
      access: "personal",
    });
    const org = await makeOrganization();
    const foreign = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      access: "org",
    });
    expect(
      (await get("/api/agents/chat-roster?bootstrap=true")).map(
        (row: { id: string }) => row.id,
      ),
    ).toEqual([own.id]);
    expect(
      (
        await get(
          `/api/agents/chat-roster?ids=${own.id},${inaccessible.id},${foreign.id}`,
        )
      ).map((row: { id: string }) => row.id),
    ).toEqual([own.id]);
  });
});
