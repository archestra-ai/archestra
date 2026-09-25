import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { AgentPinModel } from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { createA2aRemoteAgent } from "@/services/a2a-outbound-registry";
import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
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
    });
    const delta = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: "Delta",
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

  test("splits pinned internal agents from the unified catalog", async ({
    makeAgent,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const alpha = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: "Alpha pinned",
    });
    const bravo = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: "Bravo unpinned",
    });
    const zulu = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: "Zulu pinned",
    });
    const external = await createA2aRemoteAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      input: {
        name: "External agent",
        source: { type: "inline_card", agentCard: makeAgentCard() },
        auth: { type: "none" },
        scope: "org",
      },
    });

    await AgentPinModel.pin({ userId: ctx.user.id, agentId: alpha.id });
    await AgentPinModel.pin({ userId: ctx.user.id, agentId: zulu.id });
    await setPinnedAt(alpha.id, "2026-01-01T00:00:00.000Z");
    await setPinnedAt(zulu.id, "2026-01-02T00:00:00.000Z");

    const pinned = await ctx.app.inject({
      method: "GET",
      url: "/api/agent-catalog?pinned=true&sortBy=name&sortDirection=asc&limit=20&offset=0",
    });
    expect(pinned.statusCode, pinned.body).toBe(200);
    expect(pinned.json()).toMatchObject({
      data: [
        { type: "agent", value: { id: zulu.id } },
        { type: "agent", value: { id: alpha.id } },
      ],
      pagination: { total: 2 },
      totals: { agents: 2, externalAgents: 0 },
    });
    expect(
      pinned
        .json()
        .data.every(
          (row: { value: { pinnedAt: unknown } }) =>
            typeof row.value.pinnedAt === "string",
        ),
    ).toBe(true);

    const unpinned = await ctx.app.inject({
      method: "GET",
      url: "/api/agent-catalog?pinned=false&sortBy=name&sortDirection=asc&limit=20&offset=0",
    });
    expect(unpinned.statusCode, unpinned.body).toBe(200);
    expect(unpinned.json()).toMatchObject({
      data: [
        { type: "agent", value: { id: bravo.id, pinnedAt: null } },
        { type: "external", value: { id: external.id } },
      ],
      pagination: { total: 2 },
      totals: { agents: 1, externalAgents: 1 },
    });

    async function setPinnedAt(agentId: string, value: string) {
      await db
        .update(schema.agentPinsTable)
        .set({ pinnedAt: new Date(value) })
        .where(
          and(
            eq(schema.agentPinsTable.userId, ctx.user.id),
            eq(schema.agentPinsTable.agentId, agentId),
          ),
        );
    }
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
      access: "personal",
      authorId: otherUser.id,
    });
    // Sharing an agent by name is a grant on its policy now; the legacy
    // agent_users junction no longer confers access once the policy is
    // migrated, which it is for every agent created in this organization.
    const policyKey = {
      organizationId: ctx.organizationId,
      resource: "agent" as const,
      scope: sharedRegularAgent.id,
    };
    const policy = await ResourcePermissionPolicyModel.find(policyKey);
    await ResourcePermissionPolicyModel.replace({
      ...policyKey,
      revision: policy?.revision ?? 0,
      grants: [
        ...(policy?.grants ?? []),
        {
          subject: { type: "user", id: ctx.user.id },
          actions: ["read", "use"],
        },
      ],
    });

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
