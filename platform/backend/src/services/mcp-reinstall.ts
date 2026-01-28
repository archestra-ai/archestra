import logger from "@/logging";
import { McpServerRuntimeManager } from "@/mcp-server-runtime";
import { McpServerModel, ToolModel } from "@/models";
import type { InternalMcpCatalog, McpServer } from "@/types";

/**
 * Checks if a catalog edit requires new user input for reinstallation.
 *
 * Returns true (manual reinstall required) when:
 * - ANY env var with promptOnInstallation=true exists (local servers)
 * - ANY required userConfig field exists (remote servers)
 * - OAuth config exists (remote servers)
 *
 * Returns false (auto-reinstall possible) when:
 * - No prompted env vars exist (local servers)
 * - No required userConfig fields or OAuth (remote servers)
 *
 * Note: We don't try to recover secrets from the secret manager because
 * that's unreliable across different backends (DB, Vault, BYOS Vault).
 * Instead, we require the user to re-enter values via the install dialog.
 */
export function requiresNewUserInputForReinstall(
  _oldCatalogItem: InternalMcpCatalog,
  newCatalogItem: InternalMcpCatalog,
): boolean {
  // Local servers: check if ANY prompted env vars exist
  if (newCatalogItem.serverType === "local") {
    const hasPromptedEnvVars = (
      newCatalogItem.localConfig?.environment || []
    ).some((env) => env.promptOnInstallation);

    if (hasPromptedEnvVars) {
      logger.info(
        { catalogId: newCatalogItem.id },
        "Catalog has prompted env vars - manual reinstall required",
      );
      return true;
    }

    return false;
  }

  // Remote servers: check for OAuth or required userConfig
  if (newCatalogItem.serverType === "remote") {
    // OAuth requires user auth flow
    if (newCatalogItem.oauthConfig) {
      logger.info(
        { catalogId: newCatalogItem.id },
        "Catalog has OAuth config - manual reinstall required",
      );
      return true;
    }

    // Check for any required userConfig fields
    const hasRequiredUserConfig = Object.values(
      newCatalogItem.userConfig || {},
    ).some((field) => field.required);

    if (hasRequiredUserConfig) {
      logger.info(
        { catalogId: newCatalogItem.id },
        "Catalog has required userConfig fields - manual reinstall required",
      );
      return true;
    }

    return false;
  }

  // Builtin servers don't need reinstall
  return false;
}

/**
 * Auto-reinstall an MCP server without requiring user input.
 * Used when catalog is edited but no new user-prompted values are needed.
 *
 * For local servers: restarts K8s deployment and syncs tools
 * For remote servers: just re-fetches and syncs tools
 */
export async function autoReinstallServer(
  server: McpServer,
  catalogItem: InternalMcpCatalog,
): Promise<void> {
  logger.info(
    { serverId: server.id, serverName: server.name },
    "Starting auto-reinstall of MCP server",
  );

  // For local servers: restart K8s deployment
  if (catalogItem.serverType === "local") {
    await McpServerRuntimeManager.restartServer(server.id);

    // Wait for deployment to be ready
    const deployment = await McpServerRuntimeManager.getOrLoadDeployment(
      server.id,
    );
    if (deployment) {
      await deployment.waitForDeploymentReady(60, 2000); // 60 attempts * 2s = 2 minutes max
    }
  }

  // Fetch and sync tools
  const tools = await McpServerModel.getToolsFromServer(server);

  // Use catalog item name for tool naming (consistent with install flow)
  const toolNamePrefix = catalogItem.name;
  const toolsToSync = tools.map((tool) => ({
    name: ToolModel.slugifyName(toolNamePrefix, tool.name),
    description: tool.description,
    parameters: tool.inputSchema,
    catalogId: catalogItem.id,
    mcpServerId: server.id,
    // Pass the raw tool name from MCP server for accurate matching
    // This handles cases where catalog name contains `__` (e.g., huggingface__remote-mcp)
    rawToolName: tool.name,
  }));

  const syncResult = await ToolModel.syncToolsForCatalog(toolsToSync);

  logger.info(
    {
      serverId: server.id,
      serverName: server.name,
      created: syncResult.created.length,
      updated: syncResult.updated.length,
      unchanged: syncResult.unchanged.length,
      deleted: syncResult.deleted.length,
    },
    "Auto-reinstall completed - tools synced",
  );

  // Clear reinstall flag
  await McpServerModel.update(server.id, { reinstallRequired: false });
}
