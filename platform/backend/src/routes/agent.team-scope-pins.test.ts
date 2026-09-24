import type { ResourcePermissionGrant } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import resourcePermissionRoutes from "./resource-permission/resource-permission.routes";

/**
 * Changing who can reach an agent can move a team-scoped connection out of
 * its reach while a static tool assignment still pins that connection. The
 * runtime trusts the persisted mcpServerId, so the agent would keep using a
 * credential its audience no longer shares. A permissions edit that would do
 * that is refused, and nothing is written.
 */
describe("agent permission edits and static connection pins", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId, { role: "admin" });
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      request.user = user;
      request.organizationId = organizationId;
    });
    await app.register(resourcePermissionRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  /** Replace the agent's team grants, keeping its author's own grant. */
  async function setTeams(agentId: string, teamIds: string[]) {
    return setGrants(agentId, (grants) => [
      ...grants.filter((grant) => grant.subject.type === "user"),
      ...teamIds.map((id) => ({
        subject: { type: "team" as const, id },
        actions: ["read" as const, "use" as const],
      })),
    ]);
  }

  async function setGrants(
    agentId: string,
    next: (grants: ResourcePermissionGrant[]) => ResourcePermissionGrant[],
  ) {
    const policy = await ResourcePermissionPolicyModel.find({
      organizationId,
      resource: "agent",
      scope: agentId,
    });
    return app.inject({
      method: "PUT",
      url: `/api/resource-permissions/agent/${agentId}`,
      payload: {
        revision: policy?.revision ?? 0,
        grants: next(policy?.grants ?? []),
      },
    });
  }

  async function teamIdsOf(agentId: string) {
    const { teamIds } = await ResourcePermissionPolicyModel.findAudience({
      organizationId,
      resource: "agent",
      scope: agentId,
    });
    return teamIds;
  }

  test("refuses removing the team whose connection a static pin points at", async ({
    makeTeam,
    makeInternalAgent,
    makeMcpServer,
    makeTool,
    makeAgentTool,
  }) => {
    const teamA = await makeTeam(organizationId, user.id, { name: "Team A" });
    const teamB = await makeTeam(organizationId, user.id, { name: "Team B" });
    const connection = await makeMcpServer({
      name: "Team A Connection",
      scope: "team",
      teamId: teamA.id,
    });
    const tool = await makeTool({
      name: "team-a-tool",
      catalogId: connection.catalogId,
    });
    const agent = await makeInternalAgent({
      organizationId,
      authorId: user.id,
      access: { teams: [teamA.id] },
    });
    await makeAgentTool(agent.id, tool.id, {
      mcpServerId: connection.id,
      credentialResolutionMode: "static",
    });

    const response = await setTeams(agent.id, [teamB.id]);

    expect(response.statusCode, response.body).toBe(400);
    const message = response.json().error.message;
    expect(message).toContain("team-a-tool");
    expect(message).toContain("Team A Connection");
    expect(await teamIdsOf(agent.id)).toEqual([teamA.id]);
  });

  test("allows a change that keeps the pinned connection's team", async ({
    makeTeam,
    makeInternalAgent,
    makeMcpServer,
    makeTool,
    makeAgentTool,
  }) => {
    const teamA = await makeTeam(organizationId, user.id);
    const teamB = await makeTeam(organizationId, user.id);
    const connection = await makeMcpServer({ scope: "team", teamId: teamA.id });
    const tool = await makeTool({ catalogId: connection.catalogId });
    const agent = await makeInternalAgent({
      organizationId,
      authorId: user.id,
      access: { teams: [teamA.id] },
    });
    await makeAgentTool(agent.id, tool.id, {
      mcpServerId: connection.id,
      credentialResolutionMode: "static",
    });

    const response = await setTeams(agent.id, [teamA.id, teamB.id]);

    expect(response.statusCode, response.body).toBe(200);
    expect((await teamIdsOf(agent.id)).sort()).toEqual(
      [teamA.id, teamB.id].sort(),
    );
  });

  test("a dynamic assignment never blocks the change", async ({
    makeTeam,
    makeInternalAgent,
    makeMcpServer,
    makeTool,
    makeAgentTool,
  }) => {
    const teamA = await makeTeam(organizationId, user.id);
    const teamB = await makeTeam(organizationId, user.id);
    const connection = await makeMcpServer({ scope: "team", teamId: teamA.id });
    const tool = await makeTool({ catalogId: connection.catalogId });
    const agent = await makeInternalAgent({
      organizationId,
      authorId: user.id,
      access: { teams: [teamA.id] },
    });
    await makeAgentTool(agent.id, tool.id, {
      mcpServerId: connection.id,
      credentialResolutionMode: "dynamic",
    });

    const response = await setTeams(agent.id, [teamB.id]);

    expect(response.statusCode, response.body).toBe(200);
  });

  test("sharing with the whole organization keeps every team connection assignable", async ({
    makeTeam,
    makeInternalAgent,
    makeMcpServer,
    makeTool,
    makeAgentTool,
  }) => {
    const teamA = await makeTeam(organizationId, user.id);
    const connection = await makeMcpServer({ scope: "team", teamId: teamA.id });
    const tool = await makeTool({ catalogId: connection.catalogId });
    const agent = await makeInternalAgent({
      organizationId,
      authorId: user.id,
      access: { teams: [teamA.id] },
    });
    await makeAgentTool(agent.id, tool.id, {
      mcpServerId: connection.id,
      credentialResolutionMode: "static",
    });

    const response = await setGrants(agent.id, (grants) => [
      ...grants.filter((grant) => grant.subject.type === "user"),
      {
        subject: { type: "organization", id: "*" },
        actions: ["read", "use"],
      },
    ]);

    expect(response.statusCode, response.body).toBe(200);
  });

  test("an organization-wide connection survives any team change", async ({
    makeTeam,
    makeInternalAgent,
    makeMcpServer,
    makeTool,
    makeAgentTool,
  }) => {
    const teamA = await makeTeam(organizationId, user.id);
    const teamB = await makeTeam(organizationId, user.id);
    const connection = await makeMcpServer({ scope: "org" });
    const tool = await makeTool({ catalogId: connection.catalogId });
    const agent = await makeInternalAgent({
      organizationId,
      authorId: user.id,
      access: { teams: [teamA.id] },
    });
    await makeAgentTool(agent.id, tool.id, {
      mcpServerId: connection.id,
      credentialResolutionMode: "static",
    });

    const response = await setTeams(agent.id, [teamB.id]);

    expect(response.statusCode, response.body).toBe(200);
  });

  test("a pin that is already unassignable is not the change's doing", async ({
    makeTeam,
    makeInternalAgent,
    makeMcpServer,
    makeTool,
    makeAgentTool,
  }) => {
    const connectionTeam = await makeTeam(organizationId, user.id);
    const agentTeam = await makeTeam(organizationId, user.id);
    const nextTeam = await makeTeam(organizationId, user.id);
    const connection = await makeMcpServer({
      scope: "team",
      teamId: connectionTeam.id,
    });
    const tool = await makeTool({ catalogId: connection.catalogId });
    const agent = await makeInternalAgent({
      organizationId,
      authorId: user.id,
      access: { teams: [agentTeam.id] },
    });
    await makeAgentTool(agent.id, tool.id, {
      mcpServerId: connection.id,
      credentialResolutionMode: "static",
    });

    const response = await setTeams(agent.id, [nextTeam.id]);

    expect(response.statusCode, response.body).toBe(200);
  });

  test("an enterprise-managed assignment still pins its connection", async ({
    makeTeam,
    makeInternalAgent,
    makeMcpServer,
    makeTool,
    makeAgentTool,
  }) => {
    const teamA = await makeTeam(organizationId, user.id);
    const teamB = await makeTeam(organizationId, user.id);
    const connection = await makeMcpServer({ scope: "team", teamId: teamA.id });
    const tool = await makeTool({
      name: "enterprise-tool",
      catalogId: connection.catalogId,
    });
    const agent = await makeInternalAgent({
      organizationId,
      authorId: user.id,
      access: { teams: [teamA.id] },
    });
    await makeAgentTool(agent.id, tool.id, {
      mcpServerId: connection.id,
      credentialResolutionMode: "enterprise_managed",
    });

    const response = await setTeams(agent.id, [teamB.id]);

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error.message).toContain("enterprise-tool");
  });
});
