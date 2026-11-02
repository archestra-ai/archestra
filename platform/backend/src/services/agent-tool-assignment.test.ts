import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import {
  assignToolToAgent,
  assignToolToApp,
  validateAssignment,
} from "./agent-tool-assignment";
import {
  filterMcpServersAssignableToTarget,
  isMcpServerAssignableToTarget,
} from "./mcp-server-assignability";

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
      access: "personal",
    });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({
      name: "remote_assignment_tool",
      catalogId: catalog.id,
    });
    const firstServer = await makeMcpServer({
      ownerId: owner.id,
      catalogId: catalog.id,
      scope: "org",
    });
    const secondServer = await makeMcpServer({
      ownerId: owner.id,
      catalogId: catalog.id,
      scope: "org",
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
      access: "personal",
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
      scope: "org",
    });
    const secondServer = await makeMcpServer({
      ownerId: author.id,
      catalogId: catalog.id,
      scope: "org",
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

  test("rejects every personal connection for a personal app", async ({
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
      access: "personal",
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
    expect(allowed).toMatchObject({ code: "validation_error" });
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

describe("personal connections are never statically assignable", () => {
  const orgTarget = {
    organizationId: "org-1",
    scope: "org" as const,
    authorId: "me",
    teamIds: [],
  };

  test("rejects another user's personal connection", async () => {
    const assignable = await isMcpServerAssignableToTarget({
      mcpServer: {
        ownerId: "colleague",
        teamId: null,
        scope: "personal",
      },
      target: orgTarget,
    });

    expect(assignable).toBe(false);
  });

  test("rejects the target owner's own personal connection", async () => {
    const assignable = await isMcpServerAssignableToTarget({
      mcpServer: { ownerId: "me", teamId: null, scope: "personal" },
      target: { ...orgTarget, scope: "personal" },
    });

    expect(assignable).toBe(false);
  });

  test("rejects the target owner's personal local installation", async () => {
    const assignable = await isMcpServerAssignableToTarget({
      mcpServer: {
        ownerId: "me",
        serverType: "local",
        teamId: null,
        scope: "personal",
      },
      target: { ...orgTarget, scope: "personal" },
    });

    expect(assignable).toBe(false);
  });

  test("org- and team-scoped servers are unaffected — they are shared resources, not someone's credentials", async () => {
    const orgScoped = await isMcpServerAssignableToTarget({
      mcpServer: { ownerId: "colleague", teamId: null, scope: "org" },
      target: orgTarget,
    });

    expect(orgScoped).toBe(true);
  });

  test("the picker filter drops all personal connections", async () => {
    const mine = {
      ownerId: "me",
      serverType: "local" as const,
      teamId: null,
      scope: "personal" as const,
    };
    const theirs = {
      ownerId: "colleague",
      teamId: null,
      scope: "personal" as const,
    };
    const shared = { ownerId: null, teamId: null, scope: "org" as const };

    const visible = await filterMcpServersAssignableToTarget({
      mcpServers: [mine, theirs, shared],
      target: orgTarget,
    });

    expect(visible).toEqual([shared]);
  });

  test("validateAssignment directs every caller to dynamic resolution", async ({
    makeAgent,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTool,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const me = await makeUser();
    const colleague = await makeUser();
    await makeMember(me.id, org.id, { role: "member" });
    await makeMember(colleague.id, org.id, { role: "member" });

    const agent = await makeAgent({
      organizationId: org.id,
      authorId: me.id,
    });
    const tool = await makeTool({});
    const theirs = await makeMcpServer({
      scope: "personal",
      ownerId: colleague.id,
      serverType: "remote",
    });

    const result = await validateAssignment({
      agentId: agent.id,
      toolId: tool.id,
      mcpServerId: theirs.id,
    });

    expect(result).toMatchObject({
      code: "validation_error",
      error: { type: "validation_error" },
    });
    expect(result?.error.message).toContain("dynamic credential resolution");
  });

  test("validateAssignment rejects a personal local installation", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTool,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const me = await makeUser();
    await makeMember(me.id, org.id, { role: "member" });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      serverType: "local",
    });
    const agent = await makeAgent({
      organizationId: org.id,
      authorId: me.id,
      access: "personal",
    });
    const tool = await makeTool({ catalogId: catalog.id });
    const personalInstallation = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: me.id,
      serverType: "local",
    });

    const result = await validateAssignment({
      agentId: agent.id,
      toolId: tool.id,
      mcpServerId: personalInstallation.id,
    });

    expect(result).toMatchObject({
      code: "validation_error",
      error: { type: "validation_error" },
    });
    expect(result?.error.message).toContain("dynamic credential resolution");
  });

  test("validateAssignment rejects a team-local installation outside the agent author's teams", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTeam,
    makeTool,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const teamOwner = await makeUser();
    await makeMember(author.id, org.id, { role: "member" });
    await makeMember(teamOwner.id, org.id, { role: "member" });
    const team = await makeTeam(org.id, teamOwner.id);
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      serverType: "local",
    });
    const agent = await makeAgent({
      organizationId: org.id,
      authorId: author.id,
      access: "personal",
    });
    const tool = await makeTool({ catalogId: catalog.id });
    const teamInstallation = await makeMcpServer({
      catalogId: catalog.id,
      scope: "team",
      teamId: team.id,
      ownerId: teamOwner.id,
      serverType: "local",
    });

    const result = await validateAssignment({
      agentId: agent.id,
      toolId: tool.id,
      mcpServerId: teamInstallation.id,
    });

    expect(result).toMatchObject({
      code: "validation_error",
      error: { type: "validation_error" },
    });
    expect(result?.error.message).toContain("not shared");
  });
});
