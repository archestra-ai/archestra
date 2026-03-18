import type { Permission } from "@shared";
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { userHasPermission } from "@/auth/utils";
import { UserModel } from "@/models";
import type { ArchestraToolShortName } from ".";
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
  query_knowledge_sources: { resource: "knowledgeBase", action: "query" },
  create_knowledge_base: { resource: "knowledgeBase", action: "create" },
  get_knowledge_bases: { resource: "knowledgeBase", action: "read" },
  get_knowledge_base: { resource: "knowledgeBase", action: "read" },
  update_knowledge_base: { resource: "knowledgeBase", action: "update" },
  delete_knowledge_base: { resource: "knowledgeBase", action: "delete" },
  create_knowledge_connector: { resource: "knowledgeBase", action: "create" },
  get_knowledge_connectors: { resource: "knowledgeBase", action: "read" },
  get_knowledge_connector: { resource: "knowledgeBase", action: "read" },
  update_knowledge_connector: { resource: "knowledgeBase", action: "update" },
  delete_knowledge_connector: { resource: "knowledgeBase", action: "delete" },
  assign_knowledge_connector_to_knowledge_base: {
    resource: "knowledgeBase",
    action: "update",
  },
  unassign_knowledge_connector_from_knowledge_base: {
    resource: "knowledgeBase",
    action: "update",
  },
  assign_knowledge_base_to_agent: {
    resource: "knowledgeBase",
    action: "update",
  },
  unassign_knowledge_base_from_agent: {
    resource: "knowledgeBase",
    action: "update",
  },
  assign_knowledge_connector_to_agent: {
    resource: "knowledgeBase",
    action: "update",
  },
  unassign_knowledge_connector_from_agent: {
    resource: "knowledgeBase",
    action: "update",
  },

  // Chat — available to all (operate within user's own chat session)
  todo_write: null,
  artifact_write: null,
  swap_agent: { resource: "agent", action: "read" },
  swap_to_default_agent: null,
};

/**
 * Check if a user has permission to execute a specific Archestra tool.
 * Returns an error result if denied, or null if allowed.
 */
export async function checkToolPermission(
  toolName: string,
  context: ArchestraContext,
) {
  const shortName = extractShortName(toolName);
  if (!shortName) return null; // Not an Archestra tool — allow (handled elsewhere)

  // Cast is safe: unknown-but-prefixed tools return undefined here and are
  // allowed through — they'll fail in the handler chain with "unknown tool".
  // Known tools with `null` permission are also allowed (no RBAC needed).
  const perm = TOOL_PERMISSIONS[shortName as ArchestraToolShortName];
  if (!perm) return null;

  if (!context.userId || !context.organizationId) {
    return errorResult("User context not available");
  }

  const allowed = await userHasPermission(
    context.userId,
    context.organizationId,
    perm.resource,
    perm.action,
  );

  if (!allowed) {
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
    // No user context — only include tools with no permission requirement
    return new Set(
      toolNames.filter((name) => {
        const shortName = extractShortName(name);
        if (!shortName) return true; // Non-Archestra tool
        const perm = TOOL_PERMISSIONS[shortName as ArchestraToolShortName];
        return perm === null; // null means no permission required
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
    const shortName = extractShortName(name);
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
    const shortName = extractShortName(name);
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

// === Internal helpers ===

const TOOL_PREFIX = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}`;

function extractShortName(fullName: string): string | null {
  if (!fullName.startsWith(TOOL_PREFIX)) return null;
  return fullName.slice(TOOL_PREFIX.length);
}
