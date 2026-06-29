import type { ArchestraToolShortName, Permission } from "@archestra/shared";
import { userHasPermission } from "@/auth/utils";
import logger from "@/logging";
import { UserModel } from "@/models";
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
  Permission | null
> = {
  // Identity — available to all
  whoami: null,

  // Agents
  create_agent: { resource: "agent", action: "create" },
  get_agent: { resource: "agent", action: "read" },
  list_agents: { resource: "agent", action: "read" },
  edit_agent: { resource: "agent", action: "update" },

  // LLM Proxies
  create_llm_proxy: { resource: "llmProxy", action: "create" },
  get_llm_proxy: { resource: "llmProxy", action: "read" },
  edit_llm_proxy: { resource: "llmProxy", action: "update" },

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
  create_mcp_server_installation_request: {
    resource: "mcpServerInstallationRequest",
    action: "create",
  },

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
  artifact_write: null,
  swap_agent: { resource: "agent", action: "read" },
  swap_to_default_agent: null,
  create_project_from_conversation: { resource: "project", action: "create" },

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
  // Code execution sandbox — gated by `sandbox:execute` and per-agent tool
  // assignment. The implicit per-conversation sandbox is created lazily; the
  // create step is not a tool. load_skill (skill:read) mounts a skill into
  // the sandbox when the caller also has sandbox:execute.
  run_command: { resource: "sandbox", action: "execute" },
  download_file: { resource: "sandbox", action: "execute" },
  upload_file: { resource: "sandbox", action: "execute" },
  search_files: { resource: "sandbox", action: "execute" },
  read_file: { resource: "sandbox", action: "execute" },
  save_file: { resource: "sandbox", action: "execute" },
  edit_file: { resource: "sandbox", action: "execute" },
  delete_file: { resource: "sandbox", action: "execute" },

  // MCP Apps. The data-store tools gate on app:read/update; the running app's
  // appId is route-bound (set by the app MCP proxy), so the permission check
  // plus that binding together confine a caller to apps it may use.
  scaffold_app: { resource: "app", action: "create" },
  // refine mutates the app head (persists its spec), mirroring edit_app.
  refine_app: { resource: "app", action: "update" },
  list_apps: { resource: "app", action: "read" },
  render_app: { resource: "app", action: "read" },
  read_app: { resource: "app", action: "read" },
  edit_app: { resource: "app", action: "update" },
  // set_app_tools replaces an app's assigned tool set; assertCallerMayModifyApp
  // is the real authority, app:update is the floor (mirrors edit_app).
  set_app_tools: { resource: "app", action: "update" },
  // validate_app only reads the head html and reports static findings.
  validate_app: { resource: "app", action: "read" },
  // publish_app changes the app's visibility scope; the scope-promotion gate
  // (assertCallerMayModifyApp) is the real authority, app:update is the floor.
  publish_app: { resource: "app", action: "update" },
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
    return errorResult("User context not available");
  }

  // org/team-token sessions have no user; they may still use read-only tools
  // that operate at organization scope — the handlers restrict the results.
  if (!context.userId) {
    if (ORG_CONTEXT_READ_TOOLS.has(typedShortName)) return null;
    return errorResult("User context not available");
  }

  const allowed = await userHasPermission(
    context.userId,
    context.organizationId,
    perm.resource,
    perm.action,
  );

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
    return errorResult(
      `You do not have permission to perform this action (requires ${perm.resource}:${perm.action}).`,
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

  const permissions = await UserModel.getUserPermissions(
    userId,
    organizationId,
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
          permissions[perm.resource]?.includes(perm.action) ?? false,
        );
      }
    }
  }

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
    if (permResults.get(`${perm.resource}:${perm.action}`)) {
      allowed.add(name);
    }
  }

  return allowed;
}
