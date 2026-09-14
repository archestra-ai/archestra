import { ADMIN_ROLE_NAME } from "@archestra/shared";
import AgentUserModel from "@/models/agent-user";
import { createA2aRemoteAgent } from "@/services/a2a-outbound-registry";
import { describe, expect, test, useRouteTestApp } from "@/test";
import { makeAgentCard } from "../a2a-remote-agent/a2a-remote-agent.test-helpers";
import agentCatalogRoutes from "./agent-catalog.routes";

describe("GET /api/agent-catalog", () => {
  const ctx = useRouteTestApp(agentCatalogRoutes);

  test("globally sorts and paginates internal and external agents", async ({
    makeAgent,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const beta = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: "Beta",
      scope: "org",
    });
    const delta = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: "Delta",
      scope: "org",
    });
    const alpha = await createRemoteAgent("Alpha");
    const charlie = await createRemoteAgent("Charlie");

    const firstPage = await ctx.app.inject({
      method: "GET",
      url: "/api/agent-catalog?sortBy=name&sortDirection=asc&limit=2&offset=0",
    });
    expect(firstPage.statusCode, firstPage.body).toBe(200);
    expect(firstPage.json()).toMatchObject({
      data: [
        { type: "external", value: { id: alpha.id, name: "Alpha" } },
        { type: "agent", value: { id: beta.id, name: "Beta" } },
      ],
      pagination: { total: 4, hasNext: true, hasPrev: false },
      totals: { agents: 2, externalAgents: 2 },
    });

    const secondPage = await ctx.app.inject({
      method: "GET",
      url: "/api/agent-catalog?sortBy=name&sortDirection=asc&limit=2&offset=2",
    });
    expect(secondPage.statusCode, secondPage.body).toBe(200);
    expect(secondPage.json().data).toMatchObject([
      { type: "external", value: { id: charlie.id, name: "Charlie" } },
      { type: "agent", value: { id: delta.id, name: "Delta" } },
    ]);

    const descending = await ctx.app.inject({
      method: "GET",
      url: "/api/agent-catalog?sortBy=name&sortDirection=desc&limit=4&offset=0",
    });
    expect(descending.statusCode, descending.body).toBe(200);
    expect(
      descending
        .json()
        .data.map((row: { value: { name: string } }) => row.value.name),
    ).toEqual(["Delta", "Charlie", "Beta", "Alpha"]);

    async function createRemoteAgent(name: string) {
      return createA2aRemoteAgent({
        organizationId: ctx.organizationId,
        authorId: ctx.user.id,
        input: {
          name,
          source: {
            type: "inline_card",
            agentCard: makeAgentCard("none", { name }),
          },
          auth: { type: "none" },
          scope: "org",
        },
      });
    }
  });

  test("keeps external agents out of regular-only filtered views", async ({
    makeAgent,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: "Matching regular agent",
      scope: "org",
    });
    await createA2aRemoteAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      input: {
        name: "External agent",
        source: {
          type: "inline_card",
          agentCard: makeAgentCard(),
        },
        auth: { type: "none" },
        scope: "org",
      },
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/agent-catalog?labels=missing:value&limit=20&offset=0",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      data: [],
      pagination: { total: 0 },
      totals: { agents: 0, externalAgents: 0 },
    });
  });

  test("returns only rows the caller can bulk-select when requested", async ({
    makeAgent,
    makeCustomRole,
    makeMember,
  }) => {
    const role = await makeCustomRole(ctx.organizationId, {
      permission: { agent: ["read"] },
    });
    await makeMember(ctx.user.id, ctx.organizationId, { role: role.role });
    const regularAgent = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: "Selectable regular agent",
      scope: "org",
    });
    await createA2aRemoteAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      input: {
        name: "Visible but unselectable external agent",
        source: { type: "inline_card", agentCard: makeAgentCard() },
        auth: { type: "none" },
        scope: "org",
      },
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/agent-catalog?selectableOnly=true&limit=20&offset=0",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      data: [{ type: "agent", value: { id: regularAgent.id } }],
      pagination: { total: 1 },
      totals: { agents: 1, externalAgents: 0 },
    });
  });

  test("scopes the personal-owner filter to external agents for non-agent-admin managers", async ({
    makeAgent,
    makeCustomRole,
    makeMember,
    makeUser,
  }) => {
    const role = await makeCustomRole(ctx.organizationId, {
      permission: {
        agent: ["read"],
        agentSettings: ["update"],
      },
    });
    await makeMember(ctx.user.id, ctx.organizationId, { role: role.role });
    const otherUser = await makeUser();

    const sharedRegularAgent = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: "Shared regular agent",
      scope: "personal",
      authorId: otherUser.id,
    });
    await AgentUserModel.syncAgentUsers(sharedRegularAgent.id, [ctx.user.id]);

    const ownAgent = await createA2aRemoteAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      input: {
        name: "Own external agent",
        source: { type: "inline_card", agentCard: makeAgentCard() },
        auth: { type: "none" },
        scope: "personal",
      },
    });
    await createA2aRemoteAgent({
      organizationId: ctx.organizationId,
      authorId: otherUser.id,
      input: {
        name: "Other external agent",
        source: { type: "inline_card", agentCard: makeAgentCard() },
        auth: { type: "none" },
        scope: "personal",
      },
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/agent-catalog?excludeOtherPersonalAgents=true&limit=20&offset=0",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      data: [
        { type: "external", value: { id: ownAgent.id } },
        { type: "agent", value: { id: sharedRegularAgent.id } },
      ],
      pagination: { total: 2 },
      totals: { agents: 1, externalAgents: 1 },
    });
  });
});
