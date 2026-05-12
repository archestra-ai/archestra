// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { InternalMcpCatalogModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

describe("mcp server tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;
  let organizationId: string;

  beforeEach(async ({ makeAgent, makeUser, makeOrganization, makeMember }) => {
    const org = await makeOrganization();
    organizationId = org.id;
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    testAgent = await makeAgent({ name: "Test Agent", organizationId: org.id });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      userId: user.id,
      organizationId: org.id,
    };
  });

  test("get_mcp_server_tools returns error when mcpServerId is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_mcp_server_tools`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Validation error in archestra__get_mcp_server_tools",
    );
    expect((result.content[0] as any).text).toContain("mcpServerId:");
  });

  test("get_mcp_servers returns catalog items", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_mcp_servers`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ items: expect.any(Array) });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(Array.isArray(parsed)).toBe(true);
  });

  test("search_private_mcp_registry with no results", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}search_private_mcp_registry`,
      { query: "nonexistent_mcp_server_xyz_999" },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain("No MCP servers found");
  });

  test("edit_mcp_description returns error when id is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_mcp_description`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Validation error in archestra__edit_mcp_description",
    );
    expect((result.content[0] as any).text).toContain("id:");
  });

  test("edit_mcp_description returns error when user/org context is missing", async () => {
    const noAuthContext: ArchestraContext = {
      agent: { id: testAgent.id, name: testAgent.name },
    };
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_mcp_description`,
      { id: "00000000-0000-4000-8000-000000000001" },
      noAuthContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "User context not available",
    );
  });

  test("create_mcp_server_installation_request returns success message", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_server_installation_request`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain(
      "dialog for adding or requesting",
    );
  });

  test("get_mcp_servers returns real catalog items", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "Test MCP Server",
      description: "A test server",
      organizationId,
    });

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_mcp_servers`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      items: expect.arrayContaining([
        expect.objectContaining({ id: catalog.id, name: "Test MCP Server" }),
      ]),
    });
    const parsed = JSON.parse((result.content[0] as any).text);
    const found = parsed.find((item: any) => item.id === catalog.id);
    expect(found).toBeDefined();
    expect(found.name).toBe("Test MCP Server");
    expect(found.description).toBe("A test server");
  });

  test("search_private_mcp_registry finds matching catalog item", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "UniqueSearchableServer",
      description: "Unique description for search",
      organizationId,
    });

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}search_private_mcp_registry`,
      { query: "UniqueSearchableServer" },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const text = (result.content[0] as any).text;
    expect(text).toContain("UniqueSearchableServer");
    expect(text).toContain(catalog.id);
  });

  test("get_mcp_server_tools returns tools for a catalog item", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "Server With Tools",
      organizationId,
    });
    await makeTool({ catalogId: catalog.id, name: "test_tool_1" });
    await makeTool({ catalogId: catalog.id, name: "test_tool_2" });

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_mcp_server_tools`,
      { mcpServerId: catalog.id },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.length).toBe(2);
    const names = parsed.map((t: any) => t.name);
    expect(names).toContain("test_tool_1");
    expect(names).toContain("test_tool_2");
  });

  test("edit_mcp_description updates an existing catalog item", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "Original Name",
      description: "Original description",
      organizationId,
    });

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_mcp_description`,
      {
        id: catalog.id,
        name: "Updated Name",
        description: "Updated description",
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const text = (result.content[0] as any).text;
    expect(text).toContain("Successfully updated MCP server");
    expect(text).toContain("Updated Name");
    expect(text).toContain("Updated description");

    const updatedCatalog = await InternalMcpCatalogModel.findById(catalog.id, {
      expandSecrets: false,
    });
    expect(updatedCatalog?.name).toBe("Updated Name");
    expect(updatedCatalog?.description).toBe("Updated description");
  });

  test("create_mcp_server persists a new MCP catalog item", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_server`,
      {
        name: "Created Via Tool",
        description: "Created from the Archestra MCP tool handler",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
      },
      mockContext,
    );

    expect(result.isError).toBe(false);

    const createdCatalog =
      await InternalMcpCatalogModel.findByName("Created Via Tool");
    expect(createdCatalog).toBeTruthy();
    expect(createdCatalog?.description).toBe(
      "Created from the Archestra MCP tool handler",
    );
    expect(createdCatalog?.serverType).toBe("remote");
    expect(createdCatalog?.serverUrl).toBe("https://example.com/mcp");
  });

  test("edit_mcp_config updates persisted MCP server configuration", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "Configurable MCP Server",
      serverType: "local",
      organizationId,
    });

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_mcp_config`,
      {
        id: catalog.id,
        command: "npx",
        arguments: ["-y", "@modelcontextprotocol/server-github"],
        transportType: "stdio",
      },
      mockContext,
    );

    expect(result.isError).toBe(false);

    const updatedCatalog = await InternalMcpCatalogModel.findById(catalog.id, {
      expandSecrets: false,
    });
    expect(updatedCatalog?.localConfig?.command).toBe("npx");
    expect(updatedCatalog?.localConfig?.arguments).toEqual([
      "-y",
      "@modelcontextprotocol/server-github",
    ]);
    expect(updatedCatalog?.localConfig?.transportType).toBe("stdio");
  });
});

describe("deploy_mcp_server", () => {
  const DEPLOY_TOOL = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}deploy_mcp_server`;

  test("personal install: admin succeeds", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({ organizationId: org.id });
    const ctx: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      userId: user.id,
      organizationId: org.id,
    };
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
    });

    const result = await executeArchestraTool(
      DEPLOY_TOOL,
      { catalogId: catalog.id, scope: "personal" },
      ctx,
    );

    expect(result.isError).toBe(false);
  });

  test("personal install: non-admin with create succeeds", async ({
    makeAgent,
    makeCustomRole,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const callerRole = await makeCustomRole(org.id, {
      permission: {
        mcpRegistry: ["update"],
        mcpServerInstallation: ["read", "create"],
      },
    });
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: callerRole.role });
    const agent = await makeAgent({ organizationId: org.id });
    const ctx: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      userId: user.id,
      organizationId: org.id,
    };
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
    });

    const result = await executeArchestraTool(
      DEPLOY_TOOL,
      { catalogId: catalog.id, scope: "personal" },
      ctx,
    );

    expect(result.isError).toBe(false);
  });

  test("team install: org admin can install for a team they don't belong to", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const notTeamMember = await makeUser();
    const teamMember = await makeUser();
    await makeMember(notTeamMember.id, org.id, { role: "admin" });
    await makeMember(teamMember.id, org.id, { role: "admin" });
    const team = await makeTeam(org.id, teamMember.id);
    const agent = await makeAgent({ organizationId: org.id });
    const ctx: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      userId: notTeamMember.id,
      organizationId: org.id,
    };
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
    });

    const result = await executeArchestraTool(
      DEPLOY_TOOL,
      { catalogId: catalog.id, scope: "team", teamId: team.id },
      ctx,
    );

    expect(result.isError).toBe(false);
  });

  test("team install: member of team and editor succeeds", async ({
    makeAgent,
    makeCustomRole,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    await makeMember(owner.id, org.id, { role: "admin" });
    const editorRole = await makeCustomRole(org.id, {
      permission: {
        mcpRegistry: ["update"],
        mcpServerInstallation: ["read", "create", "update"],
      },
    });
    const editor = await makeUser();
    await makeMember(editor.id, org.id, { role: editorRole.role });
    const team = await makeTeam(org.id, owner.id);
    await makeTeamMember(team.id, editor.id);
    const agent = await makeAgent({ organizationId: org.id });
    const ctx: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      userId: editor.id,
      organizationId: org.id,
    };
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
    });

    const result = await executeArchestraTool(
      DEPLOY_TOOL,
      { catalogId: catalog.id, scope: "team", teamId: team.id },
      ctx,
    );

    expect(result.isError).toBe(false);
  });

  test("team install: member of team and non-editor is rejected", async ({
    makeAgent,
    makeCustomRole,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    await makeMember(owner.id, org.id, { role: "admin" });
    const callerOnlyRole = await makeCustomRole(org.id, {
      permission: {
        mcpRegistry: ["update"],
        mcpServerInstallation: ["read", "create"],
      },
    });
    const caller = await makeUser();
    await makeMember(caller.id, org.id, { role: callerOnlyRole.role });
    const team = await makeTeam(org.id, owner.id);
    await makeTeamMember(team.id, caller.id);
    const agent = await makeAgent({ organizationId: org.id });
    const ctx: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      userId: caller.id,
      organizationId: org.id,
    };
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
    });

    const result = await executeArchestraTool(
      DEPLOY_TOOL,
      { catalogId: catalog.id, scope: "team", teamId: team.id },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "You don't have permission to create team MCP server installations",
    );
  });

  test("team install: editor not a member of the target team is rejected", async ({
    makeAgent,
    makeCustomRole,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    await makeMember(owner.id, org.id, { role: "admin" });
    const editorRole = await makeCustomRole(org.id, {
      permission: {
        mcpRegistry: ["update"],
        mcpServerInstallation: ["read", "create", "update"],
      },
    });
    const notTeamMember = await makeUser();
    await makeMember(notTeamMember.id, org.id, { role: editorRole.role });
    const team = await makeTeam(org.id, owner.id);
    const agent = await makeAgent({ organizationId: org.id });
    const ctx: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      userId: notTeamMember.id,
      organizationId: org.id,
    };
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
    });

    const result = await executeArchestraTool(
      DEPLOY_TOOL,
      { catalogId: catalog.id, scope: "team", teamId: team.id },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "You can only create MCP server installations for teams you are a member of",
    );
  });

  test("org install: mcpServerInstallation:admin succeeds", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({ organizationId: org.id });
    const ctx: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      userId: user.id,
      organizationId: org.id,
    };
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
    });

    const result = await executeArchestraTool(
      DEPLOY_TOOL,
      { catalogId: catalog.id, scope: "org" },
      ctx,
    );

    expect(result.isError).toBe(false);
  });

  test("org install: non-admin (no mcpServerInstallation:admin) is rejected", async ({
    makeAgent,
    makeCustomRole,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const callerRole = await makeCustomRole(org.id, {
      permission: {
        mcpRegistry: ["update"],
        mcpServerInstallation: ["read", "create"],
      },
    });
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: callerRole.role });
    const agent = await makeAgent({ organizationId: org.id });
    const ctx: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      userId: user.id,
      organizationId: org.id,
    };
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
    });

    const result = await executeArchestraTool(
      DEPLOY_TOOL,
      { catalogId: catalog.id, scope: "org" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Only mcpServerInstallation admins can install organization-scoped MCP servers",
    );
  });

  test("org install: duplicate org-scoped install for the same catalog is rejected", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({ organizationId: org.id });
    const ctx: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      userId: user.id,
      organizationId: org.id,
    };
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
    });
    await makeMcpServer({
      catalogId: catalog.id,
      scope: "org",
      ownerId: user.id,
    });

    const result = await executeArchestraTool(
      DEPLOY_TOOL,
      { catalogId: catalog.id, scope: "org" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "This organization already has an installation of this MCP server",
    );
  });

  test("org install: scope=org with teamId is rejected", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({ organizationId: org.id });
    const ctx: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      userId: user.id,
      organizationId: org.id,
    };
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
    });

    const result = await executeArchestraTool(
      DEPLOY_TOOL,
      { catalogId: catalog.id, scope: "org", teamId: team.id },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "teamId should not be provided for non-team MCP server installations",
    );
  });
});
