import { McpServerRuntimeManager } from "@/k8s/mcp-server-runtime";
import logger from "@/logging";
import { InternalMcpCatalogModel, McpServerModel, ToolModel } from "@/models";
import type { InternalMcpCatalog, LocalConfig, McpServer } from "@/types";
import { broadcastMcpInstallationStatus } from "@/websocket";

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

    // Multi-tenant catalogs handle execution-config drift via the
    // catalog-level `catalogReinstallRequired` flag (one shared pod across
    // all installs; the catalog-reinstall endpoint applies the change for
    // everyone in one shot). Single-tenant: each install owns its own pod,
    // so a silent auto-restart of others' pods would surprise them; mark
    // every install reinstall-required and let owners reinstall explicitly.
    if (
      !newCatalogItem.multitenant &&
      localExecutionConfigChanged(oldCatalogItem, newCatalogItem)
    ) {
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
 * Returns true when (and only when) the catalog diff is JUST
 * forward-compatible schema evolution that doesn't actually invalidate
 * any install. Used as a
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

  // 1b. Runtime-only prompted-env changes (e.g., `mounted` flip) don't
  //    need user re-prompt, but DO need a pod restart because they
  //    change the pod spec (env var vs mounted secret file at
  //    `/secrets/<key>`). Return false so the cascade fires via the
  //    auto path — not the manual path that re-prompts the user.
  if (promptedEnvVarsRuntimeChanged(oldPrompted, newPrompted)) return false;

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

  // 4. No OTHER non-metadata catalog field changed.
  //
  // Compare an explicit projection of cascade-relevant fields rather
  // than `JSON.stringify({...cat, …})`. Two reasons spread+stringify
  // is unsafe here:
  //   (a) The two snapshots can come from differently-enriched code
  //       paths — e.g. a list/read snapshot carrying `toolCount`
  //       compared against `Model.update()`'s return (which adds
  //       `authorName` but not `toolCount`). A whole-row stringify
  //       diffs on these bookkeeping fields and over-fires the auto
  //       cascade.
  //   (b) JavaScript object-spread preserves the original key order,
  //       so even if every value matches after overrides, the JSON
  //       string can still differ when the two inputs spread keys in
  //       different orders. Explicit projection in a fixed order
  //       sidesteps the issue.
  //
  // Any cascade-relevant field added to `internal_mcp_catalog` in the
  // future must be added to this projection — otherwise its changes
  // become invisible to the auto path.
  const project = (cat: InternalMcpCatalog) =>
    JSON.stringify({
      name: cat.name ?? "",
      version: cat.version ?? "",
      instructions: cat.instructions ?? "",
      repository: cat.repository ?? "",
      installationCommand: cat.installationCommand ?? "",
      requiresAuth: Boolean(cat.requiresAuth),
      authDescription: cat.authDescription ?? "",
      authFields: cat.authFields ?? null,
      serverType: cat.serverType ?? "",
      multitenant: Boolean(cat.multitenant),
      // Environment assignment determines the deployment namespace; a change
      // must trigger the cascade so the pod relocates (single-tenant via the
      // per-install restart below; multi-tenant via reinstallSharedDeployment
      // in the catalog PUT route).
      environmentId: cat.environmentId ?? null,
      serverUrl: cat.serverUrl ?? "",
      docsUrl: cat.docsUrl ?? "",
      icon: cat.icon ?? null,
      clientSecretId: cat.clientSecretId ?? null,
      localConfigSecretId: cat.localConfigSecretId ?? null,
      deploymentSpecYaml: cat.deploymentSpecYaml ?? "",
      oauthConfig: cat.oauthConfig ?? null,
      enterpriseManagedConfig: cat.enterpriseManagedConfig ?? null,
      // localConfig minus environment (covered by steps 1, 1b, 2 above).
      localConfig: cat.localConfig
        ? {
            command: cat.localConfig.command ?? "",
            arguments: cat.localConfig.arguments ?? [],
            envFrom: cat.localConfig.envFrom ?? [],
            dockerImage: cat.localConfig.dockerImage ?? "",
            transportType: cat.localConfig.transportType ?? "",
            httpPort: cat.localConfig.httpPort ?? null,
            httpPath: cat.localConfig.httpPath ?? "",
            nodePort: cat.localConfig.nodePort ?? null,
            serviceAccount: cat.localConfig.serviceAccount ?? "",
            imagePullSecrets: cat.localConfig.imagePullSecrets ?? [],
          }
        : null,
    });
  return project(oldCatalogItem) === project(newCatalogItem);
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
    // Static header value rotation. For a static header-mapped userConfig
    // entry (no install prompt), `default` IS the runtime header value the
    // form transform writes from the admin's input — changing it changes
    // what installs send on the wire. For prompted entries `default` is
    // just a placeholder/template, so we still skip those.
    if (
      String(p.headerName ?? "") !== "" &&
      !p.promptOnInstallation &&
      !n.promptOnInstallation &&
      String(p.default ?? "") !== String(n.default ?? "")
    ) {
      return true;
    }
    // Note: `description`, `title`, `valuePrefix` remain cosmetic — they
    // don't change what installs send.
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

  await syncToolsForServer(server, catalogItem, options);

  // Clear reinstall flag
  await McpServerModel.update(server.id, {
    reinstallRequired: false,
  });
}

/**
 * Fetch tools from a running MCP server and reconcile the `tools` table
 * for its catalog. Used by `autoReinstallServer` after a restart, and by
 * the catalog-reinstall endpoint to cascade tools to every install
 * attached to a multi-tenant catalog once the shared pod is back up.
 */
async function syncToolsForServer(
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
  const tools = options?.getTools
    ? await options.getTools({ server, catalogItem })
    : await McpServerModel.getToolsFromServer(server);

  const toolNamePrefix = catalogItem.name;
  const toolsToSync = tools.map((tool) => ({
    name: ToolModel.slugifyName(toolNamePrefix, tool.name),
    description: tool.description,
    parameters: tool.inputSchema,
    meta: { _meta: tool._meta, annotations: tool.annotations },
    catalogId: catalogItem.id,
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
    "Tools synced for MCP server",
  );
}

/**
 * Reinstall a multi-tenant local catalog: recreate the shared K8s
 * Deployment and cascade tool sync to every install attached to the
 * catalog, broadcasting per-install status the whole way.
 *
 * Phase 1 — recreate the shared pod (delete + create, bypassing the
 * per-install sibling guard). If this step fails every install is marked
 * `error` and the function throws so the caller can surface an HTTP 500.
 *
 * Phase 2 — fan out `syncToolsForServer` to every install. Per-install
 * errors are surfaced via WebSocket but don't abort the cascade —
 * remaining installs still get a chance to sync.
 *
 * On full success `catalog_reinstall_required` is cleared.
 *
 * Callers are expected to have validated:
 *   - catalog exists
 *   - catalog is multi-tenant + local
 *   - caller has edit rights on the catalog
 *   - `catalog_reinstall_required` is true
 * The route handler `/api/internal_mcp_catalog/:id/reinstall` performs
 * those checks before delegating here.
 */
export async function reinstallMultitenantCatalog(
  catalogItem: InternalMcpCatalog,
): Promise<void> {
  const installs = await McpServerModel.findByCatalogId(catalogItem.id);

  // Flip every install pending up-front so each tenant's UI shows
  // progress; per-install events are fanned out as each one's tool
  // sync completes (matches existing reinstall UX).
  //
  // Parallelize per-install bookkeeping — they're independent rows and
  // independent WS broadcasts. `allSettled` so one row's failed DB
  // write doesn't abort the rest; per-install errors are logged but
  // not fatal here (Phase 2 still runs and reports per-install status).
  await Promise.allSettled(
    installs.map(async (install) => {
      await McpServerModel.update(install.id, {
        localInstallationStatus: "pending",
        localInstallationError: null,
      });
      broadcastMcpInstallationStatus(install.id, "pending", null);
    }),
  );

  // Phase 1 — recreate the shared pod.
  try {
    await McpServerRuntimeManager.reinstallSharedDeployment(catalogItem.id);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    logger.error(
      { err: error, catalogId: catalogItem.id },
      "Catalog reinstall: shared deployment recreate failed",
    );
    await Promise.allSettled(
      installs.map(async (install) => {
        await McpServerModel.update(install.id, {
          localInstallationStatus: "error",
          localInstallationError: errorMessage,
        });
        broadcastMcpInstallationStatus(install.id, "error", errorMessage);
      }),
    );
    throw error;
  }

  // Phase 2 — cascade tool sync to every install in parallel. The pod
  // is up and shared across all installs, so the syncs are independent.
  // `allSettled` ensures one failing install doesn't abort the rest;
  // per-install errors are recorded inline.
  await Promise.allSettled(
    installs.map(async (install) => {
      try {
        await syncToolsForServer(install, catalogItem);
        await McpServerModel.update(install.id, {
          localInstallationStatus: "success",
          localInstallationError: null,
        });
        broadcastMcpInstallationStatus(install.id, "success", null);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        logger.error(
          { err: error, serverId: install.id, catalogId: catalogItem.id },
          "Catalog reinstall: tool sync failed for install",
        );
        // Flag for per-install retry. The catalog-level flag is cleared
        // unconditionally below once Phase 1 succeeded, so without this
        // the tenant is stuck: the catalog Reinstall button is gone and
        // the per-install Reinstall button is gated on
        // `reinstallRequired` (see mcp-server-card.tsx userFlaggedInstalls).
        await McpServerModel.update(install.id, {
          reinstallRequired: true,
          localInstallationStatus: "error",
          localInstallationError: errorMessage,
        });
        broadcastMcpInstallationStatus(install.id, "error", errorMessage);
      }
    }),
  );

  await InternalMcpCatalogModel.update(catalogItem.id, {
    catalogReinstallRequired: false,
  });
}

// ===== Internal helpers =====

type PromptedEnvVarInfo = {
  required: boolean;
  type: string;
  // `mounted` flips the pod spec between an env var (`mounted=false`)
  // and a mounted secret file at `/secrets/<key>` (`mounted=true`).
  // Captured here so the runtime-only gate below can detect a pure
  // mount-flag change — it doesn't need user re-prompt but pods still
  // need to restart to pick up the new layout.
  mounted: boolean;
};
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
      map.set(env.key, {
        required: env.required ?? false,
        type: env.type,
        mounted: env.mounted ?? false,
      });
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

/**
 * Runtime-only change detector for prompted env vars. Returns true when
 * a key present on both sides has a different `mounted` flag — flipping
 * mounted changes the pod spec (env var ↔ mounted secret file at
 * `/secrets/<key>`) but does NOT change what the user supplied at
 * install time. So the cascade still needs to fire (pod restart) but
 * via the AUTO path, not the manual re-prompt path.
 */
function promptedEnvVarsRuntimeChanged(
  oldMap: Map<string, PromptedEnvVarInfo>,
  newMap: Map<string, PromptedEnvVarInfo>,
): boolean {
  for (const [key, oldVal] of oldMap) {
    const newVal = newMap.get(key);
    if (!newVal) continue; // Removal is handled by promptedEnvVarsChanged
    if (oldVal.mounted !== newVal.mounted) return true;
  }
  return false;
}

export function localExecutionConfigChanged(
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
 * Check if a change to the required-userConfig-fields set needs a user
 * re-prompt. Treats *additions* to the required set as breaking (the
 * installer must supply a value the install didn't have) and
 * *type changes on a still-required field* as breaking (storage moves).
 *
 * Removals from the required set are NOT breaking: that case is either
 *   - a demotion (required true → false): the install already supplied a
 *     value, and the now-optional field accepts that value, OR
 *   - a full field deletion: the install's stored value becomes orphaned,
 *     but the pod doesn't need the user to re-supply anything. The pod
 *     does need to restart to stop injecting the stale value — that's
 *     caught by `userConfigChangedBreakingly` further down the gate
 *     chain, which routes the cascade to the auto path.
 */
function requiredUserConfigChanged(
  oldMap: Map<string, UserConfigFieldInfo>,
  newMap: Map<string, UserConfigFieldInfo>,
): boolean {
  for (const [key, oldVal] of oldMap) {
    const newVal = newMap.get(key);
    if (!newVal) continue; // Removed from required set — see comment above
    if (newVal.type !== oldVal.type) return true; // Type changed on still-required field
  }

  for (const key of newMap.keys()) {
    if (!oldMap.has(key)) return true; // Added required → install must supply
  }

  return false;
}
