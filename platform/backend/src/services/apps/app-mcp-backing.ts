import { getArchestraAppResourceUri } from "@archestra/shared";
import logger from "@/logging";
import {
  AgentModel,
  AgentToolModel,
  AppModel,
  AppTeamModel,
  InternalMcpCatalogModel,
  McpServerModel,
  ToolModel,
} from "@/models";
import McpCatalogTeamModel from "@/models/mcp-catalog-team";
import type { App } from "@/types/app";
import type { ResourceVisibilityScope } from "@/types/visibility";

/**
 * The gateway-visible tool every app's backing server exposes. Calling it hands
 * the host the app's `ui://` resource (resolved in-process by the gateway), so
 * the app renders through the standard MCP serving path. It is the real,
 * policy-governable `tool` row counterpart of the serve-time-synthesized
 * launch tool (`APP_LAUNCH_TOOL_NAME` = "open") in mcp-app-gateway.utils.ts —
 * unlike that one, this row exists in the catalog so it shows up in the
 * guardrails UI and is environment- and scope-filtered like any tool.
 */
const APP_SHOW_TOOL_NAME = "show_app";

/**
 * Make an app a first-class catalog entity: create its backing
 * `internal_mcp_catalog` + `mcp_server` rows and a `show_app` tool, then link
 * the app to the server. The backing server is `serverType: "app"` — it opts
 * out of K8s deploy / install / discovery and is served in-process. Mandatory:
 * pass the app-creation transaction so the app and its backing commit (or roll
 * back) atomically — an app must never exist without backing, since the catalog
 * is the single source of truth for its visibility + environment.
 */
export async function createAppBacking(params: {
  app: { id: string; name: string; description: string | null };
  scope: ResourceVisibilityScope;
  environmentId: string | null;
  userId: string;
  organizationId: string;
  teamIds: string[];
}): Promise<void> {
  const { app, scope, environmentId, userId, organizationId, teamIds } = params;
  const catalog = await InternalMcpCatalogModel.create(
    {
      name: app.name,
      description: app.description ?? null,
      serverType: "app",
      scope,
      environmentId,
      requiresAuth: false,
      ...(scope === "team" && teamIds.length > 0 ? { teams: teamIds } : {}),
    },
    { organizationId, authorId: userId },
  );

  const server = await McpServerModel.create({
    name: app.name,
    catalogId: catalog.id,
    serverType: "app",
    scope,
    ownerId: userId,
    teamId: scope === "team" ? (teamIds[0] ?? null) : null,
    userId,
    localInstallationStatus: "success",
  });

  // Plain insert (not bulkCreateToolsIfNotExists, which would adopt a
  // pre-existing NULL-catalog proxy tool of the same name and its assignments).
  // The catalog is brand-new, so a direct insert can't collide.
  //
  // Slugify the name per the discovered-tool convention (`<server>__show_app`)
  // so that when multiple apps are assigned to the same gateway profile their
  // launch tools stay distinct — an unprefixed "show_app" would collide in the
  // gateway's dedupe-by-name and shadow all but one app.
  const tool = await ToolModel.create({
    name: ToolModel.slugifyName(server.name, APP_SHOW_TOOL_NAME),
    description: `Open the "${app.name}" app and render its UI.`,
    parameters: { type: "object", properties: {} },
    catalogId: catalog.id,
    meta: {
      _meta: { ui: { resourceUri: getArchestraAppResourceUri(app.id) } },
    },
  });

  // Auto-assign show_app to the creator's personal gateway so they can connect
  // and see it immediately (mirrors the install auto-assign). Dynamic mode: the
  // call short-circuits in-process, but dynamic is the only mode that fits an
  // org-shared, viewer-scoped app.
  const personalGateway = await AgentModel.ensurePersonalMcpGateway({
    userId,
    organizationId,
  });
  await AgentToolModel.bulkCreateForAgentsAndTools(
    [personalGateway.id],
    [tool.id],
    { mcpServerId: server.id, credentialResolutionMode: "dynamic" },
  );

  await AppModel.setMcpServerId(app.id, server.id);
  logger.info(
    { appId: app.id, mcpServerId: server.id, catalogId: catalog.id },
    "Created MCP backing for app",
  );
}

/**
 * Mirror an app edit onto its backing catalog + server so the registry card,
 * tool environment isolation, and gateway visibility track the app: name, scope,
 * environment, and team membership. The server's scope (install-time-only for
 * real installs) is re-pointed in place via {@link McpServerModel.setScope} —
 * safe because an app server has no deployment. Best-effort; failures are logged.
 */
export async function syncAppBacking(app: App): Promise<void> {
  if (!app.mcpServerId) return;
  try {
    const server = await McpServerModel.findById(app.mcpServerId);
    if (!server) return;
    const teamIds =
      app.scope === "team" ? await AppTeamModel.getTeamsForApp(app.id) : [];
    if (server.scope !== app.scope) {
      await McpServerModel.setScope(server.id, app.scope);
    }
    // Keep the backing server name in lockstep with the app. constructServerName
    // leaves non-local types unchanged, so an app server's name has no scope
    // suffix and tracks app.name exactly. Re-slugify the launch tool too so its
    // gateway name (<server>__show_app) doesn't go stale and a later app reusing
    // the freed name can't reintroduce a dedupe collision.
    if (server.name !== app.name) {
      await McpServerModel.update(server.id, { name: app.name });
      if (server.catalogId) {
        await ToolModel.renameToolsByCatalogId(
          server.catalogId,
          ToolModel.slugifyName(app.name, APP_SHOW_TOOL_NAME),
        );
      }
    }
    await McpServerModel.setTeam(server.id, teamIds[0] ?? null);
    if (server.catalogId) {
      // The registry card and tool isolation read the catalog's name/scope/
      // environment, so the catalog is the one that must track the app. Team
      // membership rides the catalog-team junction.
      await InternalMcpCatalogModel.update(server.catalogId, {
        name: app.name,
        scope: app.scope,
        environmentId: app.environmentId,
      });
      await McpCatalogTeamModel.syncCatalogTeams(server.catalogId, teamIds);
    }
  } catch (error) {
    logger.warn(
      { err: error, appId: app.id, mcpServerId: app.mcpServerId },
      "Failed to sync MCP backing for app",
    );
  }
}

/**
 * Propagate a visibility/environment edit made through the MCP catalog form
 * (the app's Configuration tab) back to the linked app row and backing server,
 * so the app, its catalog, and its server stay consistent regardless of which
 * surface edited them. Best-effort.
 */
export async function propagateAppCatalogChange(
  catalogId: string,
  changes: {
    scope: ResourceVisibilityScope;
    environmentId: string | null;
    description: string | null;
  },
): Promise<void> {
  try {
    const server = (await McpServerModel.findByCatalogId(catalogId)).find(
      (s) => s.serverType === "app",
    );
    if (!server) return;
    if (server.scope !== changes.scope) {
      await McpServerModel.setScope(server.id, changes.scope);
    }
    const app = await AppModel.findByMcpServerId(server.id);
    if (app) {
      // Mirror the catalog's team membership onto the app so app_team and the
      // catalog-team junction don't diverge when teams are edited via the MCP
      // Configuration form (otherwise a team rescope leaves the app visible to
      // the old team). AppModel.update replaces app_team in the same transaction.
      const teamIds =
        changes.scope === "team"
          ? (await McpCatalogTeamModel.getTeamDetailsForCatalog(catalogId)).map(
              (t) => t.id,
            )
          : [];
      await AppModel.update({
        id: app.id,
        patch: {
          scope: changes.scope,
          environmentId: changes.environmentId,
          description: changes.description,
        },
        teamIds,
      });
    }
  } catch (error) {
    logger.warn(
      { err: error, catalogId },
      "Failed to propagate app catalog change to app/server",
    );
  }
}

/**
 * Tear down an app's backing rows. Deleting the catalog cascade-removes the
 * `show_app` tool (and its assignments); the server is removed explicitly first
 * (its `catalogId` FK only nulls on catalog delete). Best-effort.
 */
export async function deleteAppBacking(app: App): Promise<void> {
  if (!app.mcpServerId) return;
  try {
    const server = await McpServerModel.findById(app.mcpServerId);
    await McpServerModel.delete(app.mcpServerId);
    if (server?.catalogId) {
      await InternalMcpCatalogModel.delete(server.catalogId);
    }
  } catch (error) {
    logger.warn(
      { err: error, appId: app.id, mcpServerId: app.mcpServerId },
      "Failed to delete MCP backing for app",
    );
  }
}
