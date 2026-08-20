import { type Mock, vi } from "vitest";
import {
  getAgentTypePermissionChecker,
  hasAnyAgentTypeReadPermission,
  isAgentTypeAdmin,
} from "@/auth";
import { AgentToolModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

const mockGetAgentTypePermissionChecker = getAgentTypePermissionChecker as Mock;

/**
 * Changing an agent's teams or scope can move a team-scoped connection out of
 * its reach while a static tool assignment still pins that connection — the
 * runtime trusts the persisted mcpServerId, so the agent would keep using a
 * credential it no longer has a claim to. PUT /api/agents/:id rejects such a
 * change instead of writing it.
 */
describe("PUT /api/agents/:id static connection pins", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let isAdmin: Mock;
  let isTeamAdmin: Mock;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();

    vi.mocked(hasAnyAgentTypeReadPermission).mockResolvedValue(true);
    vi.mocked(isAgentTypeAdmin).mockResolvedValue(true);

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId);

    isAdmin = vi.fn().mockReturnValue(true);
    isTeamAdmin = vi.fn().mockReturnValue(true);
    mockGetAgentTypePermissionChecker.mockResolvedValue({
      require: vi.fn(),
      isAdmin,
      isTeamAdmin,
      hasAnyReadPermission: vi.fn().mockReturnValue(true),
      hasAnyAdminPermission: vi.fn().mockReturnValue(true),
    });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: agentRoutes } = await import("./agent");
    await app.register(agentRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("rejects removing the team whose connection a static pin points at", async ({
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
      scope: "team",
      teams: [teamA.id],
    });
    await makeAgentTool(agent.id, tool.id, {
      mcpServerId: connection.id,
      credentialResolutionMode: "static",
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}`,
      payload: { teams: [teamB.id] },
    });

    expect(response.statusCode).toBe(400);
    const message = response.json().error.message;
    expect(message).toContain("team-a-tool");
    expect(message).toContain("Team A Connection");

    // Nothing was written: the agent still belongs to team A.
    const after = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}`,
    });
    expect(after.json().teams.map((team: { id: string }) => team.id)).toEqual([
      teamA.id,
    ]);
  });

  test("allows a team change that keeps the pinned connection's team", async ({
    makeTeam,
    makeInternalAgent,
    makeMcpServer,
    makeTool,
    makeAgentTool,
  }) => {
    const teamA = await makeTeam(organizationId, user.id);
    const teamB = await makeTeam(organizationId, user.id);
    const connection = await makeMcpServer({
      scope: "team",
      teamId: teamA.id,
    });
    const tool = await makeTool({ catalogId: connection.catalogId });
    const agent = await makeInternalAgent({
      organizationId,
      authorId: user.id,
      scope: "team",
      teams: [teamA.id],
    });
    await makeAgentTool(agent.id, tool.id, {
      mcpServerId: connection.id,
      credentialResolutionMode: "static",
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}`,
      payload: { teams: [teamA.id, teamB.id] },
    });

    expect(response.statusCode).toBe(200);
    expect(
      response
        .json()
        .teams.map((team: { id: string }) => team.id)
        .sort(),
    ).toEqual([teamA.id, teamB.id].sort());
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
    const connection = await makeMcpServer({
      scope: "team",
      teamId: teamA.id,
    });
    const tool = await makeTool({ catalogId: connection.catalogId });
    const agent = await makeInternalAgent({
      organizationId,
      authorId: user.id,
      scope: "team",
      teams: [teamA.id],
    });
    // Resolve-at-call-time: the credential is chosen per caller, so there is
    // no pin to strand even though the row still names a server.
    await makeAgentTool(agent.id, tool.id, {
      mcpServerId: connection.id,
      credentialResolutionMode: "dynamic",
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}`,
      payload: { teams: [teamB.id] },
    });

    expect(response.statusCode).toBe(200);
  });

  test("going org-scoped keeps every team connection assignable", async ({
    makeTeam,
    makeInternalAgent,
    makeMcpServer,
    makeTool,
    makeAgentTool,
  }) => {
    const teamA = await makeTeam(organizationId, user.id);
    const connection = await makeMcpServer({
      scope: "team",
      teamId: teamA.id,
    });
    const tool = await makeTool({ catalogId: connection.catalogId });
    const agent = await makeInternalAgent({
      organizationId,
      authorId: user.id,
      scope: "team",
      teams: [teamA.id],
    });
    await makeAgentTool(agent.id, tool.id, {
      mcpServerId: connection.id,
      credentialResolutionMode: "static",
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}`,
      payload: { scope: "org", teams: [] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().scope).toBe("org");
  });

  test("an org-scoped connection survives any team change", async ({
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
      scope: "team",
      teams: [teamA.id],
    });
    await makeAgentTool(agent.id, tool.id, {
      mcpServerId: connection.id,
      credentialResolutionMode: "static",
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}`,
      payload: { teams: [teamB.id] },
    });

    expect(response.statusCode).toBe(200);
  });

  test("an unrelated edit that leaves teams and scope alone is never checked", async ({
    makeTeam,
    makeInternalAgent,
    makeMcpServer,
    makeTool,
    makeAgentTool,
  }) => {
    const teamA = await makeTeam(organizationId, user.id);
    const connection = await makeMcpServer({
      scope: "team",
      teamId: teamA.id,
    });
    const tool = await makeTool({ catalogId: connection.catalogId });
    const agent = await makeInternalAgent({
      organizationId,
      authorId: user.id,
      scope: "team",
      teams: [teamA.id],
    });
    await makeAgentTool(agent.id, tool.id, {
      mcpServerId: connection.id,
      credentialResolutionMode: "static",
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}`,
      payload: { description: "Renamed description" },
    });

    expect(response.statusCode).toBe(200);
  });

  test("a pin that is already unassignable today is not the change's doing", async ({
    makeTeam,
    makeInternalAgent,
    makeMcpServer,
    makeTool,
    makeAgentTool,
  }) => {
    const agentTeam = await makeTeam(organizationId, user.id);
    const connectionTeam = await makeTeam(organizationId, user.id);
    const nextTeam = await makeTeam(organizationId, user.id);
    // The agent never shared this connection's team, so the pin resolves
    // nothing already. Blocking on it would freeze the agent's teams instead
    // of repairing anything.
    const connection = await makeMcpServer({
      name: "Foreign Team Connection",
      scope: "team",
      teamId: connectionTeam.id,
    });
    const tool = await makeTool({
      name: "foreign-team-tool",
      catalogId: connection.catalogId,
    });
    const agent = await makeInternalAgent({
      organizationId,
      authorId: user.id,
      scope: "team",
      teams: [agentTeam.id],
    });
    await makeAgentTool(agent.id, tool.id, {
      mcpServerId: connection.id,
      credentialResolutionMode: "static",
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}`,
      payload: { teams: [nextTeam.id] },
    });

    expect(response.statusCode).toBe(200);
    expect(
      response.json().teams.map((team: { id: string }) => team.id),
    ).toEqual([nextTeam.id]);
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
    const connection = await makeMcpServer({
      name: "Enterprise Connection",
      scope: "team",
      teamId: teamA.id,
    });
    const tool = await makeTool({
      name: "enterprise-tool",
      catalogId: connection.catalogId,
    });
    const agent = await makeInternalAgent({
      organizationId,
      authorId: user.id,
      scope: "team",
      teams: [teamA.id],
    });
    // The credential comes from the IdP, but the named server is still the
    // execution target the runtime routes to, so losing access to it matters.
    await makeAgentTool(agent.id, tool.id, {
      mcpServerId: connection.id,
      credentialResolutionMode: "enterprise_managed",
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}`,
      payload: { teams: [teamB.id] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("enterprise-tool");
  });

  describe("team admin", () => {
    /**
     * A team admin only controls their own teams: the handler re-adds the ones
     * they cannot touch before writing, so the pin check has to run on that
     * merged set, not on the raw request body.
     */
    beforeEach(() => {
      isAdmin.mockReturnValue(false);
      isTeamAdmin.mockReturnValue(true);
    });

    test("rejects dropping the team admin's own team when it owns the pin", async ({
      makeTeam,
      makeTeamMember,
      makeInternalAgent,
      makeMcpServer,
      makeTool,
      makeAgentTool,
    }) => {
      const preservedTeam = await makeTeam(organizationId, user.id);
      const ownTeam = await makeTeam(organizationId, user.id);
      await makeTeamMember(ownTeam.id, user.id);
      const connection = await makeMcpServer({
        name: "Own Team Connection",
        scope: "team",
        teamId: ownTeam.id,
      });
      const tool = await makeTool({
        name: "own-team-tool",
        catalogId: connection.catalogId,
      });
      const agent = await makeInternalAgent({
        organizationId,
        authorId: user.id,
        scope: "team",
        teams: [preservedTeam.id, ownTeam.id],
      });
      await makeAgentTool(agent.id, tool.id, {
        mcpServerId: connection.id,
        credentialResolutionMode: "static",
      });

      const response = await app.inject({
        method: "PUT",
        url: `/api/agents/${agent.id}`,
        payload: { teams: [] },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain("own-team-tool");
    });

    test("allows the same request when the preserved team owns the pin", async ({
      makeTeam,
      makeTeamMember,
      makeInternalAgent,
      makeMcpServer,
      makeTool,
      makeAgentTool,
    }) => {
      const preservedTeam = await makeTeam(organizationId, user.id);
      const ownTeam = await makeTeam(organizationId, user.id);
      await makeTeamMember(ownTeam.id, user.id);
      const connection = await makeMcpServer({
        scope: "team",
        teamId: preservedTeam.id,
      });
      const tool = await makeTool({ catalogId: connection.catalogId });
      const agent = await makeInternalAgent({
        organizationId,
        authorId: user.id,
        scope: "team",
        teams: [preservedTeam.id, ownTeam.id],
      });
      await makeAgentTool(agent.id, tool.id, {
        mcpServerId: connection.id,
        credentialResolutionMode: "static",
      });

      const response = await app.inject({
        method: "PUT",
        url: `/api/agents/${agent.id}`,
        payload: { teams: [] },
      });

      // The team the caller does not control is preserved, so the pin holds.
      expect(response.statusCode).toBe(200);
      expect(
        response.json().teams.map((team: { id: string }) => team.id),
      ).toEqual([preservedTeam.id]);

      // And the assignment itself is untouched.
      const assignments = await AgentToolModel.findAssignmentsByAgent(agent.id);
      expect(
        assignments.find((assignment) => assignment.toolId === tool.id)
          ?.mcpServerId,
      ).toBe(connection.id);
    });
  });
});
