import {
  ADMIN_ROLE_NAME,
  type ResourcePermissionGrant,
  SANDBOX_RUNTIME_ARCHESTRA_TOOL_SHORT_NAMES,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import config from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import mcpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";
import logger from "@/logging";
import {
  AgentModel,
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
import { deleteEnvironment } from "@/services/environments/environment";
import { reloadToolsForServer } from "@/services/mcp-reinstall";
import type { NetworkPolicy } from "@/types";
import {
  SRE_AGENT_ID,
  SRE_AGENT_NAME,
  SRE_AGENT_TOOL_NAMES,
  SRE_CATALOG_ID,
  SRE_ENVIRONMENT_ID,
  SRE_ENVIRONMENT_NAME,
  SRE_OPENAPPA_BATTERY,
  SRE_SERVER_NAME,
  sreAgentSystemPrompt,
  sreLocalConfig,
} from "./definition";

// === Public API ===

/**
 * The opt-in SRE agent: a read-only Kubernetes MCP server in its own "SRE"
 * environment, whose egress allows only the configured API server CIDRs, plus
 * an org-wide agent that uses its tools.
 *
 * Seeded once. While the feature is on, a catalog item, install, or agent an
 * admin deleted stays deleted (the soft-deleted row is the marker). Turning
 * the feature off purges everything it seeded, so turning it on again seeds
 * from scratch.
 */
class SreAgentService {
  /**
   * Runs at startup before the MCP runtime starts, so the runtime deploys the
   * install with the current image and service account.
   */
  async seed(): Promise<void> {
    try {
      if (!config.sreAgent.enabled) {
        await this.teardown();
        return;
      }
      const serviceAccount = config.sreAgent.k8sServiceAccount;
      if (!serviceAccount) {
        logger.error(
          "The SRE agent needs ARCHESTRA_SRE_K8S_SERVICE_ACCOUNT; not seeding it",
        );
        return;
      }
      await this.seedResources(serviceAccount);
    } catch (error) {
      logger.error({ err: error }, "Failed to seed the SRE agent");
    }
  }

  /**
   * Runs after the MCP runtime started its deployments: waits for the
   * install, discovers its tools, and creates the agent once they exist.
   * Anything missing is retried on the next start.
   */
  async finalize(): Promise<void> {
    if (!config.sreAgent.enabled) return;
    const catalog = await SreRuntimeModel.findCatalog(SRE_CATALOG_ID);
    if (!catalog || catalog.deletedAt || !catalog.organizationId) return;
    const [server] = await McpServerModel.findByCatalogId(SRE_CATALOG_ID);
    if (!server) return;

    try {
      const deployment = await mcpServerRuntimeManager.getOrLoadDeployment(
        server.id,
      );
      if (!deployment) {
        throw new Error("The SRE MCP server deployment is unavailable");
      }
      await deployment.waitForDeploymentReady(60, 2000);
      await McpServerModel.update(server.id, {
        localInstallationStatus: "discovering-tools",
        localInstallationError: null,
      });
      await reloadToolsForServer(server);
      await McpServerModel.update(server.id, {
        localInstallationStatus: "success",
        localInstallationError: null,
      });
      await openappaBatteriesService.onCatalogToolsChanged(SRE_CATALOG_ID);
    } catch (error) {
      await McpServerModel.update(server.id, {
        localInstallationStatus: "error",
        localInstallationError:
          error instanceof Error ? error.message : String(error),
      });
      logger.error(
        { err: error, serverId: server.id },
        "SRE MCP server did not start; retrying on next start",
      );
      return;
    }

    await this.ensureAgent({
      organizationId: catalog.organizationId,
      authorId: catalog.authorId,
      mcpServerId: server.id,
    });
  }

  /**
   * Creates the agent with exactly the SRE tools, plus the sandbox tools when
   * the code runtime is on, only when every one of them exists and setup never
   * completed. Setup completes when version 1 is forked, after the tools are
   * assigned, so an agent without a version was left by an interrupted run and
   * gets its tools now.
   */
  async ensureAgent(params: {
    organizationId: string;
    authorId: string | null;
    mcpServerId: string;
  }): Promise<void> {
    const existing = await SreRuntimeModel.findAgent(SRE_AGENT_ID);
    if (existing && (existing.deletedAt || existing.latestVersion > 0)) return;

    const tools = await SreRuntimeModel.findToolsByRawName({
      catalogId: SRE_CATALOG_ID,
      rawNames: SRE_AGENT_TOOL_NAMES,
    });
    const found = new Set(tools.map(({ rawName }) => rawName));
    const missing = SRE_AGENT_TOOL_NAMES.filter((name) => !found.has(name));
    if (missing.length > 0) {
      logger.warn(
        { missing },
        "SRE MCP server is missing required tools; not creating the SRE agent, retrying on next start",
      );
      return;
    }

    const sandbox = config.skillsSandbox.enabled;
    const sandboxToolNames = sandbox
      ? SANDBOX_RUNTIME_ARCHESTRA_TOOL_SHORT_NAMES.map((shortName) =>
          archestraMcpBranding.getToolName(shortName),
        )
      : [];
    const sandboxToolIds =
      await ToolModel.findBuiltInToolIdsByNames(sandboxToolNames);
    if (sandboxToolIds.length < sandboxToolNames.length) {
      logger.warn(
        { sandboxToolNames },
        "Sandbox tools are not seeded yet; not creating the SRE agent, retrying on next start",
      );
      return;
    }
    const toolIds = tools.map(({ id }) => id);
    // An admin may have uninstalled the server while discovery ran.
    if (!(await this.isInstallLive(params.mcpServerId))) return;

    if (!existing) {
      await AgentModel.create(
        {
          id: SRE_AGENT_ID,
          organizationId: params.organizationId,
          name: SRE_AGENT_NAME,
          agentType: "agent",
          description:
            "Investigates this installation's pods, logs, and events in Kubernetes, read-only.",
          systemPrompt: sreAgentSystemPrompt({
            appName: archestraMcpBranding.appName,
            namespace: config.orchestrator.kubernetes.namespace,
            sandbox,
          }),
          environmentId: SRE_ENVIRONMENT_ID,
        },
        params.authorId ?? undefined,
        {
          initialPermissionGrants: SRE_ADMIN_GRANTS,
          skipCreationDefaultTools: true,
          deferInitialVersionFork: true,
        },
      );
    }
    await AgentToolModel.bulkCreateForAgentsAndTools([SRE_AGENT_ID], toolIds, {
      mcpServerId: params.mcpServerId,
    });
    await AgentToolModel.createManyIfNotExists(SRE_AGENT_ID, sandboxToolIds);
    await AgentVersionModel.forkIfChangedBestEffort(SRE_AGENT_ID);
    logger.info({ agentId: SRE_AGENT_ID }, "Set up the SRE agent");
    if (params.authorId) {
      await this.bindOpenappaBattery({
        organizationId: params.organizationId,
        userId: params.authorId,
      });
    }
  }

  /** Purges everything the feature seeded. A no-op when nothing was. */
  async teardown(): Promise<void> {
    const [catalog, agent, environment] = await Promise.all([
      SreRuntimeModel.findCatalog(SRE_CATALOG_ID),
      SreRuntimeModel.findAgent(SRE_AGENT_ID),
      EnvironmentModel.findById(SRE_ENVIRONMENT_ID),
    ]);
    if (!catalog && !agent && !environment) return;

    if (agent) await AgentModel.hardDelete(agent.id);
    if (catalog) {
      // The soft delete tears down the K8s deployment of each live install.
      await InternalMcpCatalogModel.delete(catalog.id);
      for (const serverId of await SreRuntimeModel.findServerIds(catalog.id)) {
        await McpServerModel.hardDelete(serverId);
      }
      await InternalMcpCatalogModel.hardDelete(catalog.id);
    }
    if (environment) {
      await deleteEnvironment({
        id: environment.id,
        organizationId: environment.organizationId,
      });
    }
    logger.info("Removed the SRE agent and its MCP server");
  }

  // === Internal helpers ===

  private async createInstall(ownerId: string | null): Promise<void> {
    await McpServerModel.create({
      name: SRE_SERVER_NAME,
      catalogId: SRE_CATALOG_ID,
      serverType: "local",
      scope: "org",
      ownerId,
      teamId: null,
    });
  }

  private async isInstallLive(mcpServerId: string): Promise<boolean> {
    const [catalog, server] = await Promise.all([
      SreRuntimeModel.findCatalog(SRE_CATALOG_ID),
      McpServerModel.findById(mcpServerId),
    ]);
    return (
      !!catalog && !catalog.deletedAt && server?.catalogId === SRE_CATALOG_ID
    );
  }

  /**
   * Governs the SRE tools with the OpenAPPA kubernetes battery when it is
   * available. Runs once, with the agent's creation, so an admin who removes
   * the install keeps it removed.
   */
  private async bindOpenappaBattery(params: {
    organizationId: string;
    userId: string;
  }): Promise<void> {
    if (!enterpriseTier.isOpenappaActive()) return;
    const { organizationId, userId } = params;
    try {
      const match = (
        await openappaBatteriesService.batteriesForCatalogs({
          organizationId,
          catalogIds: [SRE_CATALOG_ID],
        })
      ).get(SRE_CATALOG_ID);
      if (match?.battery !== SRE_OPENAPPA_BATTERY) {
        logger.info(
          "The OpenAPPA kubernetes battery is not available; leaving the SRE MCP server ungoverned by it",
        );
        return;
      }
      if (match.status !== "available") return;
      await openappaBatteriesService.createInstall({
        userId,
        organizationId,
        install: {
          batteryName: SRE_OPENAPPA_BATTERY,
          catalogId: SRE_CATALOG_ID,
          packageHash: null,
        },
      });
    } catch (error) {
      logger.error(
        { err: error },
        "Failed to install the OpenAPPA kubernetes battery for the SRE MCP server",
      );
    }
  }

  private async seedResources(serviceAccount: string): Promise<void> {
    const catalog = await SreRuntimeModel.findCatalog(SRE_CATALOG_ID);
    if (catalog?.deletedAt) return;

    if (config.sreAgent.apiServerCidrs.length === 0) {
      logger.warn(
        "ARCHESTRA_SRE_APISERVER_CIDRS is empty; the SRE MCP server can reach the Kubernetes API only where egress is not enforced",
      );
    }
    const localConfig = sreLocalConfig(serviceAccount);

    if (catalog) {
      const organizationId = catalog.organizationId ?? "";
      await EnvironmentModel.update({
        id: SRE_ENVIRONMENT_ID,
        organizationId,
        networkPolicy: await sreNetworkPolicy(organizationId),
      });
      await InternalMcpCatalogModel.update(catalog.id, { localConfig });
      // No install row at all, not even an uninstalled one: an earlier run
      // stopped between the catalog item and its install.
      if ((await SreRuntimeModel.findServerIds(catalog.id)).length === 0) {
        await this.createInstall(catalog.authorId);
      }
      return;
    }

    const organization =
      await OrganizationModel.getOrCreateDefaultOrganization();
    const adminUserId = await SreRuntimeModel.findEarliestAdminUserId(
      organization.id,
    );
    if (!adminUserId) return;

    if (!(await EnvironmentModel.findById(SRE_ENVIRONMENT_ID))) {
      await EnvironmentModel.create({
        id: SRE_ENVIRONMENT_ID,
        organizationId: organization.id,
        name: SRE_ENVIRONMENT_NAME,
        description: "Runs the SRE agent's read-only Kubernetes MCP server.",
        networkPolicy: await sreNetworkPolicy(organization.id),
        authorId: adminUserId,
        initialPermissionGrants: SRE_ADMIN_GRANTS,
      });
    }
    await InternalMcpCatalogModel.create(
      {
        id: SRE_CATALOG_ID,
        name: SRE_SERVER_NAME,
        description:
          "Read-only Kubernetes access to this installation's namespace, for the SRE agent.",
        serverType: "local",
        requiresAuth: false,
        localConfig,
        environmentId: SRE_ENVIRONMENT_ID,
      },
      {
        organizationId: organization.id,
        authorId: adminUserId,
        initialPermissionGrants: SRE_ADMIN_GRANTS,
      },
    );
    await this.createInstall(adminUserId);
    logger.info(
      { organizationId: organization.id },
      "Seeded the SRE MCP server",
    );
  }
}

export const sreAgentService = new SreAgentService();

/**
 * The SRE tools can read other installs' pod specs, whose arguments may carry
 * resolved credentials, so the agent, its catalog item, and its environment
 * are shared with Admins only. Seeing the agent and calling the tools also
 * take `sre:read`.
 */
const SRE_ADMIN_GRANTS: ResourcePermissionGrant[] = [
  { subject: { type: "role", id: ADMIN_ROLE_NAME }, actions: ["read", "use"] },
];

/**
 * The organization's default egress (or the built-in public-internet floor)
 * plus the API server, which the floor's private-range block would otherwise
 * cut off. Without API server CIDRs the environment simply inherits the default.
 */
async function sreNetworkPolicy(
  organizationId: string,
): Promise<NetworkPolicy | null> {
  const apiServerCidrs = config.sreAgent.apiServerCidrs;
  if (apiServerCidrs.length === 0) return null;
  const base: NetworkPolicy = (await OrganizationModel.getDefaultNetworkPolicy(
    organizationId,
  )) ?? {
    egressMode: "unrestricted",
    domainPreset: "none",
    allowedDomains: [],
    allowedCidrs: [],
  };
  if (base.egressMode === "off") {
    logger.warn(
      "The organization's default egress is off; the SRE MCP server cannot reach the Kubernetes API",
    );
    return base;
  }
  return {
    ...base,
    allowedCidrs: [...new Set([...base.allowedCidrs, ...apiServerCidrs])],
  };
}
