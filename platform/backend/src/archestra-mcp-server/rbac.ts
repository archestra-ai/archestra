import {
  type ArchestraToolShortName,
  type Permission,
  type ResourcePermissionAction,
  type ScopedResource,
  TOOL_SHARE_FILE_PUBLICLY_SHORT_NAME,
} from "@archestra/shared";
import {
  allAvailableActions,
  roleActionResourceFor,
} from "@archestra/shared/access-control";
import type { RequestLookups } from "@/auth/request-lookups";
import { getPermissionsForUserContext, userHasPermission } from "@/auth/utils";
import logger from "@/logging";
import OrganizationModel from "@/models/organization";
import ResourcePermissionTargetModel from "@/models/resource-permission-target";
import { ResourcePermissions } from "@/services/resource-permissions";
import { archestraMcpBranding } from "./branding";
import { errorResult } from "./helpers";
import type { ArchestraContext } from "./types";

// === Exports ===

/**
 * Permission required to use each Archestra MCP tool.
 * `null` means the tool is available to all authenticated users (no additional RBAC check).
 * Typed as `Record<ArchestraToolShortName, ...>` so adding a new tool without
 * updating this map causes a compile error.
 */
export const TOOL_PERMISSIONS: Record<
  ArchestraToolShortName,
  | Permission
  | { resource: ScopedResource; action: ResourcePermissionAction }
  | null
> = {
  // Identity
  whoami: null,
  // OpenAPPA
  execute_remedy_plan: null,
  yell: null,
  get_remedy_plans: null,
  list_peer_messages: null,
  read_peer_message: null,
  get_openappa_yell: { resource: "openappaDiagnostics", action: "read" },
  list_openappa_consults: { resource: "openappaDiagnostics", action: "read" },
  get_guardrails_policy: { resource: "openappaPolicy", action: "read" },
  list_guardrails_battery_fits: { resource: "openappaPolicy", action: "read" },
  inspect_guardrails_server: { resource: "openappaPolicy", action: "read" },
  validate_guardrails_policy: { resource: "openappaPolicy", action: "read" },
  preview_guardrails_policy_change: {
    resource: "openappaPolicy",
    action: "read",
  },
  update_guardrails_policy: { resource: "openappaPolicy", action: "update" },
  get_guardrails_policy_change_status: {
    resource: "openappaPolicy",
    action: "read",
  },
  create_guardrails_repository: {
    resource: "organizationSettings",
    action: "update",
  },
  list_runtime_credentials: { resource: "credential", action: "read" },
  get_runtime_credential: { resource: "credential", action: "read" },
  create_runtime_credential: { resource: "credential", action: "create" },
  update_runtime_credential: { resource: "credential", action: "update" },
  delete_runtime_credential: { resource: "credential", action: "delete" },
  request_runtime_credential_setup: {
    resource: "credential",
    action: "create",
  },

  // Agents
  create_agent: { resource: "agent", action: "create" },
  get_agent: { resource: "agent", action: "read" },
  list_agents: { resource: "agent", action: "read" },
  edit_agent: { resource: "agent", action: "update" },

  // Agent lifecycle hooks — mirror the REST hook routes' permissions
  list_hooks: { resource: "agent", action: "read" },
  create_hook: { resource: "agent", action: "update" },
  update_hook: { resource: "agent", action: "update" },
  delete_hook: { resource: "agent", action: "update" },

  // MCP Gateways
  create_mcp_gateway: { resource: "mcpGateway", action: "create" },
  get_mcp_gateway: { resource: "mcpGateway", action: "read" },
  edit_mcp_gateway: { resource: "mcpGateway", action: "update" },

  // MCP Servers
  search_private_mcp_registry: { resource: "mcpRegistry", action: "read" },
  get_mcp_servers: { resource: "mcpRegistry", action: "read" },
  get_mcp_server_tools: { resource: "mcpRegistry", action: "read" },
  edit_mcp_description: { resource: "mcpRegistry", action: "update" },
  edit_mcp_config: { resource: "mcpRegistry", action: "update" },
  create_mcp_server: { resource: "mcpRegistry", action: "create" },
  deploy_mcp_server: { resource: "mcpRegistry", action: "update" },
  list_mcp_server_deployments: { resource: "mcpRegistry", action: "read" },
  get_mcp_server_logs: { resource: "mcpRegistry", action: "read" },
  // Same gate as the ReloadMcpServerTools route: a subset of reinstalling.
  reload_mcp_server_tools: {
    resource: "mcpServerInstallation",
    action: "create",
  },

  // Teams
  create_team: { resource: "team", action: "create" },
  get_team: { resource: "team", action: "read" },
  list_teams: { resource: "team", action: "read" },
  edit_team: { resource: "team", action: "update" },
  delete_team: { resource: "team", action: "delete" },
  list_team_members: { resource: "team", action: "read" },
  // Membership mutations use team:read as the coarse gate and then enforce a
  // finer check in the handler (org-level team manager OR admin of that
  // specific team), mirroring the REST route's `assertCanManageTeam`. Gating
  // these on team:update here would lock out team admins who are only org
  // members (they hold team:read, not team:update).
  add_team_member: { resource: "team", action: "read" },
  update_team_member_role: { resource: "team", action: "read" },
  remove_team_member: { resource: "team", action: "read" },
  // External group sync tools follow the same pattern as membership tools:
  // team:read as the coarse gate (matching the REST routes), with the finer
  // manage check (org-level team manager OR team admin) and the enterprise
  // license gate enforced in the handlers.
  list_team_external_groups: { resource: "team", action: "read" },
  add_team_external_group: { resource: "team", action: "read" },
  remove_team_external_group: { resource: "team", action: "read" },

  // Limits
  create_limit: { resource: "llmLimit", action: "create" },
  get_limits: { resource: "llmLimit", action: "read" },
  update_limit: { resource: "llmLimit", action: "update" },
  delete_limit: { resource: "llmLimit", action: "delete" },
  get_agent_token_usage: { resource: "llmLimit", action: "read" },
  get_llm_proxy_token_usage: { resource: "llmLimit", action: "read" },

  // Policies
  get_autonomy_policy_operators: { resource: "toolPolicy", action: "read" },
  get_tool_invocation_policies: { resource: "toolPolicy", action: "read" },
  create_tool_invocation_policy: { resource: "toolPolicy", action: "create" },
  get_tool_invocation_policy: { resource: "toolPolicy", action: "read" },
  update_tool_invocation_policy: { resource: "toolPolicy", action: "update" },
  delete_tool_invocation_policy: { resource: "toolPolicy", action: "delete" },
  get_trusted_data_policies: { resource: "toolPolicy", action: "read" },
  create_trusted_data_policy: { resource: "toolPolicy", action: "create" },
  get_trusted_data_policy: { resource: "toolPolicy", action: "read" },
  update_trusted_data_policy: { resource: "toolPolicy", action: "update" },
  delete_trusted_data_policy: { resource: "toolPolicy", action: "delete" },

  // Tool Assignment
  bulk_assign_tools_to_agents: { resource: "agent", action: "update" },
  bulk_remove_tools_from_agents: { resource: "agent", action: "update" },
  bulk_assign_tools_to_mcp_gateways: {
    resource: "mcpGateway",
    action: "update",
  },

  // Knowledge Management
  query_knowledge_sources: { resource: "knowledgeSource", action: "query" },
  create_knowledge_base: { resource: "knowledgeSource", action: "create" },
  get_knowledge_bases: { resource: "knowledgeSource", action: "read" },
  get_knowledge_base: { resource: "knowledgeSource", action: "read" },
  update_knowledge_base: { resource: "knowledgeSource", action: "update" },
  delete_knowledge_base: { resource: "knowledgeSource", action: "delete" },
  create_knowledge_connector: { resource: "knowledgeSource", action: "create" },
  get_knowledge_connectors: { resource: "knowledgeSource", action: "read" },
  get_knowledge_connector: { resource: "knowledgeSource", action: "read" },
  update_knowledge_connector: { resource: "knowledgeSource", action: "update" },
  delete_knowledge_connector: { resource: "knowledgeSource", action: "delete" },
  assign_knowledge_connector_to_knowledge_base: {
    resource: "knowledgeSource",
    action: "update",
  },
  unassign_knowledge_connector_from_knowledge_base: {
    resource: "knowledgeSource",
    action: "update",
  },
  assign_knowledge_base_to_agent: {
    resource: "knowledgeSource",
    action: "update",
  },
  unassign_knowledge_base_from_agent: {
    resource: "knowledgeSource",
    action: "update",
  },
  assign_knowledge_connector_to_agent: {
    resource: "knowledgeSource",
    action: "update",
  },
  unassign_knowledge_connector_from_agent: {
    resource: "knowledgeSource",
    action: "update",
  },

  // Chat — available to all (operate within user's own chat session)
  todo_write: null,
  ask_user: null,
  create_project_from_conversation: { resource: "project", action: "create" },
  // Reads mirror the GetProjects/GetProject routes. The permission is only the
  // floor: both handlers narrow to what the caller can actually reach (owner or
  // shared-with), so `project:read` never widens visibility past their own set.
  list_projects: { resource: "project", action: "read" },
  get_project: { resource: "project", action: "read" },
  // Mirror the LinkProjectApp/UnlinkProjectApp routes: project membership is
  // the floor, and the handler re-checks the caller's read access to the app.
  link_app_to_project: { resource: "project", action: "read" },
  unlink_app_from_project: { resource: "project", action: "read" },

  // Scheduled tasks — mirror the /api/schedule-triggers routes. As with the
  // project reads the permission is only the floor: every handler runs the
  // same owner / `scheduledTask:*` / project-member gate the REST routes use
  // (services/schedule-trigger-access.ts), so `scheduledTask:read` never
  // widens visibility past the caller's own schedules.
  create_schedule_trigger: { resource: "scheduledTask", action: "create" },
  update_schedule_trigger: { resource: "scheduledTask", action: "update" },
  delete_schedule_trigger: { resource: "scheduledTask", action: "delete" },
  list_schedule_triggers: { resource: "scheduledTask", action: "read" },
  get_schedule_trigger: { resource: "scheduledTask", action: "read" },
  list_schedule_trigger_runs: { resource: "scheduledTask", action: "read" },
  get_schedule_trigger_run: { resource: "scheduledTask", action: "read" },
  enable_schedule_trigger: { resource: "scheduledTask", action: "update" },
  disable_schedule_trigger: { resource: "scheduledTask", action: "update" },
  // Starting a run creates a run row, matching RunScheduleTriggerNow.
  run_schedule_trigger_now: { resource: "scheduledTask", action: "create" },

  // Meta — permission is enforced on the target tool, not on run_tool itself
  search_tools: null,
  run_tool: null,

  // skills — require skill:read; handlers further filter by per-skill scope.
  list_skills: { resource: "skill", action: "read" },
  load_skill: { resource: "skill", action: "read" },
  // Skill authoring — writes need skill:create/update; create_skill always
  // makes a personal skill, update_skill re-checks the target skill's scope.
  create_skill: { resource: "skill", action: "create" },
  update_skill: { resource: "skill", action: "update" },
  edit_skill: { resource: "skill", action: "update" },
  // Plugins — executable opaque bytes, so only the metadata catalog is
  // readable without managing every plugin; byte reads and every mutation
  // also require `update` on every plugin (a grant at `*`), which each handler
  // checks, matching the REST routes (plugin.routes.ts).
  list_plugins: { resource: "plugin", action: "read" },
  get_plugin: { resource: "plugin", action: "read" },
  create_plugin: { resource: "plugin", action: "create" },
  update_plugin: { resource: "plugin", action: "update" },
  edit_plugin: { resource: "plugin", action: "update" },
  delete_plugin: { resource: "plugin", action: "delete" },
  // Code execution sandbox — part of using an agent (`agent:read`) plus
  // per-agent tool assignment. The implicit per-conversation sandbox is
  // created lazily; the create step is not a tool. load_skill (skill:read)
  // mounts a skill into the sandbox when the caller also has agent:read.
  run_command: { resource: "agent", action: "read" },
  download_file: { resource: "agent", action: "read" },
  upload_file: { resource: "agent", action: "read" },
  // Its own permission, plus the organization switch (allowPublicFileSharing,
  // off by default) checked in the handler.
  share_file_publicly: { resource: "publicFileLink", action: "create" },

  // Runs are an Agent capability, including when an Agent opts into
  // Agent Runtime. Per-run ownership stays in the handlers.
  start_run: { resource: "agent", action: "read" },
  get_run: { resource: "agent", action: "read" },
  list_runs: { resource: "agent", action: "read" },
  list_agent_runs: { resource: "agent", action: "read" },
  steer_run: { resource: "agent", action: "read" },
  cancel_run: { resource: "agent", action: "read" },
  post_run_file: { resource: "agent", action: "read" },
  read_workspace_file: { resource: "agent", action: "read" },
  write_workspace_file: { resource: "agent", action: "read" },
  transfer_workspace_file: { resource: "agent", action: "read" },
  delete_workspace: { resource: "agent", action: "read" },
  // Writes only the caller's own personal credential, so it needs no elevated
  // permission; the handler additionally requires access to the target Agent
  // and refuses keys declared at organization scope.
  transfer_credential: { resource: "credential", action: "create" },
  // Persistent file store (`skill_sandbox_files`) — part of using an agent,
  // like the sandbox itself, so `agent:read`. Per-file authorization
  // (authorship, project membership) stays in the handlers.
  search_files: { resource: "agent", action: "read" },
  read_file: { resource: "agent", action: "read" },
  // Agent-side exchange with the chat's open app — pure PFS↔PFS.
  copy_file: { resource: "agent", action: "read" },
  // App-runtime only (never seeded/agent-visible); still viewer-RBAC-checked.
  read_file_raw: { resource: "agent", action: "read" },
  save_file: { resource: "agent", action: "read" },
  edit_file: { resource: "agent", action: "read" },
  delete_file: { resource: "agent", action: "read" },

  // MCP Apps. The data-store tools gate on app:read/update; the running app's
  // appId is route-bound (set by the app MCP proxy), so the permission check
  // plus that binding together confine a caller to apps it may use.
  scaffold_app: { resource: "app", action: "create" },
  // refine mutates the app head (persists its spec), mirroring edit_app.
  refine_app: { resource: "app", action: "update" },
  list_apps: { resource: "app", action: "read" },
  list_app_versions: { resource: "app", action: "read" },
  render_app: { resource: "app", action: "read" },
  read_app: { resource: "app", action: "read" },
  restore_app_version: { resource: "app", action: "update" },
  edit_app: { resource: "app", action: "update" },
  // set_app_tools replaces an app's assigned tool set; assertCallerMayModifyApp
  // is the real authority, app:update is the floor (mirrors edit_app).
  set_app_tools: { resource: "app", action: "update" },
  set_app_labels: { resource: "app", action: "update" },
  // set_app_lock flips the app's lock; the per-app authorization (scope +
  // author + teams) rides the same loadApp modify gate as the other mutations.
  set_app_lock: { resource: "app", action: "update" },
  // validate_app only reads the head html and reports static findings.
  validate_app: { resource: "app", action: "read" },
  // publish_app delegates read/use access through the resource permission policy; the handler
  // checks the target and prevents delegating actions the caller does not hold.
  publish_app: { resource: "app", action: "manage-permissions" },
  delete_app: { resource: "app", action: "delete" },
  // Authoring intent: the preview is exercised while building/fixing an app.
  preview_app_tool: { resource: "app", action: "update" },
  get_app_diagnostics: { resource: "app", action: "read" },
  app_data_get: { resource: "app", action: "read" },
  app_data_set: { resource: "app", action: "update" },
  app_data_list: { resource: "app", action: "read" },
  app_data_delete: { resource: "app", action: "update" },
  // A viewer who can use an app can run its archestra.llm.complete() calls.
  llm_complete: { resource: "app", action: "read" },
};

/**
 * Read-only tools that operate at organization scope and so may be used by
 * org/team-token MCP sessions, which carry no `userId`. Their handlers
 * restrict results to org-scoped resources when no user is present.
 */
const ORG_CONTEXT_READ_TOOLS: ReadonlySet<ArchestraToolShortName> = new Set([
  "list_skills",
  "load_skill",
]);

/**
 * Check if a user has permission to execute a specific Archestra tool.
 * Returns an error result if denied, or null if allowed.
 */
export async function checkToolPermission(
  toolName: string,
  context: ArchestraContext,
) {
  const shortName = archestraMcpBranding.getToolShortName(toolName);
  if (!shortName) return null; // Not an Archestra tool — allow (handled elsewhere)

  // Cast is safe: unknown-but-prefixed tools return undefined here and are
  // allowed through — they'll fail in the handler chain with "unknown tool".
  // Known tools with `null` permission are also allowed (no RBAC needed).
  const typedShortName = shortName as ArchestraToolShortName;
  const perm = TOOL_PERMISSIONS[typedShortName];
  if (!perm) return null;

  if (!context.organizationId) {
    return errorResult("Organization context not available");
  }

  // org/team-token sessions have no user; they may still use read-only tools
  // that operate at organization scope — the handlers restrict the results.
  if (!context.userId) {
    if (ORG_CONTEXT_READ_TOOLS.has(typedShortName)) return null;
    // Name the cause: this is reached whenever the caller authenticated with a
    // credential that acts for an application rather than a person, and the
    // previous wording ("User context not available") read as an internal
    // fault rather than a fixable choice of credential.
    return errorResult(
      `${toolName} requires an acting user, but the credential used to authenticate does not identify one. Team tokens, organization tokens, and OAuth client-credentials tokens act for an application, not a person. Re-authenticate with a personal token, a user OAuth token, or an Identity Provider JWT.`,
    );
  }

  const allowed =
    perm.action === "manage-permissions" ||
    perm.action === "use" ||
    perm.action === "configure-deployment-spec"
      ? false
      : await userHasPermission(
          context.userId,
          context.organizationId,
          // A scoped resource whose name is not a role action maps onto the
          // one that used to gate it, so knowledge tools keep asking for
          // `knowledgeSource`.
          roleActionResourceFor(perm.resource),
          perm.action,
        );

  const scopedAction = SCOPED_CATALOG_TOOLS[typedShortName];
  // People can edit what they create, so a role that can create the resource
  // reaches its per-item tools before it owns any item. The handler still
  // checks the specific item.
  if (
    !allowed &&
    isToolGrantGated(typedShortName) &&
    (await userHasPermission(
      context.userId,
      context.organizationId,
      roleActionResourceFor(perm.resource),
      "create",
    ))
  )
    return null;
  if (
    !allowed &&
    scopedAction &&
    (await ResourcePermissionTargetModel.hasAnyCatalogGrant({
      userId: context.userId,
      organizationId: context.organizationId,
      action: scopedAction,
    }))
  )
    return null;

  const scoped = SCOPED_RESOURCE_TOOLS[typedShortName];
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  if (
    !allowed &&
    scoped &&
    (
      await ResourcePermissions.resolveAll({
        userId: context.userId,
        organizationId: context.organizationId,
      })
    ).some(
      (grant) =>
        grant.resource === scoped.resource && grant.action === scoped.action,
    )
  )
    return null;
  // SPDX-SnippetEnd

  if (!allowed) {
    logger.warn(
      {
        organizationId: context.organizationId,
        userId: context.userId,
        toolName,
        resource: perm.resource,
        action: perm.action,
      },
      "[ArchestraMCP] rbac denied tool execution",
    );
    const resource = roleActionResourceFor(perm.resource);
    return errorResult(
      allAvailableActions[resource]?.includes(perm.action as never)
        ? `You do not have permission to perform this action (requires ${perm.resource}:${perm.action}).`
        : `You do not have permission to perform this action (requires the ${perm.action} grant on the item).`,
    );
  }

  return null;
}

/**
 * Filter a list of tool names to only those the user has permission to use.
 * Non-Archestra tools are always included (their auth is handled separately).
 */
export async function filterToolNamesByPermission(
  toolNames: string[],
  userId: string | undefined,
  organizationId: string | undefined,
  lookups?: RequestLookups,
): Promise<Set<string>> {
  if (!userId || !organizationId) {
    // No user context — include tools with no permission requirement, plus
    // org-context read tools when an organization context is present.
    return new Set(
      toolNames.filter((name) => {
        const shortName = archestraMcpBranding.getToolShortName(name);
        if (!shortName) return true; // Non-Archestra tool
        const typed = shortName as ArchestraToolShortName;
        if (TOOL_PERMISSIONS[typed] === null) return true;
        return (
          organizationId !== undefined && ORG_CONTEXT_READ_TOOLS.has(typed)
        );
      }),
    );
  }

  const permissions = lookups
    ? await lookups.permissions({ userId, organizationId })
    : await getPermissionsForUserContext({ userId, organizationId });
  const scopedActions = new Set<ResourcePermissionAction>();
  const neededScopedActions = new Set(
    toolNames
      .map(
        (name) =>
          SCOPED_CATALOG_TOOLS[
            archestraMcpBranding.getToolShortName(
              name,
            ) as ArchestraToolShortName
          ],
      )
      .filter((action): action is ResourcePermissionAction => !!action),
  );
  await Promise.all(
    [...neededScopedActions].map(async (action) => {
      if (
        await ResourcePermissionTargetModel.hasAnyCatalogGrant({
          userId,
          organizationId,
          action,
          lookups,
        })
      )
        scopedActions.add(action);
    }),
  );

  // Collect unique permissions we need to check
  const permResults = new Map<string, boolean>();
  for (const name of toolNames) {
    const shortName = archestraMcpBranding.getToolShortName(name);
    if (!shortName) continue;
    const perm = TOOL_PERMISSIONS[shortName as ArchestraToolShortName];
    if (perm) {
      const key = `${perm.resource}:${perm.action}`;
      if (!permResults.has(key)) {
        permResults.set(
          key,
          perm.action === "manage-permissions" ||
            perm.action === "use" ||
            perm.action === "configure-deployment-spec"
            ? false
            : (permissions[roleActionResourceFor(perm.resource)]?.includes(
                perm.action,
              ) ?? false),
        );
      }
    }
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  const resourceGrants = toolNames.some(
    (name) =>
      SCOPED_RESOURCE_TOOLS[
        archestraMcpBranding.getToolShortName(name) as ArchestraToolShortName
      ],
  )
    ? await ResourcePermissions.resolveAll({ userId, organizationId, lookups })
    : [];
  // SPDX-SnippetEnd

  // Filter tools
  const allowed = new Set<string>();
  for (const name of toolNames) {
    const shortName = archestraMcpBranding.getToolShortName(name);
    if (!shortName) {
      allowed.add(name); // Non-Archestra tool
      continue;
    }
    const perm = TOOL_PERMISSIONS[shortName as ArchestraToolShortName];
    if (!perm) {
      allowed.add(name); // No permission required
      continue;
    }
    const scopedAction =
      SCOPED_CATALOG_TOOLS[shortName as ArchestraToolShortName];
    if (
      permResults.get(`${perm.resource}:${perm.action}`) ||
      // Same rule as checkToolPermission: creators reach per-item tools.
      (isToolGrantGated(shortName as ArchestraToolShortName) &&
        (permissions[roleActionResourceFor(perm.resource)]?.includes(
          "create",
        ) ??
          false)) ||
      (scopedAction && scopedActions.has(scopedAction)) ||
      resourceGrants.some(
        (grant) =>
          grant.resource ===
            SCOPED_RESOURCE_TOOLS[shortName as ArchestraToolShortName]
              ?.resource &&
          grant.action ===
            SCOPED_RESOURCE_TOOLS[shortName as ArchestraToolShortName]?.action,
      )
    ) {
      allowed.add(name);
    }
  }

  await dropToolsSwitchedOffByOrganization({ allowed, organizationId });
  return allowed;
}

/**
 * Whether a per-object grant can open this tool, independently of the role.
 * @public — the coverage test uses it to prove every tool stays reachable.
 */
export function isToolGrantGated(shortName: ArchestraToolShortName): boolean {
  return Boolean(
    SCOPED_CATALOG_TOOLS[shortName] || SCOPED_RESOURCE_TOOLS[shortName],
  );
}

// Only handlers that enforce the exact object action or filter their list in
// SQL may bypass the organization-level permission gate through this map.
const SCOPED_CATALOG_TOOLS: Partial<
  Record<ArchestraToolShortName, ResourcePermissionAction>
> = {
  edit_mcp_description: "update",
  edit_mcp_config: "update",
  deploy_mcp_server: "use",
  search_private_mcp_registry: "read",
  get_mcp_servers: "read",
  get_mcp_server_tools: "read",
};

const SCOPED_RESOURCE_TOOLS: Partial<
  Record<
    ArchestraToolShortName,
    { resource: ScopedResource; action: ResourcePermissionAction }
  >
> = {
  list_hooks: { resource: "agent", action: "read" },
  create_hook: { resource: "agent", action: "update" },
  update_hook: { resource: "agent", action: "update" },
  delete_hook: { resource: "agent", action: "update" },
  app_data_get: { resource: "app", action: "use" },
  app_data_set: { resource: "app", action: "use" },
  app_data_list: { resource: "app", action: "use" },
  app_data_delete: { resource: "app", action: "use" },
  llm_complete: { resource: "app", action: "use" },
  list_apps: { resource: "app", action: "read" },
  read_app: { resource: "app", action: "read" },
  list_app_versions: { resource: "app", action: "read" },
  render_app: { resource: "app", action: "use" },
  edit_app: { resource: "app", action: "update" },
  refine_app: { resource: "app", action: "update" },
  set_app_tools: { resource: "app", action: "update" },
  set_app_labels: { resource: "app", action: "update" },
  publish_app: { resource: "app", action: "manage-permissions" },
  restore_app_version: { resource: "app", action: "update" },
  set_app_lock: { resource: "app", action: "update" },
  validate_app: { resource: "app", action: "read" },
  get_app_diagnostics: { resource: "app", action: "read" },
  preview_app_tool: { resource: "app", action: "update" },
  delete_app: { resource: "app", action: "delete" },
  list_skills: { resource: "skill", action: "read" },
  load_skill: { resource: "skill", action: "use" },
  update_skill: { resource: "skill", action: "update" },
  edit_skill: { resource: "skill", action: "update" },
  bulk_assign_tools_to_agents: { resource: "agent", action: "update" },
  bulk_remove_tools_from_agents: { resource: "agent", action: "update" },
  bulk_assign_tools_to_mcp_gateways: {
    resource: "mcpGateway",
    action: "update",
  },
  get_agent: { resource: "agent", action: "read" },
  list_agents: { resource: "agent", action: "read" },
  edit_agent: { resource: "agent", action: "update" },
  get_mcp_gateway: { resource: "mcpGateway", action: "read" },
  edit_mcp_gateway: { resource: "mcpGateway", action: "update" },
};

/**
 * Tools an organization setting withdraws whatever the role allows, so a model
 * never sees a tool it cannot use: `share_file_publicly` while public file
 * sharing is off. The handler re-checks the switch, which covers a list cached
 * from before an admin turned it off.
 */
async function dropToolsSwitchedOffByOrganization(params: {
  allowed: Set<string>;
  organizationId: string;
}): Promise<void> {
  const shareTool = [...params.allowed].find(
    (name) =>
      archestraMcpBranding.getToolShortName(name) ===
      TOOL_SHARE_FILE_PUBLICLY_SHORT_NAME,
  );
  if (!shareTool) return;
  const organization = await OrganizationModel.getById(params.organizationId);
  if (!organization?.allowPublicFileSharing) params.allowed.delete(shareTool);
}
