import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import MemberModel from "@/models/member";
import TeamModel from "@/models/team";
import { describe, expect, test } from "@/test";
import {
  assignToolToAgent,
  assignToolToApp,
  filterMcpServersAssignableToTarget,
  isMcpServerAssignableToTarget,
  validateAssignment,
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

describe("assignToolToApp", () => {
  test("assigns a tool to an app and reports a repeat as duplicate", async ({
    makeApp,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
  }) => {
    const organization = await makeOrganization();
    const app = await makeApp({ organizationId: organization.id });
    const catalog = await makeInternalMcpCatalog({
      organizationId: organization.id,
      serverType: "remote",
    });
    const tool = await makeTool({
      name: "app_assignment_tool",
      catalogId: catalog.id,
    });

    const first = await assignToolToApp({
      appId: app.id,
      organizationId: organization.id,
      toolId: tool.id,
      credentialResolutionMode: "dynamic",
    });
    const second = await assignToolToApp({
      appId: app.id,
      organizationId: organization.id,
      toolId: tool.id,
      credentialResolutionMode: "dynamic",
    });

    expect(first).toBeNull();
    expect(second).toBe("duplicate");

    const [assignment] = await db
      .select()
      .from(schema.appToolsTable)
      .where(
        and(
          eq(schema.appToolsTable.appId, app.id),
          eq(schema.appToolsTable.toolId, tool.id),
        ),
      );
    expect(assignment?.toolId).toBe(tool.id);
  });

  test("returns updated when an existing attachment changes its server", async ({
    makeApp,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTool,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const author = await makeUser();
    await makeMember(author.id, organization.id, { role: "admin" });

    const app = await makeApp({
      organizationId: organization.id,
      authorId: author.id,
      scope: "personal",
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: organization.id,
      serverType: "remote",
    });
    const tool = await makeTool({
      name: "rebindable_app_tool",
      catalogId: catalog.id,
    });
    const firstServer = await makeMcpServer({
      ownerId: author.id,
      catalogId: catalog.id,
    });
    const secondServer = await makeMcpServer({
      ownerId: author.id,
      catalogId: catalog.id,
    });

    const created = await assignToolToApp({
      appId: app.id,
      organizationId: organization.id,
      toolId: tool.id,
      mcpServerId: firstServer.id,
    });
    const updated = await assignToolToApp({
      appId: app.id,
      organizationId: organization.id,
      toolId: tool.id,
      mcpServerId: secondServer.id,
    });

    expect(created).toBeNull();
    expect(updated).toBe("updated");

    const [assignment] = await db
      .select()
      .from(schema.appToolsTable)
      .where(
        and(
          eq(schema.appToolsTable.appId, app.id),
          eq(schema.appToolsTable.toolId, tool.id),
        ),
      );
    expect(assignment?.mcpServerId).toBe(secondServer.id);
  });

  test("returns not_found for an unknown app", async ({
    makeOrganization,
    makeTool,
  }) => {
    const organization = await makeOrganization();
    const tool = await makeTool({ name: "orphan_app_tool" });
    const result = await assignToolToApp({
      appId: "00000000-0000-0000-0000-000000000000",
      organizationId: organization.id,
      toolId: tool.id,
    });
    expect(result).not.toBeNull();
    expect(result).toMatchObject({ code: "not_found" });
  });

  test("rejects a server a personal app has no claim to, but allows the author's own", async ({
    makeApp,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTool,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const author = await makeUser();
    const stranger = await makeUser();
    await makeMember(author.id, organization.id, { role: "member" });
    await makeMember(stranger.id, organization.id, { role: "member" });

    const app = await makeApp({
      organizationId: organization.id,
      authorId: author.id,
      scope: "personal",
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: organization.id,
      serverType: "remote",
    });
    const tool = await makeTool({
      name: "scoped_app_tool",
      catalogId: catalog.id,
    });
    const strangersServer = await makeMcpServer({
      ownerId: stranger.id,
      catalogId: catalog.id,
    });
    const authorsServer = await makeMcpServer({
      ownerId: author.id,
      catalogId: catalog.id,
    });

    const rejected = await assignToolToApp({
      appId: app.id,
      organizationId: organization.id,
      toolId: tool.id,
      mcpServerId: strangersServer.id,
    });
    expect(rejected).toMatchObject({ code: "validation_error" });

    const allowed = await assignToolToApp({
      appId: app.id,
      organizationId: organization.id,
      toolId: tool.id,
      mcpServerId: authorsServer.id,
    });
    expect(allowed).toBeNull();
  });

  test("rejects a tool from another organization as not_found", async ({
    makeApp,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTool,
    makeUser,
  }) => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    const authorB = await makeUser();
    await makeMember(authorB.id, orgB.id, { role: "admin" });

    const appB = await makeApp({
      organizationId: orgB.id,
      authorId: authorB.id,
      scope: "org",
    });
    const catalogA = await makeInternalMcpCatalog({
      organizationId: orgA.id,
      serverType: "remote",
    });
    const toolA = await makeTool({
      name: "foreign_org_tool",
      catalogId: catalogA.id,
    });

    const result = await assignToolToApp({
      appId: appB.id,
      organizationId: orgB.id,
      toolId: toolA.id,
      credentialResolutionMode: "dynamic",
    });
    expect(result).toMatchObject({ code: "not_found" });
  });

  test("rejects a foreign-org server sharing the tool's catalog as not_found", async ({
    makeApp,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTool,
    makeUser,
  }) => {
    // The tool's catalog belongs to orgB (so the tool resolves), but the server
    // is owned by an orgA-only user and shares that catalog. It would pass the
    // catalog-match + org-scoped-server assignability checks, so org-scoping the
    // server lookup is what rejects it before those checks run.
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    const foreignOwner = await makeUser();
    await makeMember(foreignOwner.id, orgA.id, { role: "admin" });
    const authorB = await makeUser();
    await makeMember(authorB.id, orgB.id, { role: "admin" });

    const catalogB = await makeInternalMcpCatalog({
      organizationId: orgB.id,
      serverType: "remote",
    });
    const tool = await makeTool({
      name: "shared_catalog_tool",
      catalogId: catalogB.id,
    });
    const foreignServer = await makeMcpServer({
      ownerId: foreignOwner.id,
      catalogId: catalogB.id,
      scope: "org",
    });
    const appB = await makeApp({
      organizationId: orgB.id,
      authorId: authorB.id,
      scope: "org",
    });

    const result = await assignToolToApp({
      appId: appB.id,
      organizationId: orgB.id,
      toolId: tool.id,
      mcpServerId: foreignServer.id,
    });
    expect(result).toMatchObject({ code: "not_found" });
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
