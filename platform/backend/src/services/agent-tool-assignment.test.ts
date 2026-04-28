import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import MemberModel from "@/models/member";
import TeamModel from "@/models/team";
import { describe, expect, test } from "@/test";
import {
  assignToolToAgent,
  filterMcpServersAssignableToTarget,
  isMcpServerAssignableToTarget,
  validateAssignment,
  validateCredentialSource,
  validateExecutionSource,
} from "./agent-tool-assignment";

describe("filterMcpServersAssignableToTarget", () => {
  test("uses one organization membership lookup for org-scoped target filtering", async ({
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const memberOwner = await makeUser();
    const outsideOwner = await makeUser();
    await makeMember(memberOwner.id, organization.id, { role: "member" });

    const getByUserIdSpy = vi.spyOn(MemberModel, "getByUserId");
    const findUserIdsSpy = vi.spyOn(MemberModel, "findUserIdsInOrganization");

    const filtered = await filterMcpServersAssignableToTarget({
      mcpServers: [
        {
          id: "member-owned",
          ownerId: memberOwner.id,
          teamId: null,
          scope: "personal",
        },
        {
          id: "outside-owned",
          ownerId: outsideOwner.id,
          teamId: null,
          scope: "personal",
        },
        { id: "org-owned", ownerId: null, teamId: null, scope: "personal" },
      ],
      target: {
        organizationId: organization.id,
        scope: "org",
        authorId: null,
        teamIds: [],
      },
    });

    expect(filtered.map((server) => server.id)).toEqual([
      "member-owned",
      "org-owned",
    ]);
    expect(findUserIdsSpy).toHaveBeenCalledTimes(1);
    expect(getByUserIdSpy).not.toHaveBeenCalled();

    getByUserIdSpy.mockRestore();
    findUserIdsSpy.mockRestore();
  });

  test("uses one team membership lookup for team-scoped personal server filtering", async ({
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const requester = await makeUser();
    const selectedTeam = await makeTeam(organization.id, requester.id, {
      name: "Selected Team",
    });
    const otherTeam = await makeTeam(organization.id, requester.id, {
      name: "Other Team",
    });
    const selectedOwner = await makeUser();
    const otherOwner = await makeUser();
    await makeTeamMember(selectedTeam.id, selectedOwner.id);
    await makeTeamMember(otherTeam.id, otherOwner.id);

    const isUserInAnyTeamSpy = vi.spyOn(TeamModel, "isUserInAnyTeam");
    const findUserIdsSpy = vi.spyOn(TeamModel, "findUserIdsInAnyTeam");

    const filtered = await filterMcpServersAssignableToTarget({
      mcpServers: [
        {
          id: "selected-owner",
          ownerId: selectedOwner.id,
          teamId: null,
          scope: "personal",
        },
        {
          id: "other-owner",
          ownerId: otherOwner.id,
          teamId: null,
          scope: "personal",
        },
        {
          id: "selected-team",
          ownerId: requester.id,
          teamId: selectedTeam.id,
          scope: "team",
        },
        {
          id: "other-team",
          ownerId: requester.id,
          teamId: otherTeam.id,
          scope: "team",
        },
      ],
      target: {
        organizationId: organization.id,
        scope: "team",
        authorId: requester.id,
        teamIds: [selectedTeam.id],
      },
    });

    expect(filtered.map((server) => server.id)).toEqual([
      "selected-owner",
      "selected-team",
    ]);
    expect(findUserIdsSpy).toHaveBeenCalledTimes(1);
    expect(isUserInAnyTeamSpy).not.toHaveBeenCalled();

    isUserInAnyTeamSpy.mockRestore();
    findUserIdsSpy.mockRestore();
  });

  test("uses the author's team IDs once for personal target filtering", async ({
    makeMember,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const author = await makeUser();
    await makeMember(author.id, organization.id, { role: "member" });
    const authorTeam = await makeTeam(organization.id, author.id, {
      name: "Author Team",
    });
    const otherTeam = await makeTeam(organization.id, author.id, {
      name: "Other Team",
    });
    await makeTeamMember(authorTeam.id, author.id);

    const getUserTeamIdsSpy = vi.spyOn(TeamModel, "getUserTeamIds");
    const isUserInAnyTeamSpy = vi.spyOn(TeamModel, "isUserInAnyTeam");

    const filtered = await filterMcpServersAssignableToTarget({
      mcpServers: [
        {
          id: "own-personal",
          ownerId: author.id,
          teamId: null,
          scope: "personal",
        },
        {
          id: "other-personal",
          ownerId: crypto.randomUUID(),
          teamId: null,
          scope: "personal",
        },
        {
          id: "author-team",
          ownerId: null,
          teamId: authorTeam.id,
          scope: "team",
        },
        {
          id: "other-team",
          ownerId: null,
          teamId: otherTeam.id,
          scope: "team",
        },
        { id: "org-owned", ownerId: null, teamId: null, scope: "personal" },
      ],
      target: {
        organizationId: organization.id,
        scope: "personal",
        authorId: author.id,
        teamIds: [],
      },
    });

    expect(filtered.map((server) => server.id)).toEqual([
      "own-personal",
      "author-team",
      "org-owned",
    ]);
    expect(getUserTeamIdsSpy).toHaveBeenCalledTimes(1);
    expect(isUserInAnyTeamSpy).not.toHaveBeenCalled();

    getUserTeamIdsSpy.mockRestore();
    isUserInAnyTeamSpy.mockRestore();
  });

  test("includes team-scoped servers when filtering for an org-scoped target", async ({
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const requester = await makeUser();
    const team = await makeTeam(organization.id, requester.id, {
      name: "Some Team",
    });

    const filtered = await filterMcpServersAssignableToTarget({
      mcpServers: [
        {
          id: "team-server",
          ownerId: requester.id,
          teamId: team.id,
          scope: "team",
        },
      ],
      target: {
        organizationId: organization.id,
        scope: "org",
        authorId: null,
        teamIds: [],
      },
    });

    expect(filtered.map((server) => server.id)).toEqual(["team-server"]);
  });
});

describe("validateCredentialSource", () => {
  test("returns a validation error when a personal credential owner cannot access the target resource", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTool,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    const otherUser = await makeUser();

    await makeMember(owner.id, organization.id, { role: "member" });
    await makeMember(otherUser.id, organization.id, { role: "member" });

    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: otherUser.id,
      scope: "personal",
    });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({ catalogId: catalog.id, name: "remote_tool" });
    const mcpServer = await makeMcpServer({
      ownerId: owner.id,
      catalogId: catalog.id,
    });

    const result = await validateCredentialSource({
      agentId: agent.id,
      mcpServerId: mcpServer.id,
      toolId: tool.id,
    });

    expect(result).toEqual({
      code: "validation_error",
      error: {
        message:
          "The credential owner must be a member of a team that this resource is assigned to",
        type: "validation_error",
      },
    });
  });

  test("allows a team-installed MCP server when the target resource shares that team", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeTool,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    const author = await makeUser();

    await makeMember(owner.id, organization.id, { role: "member" });
    await makeMember(author.id, organization.id, { role: "member" });

    const sharedTeam = await makeTeam(organization.id, author.id, {
      name: "Shared Team",
    });
    await makeTeamMember(sharedTeam.id, author.id);

    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: author.id,
      scope: "team",
      teams: [sharedTeam.id],
    });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({ catalogId: catalog.id, name: "remote_tool" });
    const mcpServer = await makeMcpServer({
      scope: "team",
      teamId: sharedTeam.id,
      ownerId: owner.id,
      catalogId: catalog.id,
    });

    const result = await validateCredentialSource({
      agentId: agent.id,
      mcpServerId: mcpServer.id,
      toolId: tool.id,
    });

    expect(result).toBeNull();
  });

  test("rejects a team-installed MCP server when the target resource is assigned to a different team", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeTool,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    const author = await makeUser();

    await makeMember(owner.id, organization.id, { role: "member" });
    await makeMember(author.id, organization.id, { role: "member" });

    const gatewayTeam = await makeTeam(organization.id, author.id, {
      name: "Gateway Team",
    });
    const otherTeam = await makeTeam(organization.id, author.id, {
      name: "Other Team",
    });
    await makeTeamMember(gatewayTeam.id, author.id);

    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: author.id,
      scope: "team",
      teams: [gatewayTeam.id],
    });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({ catalogId: catalog.id, name: "remote_tool" });
    const mcpServer = await makeMcpServer({
      scope: "team",
      teamId: otherTeam.id,
      ownerId: owner.id,
      catalogId: catalog.id,
    });

    const result = await validateCredentialSource({
      agentId: agent.id,
      mcpServerId: mcpServer.id,
      toolId: tool.id,
    });

    expect(result).toEqual({
      code: "validation_error",
      error: {
        message: "This team connection is not shared with the selected team",
        type: "validation_error",
      },
    });
  });

  test("allows a team-installed MCP server when the target resource is org-scoped", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeTool,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    const author = await makeUser();

    await makeMember(owner.id, organization.id, { role: "member" });
    await makeMember(author.id, organization.id, { role: "admin" });

    const team = await makeTeam(organization.id, author.id, {
      name: "Some Team",
    });
    await makeTeamMember(team.id, owner.id);

    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: author.id,
      scope: "org",
    });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({ catalogId: catalog.id, name: "remote_tool" });
    const mcpServer = await makeMcpServer({
      scope: "team",
      teamId: team.id,
      ownerId: owner.id,
      catalogId: catalog.id,
    });

    const result = await validateCredentialSource({
      agentId: agent.id,
      mcpServerId: mcpServer.id,
      toolId: tool.id,
    });

    expect(result).toBeNull();
  });

  test("rejects a personal credential for an org-scoped resource when the owner is outside the organization", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTool,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const otherOrganization = await makeOrganization();
    const owner = await makeUser();
    const author = await makeUser();

    await makeMember(author.id, organization.id, { role: "member" });
    await makeMember(owner.id, otherOrganization.id, { role: "member" });

    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: author.id,
      scope: "org",
    });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({ catalogId: catalog.id, name: "remote_tool" });
    const mcpServer = await makeMcpServer({
      ownerId: owner.id,
      catalogId: catalog.id,
    });

    const result = await validateCredentialSource({
      agentId: agent.id,
      mcpServerId: mcpServer.id,
      toolId: tool.id,
    });

    expect(result).toEqual({
      code: "validation_error",
      error: {
        message:
          "The credential owner must be a member of a team that this resource is assigned to",
        type: "validation_error",
      },
    });
  });

  test("accepts a team-installed MCP server for a personal agent when the author is a member of that team", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeTool,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    const author = await makeUser();

    await makeMember(owner.id, organization.id, { role: "member" });
    await makeMember(author.id, organization.id, { role: "member" });

    const sharedTeam = await makeTeam(organization.id, author.id, {
      name: "Shared Team",
    });
    await makeTeamMember(sharedTeam.id, author.id);

    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: author.id,
      scope: "personal",
    });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({ catalogId: catalog.id, name: "remote_tool" });
    const mcpServer = await makeMcpServer({
      scope: "team",
      teamId: sharedTeam.id,
      ownerId: owner.id,
      catalogId: catalog.id,
    });

    const result = await validateCredentialSource({
      agentId: agent.id,
      mcpServerId: mcpServer.id,
      toolId: tool.id,
    });

    expect(result).toBeNull();
  });

  test("rejects a team-installed MCP server for a personal agent when the author is not a member of that team", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTeam,
    makeTool,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    const author = await makeUser();

    await makeMember(owner.id, organization.id, { role: "member" });
    await makeMember(author.id, organization.id, { role: "member" });

    const otherTeam = await makeTeam(organization.id, author.id, {
      name: "Other Team",
    });

    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: author.id,
      scope: "personal",
    });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({ catalogId: catalog.id, name: "remote_tool" });
    const mcpServer = await makeMcpServer({
      scope: "team",
      teamId: otherTeam.id,
      ownerId: owner.id,
      catalogId: catalog.id,
    });

    const result = await validateCredentialSource({
      agentId: agent.id,
      mcpServerId: mcpServer.id,
      toolId: tool.id,
    });

    expect(result).toEqual({
      code: "validation_error",
      error: {
        message: "This team connection is not shared with the selected team",
        type: "validation_error",
      },
    });
  });

  test("accepts a team-installed MCP server for a personal agent when the author is an org admin", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTeam,
    makeTool,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    const author = await makeUser();

    await makeMember(owner.id, organization.id, { role: "member" });
    await makeMember(author.id, organization.id, { role: "admin" });

    const otherTeam = await makeTeam(organization.id, owner.id, {
      name: "Eng Team",
    });

    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: author.id,
      scope: "personal",
    });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({ catalogId: catalog.id, name: "remote_tool" });
    const mcpServer = await makeMcpServer({
      scope: "team",
      teamId: otherTeam.id,
      ownerId: owner.id,
      catalogId: catalog.id,
    });

    const result = await validateCredentialSource({
      agentId: agent.id,
      mcpServerId: mcpServer.id,
      toolId: tool.id,
    });

    expect(result).toBeNull();
  });

  test("accepts a personal credential for a team-scoped resource when the owner is a team member", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeTool,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    const author = await makeUser();

    await makeMember(author.id, organization.id, { role: "member" });
    await makeMember(owner.id, organization.id, { role: "member" });

    const sharedTeam = await makeTeam(organization.id, author.id, {
      name: "Shared Team",
    });
    await makeTeamMember(sharedTeam.id, author.id);
    await makeTeamMember(sharedTeam.id, owner.id);

    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: author.id,
      scope: "team",
      teams: [sharedTeam.id],
    });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({ catalogId: catalog.id, name: "remote_tool" });
    const mcpServer = await makeMcpServer({
      ownerId: owner.id,
      catalogId: catalog.id,
    });

    const result = await validateCredentialSource({
      agentId: agent.id,
      mcpServerId: mcpServer.id,
      toolId: tool.id,
    });

    expect(result).toBeNull();
  });
});

describe("validateExecutionSource", () => {
  test("accepts prefetched tool data to avoid a redundant tool lookup", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ serverType: "local" });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: "tool_1",
    });

    const result = await validateExecutionSource({
      toolId: tool.id,
      preFetchedTool: tool,
      mcpServerId: "server-1",
      preFetchedServer: {
        id: "server-1",
        catalogId: catalog.id,
      },
    });

    expect(result).toBeNull();
  });

  test("returns a validation error when the prefetched execution source comes from another catalog", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const toolCatalog = await makeInternalMcpCatalog({ serverType: "local" });
    const otherCatalog = await makeInternalMcpCatalog({ serverType: "local" });
    const tool = await makeTool({
      catalogId: toolCatalog.id,
      name: "tool_1",
    });

    const result = await validateExecutionSource({
      toolId: tool.id,
      preFetchedTool: tool,
      mcpServerId: "server-1",
      preFetchedServer: {
        id: "server-1",
        catalogId: otherCatalog.id,
      },
    });

    expect(result).toEqual({
      code: "validation_error",
      error: {
        message:
          "Execution source MCP server must come from the same catalog item as the tool",
        type: "validation_error",
      },
    });
  });
});

describe("validateAssignment late-bound precedence", () => {
  test("prefers explicit credentialResolutionMode over resolveAtCallTime", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const agent = await makeAgent();
    const remoteCatalog = await makeInternalMcpCatalog({
      serverType: "remote",
    });
    const tool = await makeTool({
      name: "precedence_remote_tool",
      catalogId: remoteCatalog.id,
    });

    const result = await validateAssignment({
      agentId: agent.id,
      toolId: tool.id,
      resolveAtCallTime: true,
      credentialResolutionMode: "static",
    });

    expect(result).toEqual({
      code: "validation_error",
      error: {
        message:
          "An MCP server installation or non-static credential resolution is required for remote MCP server tools",
        type: "validation_error",
      },
    });
  });

  test("defaults late-bound resolution to false when both flags are omitted", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const agent = await makeAgent();
    const remoteCatalog = await makeInternalMcpCatalog({
      serverType: "remote",
    });
    const tool = await makeTool({
      name: "default_false_remote_tool",
      catalogId: remoteCatalog.id,
    });

    const result = await validateAssignment({
      agentId: agent.id,
      toolId: tool.id,
    });

    expect(result).toEqual({
      code: "validation_error",
      error: {
        message:
          "An MCP server installation or non-static credential resolution is required for remote MCP server tools",
        type: "validation_error",
      },
    });
  });
});

describe("assignToolToAgent", () => {
  test("returns duplicate when the assignment is unchanged", async ({
    makeAgent,
    makeTool,
  }) => {
    const agent = await makeAgent();
    const tool = await makeTool({ name: "duplicate_test_tool" });

    const firstResult = await assignToolToAgent({
      agentId: agent.id,
      toolId: tool.id,
    });
    const secondResult = await assignToolToAgent({
      agentId: agent.id,
      toolId: tool.id,
    });

    expect(firstResult).toBeNull();
    expect(secondResult).toBe("duplicate");
  });

  test("returns updated when an existing assignment changes its credential source", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTool,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    await makeMember(owner.id, organization.id, { role: "admin" });

    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: owner.id,
      scope: "personal",
    });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({
      name: "remote_assignment_tool",
      catalogId: catalog.id,
    });
    const firstServer = await makeMcpServer({
      ownerId: owner.id,
      catalogId: catalog.id,
    });
    const secondServer = await makeMcpServer({
      ownerId: owner.id,
      catalogId: catalog.id,
    });

    const createResult = await assignToolToAgent({
      agentId: agent.id,
      toolId: tool.id,
      mcpServerId: firstServer.id,
    });
    const updateResult = await assignToolToAgent({
      agentId: agent.id,
      toolId: tool.id,
      mcpServerId: secondServer.id,
    });

    expect(createResult).toBeNull();
    expect(updateResult).toBe("updated");

    const [assignment] = await db
      .select()
      .from(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agent.id),
          eq(schema.agentToolsTable.toolId, tool.id),
        ),
      );

    expect(assignment?.mcpServerId).toBe(secondServer.id);
  });

  test("persists enterprise-managed mode", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const agent = await makeAgent();
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({
      name: "enterprise-managed-tool",
      catalogId: catalog.id,
    });

    const createResult = await assignToolToAgent({
      agentId: agent.id,
      toolId: tool.id,
      credentialResolutionMode: "enterprise_managed",
    });

    expect(createResult).toBeNull();

    const [assignment] = await db
      .select()
      .from(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agent.id),
          eq(schema.agentToolsTable.toolId, tool.id),
        ),
      );

    expect(assignment?.credentialResolutionMode).toBe("enterprise_managed");
    expect(assignment?.credentialResolutionMode).not.toBe("dynamic");
  });
});

describe("isMcpServerAssignableToTarget", () => {
  test("org-scoped server is assignable to org-scoped target", async () => {
    const assignable = await isMcpServerAssignableToTarget({
      mcpServer: {
        ownerId: "admin-owner",
        teamId: null,
        scope: "org",
      },
      target: {
        organizationId: "org-1",
        scope: "org",
        authorId: null,
        teamIds: [],
      },
    });

    expect(assignable).toBe(true);
  });

  test("org-scoped server is assignable to team-scoped target", async () => {
    const assignable = await isMcpServerAssignableToTarget({
      mcpServer: {
        ownerId: "admin-owner",
        teamId: null,
        scope: "org",
      },
      target: {
        organizationId: "org-1",
        scope: "team",
        authorId: null,
        teamIds: ["team-a"],
      },
    });

    expect(assignable).toBe(true);
  });

  test("team-scoped server is assignable to a team target that includes its team", async () => {
    const assignable = await isMcpServerAssignableToTarget({
      mcpServer: {
        ownerId: "owner-1",
        teamId: "team-a",
        scope: "team",
      },
      target: {
        organizationId: "org-1",
        scope: "team",
        authorId: null,
        teamIds: ["team-a", "team-b"],
      },
    });

    expect(assignable).toBe(true);
  });

  test("team-scoped server is not assignable to a team target that does not include its team", async () => {
    const assignable = await isMcpServerAssignableToTarget({
      mcpServer: {
        ownerId: "owner-1",
        teamId: "team-a",
        scope: "team",
      },
      target: {
        organizationId: "org-1",
        scope: "team",
        authorId: null,
        teamIds: ["team-b"],
      },
    });

    expect(assignable).toBe(false);
  });

  test("team-scoped server is assignable to org-scoped target", async () => {
    const assignable = await isMcpServerAssignableToTarget({
      mcpServer: {
        ownerId: "owner-1",
        teamId: "team-a",
        scope: "team",
      },
      target: {
        organizationId: "org-1",
        scope: "org",
        authorId: null,
        teamIds: [],
      },
    });

    expect(assignable).toBe(true);
  });

  test("team-scoped server with no teamId is not assignable", async () => {
    const assignable = await isMcpServerAssignableToTarget({
      mcpServer: {
        ownerId: "owner-1",
        teamId: null,
        scope: "team",
      },
      target: {
        organizationId: "org-1",
        scope: "team",
        authorId: null,
        teamIds: ["team-a"],
      },
    });

    expect(assignable).toBe(false);
  });
});
