// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import type { AgentOption } from "@/types/agent";
import { agentsForProjectAudience } from "../../../frontend/src/lib/projects/project-agent-audience";
import agentRoutes from "./agent";

describe("bounded agent options", () => {
  const ctx = useRouteTestApp(agentRoutes);
  const get = async (path: string) => {
    const response = await ctx.app.inject({ method: "GET", url: path });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };
  // The by-ID lookup is the roster's presentation source of truth.
  const resolveAll = async (query: string) => {
    const ids: string[] = await get(`/api/agents/options/ids${query}`);
    const page = await get(
      `/api/agents/options${query}&limit=1000&ids=${ids.join(",")}`,
    );
    expect(page.pagination.nextCursor).toBeNull();
    return page.data;
  };
  test("pages the complete authorized roster before hydration with stable timestamp ties", async ({
    makeMember,
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const owner = await makeUser();
    const agents = [];
    for (let i = 0; i < 5; i++)
      agents.push(
        await makeAgent({
          organizationId: ctx.organizationId,
          authorId: owner.id,
          agentType: "agent",
          name: `Candidate ${i}`,
        }),
      );
    for (const [i, agent] of agents.entries())
      await db
        .update(schema.agentsTable)
        .set({
          createdAt: sql`'2026-01-01 12:00:00'::timestamp + ${i} * interval '100 microseconds'`,
        })
        .where(eq(schema.agentsTable.id, agent.id));
    const foreign = await makeOrganization();
    await makeAgent({
      organizationId: foreign.id,
      name: "Foreign",
      agentType: "agent",
    });
    await makeAgent({
      organizationId: ctx.organizationId,
      name: "Gateway",
      agentType: "mcp_gateway",
    });
    const base =
      "/api/agents/options/page?excludeBuiltIn=true&agentTypes=agent&limit=2";
    const full = await resolveAll("?excludeBuiltIn=true&agentTypes=agent");
    const rows = [];
    let cursor: string | null = null;
    do {
      const page = await get(
        `${base}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(page.data.length).toBeLessThanOrEqual(2);
      rows.push(...page.data);
      cursor = page.pagination.nextCursor;
      if (cursor) expect(page.pagination.hasNext).toBe(true);
    } while (cursor);
    expect(rows.map((row) => row.id)).toEqual(
      agents.toReversed().map((agent) => agent.id),
    );
    expect(rows).toEqual(
      agents
        .toReversed()
        .map((agent) =>
          full.find((row: { id: string }) => row.id === agent.id),
        ),
    );
    expect(
      await get("/api/agents/options/ids?excludeBuiltIn=true&agentTypes=agent"),
    ).toEqual(rows.map((row) => row.id));
    const first = await get(base);
    expect((await get(`${base}&cursor=malformed`)).data).toEqual(first.data);
  });

  test("preserves member fences and reaches shared, organization and owned candidates", async ({
    makeMember,
    makeAgent,
    makeUser,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const other = await makeUser();
    await makeMember(other.id, ctx.organizationId);
    await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      name: "Own",
    });
    await makeAgent({
      organizationId: ctx.organizationId,
      authorId: other.id,
      agentType: "agent",
      name: "Hidden",
      access: "personal",
    });
    await makeAgent({
      organizationId: ctx.organizationId,
      authorId: other.id,
      agentType: "agent",
      name: "Organization",
      access: "org",
    });
    const shared = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: other.id,
      agentType: "agent",
      name: "Shared",
      access: "personal",
    });
    const policy = {
      organizationId: ctx.organizationId,
      resource: "agent" as const,
      scope: shared.id,
    };
    const previous = await ResourcePermissionPolicyModel.find(policy);
    await ResourcePermissionPolicyModel.replace({
      ...policy,
      revision: previous?.revision ?? 0,
      grants: [
        { subject: { type: "user", id: ctx.user.id }, actions: ["read"] },
      ],
    });
    const legacy = await resolveAll("?excludeBuiltIn=true&agentTypes=agent");
    const ids = await get(
      "/api/agents/options/ids?excludeBuiltIn=true&agentTypes=agent",
    );
    expect(ids.toSorted()).toEqual(
      legacy.map((row: { id: string }) => row.id).sort(),
    );
    expect(legacy.map((row: { name: string }) => row.name)).not.toContain(
      "Hidden",
    );
    const page = await get(
      "/api/agents/options/page?excludeBuiltIn=true&agentTypes=agent&limit=1&exactName=Shared",
    );
    expect(page.data).toEqual([
      legacy.find((row: { id: string }) => row.id === shared.id),
    ]);
    expect(
      (
        await get(
          `/api/agents/options/page?excludeBuiltIn=true&exactName=Shared&authorId=${ctx.user.id}`,
        )
      ).data,
    ).toEqual([]);
  });

  test("searches picker identity/team text or descriptions literally before limiting", async ({
    makeMember,
    makeAgent,
    makeUser,
    makeTeam,
    makeTeamMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const owner = await makeUser({
      name: "Resolver Owner",
      email: "resolver@example.test",
    });
    await makeMember(owner.id, ctx.organizationId);
    const team = await makeTeam(ctx.organizationId, ctx.user.id, {
      name: "Operations Group",
    });
    await makeTeamMember(team.id, ctx.user.id);
    const target = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: owner.id,
      agentType: "agent",
      name: "Literal%_ Name",
      description: "Special description",
      access: { teams: [team.id] },
    });
    const full = (await get(`/api/agents/options?ids=${target.id}`)).data;
    expect(full).toHaveLength(1);
    expect(full[0].teams).toHaveLength(1);
    for (const search of [
      "resolver@example.test",
      "Resolver Owner",
      "Operations Group",
      "%_",
    ])
      expect(
        (
          await get(
            `/api/agents/options/page?limit=1&search=${encodeURIComponent(search)}`,
          )
        ).data,
      ).toEqual(full);
    expect(
      (
        await get(
          "/api/agents/options/page?search=Special%20description&searchMode=name_or_description",
        )
      ).data,
    ).toEqual(full);
    expect(
      (await get("/api/agents/options/page?search=Operations&searchMode=name"))
        .data,
    ).toEqual([]);
    expect(
      (
        await get(
          "/api/agents/options/page?search=Special%20description&searchMode=selector",
        )
      ).data,
    ).toEqual([]);
  });
  test("filters exact project audiences before paging with the existing client eligibility contract", async ({
    makeMember,
    makeAgent,
    makeUser,
    makeTeam,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const owner = await makeUser();
    await makeMember(owner.id, ctx.organizationId);
    const teamA = await makeTeam(ctx.organizationId, owner.id, {
      name: "Audience A",
    });
    const teamB = await makeTeam(ctx.organizationId, owner.id, {
      name: "Audience B",
    });
    const common = {
      organizationId: ctx.organizationId,
      agentType: "agent" as const,
      authorId: owner.id,
    };
    await makeAgent({ ...common, name: "Organization", access: "org" });
    await makeAgent({
      ...common,
      name: "Both teams",
      access: { teams: [teamA.id, teamB.id] },
    });
    await makeAgent({
      ...common,
      name: "One team",
      access: { teams: [teamA.id] },
    });
    await makeAgent({
      ...common,
      name: "Named users",
      access: { users: [ctx.user.id] },
    });
    await makeAgent({ ...common, name: "Owner only", access: "personal" });
    await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: "No owner",
      access: "personal",
    });
    const legacy: AgentOption[] = await resolveAll(
      "?excludeBuiltIn=true&agentTypes=agent",
    );
    const cases = [
      {
        visibility: "none" as const,
        teamIds: [],
        userIds: [],
        editorIsOwner: true,
      },
      {
        visibility: "none" as const,
        teamIds: [],
        userIds: [],
        editorIsOwner: false,
      },
      {
        visibility: "organization" as const,
        teamIds: [],
        userIds: [],
        editorIsOwner: true,
      },
      {
        visibility: "team" as const,
        teamIds: [teamA.id, teamB.id],
        userIds: [],
        editorIsOwner: true,
      },
      {
        visibility: "team" as const,
        teamIds: [],
        userIds: [],
        editorIsOwner: true,
      },
      {
        visibility: "user" as const,
        teamIds: [],
        userIds: [owner.id, ctx.user.id],
        editorIsOwner: true,
      },
      {
        visibility: "user" as const,
        teamIds: [],
        userIds: ["missing-user"],
        editorIsOwner: true,
      },
      {
        visibility: "user" as const,
        teamIds: [],
        userIds: [],
        editorIsOwner: true,
      },
    ];
    expect(
      (
        await get(
          "/api/agents/options/ids?excludeBuiltIn=true&agentTypes=agent&onlyOwnPersonalAgents=true",
        )
      ).sort(),
    ).toEqual(
      legacy
        .filter(
          (agent) =>
            agent.scope !== "personal" || agent.authorId === ctx.user.id,
        )
        .map((agent) => agent.id)
        .sort(),
    );
    for (const share of cases) {
      const expected = agentsForProjectAudience(legacy, {
        share,
        editorIsOwner: share.editorIsOwner,
      })
        .map((agent) => agent.id)
        .sort();
      const query = new URLSearchParams({
        excludeBuiltIn: "true",
        agentTypes: "agent",
        audienceVisibility: share.visibility,
        audienceEditorIsOwner: String(share.editorIsOwner),
      });
      if (share.teamIds.length)
        query.set("audienceTeamIds", share.teamIds.join(","));
      if (share.userIds.length)
        query.set("audienceUserIds", share.userIds.join(","));
      expect((await get(`/api/agents/options/ids?${query}`)).sort()).toEqual(
        expected,
      );
      const actual: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await get(
          `/api/agents/options/page?${query}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        actual.push(...page.data.map((agent: { id: string }) => agent.id));
        cursor = page.pagination.nextCursor;
      } while (cursor);
      expect(actual.sort()).toEqual(expected);
    }
  });
  test("bounds credential readiness to requested enforcing agents without changing default eligibility", async ({
    makeMember,
    makeAgent,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const base = {
      organizationId: ctx.organizationId,
      agentType: "agent" as const,
      authorId: ctx.user.id,
    };
    const first = await makeAgent({
      ...base,
      missingCredentialBehavior: "warn",
    });
    const second = await makeAgent({
      ...base,
      missingCredentialBehavior: "block",
    });
    const allow = await makeAgent({
      ...base,
      missingCredentialBehavior: "allow",
    });
    const full = await get("/api/agents/credential-readiness");
    expect(full.map((row: { agentId: string }) => row.agentId).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(
      await get(`/api/agents/credential-readiness?ids=${first.id},${allow.id}`),
    ).toEqual(
      full.filter((row: { agentId: string }) => row.agentId === first.id),
    );
    const invalid = await ctx.app.inject({
      method: "GET",
      url: `/api/agents/credential-readiness?ids=${Array.from({ length: 201 }, () => first.id).join(",")}`,
    });
    expect(invalid.statusCode).toBe(400);
  });
});
