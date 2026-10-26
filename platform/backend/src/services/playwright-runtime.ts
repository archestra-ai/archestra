import mcpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";
import logger from "@/logging";
import { McpServerModel, PlaywrightRuntimeModel } from "@/models";
import McpDeploymentLeaseModel from "@/models/mcp-deployment-lease";
import OrganizationModel from "@/models/organization";
import { reloadToolsForServer } from "@/services/mcp-reinstall";
import { ApiError, type Organization } from "@/types";

/**
 * Complete startup of the managed browser runtime after the generic MCP
 * runtime has started its deployments. Tool discovery uses the Default
 * runtime because every Environment exposes the same Playwright tool schema.
 */
export async function initializeManagedPlaywrightRuntime(): Promise<void> {
  if (!(await PlaywrightRuntimeModel.isEnabled())) {
    await reconcileManagedPlaywrightSetting();
    return;
  }
  const server = await PlaywrightRuntimeModel.findForEnvironment(null);
  if (!server) return;

  try {
    const deployment = await mcpServerRuntimeManager.getOrLoadDeployment(
      server.id,
    );
    if (!deployment) {
      throw new Error("Managed Playwright deployment is unavailable");
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await McpServerModel.update(server.id, {
      localInstallationStatus: "error",
      localInstallationError: message,
    });
    logger.error(
      { err: error, serverId: server.id },
      "Managed Playwright runtime initialization failed",
    );
    return;
  }

  await PlaywrightRuntimeModel.retireLegacyInstallations();
}

/** Serialize setting transitions and startup cleanup across replicas. A failed
 * cleanup leaves the policy disabled and the install active for a safe retry. */
export async function reconcileManagedPlaywrightSetting(params?: {
  organizationId: string;
  settings: Partial<Organization>;
}): Promise<Organization | null> {
  return McpDeploymentLeaseModel.withLeaseWhenAvailable(
    {
      scope: "managed-playwright-policy",
      key: "deployment",
      timeoutMs: 120_000,
    },
    async (lease) => {
      const organization = params
        ? await lease.runFencedMutation((tx) =>
            OrganizationModel.patchInTransaction({
              id: params.organizationId,
              data: params.settings,
              tx,
            }),
          )
        : await OrganizationModel.getFirst();
      if (params)
        await OrganizationModel.invalidateSettingsCaches(params.organizationId);
      if (params && !organization)
        throw new ApiError(404, "Organization not found");
      if (await PlaywrightRuntimeModel.isEnabled()) {
        if (params) {
          const servers = await PlaywrightRuntimeModel.reconcileAll();
          for (const server of servers) {
            await lease.assertOwned();
            await mcpServerRuntimeManager.startServer(server);
          }
          await initializeManagedPlaywrightRuntime();
        }
      } else {
        const failures: unknown[] = [];
        for (const server of await PlaywrightRuntimeModel.findAllInstallations()) {
          await lease.assertOwned();
          try {
            const { default: mcpClient } = await import("@/clients/mcp-client");
            await mcpClient.invalidateConnectionsForServer(server.id);
            await McpServerModel.delete(server.id, {
              strictCleanup: true,
              requirePlaywrightDisabled: true,
            });
          } catch (error) {
            failures.push(error);
            logger.error(
              { err: error, serverId: server.id },
              "Managed browser cleanup will be retried",
            );
          }
        }
        if (failures.length)
          throw new ApiError(
            503,
            "Browser access is disabled, but runtime cleanup is incomplete. Retry saving to finish cleanup.",
          );
      }
      return organization;
    },
  );
}
