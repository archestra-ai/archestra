import {
  BUILT_IN_AGENT_IDS,
  ResourcePermissionActionSchema,
  type ResourcePermissionGrant,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
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
        system.id,
      ]);
      expect(bootstrap).toEqual(
        [own, system].map((agent) =>
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
  test("falls back to the newest visible nonbuiltin when no own personal agent exists", async ({
    makeMember,
    makeUser,
    makeAgent,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const other = await makeUser();
    const organization = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      access: "org",
    });
    const personal = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: other.id,
      agentType: "agent",
      access: "personal",
    });
    await db
      .update(schema.agentsTable)
      .set({ createdAt: new Date("2000-01-01T00:00:00Z") })
      .where(eq(schema.agentsTable.id, organization.id));
    await db
      .update(schema.agentsTable)
      .set({ createdAt: new Date("2001-01-01T00:00:00Z") })
      .where(eq(schema.agentsTable.id, personal.id));
    const legacy = await get("/api/agents/chat-roster");
    expect(legacy.map((row: { id: string }) => row.id)).toContain(personal.id);
    expect(await get("/api/agents/chat-roster?bootstrap=true")).toEqual([
      legacy.find((row: { id: string }) => row.id === organization.id),
    ]);
  });
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  test.for([
    "admin",
    "member",
  ] as const)("preserves %s audience visibility and cursor ordering across grant subjects", async (role, {
    makeMember,
    makeUser,
    makeAgent,
    makeTeam,
    makeTeamMember,
    makeOrganization,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role });
    const other = await makeUser();
    await makeMember(other.id, ctx.organizationId);
    const team = await makeTeam(ctx.organizationId, ctx.user.id);
    await makeTeamMember(team.id, ctx.user.id);
    const foreignOrg = await makeOrganization();
    const unrelatedTeam = await makeTeam(ctx.organizationId, other.id);
    const subjectCases: Array<{
      name: string;
      grants: ResourcePermissionGrant[];
    }> = [
      {
        name: "Organization read",
        grants: [
          { subject: { type: "organization", id: "*" }, actions: ["read"] },
        ],
      },
      {
        name: "Role read",
        grants: [{ subject: { type: "role", id: role }, actions: ["read"] }],
      },
      {
        name: "Team read",
        grants: [{ subject: { type: "team", id: team.id }, actions: ["read"] }],
      },
      {
        name: "Unrelated role read",
        grants: [
          {
            subject: { type: "role", id: "unrelated-role" },
            actions: ["read"],
          },
        ],
      },
      {
        name: "Unrelated team read",
        grants: [
          {
            subject: { type: "team", id: unrelatedTeam.id },
            actions: ["read"],
          },
        ],
      },
      {
        name: "Named user read",
        grants: [
          { subject: { type: "user", id: ctx.user.id }, actions: ["read"] },
        ],
      },
      {
        name: "Service account read",
        grants: [
          {
            subject: { type: "serviceAccount", id: crypto.randomUUID() },
            actions: ["read"],
          },
        ],
      },
      {
        name: "Organization use only",
        grants: [
          { subject: { type: "organization", id: "*" }, actions: ["use"] },
        ],
      },
      {
        name: "Role use with named reader",
        grants: [
          { subject: { type: "role", id: role }, actions: ["use"] },
          { subject: { type: "user", id: ctx.user.id }, actions: ["read"] },
        ],
      },
      {
        name: "Team update with named reader",
        grants: [
          { subject: { type: "team", id: team.id }, actions: ["update"] },
          { subject: { type: "user", id: ctx.user.id }, actions: ["read"] },
        ],
      },
      {
        name: "Mixed organization and team read",
        grants: [
          { subject: { type: "team", id: team.id }, actions: ["read"] },
          { subject: { type: "organization", id: "*" }, actions: ["read"] },
        ],
      },
      {
        name: "Duplicate team read",
        grants: Array.from({ length: 2 }, () => ({
          subject: { type: "team" as const, id: team.id },
          actions: ["read" as const],
        })),
      },
      {
        name: "Foreign scope policy",
        grants: [
          { subject: { type: "user", id: ctx.user.id }, actions: ["read"] },
        ],
      },
      {
        name: "Other resource policy",
        grants: [
          { subject: { type: "user", id: ctx.user.id }, actions: ["read"] },
        ],
      },
    ];
    for (const action of ResourcePermissionActionSchema.options.filter(
      (action) => action !== "read",
    )) {
      subjectCases.push({
        name: `Organization ${action} with named reader`,
        grants: [
          { subject: { type: "organization", id: "*" }, actions: [action] },
          { subject: { type: "user", id: ctx.user.id }, actions: ["read"] },
        ],
      });
    }
    const expectedShared = new Set<string>();
    for (const item of subjectCases) {
      const agent = await makeAgent({
        organizationId: ctx.organizationId,
        authorId: other.id,
        agentType: "agent",
        access: "personal",
        name: item.name,
      });
      await db.transaction(async (tx) =>
        ResourcePermissionPolicyModel.updatePresetUpgradePolicy({
          tx,
          policy: {
            organizationId: ctx.organizationId,
            resource: "agent",
            scope: agent.id,
          },
          grants: [
            { subject: { type: "user", id: other.id }, actions: ["read"] },
            ...item.grants,
          ],
        }),
      );
      if (
        item.name === "Foreign scope policy" ||
        item.name === "Other resource policy"
      ) {
        await ResourcePermissionPolicyModel.replace({
          organizationId:
            item.name === "Foreign scope policy"
              ? foreignOrg.id
              : ctx.organizationId,
          resource:
            item.name === "Other resource policy" ? "mcpGateway" : "agent",
          scope: agent.id,
          revision: 0,
          grants: [
            { subject: { type: "organization", id: "*" }, actions: ["read"] },
          ],
        });
      }
      if (
        [
          "Organization read",
          "Role read",
          "Team read",
          "Mixed organization and team read",
          "Duplicate team read",
        ].includes(item.name) ||
        (role === "admin" &&
          ["Unrelated role read", "Unrelated team read"].includes(item.name))
      )
        expectedShared.add(agent.id);
    }
    const own = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      access: "personal",
      name: "Own personal",
    });
    const foreign = await makeAgent({
      organizationId: foreignOrg.id,
      agentType: "agent",
      access: "org",
    });
    const deleted = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      access: "org",
    });
    await AgentModel.delete(deleted.id);
    const builtin = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      access: "org",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG },
    });
    const legacy = await get("/api/agents/chat-roster");
    const expected = legacy.filter(
      (agent: { builtIn: boolean; scope: string; authorId: string | null }) =>
        !agent.builtIn &&
        (agent.scope !== "personal" || agent.authorId === ctx.user.id),
    );
    expected.sort(
      (
        a: { scope: string; name: string; id: string },
        b: { scope: string; name: string; id: string },
      ) => {
        const rank = (scope: string) =>
          scope === "personal" ? 0 : scope === "team" ? 1 : 2;
        return (
          rank(a.scope) - rank(b.scope) ||
          Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)) ||
          a.id.localeCompare(b.id)
        );
      },
    );
    expect(new Set(expected.map((agent: { id: string }) => agent.id))).toEqual(
      new Set([own.id, ...expectedShared]),
    );
    const actual = [];
    let cursor: string | null = null;
    do {
      const page = await get(
        `/api/agents/chat-roster/page?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      actual.push(...page.data);
      cursor = page.pagination.nextCursor;
    } while (cursor);
    expect(actual).toEqual(expected);
    for (const agent of [foreign, deleted, builtin])
      expect(actual.map((row) => row.id)).not.toContain(agent.id);
    expect(
      (await get("/api/agents/chat-roster/page?search=read&limit=100")).data,
    ).toEqual(
      expected.filter((agent: { name: string }) =>
        agent.name.toLowerCase().includes("read"),
      ),
    );
  });
  // SPDX-SnippetEnd
  test("resumes the chat order from a rank and name cursor", async ({
    makeMember,
    makeAgent,
    makeTeam,
    makeTeamMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const team = await makeTeam(ctx.organizationId, ctx.user.id);
    await makeTeamMember(team.id, ctx.user.id);
    const make = (
      name: string,
      access: NonNullable<Parameters<typeof makeAgent>[0]>["access"],
    ) =>
      makeAgent({
        organizationId: ctx.organizationId,
        authorId: ctx.user.id,
        agentType: "agent",
        name,
        access,
      });
    await make("Own B", "personal");
    await make("Own A", "personal");
    await make("Team B", { teams: [team.id], level: "use" });
    await make("Team A", { teams: [team.id], level: "use" });
    await make("Org B", "org");
    await make("Org A", "org");
    const all = (await get("/api/agents/chat-roster/page?limit=100")).data as {
      id: string;
      name: string;
    }[];
    expect(all.map((row) => row.name)).toEqual([
      "Own A",
      "Own B",
      "Team A",
      "Team B",
      "Org A",
      "Org B",
    ]);
    // The cursor a page hands out: the last row's rank and name, and its id.
    const cursorAfter = (index: number, rank: number) =>
      Buffer.from(
        JSON.stringify({
          id: all[index].id,
          value: JSON.stringify({ rank, name: all[index].name }),
        }),
      ).toString("base64url");
    for (const [index, rank] of [
      [0, 0],
      [1, 0],
      [2, 1],
      [4, 2],
    ] as const) {
      const page = await get(
        `/api/agents/chat-roster/page?limit=2&cursor=${cursorAfter(index, rank)}`,
      );
      expect(page.data.map((row: { id: string }) => row.id)).toEqual(
        all.slice(index + 1, index + 3).map((row) => row.id),
      );
    }
    // Past the last rank nothing follows.
    const beyond = Buffer.from(
      JSON.stringify({
        id: all[5].id,
        value: JSON.stringify({ rank: 3, name: "" }),
      }),
    ).toString("base64url");
    expect(
      (await get(`/api/agents/chat-roster/page?limit=2&cursor=${beyond}`)).data,
    ).toEqual([]);
  });
});
