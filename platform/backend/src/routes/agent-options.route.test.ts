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
    makeTool,
    makeAgentTool,
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
      systemPrompt: "Configuration content",
    });
    await makeAgentTool(own.id, (await makeTool({})).id);
    const shared = await make("Shared");
    const teamed = await make("Team");
    const organization = await make("Organization");
    await make("Private");
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
      const options = await ctx.app.inject({
        method: "GET",
        url: `/api/agents/options${query}`,
      });
      expect(full.statusCode, full.body).toBe(200);
      expect(options.statusCode, options.body).toBe(200);
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
      expect(byId(options.json())).toEqual(byId(expected));
      expect(options.json().map((row: { id: string }) => row.id)).not.toContain(
        foreignAgent.id,
      );
      return options.json();
    };
    const query = "?excludeBuiltIn=true&agentTypes=agent";
    const admin = await compare(query);
    // Selectors get names and presentation only; editing content stays on the
    // detail route.
    const ownOption = admin.find((row: { id: string }) => row.id === own.id);
    for (const field of [
      "systemPrompt",
      "tools",
      "labels",
      "knowledgeBaseIds",
      "connectorIds",
      "suggestedPrompts",
    ]) {
      expect(ownOption).not.toHaveProperty(field);
    }
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
    expect(selected.json().map((row: { id: string }) => row.id)).toEqual([
      own.id,
    ]);
    await compare("?excludeBuiltIn=true&agentTypes=agent,mcp_gateway");
    await db
      .update(schema.membersTable)
      .set({ role: "member" })
      .where(eq(schema.membersTable.userId, ctx.user.id));
    const member = await compare(query);
    expect(member.map((row: { id: string }) => row.id)).toEqual(
      expect.arrayContaining([own.id, shared.id, teamed.id, organization.id]),
    );
    expect(member.map((row: { name: string }) => row.name)).not.toContain(
      "Private",
    );
    await replace("*", [
      { subject: { type: "role", id: "member" }, actions: ["read"] },
    ]);
    await compare(query);
  });
});
