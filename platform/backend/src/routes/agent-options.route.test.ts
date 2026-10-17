// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { ResourcePermissionGrant } from "@archestra/shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import { AgentOptionSchema } from "@/types/agent";
import agentRoutes from "./agent";

describe("agent selector presentation parity", () => {
  const ctx = useRouteTestApp(agentRoutes);

  test("selector projection preserves every full-roster presentation field and authorized row", async ({
    makeMember,
    makeUser,
    makeAgent,
    makeTeam,
    makeTeamMember,
    makeOrganization,
    makeServiceAccount,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const owner = await makeUser();
    await makeMember(owner.id, ctx.organizationId);
    const team = await makeTeam(ctx.organizationId, ctx.user.id, {
      name: "Operations",
    });
    await makeTeamMember(team.id, ctx.user.id);
    const account = await makeServiceAccount(ctx.organizationId, {
      name: "Automation",
    });
    const make = (name: string) =>
      makeAgent({
        organizationId: ctx.organizationId,
        authorId: owner.id,
        access: "personal",
        agentType: "agent",
        name,
        description: "Selector description",
        slug: `option-${name.toLowerCase()}`,
      });
    const own = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      name: "Own",
      icon: "🔎",
    });
    const shared = await make("Shared");
    const teamed = await make("Team");
    const organization = await make("Organization");
    const privateAgent = await make("Private");
    const automation = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      name: "Automation",
      icon: `data:image/png;base64,${"A".repeat(2048)}`,
    });
    await db
      .update(schema.agentsTable)
      .set({ createdByServiceAccountId: account.id })
      .where(eq(schema.agentsTable.id, automation.id));
    await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "mcp_gateway",
      authorId: ctx.user.id,
      name: "Gateway",
    });
    const deleted = await make("Deleted");
    await db
      .update(schema.agentsTable)
      .set({ deletedAt: new Date() })
      .where(eq(schema.agentsTable.id, deleted.id));
    const foreign = await makeOrganization();
    const foreignAgent = await makeAgent({
      organizationId: foreign.id,
      agentType: "agent",
      name: "Foreign",
    });
    const replace = async (
      scope: string,
      grants: ResourcePermissionGrant[],
    ) => {
      const key = {
        organizationId: ctx.organizationId,
        resource: "agent" as const,
        scope,
      };
      const existing = await ResourcePermissionPolicyModel.find(key);
      await ResourcePermissionPolicyModel.replace({
        ...key,
        revision: existing?.revision ?? 0,
        grants,
      });
    };
    await replace(shared.id, [
      { subject: { type: "user", id: ctx.user.id }, actions: ["read"] },
      { subject: { type: "user", id: owner.id }, actions: ["read"] },
      {
        subject: { type: "user", id: "00000000-0000-4000-8000-000000000099" },
        actions: ["read"],
      },
    ]);
    await replace(teamed.id, [
      { subject: { type: "team", id: team.id }, actions: ["read"] },
    ]);
    await replace(organization.id, [
      { subject: { type: "organization", id: "*" }, actions: ["read"] },
    ]);
    const compare = async (query: string) => {
      const full = await ctx.app.inject({
        method: "GET",
        url: `/api/agents${query}&limit=100`,
      });
      expect(full.statusCode, full.body).toBe(200);
      const expected = full.json().data.map((row: Record<string, unknown>) =>
        AgentOptionSchema.parse({
          ...row,
          icon:
            typeof row.icon === "string" && row.icon.length > 1024
              ? null
              : row.icon,
        }),
      );
      // The paginated list and the selector options sort rows differently.
      const byId = (rows: Array<{ id: string }>) =>
        [...rows].sort((a, b) => a.id.localeCompare(b.id));
      const options = await walkOptions(ctx.app, `${query}&limit=2`);
      expect(byId(options)).toEqual(byId(expected));
      // Ask for one unreadable row too; the lookup must drop it.
      const ids = options.map((row) => row.id);
      const selected = await walkOptions(
        ctx.app,
        `${query}&limit=2&ids=${[...ids, foreignAgent.id].join(",")}`,
      );
      expect(byId(selected)).toEqual(byId(expected));
      expect(selected.map((row) => row.id)).not.toContain(foreignAgent.id);
      return options;
    };
    const query = "?excludeBuiltIn=true&agentTypes=agent";
    const admin = await compare(query);
    expect(
      admin.find((row: { id: string }) => row.id === shared.id),
    ).toMatchObject({
      users: [{ id: ctx.user.id }],
    });
    expect(
      admin.find((row: { id: string }) => row.id === teamed.id),
    ).toMatchObject({
      scope: "team",
      teams: [{ id: team.id, name: "Operations" }],
      authorName: owner.name,
      authorEmail: owner.email,
    });
    expect(
      admin.find((row: { name: string }) => row.name === "Automation"),
    ).toMatchObject({
      authorName: account.name,
      authorEmail: null,
      icon: null,
    });
    await compare(`${query}&scope=team`);
    await compare(`${query}&status=deleted`);
    const selected = await ctx.app.inject({
      method: "GET",
      url: `/api/agents/options${query}&ids=${own.id},${foreignAgent.id}`,
    });
    expect(selected.statusCode, selected.body).toBe(200);
    expect(selected.json().data.map((row: { id: string }) => row.id)).toEqual([
      own.id,
    ]);
    await compare("?excludeBuiltIn=true&agentTypes=agent,mcp_gateway");
    await db
      .update(schema.membersTable)
      .set({ role: "member" })
      .where(eq(schema.membersTable.userId, ctx.user.id));
    const member = await compare(query);
    expect(member.map((row) => row.id)).toEqual(
      expect.arrayContaining([own.id, shared.id, teamed.id, organization.id]),
    );
    expect(member.map((row) => row.name)).not.toContain("Private");
    // Same-organization rows the member cannot read stay hidden by ID too.
    const unreadable = await ctx.app.inject({
      method: "GET",
      url: `/api/agents/options${query}&ids=${privateAgent.id},${own.id}`,
    });
    expect(unreadable.statusCode, unreadable.body).toBe(200);
    expect(unreadable.json().data.map((row: { id: string }) => row.id)).toEqual(
      [own.id],
    );
    await replace("*", [
      { subject: { type: "role", id: "member" }, actions: ["read"] },
    ]);
    await compare(query);
  });

  test("pages bounded option lists with a default first page and capped ID filters", async ({
    makeMember,
    makeAgent,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      name: "Referenced",
    });
    await db.insert(schema.agentsTable).values(
      Array.from({ length: 1000 }, (_, i) => ({
        organizationId: ctx.organizationId,
        name: `Bulk ${i}`,
        agentType: "agent" as const,
        scope: "personal" as const,
      })),
    );
    const lookup = (query: string) =>
      ctx.app.inject({ method: "GET", url: `/api/agents/options${query}` });
    const missing = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      );

    // The staging-style id-less calls now get one default page, not the roster.
    for (const query of [
      "?excludeBuiltIn=true&agentType=agent",
      "?excludeBuiltIn=true&agentTypes=agent,mcp_gateway&excludeOtherPersonalAgents=true",
    ]) {
      const first = await lookup(query);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().data).toHaveLength(100);
      expect(first.json().pagination).toMatchObject({ hasNext: true });
      expect(first.json().pagination.nextCursor).toEqual(expect.any(String));
    }
    const max = await lookup("?agentType=agent&limit=1000");
    expect(max.statusCode, max.body).toBe(200);
    expect(max.json().data).toHaveLength(1000);
    expect(max.json().pagination.hasNext).toBe(true);
    expect((await lookup("?agentType=agent&limit=1001")).statusCode).toBe(400);
    expect((await lookup("?agentType=agent&limit=0")).statusCode).toBe(400);

    const all = await walkOptions(ctx.app, "?agentType=agent&limit=1000");
    expect(all).toHaveLength(1001);

    const twoHundred = await lookup(
      `?ids=${[agent.id, ...missing(199)].join(",")}`,
    );
    expect(twoHundred.statusCode, twoHundred.body).toBe(200);
    expect(twoHundred.json().data.map((row: { id: string }) => row.id)).toEqual(
      [agent.id],
    );
    expect(
      (await lookup(`?ids=${[agent.id, ...missing(200)].join(",")}`))
        .statusCode,
    ).toBe(400);

    // A small page size walks an ID filter without gaps or duplicates.
    const someIds = all.slice(0, 7).map((row) => row.id);
    const filtered = await walkOptions(
      ctx.app,
      `?limit=2&ids=${[...someIds, ...missing(3)].join(",")}`,
    );
    expect(filtered.map((row) => row.id).sort()).toEqual([...someIds].sort());
  });
});

/** Follows `nextCursor` to the end, failing on any repeated row. */
async function walkOptions(
  app: ReturnType<typeof useRouteTestApp>["app"],
  query: string,
): Promise<Array<{ id: string; name: string }>> {
  const rows: Array<{ id: string; name: string }> = [];
  let cursor: string | null = null;
  do {
    const response: { statusCode: number; body: string; json(): unknown } =
      await app.inject({
        method: "GET",
        url: `/api/agents/options${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      });
    expect(response.statusCode, response.body).toBe(200);
    const page = response.json() as {
      data: Array<{ id: string; name: string }>;
      pagination: { nextCursor: string | null };
    };
    rows.push(...page.data);
    cursor = page.pagination.nextCursor;
  } while (cursor);
  expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  return rows;
}
