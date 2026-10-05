// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type {
  PermissionSubject,
  ResourcePermissionAction,
  ScopedResource,
} from "@archestra/shared";
import { vi } from "vitest";
import db from "@/database";
import { describe, expect, test } from "@/test";
import AgentModel from "./agent";
import AgentTeamModel from "./agent-team";
import InternalMcpCatalogModel from "./internal-mcp-catalog";
import ProjectModel from "./project";
import ProjectAccessModel from "./project-access";
import ResourcePermissionPolicyModel from "./resource-permission-policy";
import TeamModel from "./team";

describe("grant visibility through list queries", () => {
  test("a grant at * does not answer a check that leaves * out", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const reader = await makeUser();
    await makeMember(owner.id, org.id);
    await makeMember(reader.id, org.id);
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: owner.id,
      name: "wildcard-only",
    });
    await addGrant({
      organizationId: org.id,
      resource: "project",
      scope: "*",
      subject: { type: "user", id: reader.id },
      actions: ["read"],
    });

    const listed = await ProjectAccessModel.listAccessibleProjects({
      userId: reader.id,
      organizationId: org.id,
    });
    expect(listed.map((p) => p.id)).toContain(project.id);
    expect(
      await ProjectAccessModel.userCanAccessProject({
        project,
        userId: reader.id,
        organizationId: org.id,
        sessionAccess: true,
      }),
    ).toBe(false);
  });

  test("a disabled service account sees nothing its grants name", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeServiceAccount,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const agent = await makeAgent({
      organizationId: org.id,
      authorId: author.id,
      agentType: "agent",
      access: "personal",
    });
    const active = await makeServiceAccount(org.id);
    const disabled = await makeServiceAccount(org.id, { disabled: true });
    for (const account of [active, disabled]) {
      await addGrant({
        organizationId: org.id,
        resource: "agent",
        scope: agent.id,
        subject: { type: "serviceAccount", id: account.id },
        actions: ["read"],
      });
    }

    expect(
      await listAgentIds(`service-account:${active.id}`, org.id),
    ).toContain(agent.id);
    expect(
      await listAgentIds(`service-account:${disabled.id}`, org.id),
    ).toEqual([]);
  });

  test("a custom-role grant reaches the role's holders by role id", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const holder = await makeUser();
    const other = await makeUser();
    const role = await makeCustomRole(org.id);
    await makeMember(holder.id, org.id, { role: role.role });
    await makeMember(other.id, org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      authorId: author.id,
      agentType: "agent",
      access: "personal",
    });
    await addGrant({
      organizationId: org.id,
      resource: "agent",
      scope: agent.id,
      subject: { type: "role", id: role.id },
      actions: ["read"],
    });

    expect(await listAgentIds(holder.id, org.id)).toContain(agent.id);
    expect(await listAgentIds(other.id, org.id)).not.toContain(agent.id);
  });

  test("a role a team carries reaches the team's members", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeTeamMember,
    makeAgent,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const teammate = await makeUser();
    const role = await makeCustomRole(org.id);
    const team = await makeTeam(org.id, author.id);
    await makeTeamMember(team.id, teammate.id);
    await TeamModel.update(team.id, { roles: [role.role] });
    const agent = await makeAgent({
      organizationId: org.id,
      authorId: author.id,
      agentType: "agent",
      access: "personal",
    });
    await addGrant({
      organizationId: org.id,
      resource: "agent",
      scope: agent.id,
      subject: { type: "role", id: role.id },
      actions: ["read"],
    });

    expect(await listAgentIds(teammate.id, org.id)).toContain(agent.id);
  });

  test("a grant on a parent team reaches members of its child team", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeTeamMember,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const childMember = await makeUser();
    const parent = await makeTeam(org.id, author.id);
    const child = await makeTeam(org.id, author.id, { parentId: parent.id });
    await makeTeamMember(child.id, childMember.id);
    const agent = await makeAgent({
      organizationId: org.id,
      authorId: author.id,
      agentType: "agent",
      access: { teams: [parent.id], level: "use" },
    });

    expect(await listAgentIds(childMember.id, org.id)).toContain(agent.id);
  });

  test("an organization-wide grant does not reach a member of another organization", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    const author = await makeUser();
    const outsider = await makeUser();
    await makeMember(outsider.id, orgB.id);
    const agent = await makeAgent({
      organizationId: orgA.id,
      authorId: author.id,
      agentType: "agent",
      access: "personal",
    });
    await addGrant({
      organizationId: orgA.id,
      resource: "agent",
      scope: agent.id,
      subject: { type: "organization", id: "*" },
      actions: ["read"],
    });

    expect(await listAgentIds(outsider.id, orgA.id)).toEqual([]);
    expect(
      await AgentTeamModel.getUserAccessibleAgentIds(outsider.id, false),
    ).not.toContain(agent.id);
  });

  test("being an admin elsewhere does not satisfy an admin-role grant here", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    const author = await makeUser();
    const crossAdmin = await makeUser();
    const localAdmin = await makeUser();
    await makeMember(crossAdmin.id, orgA.id);
    await makeMember(crossAdmin.id, orgB.id, { role: "admin" });
    await makeMember(localAdmin.id, orgA.id, { role: "admin" });
    const agent = await makeAgent({
      organizationId: orgA.id,
      authorId: author.id,
      agentType: "agent",
      access: "personal",
    });
    await addGrant({
      organizationId: orgA.id,
      resource: "agent",
      scope: agent.id,
      subject: { type: "role", id: "admin" },
      actions: ["read"],
    });

    expect(await listAgentIds(localAdmin.id, orgA.id)).toContain(agent.id);
    expect(await listAgentIds(crossAdmin.id, orgA.id)).not.toContain(agent.id);
    expect(
      await AgentTeamModel.getUserAccessibleAgentIds(crossAdmin.id, false),
    ).not.toContain(agent.id);
  });
});

describe("grant predicate planner cost", () => {
  // Postgres JIT-compiles any plan above `jit_above_cost`; a grant fence that
  // crosses it pays seconds of compilation on every list request.
  const JIT_ABOVE_COST = 100_000;

  test("the agent list and the MCP catalog list stay below the JIT threshold for a member", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeAgent,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const member = await makeUser();
    await makeMember(author.id, org.id, { role: "admin" });
    const team = await makeTeam(org.id, author.id);
    await makeTeamMember(team.id, member.id);
    await makeAgent({
      organizationId: org.id,
      authorId: author.id,
      agentType: "agent",
    });
    await makeAgent({
      organizationId: org.id,
      authorId: author.id,
      agentType: "agent",
      access: { teams: [team.id], level: "use" },
    });
    await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: author.id,
    });

    const agentCosts = await grantQueryCosts(() =>
      AgentModel.findAll(member.id, false, {
        authorization: { organizationId: org.id, baseReadTypes: [] },
      }),
    );
    const catalogCosts = await grantQueryCosts(() =>
      InternalMcpCatalogModel.findAll({
        expandSecrets: false,
        userId: member.id,
        isAdmin: false,
        organizationId: org.id,
        readGrantContext: { userId: member.id, organizationId: org.id },
      }),
    );

    expect(agentCosts.length).toBeGreaterThan(0);
    expect(catalogCosts.length).toBeGreaterThan(0);
    for (const cost of [...agentCosts, ...catalogCosts]) {
      expect(cost).toBeLessThan(JIT_ABOVE_COST);
    }
  });
});

async function addGrant(params: {
  organizationId: string;
  resource: ScopedResource;
  scope: string;
  subject: PermissionSubject;
  actions: ResourcePermissionAction[];
}) {
  const key = {
    organizationId: params.organizationId,
    resource: params.resource,
    scope: params.scope,
  };
  const policy = await ResourcePermissionPolicyModel.find(key);
  await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: policy?.revision ?? 0,
    grants: [
      ...(policy?.grants ?? []),
      { subject: params.subject, actions: params.actions },
    ],
  });
}

/** The `/api/agents/all` read for a caller without base agent read. */
async function listAgentIds(userId: string, organizationId: string) {
  const agents = await AgentModel.findAll(userId, false, {
    authorization: { organizationId, baseReadTypes: [] },
    agentTypes: ["agent"],
  });
  return agents.map((agent) => agent.id);
}

/**
 * Run `read`, then EXPLAIN every statement it sent that consults grants, and
 * return each plan's estimated total cost.
 */
async function grantQueryCosts(read: () => Promise<unknown>) {
  const client = db.$client;
  const sent = vi.spyOn(client, "query");
  let calls: (typeof sent.mock.calls)[number][];
  try {
    await read();
  } finally {
    calls = [...sent.mock.calls];
    sent.mockRestore();
  }
  const statements = calls.flatMap(([text, params]) =>
    typeof text === "string" && text.includes("resource_permission_policies")
      ? [{ text, params }]
      : [],
  );
  const costs: number[] = [];
  for (const { text, params } of statements) {
    const result = await client.query<{
      "QUERY PLAN": [{ Plan: { "Total Cost": number } }];
    }>(`EXPLAIN (FORMAT JSON) ${text}`, params as unknown[]);
    costs.push(result.rows[0]["QUERY PLAN"][0].Plan["Total Cost"]);
  }
  return costs;
}
