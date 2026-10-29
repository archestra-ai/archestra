import {
  ADMIN_ROLE_NAME,
  BUILT_IN_AGENT_IDS,
  MEMBER_ROLE_NAME,
} from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import {
  AgentPinModel,
  AgentToolModel,
  ExternalMcpSkillUsageEventModel,
  McpCatalogSkillModel,
  PluginModel,
  PluginSkillUsageEventModel,
  SkillModel,
} from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { createA2aRemoteAgent } from "@/services/a2a-outbound-registry";
import { accessGrants, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import { drainBackgroundWork } from "@/utils/background-work";
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

    // A page past the end has no rows but keeps the totals.
    const pastEnd = await ctx.app.inject({
      method: "GET",
      url: "/api/agent-catalog?sortBy=name&sortDirection=asc&limit=2&offset=4",
    });
    expect(pastEnd.statusCode, pastEnd.body).toBe(200);
    expect(pastEnd.json()).toMatchObject({
      data: [],
      pagination: { total: 4, hasNext: false, hasPrev: true },
      totals: { agents: 2, externalAgents: 2 },
    });

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
          initialGrants: [
            {
              subject: { type: "organization", id: "*" },
              actions: ["read", "use"],
            },
          ],
        },
      });
    }
  });

  test("adds the built-in agents to an access-filtered list on request", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const otherUser = await makeUser();
    await makeMember(otherUser.id, ctx.organizationId, { role: "member" });
    const suffix = crypto.randomUUID().slice(0, 8);
    await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: `Mine ${suffix}`,
      access: "personal",
      authorId: ctx.user.id,
    });
    await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: `Theirs ${suffix}`,
      access: "personal",
      authorId: otherUser.id,
    });
    await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: `Compaction ${suffix}`,
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.CONTEXT_COMPACTION },
    });

    const list = async (query: string) => {
      const response = await ctx.app.inject({
        method: "GET",
        url: `/api/agent-catalog?limit=50&offset=0&sortBy=name&sortDirection=asc&name=${suffix}&${query}`,
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      return {
        names: body.data
          .map((row: { value: { name: string } }) =>
            row.value.name.replace(` ${suffix}`, ""),
          )
          .sort(),
        total: body.pagination.total,
      };
    };

    expect(await list("access=mine")).toEqual({ names: ["Mine"], total: 1 });
    // Built-in agents have no author, so the access filter does not apply to
    // them; the flag adds them on top of the selection.
    expect(await list("access=mine&includeBuiltIn=true")).toEqual({
      names: ["Compaction", "Mine"],
      total: 2,
    });
    expect(await list("access=others&includeBuiltIn=true")).toEqual({
      names: ["Compaction", "Theirs"],
      total: 2,
    });
    // The older origin filter still lists the built-in agents alone.
    expect(await list("scope=built_in")).toEqual({
      names: ["Compaction"],
      total: 1,
    });
  });

  test("splits external agents by how the caller reaches them, from their grants", async ({
    makeMember,
    makeUser,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const otherUser = await makeUser();
    await makeMember(otherUser.id, ctx.organizationId, { role: "member" });
    const suffix = crypto.randomUUID().slice(0, 8);
    const createExternal = (name: string, authorId?: string) =>
      createA2aRemoteAgent({
        organizationId: ctx.organizationId,
        authorId,
        input: {
          name: `${name} ${suffix}`,
          source: { type: "inline_card", agentCard: makeAgentCard() },
          auth: { type: "none" },
        },
      });
    // An authored external agent starts personal; one without an author is
    // shared with the organization.
    await createExternal("Mine", ctx.user.id);
    await createExternal("Theirs", otherUser.id);
    await createExternal("Org");

    const list = async (access: string) => {
      const response = await ctx.app.inject({
        method: "GET",
        url: `/api/agent-catalog?limit=50&offset=0&name=${suffix}&access=${access}`,
      });
      expect(response.statusCode, response.body).toBe(200);
      return response
        .json()
        .data.map((row: { value: { name: string } }) =>
          row.value.name.replace(` ${suffix}`, ""),
        )
        .sort();
    };

    // The admin reads every external agent through a `*` grant, which must
    // not count as "shared".
    expect(await list("mine")).toEqual(["Mine"]);
    expect(await list("org")).toEqual(["Org"]);
    expect(await list("shared")).toEqual([]);
    expect(await list("others")).toEqual(["Theirs"]);
    expect(await list("mine,shared,org")).toEqual(["Mine", "Org"]);
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
        initialGrants: [
          {
            subject: { type: "organization", id: "*" },
            actions: ["read", "use"],
          },
        ],
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
        initialGrants: [
          {
            subject: { type: "organization", id: "*" },
            actions: ["read", "use"],
          },
        ],
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

    // The viewer's automatic pins show as tiles, so the table leaves them out
    // of its rows, its count and its "select all".
    const withoutAutomaticPins = await ctx.app.inject({
      method: "GET",
      url: `/api/agent-catalog?pinned=false&excludeIds=${bravo.id}&sortBy=name&sortDirection=asc&limit=20&offset=0`,
    });
    expect(withoutAutomaticPins.statusCode, withoutAutomaticPins.body).toBe(
      200,
    );
    expect(withoutAutomaticPins.json()).toMatchObject({
      data: [{ type: "external", value: { id: external.id } }],
      pagination: { total: 1 },
      totals: { agents: 0, externalAgents: 1 },
    });

    // ...and reads those pins as list rows of their own.
    const automaticPins = await ctx.app.inject({
      method: "GET",
      url: `/api/agent-catalog?ids=${bravo.id},${zulu.id}&sortBy=name&sortDirection=asc&limit=20&offset=0`,
    });
    expect(automaticPins.statusCode, automaticPins.body).toBe(200);
    expect(automaticPins.json()).toMatchObject({
      data: [
        { type: "agent", value: { id: bravo.id } },
        { type: "agent", value: { id: zulu.id } },
      ],
      pagination: { total: 2 },
      totals: { agents: 2, externalAgents: 0 },
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

  test("sorts by the tools, subagents and last-use values the rows show", async ({
    makeAgent,
    makeAgentTool,
    makeInteraction,
    makeMember,
    makeTool,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const all = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: "Every tool",
      accessAllTools: true,
      accessAllSubagents: false,
    });
    const two = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: "Two tools",
      accessAllTools: false,
      accessAllSubagents: true,
    });
    const none = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: "No tools",
      accessAllTools: false,
      accessAllSubagents: false,
    });
    for (const tool of [await makeTool(), await makeTool()]) {
      await makeAgentTool(two.id, tool.id);
    }
    const external = await createA2aRemoteAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      input: {
        name: "External agent",
        source: { type: "inline_card", agentCard: makeAgentCard() },
        auth: { type: "none" },
        initialGrants: [
          {
            subject: { type: "organization", id: "*" },
            actions: ["read", "use"],
          },
        ],
      },
    });

    const idsSortedBy = async (sortBy: string) => {
      const response = await ctx.app.inject({
        method: "GET",
        url: `/api/agent-catalog?sortBy=${sortBy}&sortDirection=desc&limit=20&offset=0`,
      });
      expect(response.statusCode, response.body).toBe(200);
      return response
        .json()
        .data.map((row: { value: { id: string } }) => row.value.id);
    };

    // "All" outranks any count; an external agent has neither.
    expect(await idsSortedBy("toolsCount")).toEqual([
      all.id,
      two.id,
      none.id,
      external.id,
    ]);
    expect(await idsSortedBy("subagentsCount")).toEqual([
      two.id,
      all.id,
      none.id,
      external.id,
    ]);
    // Used beats never used; the never-used rest tie and fall back to name.
    await makeInteraction(none.id);
    expect(await idsSortedBy("lastUsedAt")).toEqual([
      none.id,
      all.id,
      external.id,
      two.id,
    ]);
  });

  test("counts tools and subagents as the rows show them, with or without the tools", async ({
    makeAgent,
    makeAgentTool,
    makeMember,
    makeTool,
    seedAndAssignArchestraTools,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const target = await makeAgent({ organizationId: ctx.organizationId });
    // Seeded first, so the agent below gets the creation defaults, among
    // them the knowledge search tool that its tools leave out without
    // knowledge sources.
    await seedAndAssignArchestraTools(target.id);
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: "Counted agent",
    });
    for (const tool of [await makeTool(), await makeTool()]) {
      await makeAgentTool(agent.id, tool.id);
    }
    await AgentToolModel.assignDelegation({
      agentId: agent.id,
      targetAgentId: target.id,
    });
    const listed = async (extra: string) => {
      const response = await ctx.app.inject({
        method: "GET",
        url: `/api/agent-catalog?name=Counted%20agent&limit=20&offset=0${extra}`,
      });
      expect(response.statusCode, response.body).toBe(200);
      const [row] = response.json().data;
      return row.value as {
        tools: Array<{ delegateToAgentId: string | null }>;
        toolsCount: number;
        subagentsCount: number;
      };
    };

    const withTools = await listed("");
    const withoutTools = await listed("&includeTools=false");

    expect(withTools.subagentsCount).toBe(1);
    expect(withTools.toolsCount).toBe(
      withTools.tools.filter((tool) => !tool.delegateToAgentId).length,
    );
    expect(withTools.subagentsCount).toBe(
      withTools.tools.filter((tool) => tool.delegateToAgentId).length,
    );
    expect(withoutTools.tools).toEqual([]);
    expect(withoutTools.toolsCount).toBe(withTools.toolsCount);
    expect(withoutTools.subagentsCount).toBe(withTools.subagentsCount);
  });

  test("returns only rows the caller can bulk-select when requested", async ({
    makeAgent,
    makeCustomRole,
    makeMember,
    makeUser,
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
    // Someone else owns it, so the caller can use it but not delete it.
    const owner = await makeUser();
    await makeMember(owner.id, ctx.organizationId);
    await createA2aRemoteAgent({
      organizationId: ctx.organizationId,
      authorId: owner.id,
      input: {
        name: "Visible but unselectable external agent",
        source: { type: "inline_card", agentCard: makeAgentCard() },
        auth: { type: "none" },
        initialGrants: [
          {
            subject: { type: "organization", id: "*" },
            actions: ["read", "use"],
          },
        ],
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

  test("scopes the personal-owner filter to external agents for non-agent-admins", async ({
    makeAgent,
    makeCustomRole,
    makeMember,
    makeUser,
  }) => {
    const role = await makeCustomRole(ctx.organizationId, {
      permission: { agent: ["read"] },
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
      },
    });
    await createA2aRemoteAgent({
      organizationId: ctx.organizationId,
      authorId: otherUser.id,
      input: {
        name: "Other external agent",
        source: { type: "inline_card", agentCard: makeAgentCard() },
        auth: { type: "none" },
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

  test.for([
    ADMIN_ROLE_NAME,
    MEMBER_ROLE_NAME,
  ])("keeps every agent the Show filter reaches by each kind of grant (%s)", async (role, {
    makeAgent,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role });
    const otherUser = await makeUser();
    await makeMember(otherUser.id, ctx.organizationId, {
      role: MEMBER_ROLE_NAME,
    });
    const callerTeam = await makeTeam(ctx.organizationId, otherUser.id);
    await makeTeamMember(callerTeam.id, ctx.user.id);
    const otherTeam = await makeTeam(ctx.organizationId, otherUser.id);
    const suffix = crypto.randomUUID().slice(0, 8);
    const agent = (
      name: string,
      access: NonNullable<Parameters<typeof makeAgent>[0]>["access"],
      authorId = otherUser.id,
    ) =>
      makeAgent({
        organizationId: ctx.organizationId,
        agentType: "agent",
        name: `${name} ${suffix}`,
        authorId,
        access,
      });

    await agent("Team", { teams: [callerTeam.id], level: "use" });
    await agent("Direct", { users: [ctx.user.id], preset: "use" });
    await agent("Org", "org");
    await agent("Own", "personal", ctx.user.id);
    await agent("Other team", { teams: [otherTeam.id], level: "use" });
    await agent("Theirs", "personal");
    // A grant to a role, and nothing else, puts an agent in "org".
    const roleOnly = await agent("Role", "personal");
    const policyKey = {
      organizationId: ctx.organizationId,
      resource: "agent" as const,
      scope: roleOnly.id,
    };
    const policy = await ResourcePermissionPolicyModel.find(policyKey);
    await ResourcePermissionPolicyModel.replace({
      ...policyKey,
      revision: policy?.revision ?? 0,
      grants: [
        ...(policy?.grants ?? []),
        { subject: { type: "role", id: role }, actions: ["read", "use"] },
      ],
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/agent-catalog?limit=50&offset=0&name=${suffix}&access=mine,shared,org`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      response
        .json()
        .data.map((row: { value: { name: string } }) =>
          row.value.name.replace(` ${suffix}`, ""),
        )
        .sort(),
    ).toEqual(["Direct", "Org", "Own", "Role", "Team"]);
    expect(response.json().pagination.total).toBe(5);
  });

  test("counts native, plugin and MCP activation skills without summarizing their usage", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    config.mcpGateway.skillsEnabled = true;
    const suffix = crypto.randomUUID().slice(0, 8);
    // includeTools=false hides explicit assignments, so the count is driven by
    // the agent's dynamic load_skill availability.
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: `Skilled ${suffix}`,
      accessAllTools: true,
    });
    await SkillModel.createWithFiles({
      skill: {
        organizationId: ctx.organizationId,
        name: `native-${suffix}`,
        description: "A native skill",
        content: "# Native instructions",
      },
      files: [],
      environmentIds: [],
      ...accessGrants("org"),
    });
    const plugin = await PluginModel.create({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      input: {
        displayName: "Release bundle",
        description: "Release tooling",
        clientType: "claude-code",
        supportedPlatforms: ["posix"],
        files: [
          {
            path: "skills/release-notes/SKILL.md",
            content:
              "---\nname: release-notes\ndescription: Draft release notes.\n---\n# Notes",
            encoding: "utf8",
            mode: "100644",
          },
        ],
      },
      ...accessGrants("org"),
    });
    if (!plugin) throw new Error("failed to create test plugin");
    const catalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      serverType: "remote",
      scope: "org",
      ownerId: ctx.user.id,
    });
    await McpCatalogSkillModel.syncCatalog({
      catalogId: catalog.id,
      generation: (await McpCatalogSkillModel.beginRefresh(catalog.id)) ?? 0,
      skills: [
        {
          uri: "skill://example/triage/SKILL.md",
          name: "triage",
          description: "Triage incidents.",
          frontmatter: { name: "triage", description: "Triage incidents." },
          resources: null,
        },
      ],
    });
    PluginSkillUsageEventModel.recordUsage({
      pluginId: plugin.id,
      skillPath: "skills/release-notes",
      userId: ctx.user.id,
    });
    ExternalMcpSkillUsageEventModel.recordUsage({
      mcpServerId: server.id,
      uri: "skill://example/triage/SKILL.md",
      userId: ctx.user.id,
    });
    await drainBackgroundWork();
    const pluginSummaries = vi.spyOn(
      PluginSkillUsageEventModel,
      "getSummaries",
    );
    const externalSummaries = vi.spyOn(
      ExternalMcpSkillUsageEventModel,
      "getSummaries",
    );

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/agent-catalog?limit=10&offset=0&sortBy=createdAt&sortDirection=desc&pinned=false&access=mine,shared,org&includeTools=false&name=${suffix}`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual([
      expect.objectContaining({
        type: "agent",
        value: expect.objectContaining({
          id: agent.id,
          activationSkillsCount: 3,
        }),
      }),
    ]);
    expect(pluginSummaries).not.toHaveBeenCalled();
    expect(externalSummaries).not.toHaveBeenCalled();
  });
});
