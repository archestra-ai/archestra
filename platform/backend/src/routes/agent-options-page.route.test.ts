// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { PGlite } from "@electric-sql/pglite";
import { eq, inArray, sql } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
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
          name: `Candidate ${Math.floor(i / 2)}`,
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
    const namedRows = [];
    cursor = null;
    do {
      const page = await get(
        `${base}&sortBy=name${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      namedRows.push(...page.data);
      cursor = page.pagination.nextCursor;
    } while (cursor);
    expect(namedRows.map((row) => row.id)).toEqual(
      agents
        .toSorted(
          (left, right) =>
            Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)) ||
            left.id.localeCompare(right.id),
        )
        .map((agent) => agent.id),
    );
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
  test("caps the ids filter at 200 on every options route", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const ids = (count: number) =>
      Array.from({ length: count }, () => crypto.randomUUID()).join(",");
    for (const path of [
      "/api/agents/options",
      "/api/agents/options/page",
      "/api/agents/options/ids",
    ]) {
      const status = async (count: number) =>
        (
          await ctx.app.inject({
            method: "GET",
            url: `${path}?ids=${ids(count)}`,
          })
        ).statusCode;
      expect(await status(200), path).toBe(200);
      expect(await status(201), path).toBe(400);
    }
  });
  test("reads a page and its shares, authors and audiences in a fixed number of statements", async ({
    makeMember,
    makeAgent,
    makeTeam,
    makeUser,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const author = await makeUser({ name: "Page Author" });
    const reader = await makeUser({ name: "Page Reader" });
    await makeMember(author.id, ctx.organizationId);
    await makeMember(reader.id, ctx.organizationId);
    const team = await makeTeam(ctx.organizationId, ctx.user.id, {
      name: "Page Team",
    });
    for (let i = 0; i < 3; i++) {
      await makeAgent({
        organizationId: ctx.organizationId,
        authorId: author.id,
        agentType: "agent",
        name: `Team Shared ${i}`,
        access: { teams: [team.id], level: "use" },
      });
      await makeAgent({
        organizationId: ctx.organizationId,
        authorId: author.id,
        agentType: "agent",
        name: `User Shared ${i}`,
        access: { users: [reader.id], preset: "view" },
      });
    }
    const statements = async (url: string) => {
      const query = vi.spyOn(PGlite.prototype, "query");
      const response = await ctx.app.inject({ method: "GET", url });
      const calls = query.mock.calls.length;
      query.mockRestore();
      expect(response.statusCode, response.body).toBe(200);
      return { calls, data: response.json().data };
    };
    for (const route of ["options/page", "chat-roster/page"]) {
      const empty = await statements(
        `/api/agents/${route}?limit=20&search=no-such-agent`,
      );
      const one = await statements(`/api/agents/${route}?limit=1`);
      const full = await statements(`/api/agents/${route}?limit=20`);
      expect(empty.data).toEqual([]);
      expect(one.data).toHaveLength(1);
      // Chat lists shared agents only; the options page also lists people's.
      expect(full.data.length).toBeGreaterThanOrEqual(
        route === "options/page" ? 6 : 3,
      );
      // Enriching more rows, or none, adds no statement of its own.
      expect(one.calls).toBe(empty.calls);
      expect(full.calls).toBe(empty.calls);
      if (route === "options/page") {
        const byName = new Map(
          full.data.map((option: AgentOption) => [option.name, option]),
        );
        expect(byName.get("Team Shared 0")).toMatchObject({
          authorName: "Page Author",
          teams: [{ id: team.id, name: "Page Team" }],
        });
        expect(byName.get("User Shared 0")).toMatchObject({
          authorName: "Page Author",
          users: [{ id: reader.id }],
        });
      }
    }
  });
  test("presents creators and read recipients of each page row", async ({
    makeMember,
    makeAgent,
    makeTeam,
    makeUser,
    makeServiceAccount,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const author = await makeUser({ name: "Row Author" });
    const reader = await makeUser({ name: "Row Reader" });
    await makeMember(author.id, ctx.organizationId);
    await makeMember(reader.id, ctx.organizationId);
    const team = await makeTeam(ctx.organizationId, ctx.user.id, {
      name: "Row Team",
    });
    const shared = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: author.id,
      agentType: "agent",
      name: "Row Shared",
      access: "personal",
    });
    const repeated = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: author.id,
      agentType: "agent",
      name: "Row Shared Again",
      access: "personal",
    });
    // One policy that names the author, a team and another person.
    await db
      .update(schema.resourcePermissionPoliciesTable)
      .set({
        grants: [
          {
            subject: { type: "user", id: author.id },
            actions: ["read", "use", "update", "delete", "manage-permissions"],
          },
          { subject: { type: "team", id: team.id }, actions: ["read", "use"] },
          { subject: { type: "user", id: reader.id }, actions: ["read"] },
        ],
      })
      .where(
        inArray(schema.resourcePermissionPoliciesTable.scope, [
          shared.id,
          repeated.id,
        ]),
      );
    const make = async (name: string) => {
      const account = await makeServiceAccount(ctx.organizationId, {
        name: `${name} Account`,
      });
      const agent = await makeAgent({
        organizationId: ctx.organizationId,
        agentType: "agent",
        name,
      });
      await db
        .update(schema.agentsTable)
        .set({ createdByServiceAccountId: account.id, authorId: null })
        .where(eq(schema.agentsTable.id, agent.id));
      return account;
    };
    await make("Row Automation");
    const removed = await make("Row Orphan");
    await db
      .delete(schema.serviceAccountsTable)
      .where(eq(schema.serviceAccountsTable.id, removed.id));
    const page: AgentOption[] = (
      await get("/api/agents/options/page?search=Row&limit=20")
    ).data;
    const byName = new Map(page.map((option) => [option.name, option]));
    expect(byName.get("Row Shared")).toMatchObject({
      authorName: "Row Author",
      teams: [{ id: team.id, name: "Row Team" }],
      // The author's own grant is not a share.
      users: [{ id: reader.id }],
    });
    expect(byName.get("Row Automation")).toMatchObject({
      authorName: "Row Automation Account",
      authorEmail: null,
    });
    expect(byName.get("Row Orphan")).toMatchObject({
      authorId: null,
      authorName: null,
      authorEmail: null,
    });
    expect(byName.get("Row Shared Again")).toMatchObject({
      authorName: "Row Author",
      teams: [{ id: team.id, name: "Row Team" }],
      users: [{ id: reader.id }],
    });
    const first = await get(
      "/api/agents/options/page?search=Row%20Shared&sortBy=name&limit=1",
    );
    const second = await get(
      `/api/agents/options/page?search=Row%20Shared&sortBy=name&limit=1&cursor=${encodeURIComponent(first.pagination.nextCursor)}`,
    );
    expect(first.data).toEqual([byName.get("Row Shared")]);
    expect(second.data).toEqual([byName.get("Row Shared Again")]);
    expect(second.pagination.nextCursor).toBeNull();
    const legacy = await AgentModel.findAll(ctx.user.id, true, {
      view: "options",
    });
    const sharedOption = byName.get("Row Shared");
    const repeatedOption = byName.get("Row Shared Again");
    if (!sharedOption || !repeatedOption)
      throw new Error("Missing shared options");
    expect(legacy.find((row) => row.id === shared.id)).toMatchObject(
      sharedOption,
    );
    expect(legacy.find((row) => row.id === repeated.id)).toMatchObject(
      repeatedOption,
    );
  });
  test("searches names, creators and team recipients alone and across fields", async ({
    makeMember,
    makeAgent,
    makeTeam,
    makeUser,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const author = await makeUser({
      name: "Quill Writer",
      email: "quill.writer@example.test",
    });
    await makeMember(author.id, ctx.organizationId);
    const team = await makeTeam(ctx.organizationId, ctx.user.id, {
      name: "Heron Squad",
    });
    await makeAgent({
      organizationId: ctx.organizationId,
      authorId: author.id,
      agentType: "agent",
      name: "Lantern",
    });
    await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      name: "Compass",
      access: { teams: [team.id], level: "use" },
    });
    const names = async (search: string) =>
      (
        await get(
          `/api/agents/options/page?limit=20&search=${encodeURIComponent(search)}`,
        )
      ).data
        .map((option: AgentOption) => option.name)
        .sort();
    expect(await names("antern")).toEqual(["Lantern"]);
    expect(await names("QUILL.WRITER@")).toEqual(["Lantern"]);
    expect(await names("writer")).toEqual(["Lantern"]);
    expect(await names("heron")).toEqual(["Compass"]);
    // A term with a space can span the searched fields: name, then email.
    expect(await names("lantern quill.writer")).toEqual(["Lantern"]);
    expect(await names("compass heron")).toEqual([]);
  });
  test("never lists LLM proxies, for an admin or a member", async ({
    makeMember,
    makeAgent,
  }) => {
    const proxy = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "llm_proxy",
      name: "Roster Proxy",
    });
    await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      authorId: ctx.user.id,
      name: "Roster Agent",
    });
    const member = await makeMember(ctx.user.id, ctx.organizationId, {
      role: "member",
    });
    for (const role of ["member", "admin"]) {
      await db
        .update(schema.membersTable)
        .set({ role })
        .where(eq(schema.membersTable.id, member.id));
      const ids: string[] = await get(
        "/api/agents/options/ids?excludeBuiltIn=false",
      );
      const page = await get("/api/agents/options/page?limit=100");
      const byIds = await get(
        `/api/agents/options?excludeBuiltIn=false&ids=${proxy.id},${ids[0]}&limit=10`,
      );
      expect(ids.length).toBeGreaterThan(0);
      expect(ids).not.toContain(proxy.id);
      for (const options of [page.data, byIds.data])
        expect(
          options.map((option: AgentOption) => option.agentType),
        ).not.toContain("llm_proxy");
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
