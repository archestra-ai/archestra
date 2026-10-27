import {
  ADMIN_ROLE_NAME,
  MEMBER_ROLE_NAME,
  PLATFORM_ADMIN_ROLE_NAME,
  TOOL_RUN_COMMAND_SHORT_NAME,
} from "@archestra/shared";
import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared/archestra-mcp-server";
import type * as k8s from "@kubernetes/client-node";
import { eq } from "drizzle-orm";
import { beforeEach } from "vitest";
import { getAppVersion } from "@/app-version";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { serviceAccountUserId } from "@/auth/service-account-user-id";
import mcpClient, { type TokenAuthContext } from "@/clients/mcp-client";
import config from "@/config";
import db, { schema } from "@/database";
import { enterpriseTier } from "@/enterprise-tier";
import { buildDaggerEgressPolicies } from "@/k8s/dagger-environment-runtime/network-policy";
import {
  AgentModel,
  AgentTeamModel,
  AgentToolModel,
  AgentVersionModel,
  EnvironmentModel,
  InternalMcpCatalogModel,
  McpServerModel,
  OrganizationModel,
  SreRuntimeModel,
  ToolModel,
} from "@/models";
import { openappaBatteriesService } from "@/openappa/batteries";
import { openappaDeclarations } from "@/openappa/declarations";
import { assignToolToAgent } from "@/services/agent-tool-assignment";
import { filterToolsByCallerCatalogAccess } from "@/services/caller-catalog-access";
import { ResourcePermissions } from "@/services/resource-permissions";
import { renderSystemPrompt } from "@/templating";
import { describe, expect, test } from "@/test";
import {
  discoverTools,
  enableSre,
  SRE_SERVICE_ACCOUNT,
  seedAdmin,
  seedSreAgent,
  seedSreInstall,
} from "@/test/sre-agent";
import { agentOwner } from "@/types";
import {
  SRE_AGENT_ID,
  SRE_AGENT_TOOL_NAMES,
  SRE_CATALOG_ID,
  SRE_ENVIRONMENT_ID,
  SRE_SERVER_NAME,
} from "./definition";
import { sreAgentService } from "./index";

describe("sreAgentService", () => {
  beforeEach(() => enableSre(["10.0.0.1/32"]));

  test("seeds one environment, catalog item, and org-wide install, idempotently", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId, admin } = await seedSreInstall({
      makeOrganization,
      makeUser,
      makeMember,
    });
    await sreAgentService.seed();

    const environment = await EnvironmentModel.findById(SRE_ENVIRONMENT_ID);
    expect(environment).toMatchObject({
      organizationId,
      namespace: null,
      networkPolicy: {
        egressMode: "unrestricted",
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
        serviceAccount: SRE_SERVICE_ACCOUNT,
        transportType: "streamable-http",
      },
    });
    const servers = await McpServerModel.findByCatalogId(SRE_CATALOG_ID);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ scope: "org", ownerId: admin.id });
  });

  test("the environment gets the built-in public-internet floor plus only the API server", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    await seedSreInstall({ makeOrganization, makeUser, makeMember });
    const environment = await EnvironmentModel.findById(SRE_ENVIRONMENT_ID);

    const [policy] = buildDaggerEgressPolicies({
      environmentId: SRE_ENVIRONMENT_ID,
      effectivePolicy: {
        source: "environment",
        policy: environment?.networkPolicy ?? null,
      },
    });
    const [builtIn] = buildDaggerEgressPolicies({
      environmentId: SRE_ENVIRONMENT_ID,
      effectivePolicy: { source: "built_in", policy: null },
    });

    const egress = (object: typeof policy) =>
      (object.object as k8s.V1NetworkPolicy).spec?.egress ?? [];
    expect(egress(policy)).toEqual([
      ...egress(builtIn),
      { to: [{ ipBlock: { cidr: "10.0.0.1/32" } }] },
    ]);
  });

  test("the environment keeps the organization's default egress and adds the API server", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId } = await seedAdmin({
      makeOrganization,
      makeUser,
      makeMember,
    });
    const defaultPolicy = {
      egressMode: "restricted" as const,
      domainPreset: "package_managers" as const,
      allowedDomains: ["registry.npmjs.org"],
      allowedCidrs: ["203.0.113.0/24"],
    };
    await OrganizationModel.patch(organizationId, {
      defaultNetworkPolicy: defaultPolicy,
    });

    await sreAgentService.seed();

    expect(
      (await EnvironmentModel.findById(SRE_ENVIRONMENT_ID))?.networkPolicy,
    ).toEqual({
      ...defaultPolicy,
      allowedCidrs: ["203.0.113.0/24", "10.0.0.1/32"],
    });
  });

  test("re-applies the configured egress and service account on the next start", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    await seedSreInstall({ makeOrganization, makeUser, makeMember });

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
    const { server } = await seedSreInstall({
      makeOrganization,
      makeUser,
      makeMember,
    });
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
    const { organizationId, ensureAgent: ensure } = await seedSreInstall({
      makeOrganization,
      makeUser,
      makeMember,
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
    const { organizationId } = await seedSreAgent({
      makeOrganization,
      makeUser,
      makeMember,
    });
    const otherAdmin = await makeUser();
    await makeMember(otherAdmin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: MEMBER_ROLE_NAME });

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

  test("a member who assigns a Kubernetes tool to their own agent can neither list nor call it", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { organizationId, admin, server } = await seedSreInstall({
      makeOrganization,
      makeUser,
      makeMember,
    });
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: MEMBER_ROLE_NAME });
    const [podsLog] = await discoverTools(["pods_log"]);
    // Outside the SRE environment, environment isolation already hides the
    // tool; inside it, the catalog item's admin-only grants still do.
    const ownAgent = await makeAgent({ organizationId, authorId: member.id });
    const sreEnvAgent = await makeAgent({
      organizationId,
      authorId: member.id,
      environmentId: SRE_ENVIRONMENT_ID,
    });
    for (const agent of [ownAgent, sreEnvAgent]) {
      expect(
        await assignToolToAgent({
          agentId: agent.id,
          toolId: podsLog.id,
          mcpServerId: server.id,
        }),
      ).toBeNull();
    }

    const listedFor = async (agentId: string, userId: string) =>
      (
        await filterToolsByCallerCatalogAccess(
          await ToolModel.getMcpToolsByAgent(agentId),
          { userId, organizationId },
        )
      ).map(({ id }) => id);
    expect(await listedFor(ownAgent.id, member.id)).toEqual([]);
    expect(await listedFor(sreEnvAgent.id, member.id)).toEqual([]);
    expect(await listedFor(sreEnvAgent.id, admin.id)).toEqual([podsLog.id]);

    for (const agent of [ownAgent, sreEnvAgent]) {
      const result = await mcpClient.executeToolCallForOwner(
        { id: "call_pods_log", name: podsLog.name, arguments: {} },
        agentOwner(agent.id),
        {
          tokenId: "member-session",
          teamId: null,
          isOrganizationToken: false,
          organizationId,
          userId: member.id,
        },
      );
      expect(result).toMatchObject({
        isError: true,
        _meta: { archestraError: { code: "unknown_tool" } },
      });
    }
  });

  test.for([
    { caller: "platform admin", canUseSre: false },
    { caller: "service account", canUseSre: false },
    { caller: "custom role with sre:read", canUseSre: true },
    { caller: "admin", canUseSre: true },
  ] as const)("the Kubernetes tools take sre:read: $caller", async ({
    caller,
    canUseSre,
  }, {
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeCustomRole,
    makeServiceAccount,
  }) => {
    const { organizationId, admin, server } = await seedSreInstall({
      makeOrganization,
      makeUser,
      makeMember,
    });
    const [podsLog] = await discoverTools(["pods_log"]);
    const agent = await makeAgent({
      organizationId,
      authorId: admin.id,
      environmentId: SRE_ENVIRONMENT_ID,
    });
    await AgentToolModel.create(agent.id, podsLog.id, {
      mcpServerId: server.id,
    });

    const callerAuth = async (): Promise<{
      userId: string;
      tokenAuth: TokenAuthContext;
    }> => {
      const base = {
        tokenId: "caller",
        teamId: null,
        isOrganizationToken: false,
        organizationId,
      };
      switch (caller) {
        case "admin":
          return {
            userId: admin.id,
            tokenAuth: { ...base, userId: admin.id },
          };
        case "service account": {
          const account = await makeServiceAccount(organizationId);
          return {
            userId: serviceAccountUserId(account.id),
            tokenAuth: { ...base, serviceAccountId: account.id },
          };
        }
        case "platform admin":
        case "custom role with sre:read": {
          const user = await makeUser();
          const role =
            caller === "platform admin"
              ? PLATFORM_ADMIN_ROLE_NAME
              : (
                  await makeCustomRole(organizationId, {
                    permission: { sre: ["read"] },
                  })
                ).role;
          await makeMember(user.id, organizationId, { role });
          return { userId: user.id, tokenAuth: { ...base, userId: user.id } };
        }
      }
    };
    const { userId, tokenAuth } = await callerAuth();

    const listed = await filterToolsByCallerCatalogAccess(
      await ToolModel.getMcpToolsByAgent(agent.id),
      { userId, organizationId },
    );
    expect(listed.map(({ id }) => id)).toEqual(canUseSre ? [podsLog.id] : []);
    const result = await mcpClient.executeToolCallForOwner(
      { id: "call_pods_log", name: podsLog.name, arguments: {} },
      agentOwner(agent.id),
      tokenAuth,
    );
    // With sre:read the call is dispatched and fails only because the test
    // runs no server; without it the catalog gate refuses it after validation
    // resolved the tool, which logs the call under the server's name.
    expect(result._meta?.archestraError).toMatchObject(
      canUseSre ? { type: "generic" } : { code: "unknown_tool" },
    );
    const [logged] = await db
      .select({ mcpServerName: schema.mcpToolCallsTable.mcpServerName })
      .from(schema.mcpToolCallsTable)
      .where(eq(schema.mcpToolCallsTable.agentId, agent.id));
    expect(logged.mcpServerName).toBe(SRE_SERVER_NAME);
  });

  test("version 1 of the agent already has its tools", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId } = await seedSreAgent({
      makeOrganization,
      makeUser,
      makeMember,
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
    const {
      organizationId,
      admin,
      ensureAgent: ensure,
    } = await seedSreInstall({
      makeOrganization,
      makeUser,
      makeMember,
    });
    const tools = await discoverTools(SRE_AGENT_TOOL_NAMES);
    await AgentModel.create(
      {
        id: SRE_AGENT_ID,
        organizationId,
        name: "SRE",
        agentType: "agent",
      },
      admin.id,
      { skipCreationDefaultTools: true, deferInitialVersionFork: true },
    );

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
    const { server, ensureAgent } = await seedSreInstall({
      makeOrganization,
      makeUser,
      makeMember,
    });
    await discoverTools(SRE_AGENT_TOOL_NAMES);
    await McpServerModel.delete(server.id);

    await ensureAgent();

    expect(await SreRuntimeModel.findAgent(SRE_AGENT_ID)).toBeNull();
  });

  test("a catalog item left without any install by an interrupted run gets one", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { server } = await seedSreInstall({
      makeOrganization,
      makeUser,
      makeMember,
    });
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
    const { ensureAgent } = await seedSreAgent({
      makeOrganization,
      makeUser,
      makeMember,
    });
    await AgentModel.delete(SRE_AGENT_ID);

    await ensureAgent();

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
    const { server } = await seedSreAgent({
      makeOrganization,
      makeUser,
      makeMember,
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
    const { organizationId } = await seedSreAgent({
      makeOrganization,
      makeUser,
      makeMember,
    });
    expect(enterpriseTier.isOpenappaActive()).toBe(true);

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
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    await seedSreAgent({ makeOrganization, makeUser, makeMember });

    const assigned = (await ToolModel.getMcpToolsByAgent(SRE_AGENT_ID)).map(
      ({ name }) => name,
    );
    expect(
      assigned.includes(
        archestraMcpBranding.getToolName(TOOL_RUN_COMMAND_SHORT_NAME),
      ),
    ).toBe(sandbox);
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
