import {
  ADMIN_ROLE_NAME,
  MEMBER_ROLE_NAME,
  TOOL_RUN_COMMAND_SHORT_NAME,
} from "@archestra/shared";
import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared/archestra-mcp-server";
import { beforeEach } from "vitest";
import { getAppVersion } from "@/app-version";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import config from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import {
  AgentModel,
  AgentTeamModel,
  AgentToolModel,
  AgentVersionModel,
  EnvironmentModel,
  InternalMcpCatalogModel,
  McpServerModel,
  SreRuntimeModel,
  ToolModel,
} from "@/models";
import { openappaBatteriesService } from "@/openappa/batteries";
import { openappaDeclarations } from "@/openappa/declarations";
import { ResourcePermissions } from "@/services/resource-permissions";
import { renderSystemPrompt } from "@/templating";
import { describe, expect, test } from "@/test";
import {
  SRE_AGENT_ID,
  SRE_AGENT_TOOL_NAMES,
  SRE_CATALOG_ID,
  SRE_ENVIRONMENT_ID,
  SRE_SERVER_NAME,
  SRE_SOURCE_HOSTS,
} from "./definition";
import { sreAgentService } from "./index";

const SERVICE_ACCOUNT = "archestra-mcp-k8s-operator";

describe("sreAgentService", () => {
  beforeEach(() => {
    config.sreAgent.enabled = true;
    config.sreAgent.k8sServiceAccount = SERVICE_ACCOUNT;
    config.sreAgent.apiServerCidrs = ["10.0.0.1/32"];
    config.skillsSandbox.enabled = false;
  });

  test("seeds one environment, catalog item, and org-wide install, idempotently", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId, adminId } = await seedAdmin({
      makeOrganization,
      makeUser,
      makeMember,
    });

    await sreAgentService.seed();
    await sreAgentService.seed();

    const environment = await EnvironmentModel.findById(SRE_ENVIRONMENT_ID);
    expect(environment).toMatchObject({
      organizationId,
      namespace: null,
      networkPolicy: {
        egressMode: "restricted",
        allowedDomains: [],
        allowedCidrs: ["10.0.0.1/32"],
      },
    });
    const catalog = await InternalMcpCatalogModel.findById(SRE_CATALOG_ID);
    expect(catalog).toMatchObject({
      organizationId,
      serverType: "local",
      environmentId: SRE_ENVIRONMENT_ID,
      localConfig: {
        serviceAccount: SERVICE_ACCOUNT,
        transportType: "streamable-http",
      },
    });
    const servers = await McpServerModel.findByCatalogId(SRE_CATALOG_ID);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ scope: "org", ownerId: adminId });
  });

  test("re-applies the configured egress and service account on the next start", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    await seedAdmin({ makeOrganization, makeUser, makeMember });
    await sreAgentService.seed();

    config.sreAgent.apiServerCidrs = [];
    config.sreAgent.k8sServiceAccount = "other-account";
    await sreAgentService.seed();

    expect(
      (await EnvironmentModel.findById(SRE_ENVIRONMENT_ID))?.networkPolicy,
    ).toBeNull();
    expect(
      (await InternalMcpCatalogModel.findById(SRE_CATALOG_ID))?.localConfig
        ?.serviceAccount,
    ).toBe("other-account");
  });

  test("a catalog item or install an admin deleted stays deleted", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    await seedAdmin({ makeOrganization, makeUser, makeMember });
    await sreAgentService.seed();
    const [server] = await McpServerModel.findByCatalogId(SRE_CATALOG_ID);
    await McpServerModel.delete(server.id);

    await sreAgentService.seed();
    expect(await McpServerModel.findByCatalogId(SRE_CATALOG_ID)).toEqual([]);

    await InternalMcpCatalogModel.delete(SRE_CATALOG_ID);
    await sreAgentService.seed();
    expect(await InternalMcpCatalogModel.findById(SRE_CATALOG_ID)).toBeNull();
    expect(await SreRuntimeModel.findServerIds(SRE_CATALOG_ID)).toEqual([
      server.id,
    ]);
  });

  test("creates the agent only once every SRE tool is discovered, with exactly those tools", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId, adminId } = await seedAdmin({
      makeOrganization,
      makeUser,
      makeMember,
    });
    await sreAgentService.seed();
    const [server] = await McpServerModel.findByCatalogId(SRE_CATALOG_ID);
    const ensure = () =>
      sreAgentService.ensureAgent({
        organizationId,
        authorId: adminId,
        mcpServerId: server.id,
      });

    await discoverTools(SRE_AGENT_TOOL_NAMES.slice(1));
    await ensure();
    expect(await SreRuntimeModel.findAgent(SRE_AGENT_ID)).toBeNull();

    const tools = await discoverTools([
      ...SRE_AGENT_TOOL_NAMES,
      "configuration_view",
      "nodes_top",
    ]);
    await ensure();
    await ensure();

    const agent = await AgentModel.findById(SRE_AGENT_ID);
    expect(agent).toMatchObject({
      organizationId,
      agentType: "agent",
      builtIn: false,
      environmentId: SRE_ENVIRONMENT_ID,
    });
    const required = new Set<string>(SRE_AGENT_TOOL_NAMES);
    const expectedToolIds = tools
      .filter((tool) => tool.rawName && required.has(tool.rawName))
      .map((tool) => tool.id)
      .sort();
    expect(
      (await AgentToolModel.findToolIdsByAgent(SRE_AGENT_ID)).sort(),
    ).toEqual(expectedToolIds);
  });

  test("only admins can reach the agent, its catalog item, and its environment", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId, adminId } = await seedAdmin({
      makeOrganization,
      makeUser,
      makeMember,
    });
    const otherAdmin = await makeUser();
    await makeMember(otherAdmin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: MEMBER_ROLE_NAME });
    await sreAgentService.seed();
    const [server] = await McpServerModel.findByCatalogId(SRE_CATALOG_ID);
    await discoverTools(SRE_AGENT_TOOL_NAMES);
    await sreAgentService.ensureAgent({
      organizationId,
      authorId: adminId,
      mcpServerId: server.id,
    });

    const canUse = async (userId: string) => ({
      agent: await AgentTeamModel.userHasAgentAccess({
        userId,
        agentId: SRE_AGENT_ID,
        isAgentAdmin: false,
        action: "use",
      }),
      catalog: await ResourcePermissions.allows({
        userId,
        organizationId,
        resource: "mcpRegistry",
        scope: SRE_CATALOG_ID,
        action: "use",
      }),
      environment: await ResourcePermissions.allows({
        userId,
        organizationId,
        resource: "environment",
        scope: SRE_ENVIRONMENT_ID,
        action: "use",
      }),
    });

    expect(await canUse(otherAdmin.id)).toEqual({
      agent: true,
      catalog: true,
      environment: true,
    });
    expect(await canUse(member.id)).toEqual({
      agent: false,
      catalog: false,
      environment: false,
    });
  });

  test("version 1 of the agent already has its tools", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId, adminId } = await seedAdmin({
      makeOrganization,
      makeUser,
      makeMember,
    });
    await sreAgentService.seed();
    const [server] = await McpServerModel.findByCatalogId(SRE_CATALOG_ID);
    await discoverTools(SRE_AGENT_TOOL_NAMES);

    await sreAgentService.ensureAgent({
      organizationId,
      authorId: adminId,
      mcpServerId: server.id,
    });

    const version = await AgentVersionModel.findByAgentAndVersion({
      agentId: SRE_AGENT_ID,
      version: 1,
      organizationId,
    });
    expect(version?.snapshot.tools).toHaveLength(SRE_AGENT_TOOL_NAMES.length);
  });

  test("an agent an interrupted run left without tools gets them; an admin removing all of them later stays", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId, adminId } = await seedAdmin({
      makeOrganization,
      makeUser,
      makeMember,
    });
    await sreAgentService.seed();
    const [server] = await McpServerModel.findByCatalogId(SRE_CATALOG_ID);
    const tools = await discoverTools(SRE_AGENT_TOOL_NAMES);
    await AgentModel.create(
      {
        id: SRE_AGENT_ID,
        organizationId,
        name: "SRE",
        agentType: "agent",
      },
      adminId,
      { skipCreationDefaultTools: true, deferInitialVersionFork: true },
    );
    const ensure = () =>
      sreAgentService.ensureAgent({
        organizationId,
        authorId: adminId,
        mcpServerId: server.id,
      });

    await ensure();
    expect(await AgentToolModel.findToolIdsByAgent(SRE_AGENT_ID)).toHaveLength(
      SRE_AGENT_TOOL_NAMES.length,
    );

    for (const { id } of tools) {
      await AgentToolModel.delete({ agentId: SRE_AGENT_ID, toolId: id });
    }
    await ensure();
    expect(await AgentToolModel.findToolIdsByAgent(SRE_AGENT_ID)).toEqual([]);
  });

  test("no agent is created for an install uninstalled during discovery", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId, adminId } = await seedAdmin({
      makeOrganization,
      makeUser,
      makeMember,
    });
    await sreAgentService.seed();
    const [server] = await McpServerModel.findByCatalogId(SRE_CATALOG_ID);
    await discoverTools(SRE_AGENT_TOOL_NAMES);
    await McpServerModel.delete(server.id);

    await sreAgentService.ensureAgent({
      organizationId,
      authorId: adminId,
      mcpServerId: server.id,
    });

    expect(await SreRuntimeModel.findAgent(SRE_AGENT_ID)).toBeNull();
  });

  test("a catalog item left without any install by an interrupted run gets one", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    await seedAdmin({ makeOrganization, makeUser, makeMember });
    await sreAgentService.seed();
    const [server] = await McpServerModel.findByCatalogId(SRE_CATALOG_ID);
    await McpServerModel.hardDelete(server.id);

    await sreAgentService.seed();

    const servers = await McpServerModel.findByCatalogId(SRE_CATALOG_ID);
    expect(servers).toHaveLength(1);
    expect(servers[0].id).not.toBe(server.id);
  });

  test("an agent an admin deleted is not created again", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId, adminId } = await seedAdmin({
      makeOrganization,
      makeUser,
      makeMember,
    });
    await sreAgentService.seed();
    const [server] = await McpServerModel.findByCatalogId(SRE_CATALOG_ID);
    await discoverTools(SRE_AGENT_TOOL_NAMES);
    const ensure = () =>
      sreAgentService.ensureAgent({
        organizationId,
        authorId: adminId,
        mcpServerId: server.id,
      });
    await ensure();
    await AgentModel.delete(SRE_AGENT_ID);

    await ensure();

    expect(await AgentModel.findById(SRE_AGENT_ID)).toBeNull();
    expect(
      (await SreRuntimeModel.findAgent(SRE_AGENT_ID))?.deletedAt,
    ).toBeInstanceOf(Date);
  });

  test("turning the feature off removes what it seeded, and turning it on seeds again", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId, adminId } = await seedAdmin({
      makeOrganization,
      makeUser,
      makeMember,
    });
    await sreAgentService.seed();
    const [server] = await McpServerModel.findByCatalogId(SRE_CATALOG_ID);
    await discoverTools(SRE_AGENT_TOOL_NAMES);
    await sreAgentService.ensureAgent({
      organizationId,
      authorId: adminId,
      mcpServerId: server.id,
    });

    config.sreAgent.enabled = false;
    await sreAgentService.seed();

    expect(await SreRuntimeModel.findCatalog(SRE_CATALOG_ID)).toBeNull();
    expect(await SreRuntimeModel.findServerIds(SRE_CATALOG_ID)).toEqual([]);
    expect(await McpServerModel.findById(server.id)).toBeNull();
    expect(await SreRuntimeModel.findAgent(SRE_AGENT_ID)).toBeNull();
    expect(await EnvironmentModel.findById(SRE_ENVIRONMENT_ID)).toBeNull();

    config.sreAgent.enabled = true;
    await sreAgentService.seed();

    expect(
      await InternalMcpCatalogModel.findById(SRE_CATALOG_ID),
    ).not.toBeNull();
    expect(await McpServerModel.findByCatalogId(SRE_CATALOG_ID)).toHaveLength(
      1,
    );
    expect(await EnvironmentModel.findById(SRE_ENVIRONMENT_ID)).not.toBeNull();
  });

  test("with OpenAPPA on, governs the SRE tools with the kubernetes battery when it is bundled", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    config.openappa.enabled = true;
    const { organizationId, adminId } = await seedAdmin({
      makeOrganization,
      makeUser,
      makeMember,
    });
    expect(enterpriseTier.isOpenappaActive()).toBe(true);
    await sreAgentService.seed();
    const [server] = await McpServerModel.findByCatalogId(SRE_CATALOG_ID);
    await discoverTools(SRE_AGENT_TOOL_NAMES);

    await sreAgentService.ensureAgent({
      organizationId,
      authorId: adminId,
      mcpServerId: server.id,
    });

    expect(await AgentModel.findById(SRE_AGENT_ID)).not.toBeNull();
    const bundled = (await openappaDeclarations.bundledBatteries()).some(
      (battery) => battery.name === "kubernetes",
    );
    const battery = (
      await openappaBatteriesService.batteriesForCatalogs({
        organizationId,
        catalogIds: [SRE_CATALOG_ID],
      })
    ).get(SRE_CATALOG_ID);
    if (bundled) {
      expect(battery).toMatchObject({ battery: "kubernetes" });
      expect(battery?.status).not.toBe("available");
    } else {
      expect(battery).toBeUndefined();
    }
  });

  test.for([
    true,
    false,
  ])("with the code runtime on: %s, the agent can read the running version's source", async (sandbox, {
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    config.skillsSandbox.enabled = sandbox;
    const { organizationId, adminId } = await seedAdmin({
      makeOrganization,
      makeUser,
      makeMember,
    });
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    await sreAgentService.seed();
    const [server] = await McpServerModel.findByCatalogId(SRE_CATALOG_ID);
    await discoverTools(SRE_AGENT_TOOL_NAMES);

    await sreAgentService.ensureAgent({
      organizationId,
      authorId: adminId,
      mcpServerId: server.id,
    });

    const assigned = (await ToolModel.getMcpToolsByAgent(SRE_AGENT_ID)).map(
      ({ name }) => name,
    );
    expect(
      assigned.includes(
        archestraMcpBranding.getToolName(TOOL_RUN_COMMAND_SHORT_NAME),
      ),
    ).toBe(sandbox);
    const environment = await EnvironmentModel.findById(SRE_ENVIRONMENT_ID);
    expect(environment?.networkPolicy?.allowedDomains).toEqual(
      sandbox ? SRE_SOURCE_HOSTS : [],
    );
    const agent = await AgentModel.findById(SRE_AGENT_ID);
    const rendered = renderSystemPrompt(agent?.systemPrompt ?? null, {
      user: { name: "", email: "", role: "", teams: [] },
    });
    expect(rendered).not.toContain("{{");
    expect(rendered?.includes(`--branch platform-v${getAppVersion()} `)).toBe(
      sandbox,
    );
  });

  test("does not seed without a service account", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    await seedAdmin({ makeOrganization, makeUser, makeMember });
    config.sreAgent.k8sServiceAccount = undefined;

    await sreAgentService.seed();

    expect(await SreRuntimeModel.findCatalog(SRE_CATALOG_ID)).toBeNull();
    expect(await EnvironmentModel.findById(SRE_ENVIRONMENT_ID)).toBeNull();
  });
});

async function seedAdmin(fixtures: {
  makeOrganization: () => Promise<{ id: string }>;
  makeUser: () => Promise<{ id: string }>;
  makeMember: (
    userId: string,
    organizationId: string,
    overrides: { role: string },
  ) => Promise<unknown>;
}): Promise<{ organizationId: string; adminId: string }> {
  const organization = await fixtures.makeOrganization();
  const admin = await fixtures.makeUser();
  await fixtures.makeMember(admin.id, organization.id, {
    role: ADMIN_ROLE_NAME,
  });
  return { organizationId: organization.id, adminId: admin.id };
}

/** The rows tool discovery writes for the server's advertised tools. */
async function discoverTools(rawNames: readonly string[]) {
  return ToolModel.bulkCreateToolsIfNotExists(
    rawNames.map((rawName) => ({
      name: ToolModel.slugifyName(SRE_SERVER_NAME, rawName),
      rawToolName: rawName,
      description: null,
      parameters: { type: "object", properties: {} },
      catalogId: SRE_CATALOG_ID,
    })),
  );
}
