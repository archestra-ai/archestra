import mcpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";
import logger from "@/logging";
import { McpServerModel, PlaywrightRuntimeModel } from "@/models";
import { reloadToolsForServer } from "@/services/mcp-reinstall";

/**
 * Complete startup of the managed browser runtime after the generic MCP
 * runtime has started its deployments. Tool discovery uses the Default
 * runtime because every Environment exposes the same Playwright tool schema.
 */
export async function initializeManagedPlaywrightRuntime(): Promise<void> {
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
