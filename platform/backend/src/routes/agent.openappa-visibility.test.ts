import { BUILT_IN_AGENT_IDS } from "@archestra/shared";
import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import agentRoutes from "./agent";
import chatRoutes from "./chat/routes";

describe("system chat agent visibility", () => {
  const ctx = useRouteTestApp(async (app) => {
    await app.register(agentRoutes);
    await app.register(chatRoutes);
  });

  const chatRosterUrl =
    "/api/agents/all?agentType=agent&excludeBuiltIn=true&includeTools=false&view=chat";

  test("the system policy assistant uses the built-in management category and the normal chat roster", async ({
    makeMember,
    makeAgent,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const policy = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG },
    });
    const ordinary = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
    });
    const compaction = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.CONTEXT_COMPACTION },
    });
    for (const url of [
      "/api/agents?agentType=agent",
      "/api/agents/all?agentType=agent&excludeBuiltIn=true",
    ]) {
      const response = await ctx.app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const agents = Array.isArray(body) ? body : body.data;
      expect(agents.map((agent: { id: string }) => agent.id)).not.toContain(
        policy.id,
      );
    }
    const builtIns = await ctx.app.inject({
      method: "GET",
      url: "/api/agents?agentType=agent&scope=built_in",
    });
    expect(
      builtIns.json().data.map((agent: { id: string }) => agent.id),
    ).toEqual(expect.arrayContaining([policy.id, compaction.id]));
    const included = await ctx.app.inject({
      method: "GET",
      url: "/api/agents/all?agentType=agent",
    });
    expect(included.statusCode).toBe(200);
    expect(included.json().map((agent: { id: string }) => agent.id)).toEqual(
      expect.arrayContaining([policy.id, compaction.id, ordinary.id]),
    );
    const roster = await ctx.app.inject({ method: "GET", url: chatRosterUrl });
    expect(roster.statusCode).toBe(200);
    expect(
      roster
        .json()
        .map((agent: { id: string }) => agent.id)
        .sort(),
    ).toEqual([policy.id, ordinary.id].sort());
  });

  test("a member can select and pin the granted system assistant without seeing other platform agents", async ({
    makeMember,
    makeAgent,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const policy = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG },
    });
    await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.CONTEXT_COMPACTION },
    });
    const roster = await ctx.app.inject({ method: "GET", url: chatRosterUrl });
    expect(roster.statusCode).toBe(200);
    expect(roster.json()).toEqual([
      expect.objectContaining({
        id: policy.id,
        builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG },
      }),
    ]);
    const pin = await ctx.app.inject({
      method: "PUT",
      url: "/api/members/default-agent",
      payload: { defaultAgentId: policy.id },
    });
    expect(pin.statusCode).toBe(200);
    const current = await ctx.app.inject({
      method: "GET",
      url: "/api/members/default-agent",
    });
    expect(current.json().defaultAgentId).toBe(policy.id);
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      payload: { agentId: policy.id, title: "Policy review" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      agentId: policy.id,
      origin: "user",
      title: "Policy review",
    });
  });
  test("the chat roster and default selection still reject an ungranted system assistant", async ({
    makeMember,
    makeAgent,
    makeUser,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const stranger = await makeUser();
    await makeMember(stranger.id, ctx.organizationId);
    const restricted = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      authorId: stranger.id,
      access: "personal",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG },
    });
    const roster = await ctx.app.inject({ method: "GET", url: chatRosterUrl });
    expect(roster.statusCode).toBe(200);
    expect(roster.json()).toEqual([]);
    const denied = await ctx.app.inject({
      method: "PUT",
      url: "/api/members/default-agent",
      payload: { defaultAgentId: restricted.id },
    });
    expect(denied.statusCode).toBe(404);
    const deniedChat = await ctx.app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      payload: { agentId: restricted.id },
    });
    expect(deniedChat.statusCode).toBe(404);
  });
});
