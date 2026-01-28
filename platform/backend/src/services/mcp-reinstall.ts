import logger from "@/logging";
import { McpServerRuntimeManager } from "@/mcp-server-runtime";
import { McpServerModel, ToolModel } from "@/models";
import type { InternalMcpCatalog, McpServer } from "@/types";

/**
 * Checks if a catalog edit requires new user input for reinstallation.
 *
 * Returns true (manual reinstall required) when:
 * - NEW env var with promptOnInstallation=true was added (local servers)
 * - NEW required userConfig field was added (remote servers)
 * - OAuth config was added (remote servers)
 *
 * Returns false (auto-reinstall possible) when:
 * - Only non-prompted values changed (command, args, docker image, etc.)
 * - All prompted env vars already existed (user already provided values)
 */
export function requiresNewUserInputForReinstall(
  oldCatalogItem: InternalMcpCatalog,
  newCatalogItem: InternalMcpCatalog,
): boolean {
  // Local servers: check if NEW prompted env vars were added
  if (newCatalogItem.serverType === "local") {
    const oldPromptedKeys = new Set(
      (oldCatalogItem.localConfig?.environment || [])
        .filter((env) => env.promptOnInstallation)
        .map((env) => env.key),
    );

    const newPromptedEnvVars = (
      newCatalogItem.localConfig?.environment || []
    ).filter((env) => env.promptOnInstallation);

    // Check if any NEW prompted env var was added (not in old config)
    for (const env of newPromptedEnvVars) {
      if (!oldPromptedKeys.has(env.key)) {
        logger.info(
          { catalogId: newCatalogItem.id, newEnvVar: env.key },
          "New prompted env var added - manual reinstall required",
        );
        return true;
      }
    }

    // All prompted env vars existed before - user already provided values
    return false;
  }

  // Remote servers: check for new required userConfig fields or OAuth
  if (newCatalogItem.serverType === "remote") {
    // If OAuth was just added, requires auth flow
    if (newCatalogItem.oauthConfig && !oldCatalogItem.oauthConfig) {
      logger.info(
        { catalogId: newCatalogItem.id },
        "OAuth config added - manual reinstall required",
      );
      return true;
    }

    // Check for new required userConfig fields
    const oldUserConfigKeys = new Set(
      Object.keys(oldCatalogItem.userConfig || {}),
    );
    const newUserConfig = newCatalogItem.userConfig || {};

    for (const [key, field] of Object.entries(newUserConfig)) {
      if (field.required && !oldUserConfigKeys.has(key)) {
        logger.info(
          { catalogId: newCatalogItem.id, newField: key },
          "New required userConfig field added - manual reinstall required",
        );
        return true;
      }
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
  }));

  const syncResult = await ToolModel.syncToolsForCatalog(toolsToSync);

  logger.info(
    {
      serverId: server.id,
      serverName: server.name,
      created: syncResult.created.length,
      updated: syncResult.updated.length,
      unchanged: syncResult.unchanged.length,
    },
    "Auto-reinstall completed - tools synced",
  );

  // Clear reinstall flag
  await McpServerModel.update(server.id, { reinstallRequired: false });
}
