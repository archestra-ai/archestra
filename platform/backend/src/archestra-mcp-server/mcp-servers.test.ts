// biome-ignore-all lint/suspicious/noExplicitAny: test

import {
  ADMIN_ROLE_NAME,
  ARCHESTRA_MCP_SERVER_NAME,
  BUILT_IN_AGENT_IDS,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_CREATE_MCP_SERVER_SHORT_NAME,
  TOOL_GET_MCP_SERVER_TOOLS_SHORT_NAME,
  TOOL_GET_MCP_SERVERS_SHORT_NAME,
  TOOL_SEARCH_PRIVATE_MCP_REGISTRY_SHORT_NAME,
} from "@archestra/shared";
import {
  EnvironmentModel,
  EnvironmentResourceDefaultModel,
  InternalMcpCatalogModel,
  OrganizationModel,
} from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { createRestrictedEnvironment } from "@/test/environments";
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
      "Organization context not available",
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

  test("get_mcp_server_tools steers an unknown id at the listing tool", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_mcp_server_tools`,
      { mcpServerId: "00000000-0000-4000-8000-000000000abc" },
      mockContext,
    );
    expect(result.isError).toBe(true);
    const text = (result.content[0] as any).text;
    expect(text).toContain("not found or you don't have access");
    expect(text).toContain(TOOL_GET_MCP_SERVERS_SHORT_NAME);
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
        description: "Updated description",
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const text = (result.content[0] as any).text;
    expect(text).toContain("Successfully updated MCP server");
    expect(text).toContain("Updated description");

    const updatedCatalog = await InternalMcpCatalogModel.findById(catalog.id, {
      expandSecrets: false,
    });
    expect(updatedCatalog?.name).toBe("Original Name");
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

  test("create_mcp_server persists environmentId", async () => {
    const env = await EnvironmentModel.create({
      organizationId,
      name: "production",
    });

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_server`,
      {
        name: "Server With Environment",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        environmentId: env.id,
      },
      mockContext,
    );

    expect(result.isError).toBe(false);

    const createdCatalog = await InternalMcpCatalogModel.findByName(
      "Server With Environment",
    );
    expect(createdCatalog?.environmentId).toBe(env.id);
  });

  test("edit_mcp_description cannot change the environmentId", async ({
    makeInternalMcpCatalog,
  }) => {
    const env = await EnvironmentModel.create({
      organizationId,
      name: "Staging",
    });
    const catalog = await makeInternalMcpCatalog({
      name: "Catalog To Move",
      organizationId,
    });
    expect(catalog.environmentId).toBeNull();

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_mcp_description`,
      {
        id: catalog.id,
        environmentId: env.id,
      },
      mockContext,
    );

    // The edit tool's args schema is strict and no longer accepts
    // environmentId, so the call is rejected and the environment is unchanged.
    expect(result.isError).toBe(true);

    const updatedCatalog = await InternalMcpCatalogModel.findById(catalog.id, {
      expandSecrets: false,
    });
    expect(updatedCatalog?.environmentId).toBeNull();
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

  test("blocks a personal local install whose image is not trusted", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    // A plain member (non-privileged: mcpRegistry:update but no team-admin/admin)
    // is the actor the gate targets — privileged authors are exempt.
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    const agent = await makeAgent({ organizationId: org.id });
    const ctx: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      userId: user.id,
      organizationId: org.id,
    };
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: user.id,
      access: "personal",
      serverType: "local",
      localConfig: { dockerImage: "ghcr.io/evil/x:1" },
    });

    const result = await executeArchestraTool(
      DEPLOY_TOOL,
      { catalogId: catalog.id, scope: "personal" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "pending administrator approval",
    );
    const flagged = await InternalMcpCatalogModel.findById(catalog.id);
    expect(flagged?.catalogItemApprovalStatus).toBe("pending");
  });

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
        mcpRegistry: ["read", "update"],
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
        mcpRegistry: ["read", "update"],
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

  test("shared team install of a use-level team item is rejected", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const teamMember = await makeUser();
    await makeMember(teamMember.id, org.id, { role: "editor" });
    const team = await makeTeam(org.id, teamMember.id);
    await makeTeamMember(team.id, teamMember.id, { role: "member" });
    const agent = await makeAgent({ organizationId: org.id });
    const ctx: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      userId: teamMember.id,
      organizationId: org.id,
    };
    // Team-scoped item where the member's team holds only `use`.
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      access: { teams: [team.id] },
    });

    const result = await executeArchestraTool(
      DEPLOY_TOOL,
      { catalogId: catalog.id, scope: "team", teamId: team.id },
      ctx,
    );

    // A shared team install is the connection others resolve through — a write.
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "permission to perform this action",
    );
  });

  test("shared team install of a write-level team item succeeds", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const teamMember = await makeUser();
    await makeMember(teamMember.id, org.id, { role: "editor" });
    const team = await makeTeam(org.id, teamMember.id);
    await makeTeamMember(team.id, teamMember.id, { role: "member" });
    const agent = await makeAgent({ organizationId: org.id });
    const ctx: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      userId: teamMember.id,
      organizationId: org.id,
    };
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      access: { teams: [team.id], level: "edit" },
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
        mcpRegistry: ["read", "update"],
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
        mcpRegistry: ["read", "update"],
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
        mcpRegistry: ["read", "update"],
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

/**
 * create_mcp_server must refuse to assign a *restricted* environment unless the
 * caller holds a `use` grant on that environment. This mirrors the REST guard
 * (internal-mcp-catalog.restricted-environment.test.ts) but exercises the MCP
 * tool path against real grants: a new organization gives the built-in Admin
 * role authority over every environment, and a custom role none. Personal-scope
 * create (the default) needs no `mcpServerInstallation:admin`, so a plain
 * member can reach the environment gate.
 */
describe("create_mcp_server restricted environment guard", () => {
  const CREATE_TOOL = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_server`;

  test("member with no grant on a RESTRICTED env is rejected and nothing is created", async ({
    makeAgent,
    makeCustomRole,
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    // A role that can create registry entries (so it passes the centralized
    // tool RBAC gate and a personal-scope create) but reaches no environment.
    const role = await makeCustomRole(org.id, {
      permission: { mcpRegistry: ["create"] },
    });
    await makeMember(user.id, org.id, { role: role.role });
    const agent = await makeAgent({ organizationId: org.id });
    const ctx: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      userId: user.id,
      organizationId: org.id,
    };
    const restricted = await createRestrictedEnvironment({
      organizationId: org.id,
      data: { name: "Prod" },
    });

    const serverName = `restricted-env-rejected-${crypto.randomUUID().slice(0, 8)}`;
    const result = await executeArchestraTool(
      CREATE_TOOL,
      {
        name: serverName,
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        environmentId: restricted.id,
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("this environment");

    const created = await InternalMcpCatalogModel.findByName(serverName);
    expect(created).toBeFalsy();
  });

  test("built-in Admin (granted use on every environment) assigning a RESTRICTED env succeeds", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeMember,
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
    const restricted = await createRestrictedEnvironment({
      organizationId: org.id,
      data: { name: "Prod" },
    });

    const serverName = `restricted-env-allowed-${crypto.randomUUID().slice(0, 8)}`;
    const result = await executeArchestraTool(
      CREATE_TOOL,
      {
        name: serverName,
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        environmentId: restricted.id,
      },
      ctx,
    );

    expect(result.isError).toBe(false);

    const created = await InternalMcpCatalogModel.findByName(serverName);
    expect(created?.environmentId).toBe(restricted.id);
  });
});

describe("mcp-server tools — team-scope RBAC", () => {
  let ctx: ArchestraContext;
  let organizationId: string;

  const CREATE = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_server`;

  beforeEach(async ({ makeAgent, makeOrganization, makeUser, makeMember }) => {
    const org = await makeOrganization();
    organizationId = org.id;
    // editor holds mcpRegistry create/update/team-admin (not installation admin)
    const editor = await makeUser();
    await makeMember(editor.id, org.id, { role: "editor" });
    const agent = await makeAgent({ organizationId: org.id });
    ctx = {
      agent: { id: agent.id, name: agent.name },
      userId: editor.id,
      organizationId: org.id,
    };
  });

  function remoteArgs(overrides: Record<string, unknown> = {}) {
    return {
      name: `srv-${crypto.randomUUID().slice(0, 8)}`,
      serverType: "remote",
      serverUrl: "https://example.test/mcp",
      ...overrides,
    };
  }

  function bodyText(result: { content: unknown[] }): string {
    return (result.content[0] as any).text as string;
  }

  test("editor shares a new server with a team they administer through initialGrants", async ({
    makeTeam,
    makeTeamMember,
  }) => {
    const team = await makeTeam(organizationId, ctx.userId as string);
    await makeTeamMember(team.id, ctx.userId as string, {
      role: ADMIN_ROLE_NAME,
    });

    const result = await executeArchestraTool(
      CREATE,
      remoteArgs({
        initialGrants: [
          { subject: { type: "team", id: team.id }, actions: ["read", "use"] },
        ],
      }),
      ctx,
    );
    expect(result.isError, bodyText(result)).toBe(false);
    expect(bodyText(result)).toContain("Successfully created");
  });

  test("create refuses the retired scope and teams arguments", async ({
    makeTeam,
  }) => {
    const team = await makeTeam(organizationId, ctx.userId as string);

    const result = await executeArchestraTool(
      CREATE,
      remoteArgs({ scope: "team", teams: [team.id] }),
      ctx,
    );
    expect(result.isError).toBe(true);
  });

  test("editor cannot create an org-scoped server", async () => {
    const result = await executeArchestraTool(
      CREATE,
      remoteArgs({ scope: "org" }),
      ctx,
    );
    expect(result.isError).toBe(true);
  });
});

/**
 * Environment isolation on the agent-facing MCP server tools: an agent bound to
 * environment E must only discover and act on servers in E, matching the tools
 * it can actually call. Without this the registry tools enumerated the whole
 * organization's catalog regardless of the agent's environment.
 */
describe("mcp server tools respect the agent's environment", () => {
  const tool = (shortName: string) =>
    `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${shortName}`;

  let orgId: string;
  let stagingContext: ArchestraContext;
  let stagingEnvId: string;
  let prodEnvId: string;

  beforeEach(async ({ makeAgent, makeUser, makeOrganization, makeMember }) => {
    const org = await makeOrganization();
    orgId = org.id;
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });

    const staging = await EnvironmentModel.create({
      organizationId: org.id,
      name: "staging",
    });
    const prod = await EnvironmentModel.create({
      organizationId: org.id,
      name: "production",
    });
    stagingEnvId = staging.id;
    prodEnvId = prod.id;

    const stagingAgent = await makeAgent({
      name: "Staging Agent",
      organizationId: org.id,
      environmentId: staging.id,
    });
    stagingContext = {
      agent: { id: stagingAgent.id, name: stagingAgent.name },
      userId: user.id,
      organizationId: org.id,
    };
  });

  test("get_mcp_servers lists only the agent's environment", async ({
    makeInternalMcpCatalog,
  }) => {
    const stagingCatalog = await makeInternalMcpCatalog({
      name: "Staging Server",
      organizationId: orgId,
      environmentId: stagingEnvId,
    });
    const prodCatalog = await makeInternalMcpCatalog({
      name: "Production Server",
      organizationId: orgId,
      environmentId: prodEnvId,
    });
    const defaultCatalog = await makeInternalMcpCatalog({
      name: "Default Server",
      organizationId: orgId,
      environmentId: null,
    });

    const result = await executeArchestraTool(
      tool(TOOL_GET_MCP_SERVERS_SHORT_NAME),
      {},
      stagingContext,
    );

    expect(result.isError).toBe(false);
    const ids = (
      result.structuredContent as { items: { id: string }[] }
    ).items.map((item) => item.id);
    expect(ids).toContain(stagingCatalog.id);
    expect(ids).not.toContain(prodCatalog.id);
    expect(ids).not.toContain(defaultCatalog.id);
  });

  test("search_private_mcp_registry does not surface other environments", async ({
    makeInternalMcpCatalog,
  }) => {
    const stagingCatalog = await makeInternalMcpCatalog({
      name: "grafana staging",
      organizationId: orgId,
      environmentId: stagingEnvId,
    });
    const prodCatalog = await makeInternalMcpCatalog({
      name: "grafana prod",
      organizationId: orgId,
      environmentId: prodEnvId,
    });

    const result = await executeArchestraTool(
      tool(TOOL_SEARCH_PRIVATE_MCP_REGISTRY_SHORT_NAME),
      { query: "grafana" },
      stagingContext,
    );

    expect(result.isError).toBe(false);
    const ids = (
      result.structuredContent as { items: { id: string }[] }
    ).items.map((item) => item.id);
    expect(ids).toEqual([stagingCatalog.id]);
    expect(ids).not.toContain(prodCatalog.id);
  });

  test("get_mcp_server_tools reports a cross-environment server as not found", async ({
    makeInternalMcpCatalog,
  }) => {
    const prodCatalog = await makeInternalMcpCatalog({
      name: "Production Only",
      organizationId: orgId,
      environmentId: prodEnvId,
    });

    const result = await executeArchestraTool(
      tool(TOOL_GET_MCP_SERVER_TOOLS_SHORT_NAME),
      { mcpServerId: prodCatalog.id },
      stagingContext,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("not found");
  });

  test("policy configuration can inspect a visible server in another environment", async ({
    makeAgent,
    makeInternalMcpCatalog,
  }) => {
    const prodCatalog = await makeInternalMcpCatalog({
      name: "Production Server",
      organizationId: orgId,
      environmentId: prodEnvId,
    });
    const policyAgent = await makeAgent({
      name: "Policy configuration",
      organizationId: orgId,
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG },
    });
    const policyContext: ArchestraContext = {
      ...stagingContext,
      agent: { id: policyAgent.id, name: policyAgent.name },
    };

    const result = await executeArchestraTool(
      tool(TOOL_GET_MCP_SERVER_TOOLS_SHORT_NAME),
      { mcpServerId: prodCatalog.id },
      policyContext,
    );

    expect(result.isError).toBe(false);
  });

  test("create_mcp_server defaults to the calling agent's environment", async () => {
    const result = await executeArchestraTool(
      tool(TOOL_CREATE_MCP_SERVER_SHORT_NAME),
      {
        name: "Agent Authored Server",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
      },
      stagingContext,
    );

    expect(result.isError).toBe(false);
    const created = await InternalMcpCatalogModel.findByName(
      "Agent Authored Server",
    );
    expect(created?.environmentId).toBe(stagingEnvId);
  });

  test("an authoring agent with no environment falls back to the org's configured default", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    await EnvironmentResourceDefaultModel.setForResource({
      organizationId: orgId,
      resource: "mcpRegistry",
      environmentId: prodEnvId,
    });
    const looseAgent = await makeAgent({
      name: "Default Env Agent",
      organizationId: orgId,
    });
    const user = await makeUser();
    await makeMember(user.id, orgId, { role: "admin" });

    const result = await executeArchestraTool(
      tool(TOOL_CREATE_MCP_SERVER_SHORT_NAME),
      {
        name: "Unbound Agent Server",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
      },
      {
        agent: { id: looseAgent.id, name: looseAgent.name },
        userId: user.id,
        organizationId: orgId,
      },
    );

    expect(result.isError).toBe(false);
    const created = await InternalMcpCatalogModel.findByName(
      "Unbound Agent Server",
    );
    expect(created?.environmentId).toBe(prodEnvId);
  });
});
