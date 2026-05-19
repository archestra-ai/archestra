import { McpServerRuntimeManager } from "@/k8s/mcp-server-runtime";
import logger from "@/logging";
import { McpServerModel, ToolModel } from "@/models";
import type { InternalMcpCatalog, LocalConfig, McpServer } from "@/types";

/**
 * Checks if a catalog edit requires new user input for reinstallation.
 *
 * Returns true (manual reinstall required) when:
 * - Server name changed (local servers) - affects secret paths
 * - Local execution config changed (command/args/docker/transport) - restart should be explicit
 * - Prompted env vars changed: added, removed, or key/required/type changed (local servers)
 * - OAuth config changed: added or removed (remote servers)
 * - Required userConfig fields changed: added, removed, or type changed (local + remote servers)
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

    if (localExecutionConfigChanged(oldCatalogItem, newCatalogItem)) {
      logger.info(
        { catalogId: newCatalogItem.id },
        "Local execution config changed - manual reinstall required",
      );
      return true;
    }

    // 4. Check if required userConfig fields changed (e.g. header-backed fields
    // added by editing the Headers section). Without this, installs end up with
    // a credential record that has no value for the new field and the header is
    // silently omitted on the wire.
    if (
      requiredUserConfigChanged(
        getRequiredUserConfigFields(oldCatalogItem),
        getRequiredUserConfigFields(newCatalogItem),
      )
    ) {
      logger.info(
        { catalogId: newCatalogItem.id },
        "Required userConfig fields changed - manual reinstall required",
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
 * Returns true iff the catalog diff is JUST forward-compatible schema
 * evolution that doesn't actually invalidate any install. Used as a
 * refinement gate on top of `isMetadataOnlyEdit`: when that predicate
 * says "non-metadata diff exists" but the diff is purely
 * forward-compatible (added optional env var, added optional header,
 * demoted required → optional, etc.), there's nothing for the
 * auto-cascade to restart.
 *
 * The two dimensions checked are:
 *   • `localConfig.environment` — prompted env-var schema evolution
 *   • `userConfig` — header / non-header userConfig schema evolution
 *
 * Mirrors the frontend's `envChangeRequiresReinstall` and
 * `additionalHeadersChangeRequiresReinstall` in `mcp-catalog-form.tsx`
 * so frontend silence and backend behavior agree.
 */
export function onlyForwardCompatibleEnvDiff(
  oldCatalogItem: InternalMcpCatalog,
  newCatalogItem: InternalMcpCatalog,
): boolean {
  // 1. Prompted env-var changes are schema-evolution compatible.
  const oldPrompted = getPromptedEnvVars(oldCatalogItem);
  const newPrompted = getPromptedEnvVars(newCatalogItem);
  if (promptedEnvVarsChanged(oldPrompted, newPrompted)) return false;

  // 2. Non-prompted env vars are unchanged (their values are part of
  //    the catalog template; any change must propagate to pods).
  const stripPromptOnInstall = (env: NonNullable<LocalConfig["environment"]>) =>
    env.filter((e) => !e.promptOnInstallation);
  const oldNonPrompted = stripPromptOnInstall(
    oldCatalogItem.localConfig?.environment ?? [],
  );
  const newNonPrompted = stripPromptOnInstall(
    newCatalogItem.localConfig?.environment ?? [],
  );
  if (JSON.stringify(oldNonPrompted) !== JSON.stringify(newNonPrompted)) {
    return false;
  }

  // 3. userConfig schema evolution. Same rules as env vars: added
  //    required = breaking, added optional = compatible, removed = breaking,
  //    type/required-flip/headerName/etc. = breaking. Covers both header-
  //    mapped userConfig fields (the form's `additionalHeaders` section)
  //    and non-header userConfig.
  if (
    userConfigChangedBreakingly(
      oldCatalogItem.userConfig ?? null,
      newCatalogItem.userConfig ?? null,
    )
  ) {
    return false;
  }

  // 4. No OTHER non-metadata catalog field changed. Strip env +
  //    userConfig + metadata fields and compare what remains. JSON.stringify
  //    is fine — both sides are DB-shape rows that round-trip stably
  //    through the model layer.
  const strip = (cat: InternalMcpCatalog): InternalMcpCatalog => ({
    ...cat,
    localConfig: cat.localConfig
      ? { ...cat.localConfig, environment: [] }
      : cat.localConfig,
    userConfig: null,
    // Metadata-only fields that legitimately differ on every PUT but
    // don't invalidate installs.
    description: "",
    createdAt: oldCatalogItem.createdAt,
    updatedAt: oldCatalogItem.updatedAt,
  });
  return (
    JSON.stringify(strip(oldCatalogItem)) ===
    JSON.stringify(strip(newCatalogItem))
  );
}

/**
 * userConfig schema-evolution check. Returns true (breaking) if any
 * field change invalidates an existing install's stored credentials/
 * values. Returns false (compatible) for: added optional field, demoted
 * required → optional, pure description/title cosmetic changes that
 * don't affect storage or routing.
 *
 * Mirror in `additionalHeadersChangeRequiresReinstall` on the frontend
 * (`mcp-catalog-form.tsx`).
 */
function userConfigChangedBreakingly(
  oldConfig: Record<string, unknown> | null,
  newConfig: Record<string, unknown> | null,
): boolean {
  const prev = (oldConfig ?? {}) as Record<string, Record<string, unknown>>;
  const next = (newConfig ?? {}) as Record<string, Record<string, unknown>>;

  // Removed any field, modified existing in a breaking way.
  for (const [key, p] of Object.entries(prev)) {
    const n = next[key];
    if (!n) return true; // Removed
    if (!p.required && Boolean(n.required)) return true; // Became required
    if (String(p.type ?? "") !== String(n.type ?? "")) return true; // Type changed
    if (String(p.headerName ?? "") !== String(n.headerName ?? "")) return true; // Routing changed
    if (Boolean(p.sensitive) !== Boolean(n.sensitive)) return true; // Storage moved
    // Note: deliberately NOT checking `default`, `description`, `title`,
    // `valuePrefix` etc. — those are cosmetic / template defaults that
    // don't affect install validity. If a default value matters to your
    // pod, change it via a runtime field (env value) instead.
  }

  // Added required field → existing installs are missing it.
  for (const [key, n] of Object.entries(next)) {
    if (key in prev) continue;
    if (n.required) return true;
  }
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
  options?: {
    getTools?: (params: {
      server: McpServer;
      catalogItem: InternalMcpCatalog;
    }) => Promise<
      Array<{
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
        _meta?: Record<string, unknown>;
        annotations?: Record<string, unknown>;
      }>
    >;
  },
): Promise<void> {
  logger.info(
    { serverId: server.id, serverName: server.name },
    "Starting auto-reinstall of MCP server",
  );

  // Reconstruct the correct server name from the current catalog name.
  const reconstructedName = McpServerModel.constructServerName({
    baseName: catalogItem.name,
    serverType: server.serverType,
    scope: server.scope,
    ownerId: server.ownerId,
    teamId: server.teamId,
  });

  // Update server name in DB BEFORE restart so the new K8s deployment
  // gets the correct name. restartServer reads from DB to create the new deployment.
  if (reconstructedName !== server.name) {
    logger.info(
      {
        serverId: server.id,
        oldName: server.name,
        newName: reconstructedName,
      },
      "Updating server name to match catalog name",
    );
    await McpServerModel.update(server.id, { name: reconstructedName });
  }

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
  const tools = options?.getTools
    ? await options.getTools({
        server,
        catalogItem,
      })
    : await McpServerModel.getToolsFromServer(server);

  // Use catalog item name for tool naming (consistent with install flow)
  const toolNamePrefix = catalogItem.name;
  const toolsToSync = tools.map((tool) => ({
    name: ToolModel.slugifyName(toolNamePrefix, tool.name),
    description: tool.description,
    parameters: tool.inputSchema,
    meta: { _meta: tool._meta, annotations: tool.annotations },
    catalogId: catalogItem.id,
    // Pass the raw tool name from MCP server for accurate matching
    // This handles cases where catalog name contains `__` (e.g., huggingface__remote-mcp)
    rawToolName: tool.name,
  }));

  const syncResult = await ToolModel.syncToolsForCatalog(toolsToSync);

  logger.info(
    {
      serverId: server.id,
      serverName: reconstructedName,
      created: syncResult.created.length,
      updated: syncResult.updated.length,
      unchanged: syncResult.unchanged.length,
      deleted: syncResult.deleted.length,
    },
    "Auto-reinstall completed - tools synced",
  );

  // Clear reinstall flag
  await McpServerModel.update(server.id, {
    reinstallRequired: false,
  });
}

// ===== Internal helpers =====

type PromptedEnvVarInfo = { required: boolean; type: string };
type ComparableLocalConfig = Pick<
  LocalConfig,
  | "command"
  | "arguments"
  | "dockerImage"
  | "transportType"
  | "httpPort"
  | "httpPath"
  | "serviceAccount"
>;

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
 * Check if prompted env vars changed in a way that invalidates existing
 * installs. Returns true only when an existing install can no longer be
 * considered valid under the new schema — i.e. the user needs to be re-
 * prompted before the install will work again.
 *
 * Schema-evolution rules:
 *   - Added OPTIONAL var       → existing installs stay valid (no reinstall)
 *   - Added REQUIRED var       → existing installs are missing a required
 *                                value (reinstall)
 *   - Removed var (any kind)   → existing installs hold a stored value for
 *                                a var the catalog no longer accepts
 *                                (reinstall to clean up)
 *   - Type change (e.g.
 *     plain ↔ secret)          → stored value lives in a different bucket
 *                                (reinstall)
 *   - required false → true    → existing installs that didn't fill the
 *                                var are now invalid (reinstall)
 *   - required true → false    → existing installs that did fill the var
 *                                are still valid; the var just became
 *                                optional (no reinstall)
 */
function promptedEnvVarsChanged(
  oldMap: Map<string, PromptedEnvVarInfo>,
  newMap: Map<string, PromptedEnvVarInfo>,
): boolean {
  for (const [key, oldVal] of oldMap) {
    const newVal = newMap.get(key);
    if (!newVal) return true; // Removed
    if (newVal.type !== oldVal.type) return true; // Type changed (e.g. plain ↔ secret)
    if (!oldVal.required && newVal.required) return true; // Became required
  }

  for (const [key, newVal] of newMap) {
    if (oldMap.has(key)) continue;
    if (newVal.required) return true; // Added required var
  }

  return false;
}

function localExecutionConfigChanged(
  oldCatalog: InternalMcpCatalog,
  newCatalog: InternalMcpCatalog,
): boolean {
  return (
    JSON.stringify(getLocalExecutionConfig(oldCatalog)) !==
    JSON.stringify(getLocalExecutionConfig(newCatalog))
  );
}

function getLocalExecutionConfig(
  catalog: InternalMcpCatalog,
): ComparableLocalConfig {
  return {
    command: catalog.localConfig?.command ?? "",
    arguments: catalog.localConfig?.arguments ?? [],
    dockerImage: catalog.localConfig?.dockerImage ?? "",
    transportType: catalog.localConfig?.transportType,
    httpPort: catalog.localConfig?.httpPort,
    httpPath: catalog.localConfig?.httpPath ?? "",
    serviceAccount: catalog.localConfig?.serviceAccount ?? "",
  };
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
