import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import {
  assignToolToAgent,
  validateAssignment,
  validateCredentialSource,
  validateExecutionSource,
} from "./agent-tool-assignment";

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
        message: "Personal connections can only be assigned to personal agents",
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

  test("rejects a personal credential for an org-scoped resource even when the owner is in the organization", async ({
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
    const author = await makeUser();

    await makeMember(author.id, organization.id, { role: "member" });
    await makeMember(owner.id, organization.id, { role: "member" });

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
        message: "Personal connections can only be assigned to personal agents",
        type: "validation_error",
      },
    });
  });

  test("rejects a personal credential for a team-scoped resource", async ({
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

    expect(result).toEqual({
      code: "validation_error",
      error: {
        message: "Personal connections can only be assigned to personal agents",
        type: "validation_error",
      },
    });
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
