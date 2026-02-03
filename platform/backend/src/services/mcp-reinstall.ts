import logger from "@/logging";
import { McpServerRuntimeManager } from "@/mcp-server-runtime";
import { McpServerModel, ToolModel } from "@/models";
import type { InternalMcpCatalog, McpServer } from "@/types";

/**
 * Checks if a catalog edit requires new user input for reinstallation.
 *
 * Returns true (manual reinstall required) when:
 * - Server name changed (local servers) - affects secret paths
 * - Prompted env vars changed: added, removed, or key/required/type changed (local servers)
 * - OAuth config changed: added or removed (remote servers)
 * - Required userConfig fields changed: added, removed, or type changed (remote servers)
 *
 * Returns false (auto-reinstall possible) when:
 * - Only non-prompted config changed (local servers) - existing secrets can be reused
 * - Only non-auth config changed (remote servers) - existing auth can be reused
 *
 * Note: We compare old vs new config to allow auto-reinstall when auth-related
 * settings haven't changed. This enables auto-reinstall for name/URL changes.
 *
 * Note 2:
 * We don't check if the deployment spec YAML changed (advanced yaml config),
 * because it's impossible to set a prompted env var and do not allow to change name of the mcp server.
 */
export function requiresNewUserInputForReinstall(
  oldCatalogItem: InternalMcpCatalog,
  newCatalogItem: InternalMcpCatalog,
): boolean {
  // Local servers: check if name or prompted env vars changed
  if (newCatalogItem.serverType === "local") {
    // 1. Check if name changed - affects secret paths
    if (oldCatalogItem.name !== newCatalogItem.name) {
      logger.info(
        { catalogId: newCatalogItem.id },
        "Catalog name changed - manual reinstall required",
      );
      return true;
    }

    // 2. Check if prompted env vars changed
    const oldPromptedEnvVars = getPromptedEnvVars(oldCatalogItem);
    const newPromptedEnvVars = getPromptedEnvVars(newCatalogItem);

    if (promptedEnvVarsChanged(oldPromptedEnvVars, newPromptedEnvVars)) {
      logger.info(
        { catalogId: newCatalogItem.id },
        "Prompted env vars changed - manual reinstall required",
      );
      return true;
    }

    // No relevant changes - auto-reinstall can proceed with existing secrets
    return false;
  }

  // Remote servers: check if OAuth or required userConfig changed
  if (newCatalogItem.serverType === "remote") {
    // Check if OAuth config changed (added or removed)
    const hadOAuth = !!oldCatalogItem.oauthConfig;
    const hasOAuth = !!newCatalogItem.oauthConfig;
    if (hadOAuth !== hasOAuth) {
      logger.info(
        { catalogId: newCatalogItem.id },
        "OAuth config changed - manual reinstall required",
      );
      return true;
    }

    // Check if required userConfig fields changed
    const oldRequiredFields = getRequiredUserConfigFields(oldCatalogItem);
    const newRequiredFields = getRequiredUserConfigFields(newCatalogItem);

    if (requiredUserConfigChanged(oldRequiredFields, newRequiredFields)) {
      logger.info(
        { catalogId: newCatalogItem.id },
        "Required userConfig fields changed - manual reinstall required",
      );
      return true;
    }

    // No auth-related changes - auto-reinstall can proceed
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

  // Update server name to match catalog name and clear reinstall flag
  await McpServerModel.update(server.id, {
    name: catalogItem.name,
    reinstallRequired: false,
  });
}

// ===== Internal helpers =====

type PromptedEnvVarInfo = { required: boolean; type: string };

/**
 * Extract prompted env vars from a catalog item as a map of key -> { required, type }
 */
function getPromptedEnvVars(
  catalog: InternalMcpCatalog,
): Map<string, PromptedEnvVarInfo> {
  const map = new Map<string, PromptedEnvVarInfo>();
  for (const env of catalog.localConfig?.environment || []) {
    if (env.promptOnInstallation) {
      map.set(env.key, { required: env.required ?? false, type: env.type });
    }
  }
  return map;
}

/**
 * Check if prompted env vars changed between old and new catalog items.
 * Returns true if any prompted env var was added, removed, or had its type/required status changed.
 */
function promptedEnvVarsChanged(
  oldMap: Map<string, PromptedEnvVarInfo>,
  newMap: Map<string, PromptedEnvVarInfo>,
): boolean {
  // Check for removals or changes
  for (const [key, oldVal] of oldMap) {
    const newVal = newMap.get(key);
    if (!newVal) return true; // Removed
    if (newVal.required !== oldVal.required) return true; // Required changed
    if (newVal.type !== oldVal.type) return true; // Type changed
  }

  // Check for additions
  for (const key of newMap.keys()) {
    if (!oldMap.has(key)) return true; // Added
  }

  return false;
}

type UserConfigFieldInfo = { type: string };

/**
 * Extract required userConfig fields from a catalog item as a map of key -> { type }
 */
function getRequiredUserConfigFields(
  catalog: InternalMcpCatalog,
): Map<string, UserConfigFieldInfo> {
  const map = new Map<string, UserConfigFieldInfo>();
  for (const [key, field] of Object.entries(catalog.userConfig || {})) {
    if (field.required) {
      map.set(key, { type: field.type });
    }
  }
  return map;
}

/**
 * Check if required userConfig fields changed between old and new catalog items.
 * Returns true if any required field was added, removed, or had its type changed.
 */
function requiredUserConfigChanged(
  oldMap: Map<string, UserConfigFieldInfo>,
  newMap: Map<string, UserConfigFieldInfo>,
): boolean {
  // Check for removals or changes
  for (const [key, oldVal] of oldMap) {
    const newVal = newMap.get(key);
    if (!newVal) return true; // Removed
    if (newVal.type !== oldVal.type) return true; // Type changed
  }

  // Check for additions
  for (const key of newMap.keys()) {
    if (!oldMap.has(key)) return true; // Added
  }

  return false;
}
