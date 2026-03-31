import { DEFAULT_APP_NAME, MCP_SERVER_TOOL_NAME_SEPARATOR } from "./consts";
import { slugify } from "./utils";

export const ARCHESTRA_MCP_SERVER_NAME = "archestra";

/**
 * Fixed UUID for the Archestra MCP catalog entry.
 * This ID is constant to ensure consistent catalog lookup across server restarts.
 * Must be a valid UUID format (version 4, variant 8/9/a/b) for Zod validation.
 */
export const ARCHESTRA_MCP_CATALOG_ID = "00000000-0000-4000-8000-000000000001";

/**
 * Prefix for all built-in Archestra MCP tools.
 * Format: archestra__<tool_name>
 */
export const ARCHESTRA_TOOL_PREFIX = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}`;

export const TOOL_WHOAMI_SHORT_NAME = "whoami";
export const TOOL_CREATE_AGENT_SHORT_NAME = "create_agent";
export const TOOL_GET_AGENT_SHORT_NAME = "get_agent";
export const TOOL_LIST_AGENTS_SHORT_NAME = "list_agents";
export const TOOL_EDIT_AGENT_SHORT_NAME = "edit_agent";
export const TOOL_CREATE_LLM_PROXY_SHORT_NAME = "create_llm_proxy";
export const TOOL_GET_LLM_PROXY_SHORT_NAME = "get_llm_proxy";
export const TOOL_EDIT_LLM_PROXY_SHORT_NAME = "edit_llm_proxy";
export const TOOL_CREATE_MCP_GATEWAY_SHORT_NAME = "create_mcp_gateway";
export const TOOL_GET_MCP_GATEWAY_SHORT_NAME = "get_mcp_gateway";
export const TOOL_EDIT_MCP_GATEWAY_SHORT_NAME = "edit_mcp_gateway";
export const TOOL_SEARCH_PRIVATE_MCP_REGISTRY_SHORT_NAME =
  "search_private_mcp_registry";
export const TOOL_GET_MCP_SERVERS_SHORT_NAME = "get_mcp_servers";
export const TOOL_GET_MCP_SERVER_TOOLS_SHORT_NAME = "get_mcp_server_tools";
export const TOOL_EDIT_MCP_DESCRIPTION_SHORT_NAME = "edit_mcp_description";
export const TOOL_EDIT_MCP_CONFIG_SHORT_NAME = "edit_mcp_config";
export const TOOL_CREATE_MCP_SERVER_SHORT_NAME = "create_mcp_server";
export const TOOL_DEPLOY_MCP_SERVER_SHORT_NAME = "deploy_mcp_server";
export const TOOL_LIST_MCP_SERVER_DEPLOYMENTS_SHORT_NAME =
  "list_mcp_server_deployments";
export const TOOL_GET_MCP_SERVER_LOGS_SHORT_NAME = "get_mcp_server_logs";
export const TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_SHORT_NAME =
  "create_mcp_server_installation_request";
export const TOOL_CREATE_LIMIT_SHORT_NAME = "create_limit";
export const TOOL_GET_LIMITS_SHORT_NAME = "get_limits";
export const TOOL_UPDATE_LIMIT_SHORT_NAME = "update_limit";
export const TOOL_DELETE_LIMIT_SHORT_NAME = "delete_limit";
export const TOOL_GET_AGENT_TOKEN_USAGE_SHORT_NAME = "get_agent_token_usage";
export const TOOL_GET_LLM_PROXY_TOKEN_USAGE_SHORT_NAME =
  "get_llm_proxy_token_usage";
export const TOOL_GET_AUTONOMY_POLICY_OPERATORS_SHORT_NAME =
  "get_autonomy_policy_operators";
export const TOOL_GET_TOOL_INVOCATION_POLICIES_SHORT_NAME =
  "get_tool_invocation_policies";
export const TOOL_CREATE_TOOL_INVOCATION_POLICY_SHORT_NAME =
  "create_tool_invocation_policy";
export const TOOL_GET_TOOL_INVOCATION_POLICY_SHORT_NAME =
  "get_tool_invocation_policy";
export const TOOL_UPDATE_TOOL_INVOCATION_POLICY_SHORT_NAME =
  "update_tool_invocation_policy";
export const TOOL_DELETE_TOOL_INVOCATION_POLICY_SHORT_NAME =
  "delete_tool_invocation_policy";
export const TOOL_GET_TRUSTED_DATA_POLICIES_SHORT_NAME =
  "get_trusted_data_policies";
export const TOOL_CREATE_TRUSTED_DATA_POLICY_SHORT_NAME =
  "create_trusted_data_policy";
export const TOOL_GET_TRUSTED_DATA_POLICY_SHORT_NAME =
  "get_trusted_data_policy";
export const TOOL_UPDATE_TRUSTED_DATA_POLICY_SHORT_NAME =
  "update_trusted_data_policy";
export const TOOL_DELETE_TRUSTED_DATA_POLICY_SHORT_NAME =
  "delete_trusted_data_policy";
export const TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_SHORT_NAME =
  "bulk_assign_tools_to_agents";
export const TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_SHORT_NAME =
  "bulk_assign_tools_to_mcp_gateways";
export const TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME =
  "query_knowledge_sources";
export const TOOL_CREATE_KNOWLEDGE_BASE_SHORT_NAME = "create_knowledge_base";
export const TOOL_GET_KNOWLEDGE_BASES_SHORT_NAME = "get_knowledge_bases";
export const TOOL_GET_KNOWLEDGE_BASE_SHORT_NAME = "get_knowledge_base";
export const TOOL_UPDATE_KNOWLEDGE_BASE_SHORT_NAME = "update_knowledge_base";
export const TOOL_DELETE_KNOWLEDGE_BASE_SHORT_NAME = "delete_knowledge_base";
export const TOOL_CREATE_KNOWLEDGE_CONNECTOR_SHORT_NAME =
  "create_knowledge_connector";
export const TOOL_GET_KNOWLEDGE_CONNECTORS_SHORT_NAME =
  "get_knowledge_connectors";
export const TOOL_GET_KNOWLEDGE_CONNECTOR_SHORT_NAME =
  "get_knowledge_connector";
export const TOOL_UPDATE_KNOWLEDGE_CONNECTOR_SHORT_NAME =
  "update_knowledge_connector";
export const TOOL_DELETE_KNOWLEDGE_CONNECTOR_SHORT_NAME =
  "delete_knowledge_connector";
export const TOOL_ASSIGN_KNOWLEDGE_CONNECTOR_TO_KNOWLEDGE_BASE_SHORT_NAME =
  "assign_knowledge_connector_to_knowledge_base";
export const TOOL_UNASSIGN_KNOWLEDGE_CONNECTOR_FROM_KNOWLEDGE_BASE_SHORT_NAME =
  "unassign_knowledge_connector_from_knowledge_base";
export const TOOL_ASSIGN_KNOWLEDGE_BASE_TO_AGENT_SHORT_NAME =
  "assign_knowledge_base_to_agent";
export const TOOL_UNASSIGN_KNOWLEDGE_BASE_FROM_AGENT_SHORT_NAME =
  "unassign_knowledge_base_from_agent";
export const TOOL_ASSIGN_KNOWLEDGE_CONNECTOR_TO_AGENT_SHORT_NAME =
  "assign_knowledge_connector_to_agent";
export const TOOL_UNASSIGN_KNOWLEDGE_CONNECTOR_FROM_AGENT_SHORT_NAME =
  "unassign_knowledge_connector_from_agent";
export const TOOL_TODO_WRITE_SHORT_NAME = "todo_write";
export const TOOL_SWAP_AGENT_SHORT_NAME = "swap_agent";
export const TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME = "swap_to_default_agent";
export const TOOL_ARTIFACT_WRITE_SHORT_NAME = "artifact_write";

export const ARCHESTRA_TOOL_SHORT_NAMES = [
  TOOL_WHOAMI_SHORT_NAME,
  TOOL_CREATE_AGENT_SHORT_NAME,
  TOOL_GET_AGENT_SHORT_NAME,
  TOOL_LIST_AGENTS_SHORT_NAME,
  TOOL_EDIT_AGENT_SHORT_NAME,
  TOOL_CREATE_LLM_PROXY_SHORT_NAME,
  TOOL_GET_LLM_PROXY_SHORT_NAME,
  TOOL_EDIT_LLM_PROXY_SHORT_NAME,
  TOOL_CREATE_MCP_GATEWAY_SHORT_NAME,
  TOOL_GET_MCP_GATEWAY_SHORT_NAME,
  TOOL_EDIT_MCP_GATEWAY_SHORT_NAME,
  TOOL_SEARCH_PRIVATE_MCP_REGISTRY_SHORT_NAME,
  TOOL_GET_MCP_SERVERS_SHORT_NAME,
  TOOL_GET_MCP_SERVER_TOOLS_SHORT_NAME,
  TOOL_EDIT_MCP_DESCRIPTION_SHORT_NAME,
  TOOL_EDIT_MCP_CONFIG_SHORT_NAME,
  TOOL_CREATE_MCP_SERVER_SHORT_NAME,
  TOOL_DEPLOY_MCP_SERVER_SHORT_NAME,
  TOOL_LIST_MCP_SERVER_DEPLOYMENTS_SHORT_NAME,
  TOOL_GET_MCP_SERVER_LOGS_SHORT_NAME,
  TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_SHORT_NAME,
  TOOL_CREATE_LIMIT_SHORT_NAME,
  TOOL_GET_LIMITS_SHORT_NAME,
  TOOL_UPDATE_LIMIT_SHORT_NAME,
  TOOL_DELETE_LIMIT_SHORT_NAME,
  TOOL_GET_AGENT_TOKEN_USAGE_SHORT_NAME,
  TOOL_GET_LLM_PROXY_TOKEN_USAGE_SHORT_NAME,
  TOOL_GET_AUTONOMY_POLICY_OPERATORS_SHORT_NAME,
  TOOL_GET_TOOL_INVOCATION_POLICIES_SHORT_NAME,
  TOOL_CREATE_TOOL_INVOCATION_POLICY_SHORT_NAME,
  TOOL_GET_TOOL_INVOCATION_POLICY_SHORT_NAME,
  TOOL_UPDATE_TOOL_INVOCATION_POLICY_SHORT_NAME,
  TOOL_DELETE_TOOL_INVOCATION_POLICY_SHORT_NAME,
  TOOL_GET_TRUSTED_DATA_POLICIES_SHORT_NAME,
  TOOL_CREATE_TRUSTED_DATA_POLICY_SHORT_NAME,
  TOOL_GET_TRUSTED_DATA_POLICY_SHORT_NAME,
  TOOL_UPDATE_TRUSTED_DATA_POLICY_SHORT_NAME,
  TOOL_DELETE_TRUSTED_DATA_POLICY_SHORT_NAME,
  TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_SHORT_NAME,
  TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_SHORT_NAME,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
  TOOL_CREATE_KNOWLEDGE_BASE_SHORT_NAME,
  TOOL_GET_KNOWLEDGE_BASES_SHORT_NAME,
  TOOL_GET_KNOWLEDGE_BASE_SHORT_NAME,
  TOOL_UPDATE_KNOWLEDGE_BASE_SHORT_NAME,
  TOOL_DELETE_KNOWLEDGE_BASE_SHORT_NAME,
  TOOL_CREATE_KNOWLEDGE_CONNECTOR_SHORT_NAME,
  TOOL_GET_KNOWLEDGE_CONNECTORS_SHORT_NAME,
  TOOL_GET_KNOWLEDGE_CONNECTOR_SHORT_NAME,
  TOOL_UPDATE_KNOWLEDGE_CONNECTOR_SHORT_NAME,
  TOOL_DELETE_KNOWLEDGE_CONNECTOR_SHORT_NAME,
  TOOL_ASSIGN_KNOWLEDGE_CONNECTOR_TO_KNOWLEDGE_BASE_SHORT_NAME,
  TOOL_UNASSIGN_KNOWLEDGE_CONNECTOR_FROM_KNOWLEDGE_BASE_SHORT_NAME,
  TOOL_ASSIGN_KNOWLEDGE_BASE_TO_AGENT_SHORT_NAME,
  TOOL_UNASSIGN_KNOWLEDGE_BASE_FROM_AGENT_SHORT_NAME,
  TOOL_ASSIGN_KNOWLEDGE_CONNECTOR_TO_AGENT_SHORT_NAME,
  TOOL_UNASSIGN_KNOWLEDGE_CONNECTOR_FROM_AGENT_SHORT_NAME,
  TOOL_TODO_WRITE_SHORT_NAME,
  TOOL_SWAP_AGENT_SHORT_NAME,
  TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME,
  TOOL_ARTIFACT_WRITE_SHORT_NAME,
] as const;

export type ArchestraToolShortName =
  (typeof ARCHESTRA_TOOL_SHORT_NAMES)[number];
export type ArchestraToolFullName<
  ShortName extends ArchestraToolShortName = ArchestraToolShortName,
> = `${typeof ARCHESTRA_TOOL_PREFIX}${ShortName}`;

export type ArchestraMcpIdentityOptions = {
  appName?: string | null;
  fullWhiteLabeling?: boolean;
};

export const TOOL_WHOAMI_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_WHOAMI_SHORT_NAME}` as const;
export const TOOL_CREATE_AGENT_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_CREATE_AGENT_SHORT_NAME}` as const;
export const TOOL_GET_AGENT_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_GET_AGENT_SHORT_NAME}` as const;
export const TOOL_LIST_AGENTS_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_LIST_AGENTS_SHORT_NAME}` as const;
export const TOOL_EDIT_AGENT_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_EDIT_AGENT_SHORT_NAME}` as const;
export const TOOL_CREATE_LLM_PROXY_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_CREATE_LLM_PROXY_SHORT_NAME}` as const;
export const TOOL_GET_LLM_PROXY_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_GET_LLM_PROXY_SHORT_NAME}` as const;
export const TOOL_EDIT_LLM_PROXY_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_EDIT_LLM_PROXY_SHORT_NAME}` as const;
export const TOOL_CREATE_MCP_GATEWAY_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_CREATE_MCP_GATEWAY_SHORT_NAME}` as const;
export const TOOL_GET_MCP_GATEWAY_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_GET_MCP_GATEWAY_SHORT_NAME}` as const;
export const TOOL_EDIT_MCP_GATEWAY_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_EDIT_MCP_GATEWAY_SHORT_NAME}` as const;
export const TOOL_SEARCH_PRIVATE_MCP_REGISTRY_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_SEARCH_PRIVATE_MCP_REGISTRY_SHORT_NAME}` as const;
export const TOOL_GET_MCP_SERVERS_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_GET_MCP_SERVERS_SHORT_NAME}` as const;
export const TOOL_GET_MCP_SERVER_TOOLS_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_GET_MCP_SERVER_TOOLS_SHORT_NAME}` as const;
export const TOOL_EDIT_MCP_DESCRIPTION_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_EDIT_MCP_DESCRIPTION_SHORT_NAME}` as const;
export const TOOL_EDIT_MCP_CONFIG_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_EDIT_MCP_CONFIG_SHORT_NAME}` as const;
export const TOOL_CREATE_MCP_SERVER_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_CREATE_MCP_SERVER_SHORT_NAME}` as const;
export const TOOL_DEPLOY_MCP_SERVER_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_DEPLOY_MCP_SERVER_SHORT_NAME}` as const;
export const TOOL_LIST_MCP_SERVER_DEPLOYMENTS_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_LIST_MCP_SERVER_DEPLOYMENTS_SHORT_NAME}` as const;
export const TOOL_GET_MCP_SERVER_LOGS_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_GET_MCP_SERVER_LOGS_SHORT_NAME}` as const;
export const TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_SHORT_NAME}` as const;
export const TOOL_CREATE_LIMIT_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_CREATE_LIMIT_SHORT_NAME}` as const;
export const TOOL_GET_LIMITS_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_GET_LIMITS_SHORT_NAME}` as const;
export const TOOL_UPDATE_LIMIT_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_UPDATE_LIMIT_SHORT_NAME}` as const;
export const TOOL_DELETE_LIMIT_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_DELETE_LIMIT_SHORT_NAME}` as const;
export const TOOL_GET_AGENT_TOKEN_USAGE_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_GET_AGENT_TOKEN_USAGE_SHORT_NAME}` as const;
export const TOOL_GET_LLM_PROXY_TOKEN_USAGE_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_GET_LLM_PROXY_TOKEN_USAGE_SHORT_NAME}` as const;
export const TOOL_GET_AUTONOMY_POLICY_OPERATORS_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_GET_AUTONOMY_POLICY_OPERATORS_SHORT_NAME}` as const;
export const TOOL_GET_TOOL_INVOCATION_POLICIES_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_GET_TOOL_INVOCATION_POLICIES_SHORT_NAME}` as const;
export const TOOL_CREATE_TOOL_INVOCATION_POLICY_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_CREATE_TOOL_INVOCATION_POLICY_SHORT_NAME}` as const;
export const TOOL_GET_TOOL_INVOCATION_POLICY_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_GET_TOOL_INVOCATION_POLICY_SHORT_NAME}` as const;
export const TOOL_UPDATE_TOOL_INVOCATION_POLICY_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_UPDATE_TOOL_INVOCATION_POLICY_SHORT_NAME}` as const;
export const TOOL_DELETE_TOOL_INVOCATION_POLICY_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_DELETE_TOOL_INVOCATION_POLICY_SHORT_NAME}` as const;
export const TOOL_GET_TRUSTED_DATA_POLICIES_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_GET_TRUSTED_DATA_POLICIES_SHORT_NAME}` as const;
export const TOOL_CREATE_TRUSTED_DATA_POLICY_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_CREATE_TRUSTED_DATA_POLICY_SHORT_NAME}` as const;
export const TOOL_GET_TRUSTED_DATA_POLICY_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_GET_TRUSTED_DATA_POLICY_SHORT_NAME}` as const;
export const TOOL_UPDATE_TRUSTED_DATA_POLICY_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_UPDATE_TRUSTED_DATA_POLICY_SHORT_NAME}` as const;
export const TOOL_DELETE_TRUSTED_DATA_POLICY_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_DELETE_TRUSTED_DATA_POLICY_SHORT_NAME}` as const;
export const TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_SHORT_NAME}` as const;
export const TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_SHORT_NAME}` as const;
export const TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME}` as const;
export const TOOL_CREATE_KNOWLEDGE_BASE_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_CREATE_KNOWLEDGE_BASE_SHORT_NAME}` as const;
export const TOOL_GET_KNOWLEDGE_BASES_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_GET_KNOWLEDGE_BASES_SHORT_NAME}` as const;
export const TOOL_GET_KNOWLEDGE_BASE_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_GET_KNOWLEDGE_BASE_SHORT_NAME}` as const;
export const TOOL_UPDATE_KNOWLEDGE_BASE_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_UPDATE_KNOWLEDGE_BASE_SHORT_NAME}` as const;
export const TOOL_DELETE_KNOWLEDGE_BASE_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_DELETE_KNOWLEDGE_BASE_SHORT_NAME}` as const;
export const TOOL_CREATE_KNOWLEDGE_CONNECTOR_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_CREATE_KNOWLEDGE_CONNECTOR_SHORT_NAME}` as const;
export const TOOL_GET_KNOWLEDGE_CONNECTORS_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_GET_KNOWLEDGE_CONNECTORS_SHORT_NAME}` as const;
export const TOOL_GET_KNOWLEDGE_CONNECTOR_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_GET_KNOWLEDGE_CONNECTOR_SHORT_NAME}` as const;
export const TOOL_UPDATE_KNOWLEDGE_CONNECTOR_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_UPDATE_KNOWLEDGE_CONNECTOR_SHORT_NAME}` as const;
export const TOOL_DELETE_KNOWLEDGE_CONNECTOR_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_DELETE_KNOWLEDGE_CONNECTOR_SHORT_NAME}` as const;
export const TOOL_ASSIGN_KNOWLEDGE_CONNECTOR_TO_KNOWLEDGE_BASE_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_ASSIGN_KNOWLEDGE_CONNECTOR_TO_KNOWLEDGE_BASE_SHORT_NAME}` as const;
export const TOOL_UNASSIGN_KNOWLEDGE_CONNECTOR_FROM_KNOWLEDGE_BASE_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_UNASSIGN_KNOWLEDGE_CONNECTOR_FROM_KNOWLEDGE_BASE_SHORT_NAME}` as const;
export const TOOL_ASSIGN_KNOWLEDGE_BASE_TO_AGENT_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_ASSIGN_KNOWLEDGE_BASE_TO_AGENT_SHORT_NAME}` as const;
export const TOOL_UNASSIGN_KNOWLEDGE_BASE_FROM_AGENT_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_UNASSIGN_KNOWLEDGE_BASE_FROM_AGENT_SHORT_NAME}` as const;
export const TOOL_ASSIGN_KNOWLEDGE_CONNECTOR_TO_AGENT_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_ASSIGN_KNOWLEDGE_CONNECTOR_TO_AGENT_SHORT_NAME}` as const;
export const TOOL_UNASSIGN_KNOWLEDGE_CONNECTOR_FROM_AGENT_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_UNASSIGN_KNOWLEDGE_CONNECTOR_FROM_AGENT_SHORT_NAME}` as const;
export const TOOL_TODO_WRITE_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_TODO_WRITE_SHORT_NAME}` as const;
export const TOOL_SWAP_AGENT_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_SWAP_AGENT_SHORT_NAME}` as const;
export const TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME}` as const;
export const TOOL_ARTIFACT_WRITE_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_ARTIFACT_WRITE_SHORT_NAME}` as const;

export const DEFAULT_ARCHESTRA_TOOL_NAMES: readonly string[] = [
  TOOL_ARTIFACT_WRITE_FULL_NAME,
  TOOL_TODO_WRITE_FULL_NAME,
  TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
];

export const DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES = [
  TOOL_ARTIFACT_WRITE_SHORT_NAME,
  TOOL_TODO_WRITE_SHORT_NAME,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
] as const satisfies readonly ArchestraToolShortName[];

export function isArchestraMcpServerTool(
  toolName: string,
  options?: ArchestraMcpIdentityOptions & { includeDefaultPrefix?: boolean },
): toolName is ArchestraToolFullName {
  return getArchestraToolShortName(toolName, options) !== null;
}

export function getArchestraToolShortName(
  toolName: string,
  options?: ArchestraMcpIdentityOptions & { includeDefaultPrefix?: boolean },
): ArchestraToolShortName | null {
  const { serverName, toolName: rawToolName } = parseArchestraToolName({
    toolName,
    options,
  });

  if (!serverName || !isArchestraToolShortName(rawToolName)) {
    return null;
  }

  return rawToolName;
}

export function getArchestraToolFullName<
  ShortName extends ArchestraToolShortName,
>(shortName: ShortName): ArchestraToolFullName<ShortName>;
export function getArchestraToolFullName<
  ShortName extends ArchestraToolShortName,
>(shortName: ShortName, options: ArchestraMcpIdentityOptions): string;
export function getArchestraToolFullName<
  ShortName extends ArchestraToolShortName,
>(
  shortName: ShortName,
  options?: ArchestraMcpIdentityOptions,
): ArchestraToolFullName<ShortName> | string {
  return `${getArchestraToolPrefix(options)}${shortName}`;
}

function isArchestraToolShortName(
  shortName: string,
): shortName is ArchestraToolShortName {
  return (ARCHESTRA_TOOL_SHORT_NAMES as readonly string[]).includes(shortName);
}

export function getArchestraMcpCatalogName(
  options?: ArchestraMcpIdentityOptions,
): string {
  if (!options?.fullWhiteLabeling) {
    return DEFAULT_APP_NAME;
  }

  const trimmedAppName = options.appName?.trim();
  return trimmedAppName || DEFAULT_APP_NAME;
}

export function getArchestraMcpServerName(
  options?: ArchestraMcpIdentityOptions,
): string {
  if (!options?.fullWhiteLabeling) {
    return ARCHESTRA_MCP_SERVER_NAME;
  }

  const catalogName = getArchestraMcpCatalogName(options);
  const brandedServerName = slugify(catalogName);
  return brandedServerName || ARCHESTRA_MCP_SERVER_NAME;
}

export function getArchestraToolPrefix(
  options?: ArchestraMcpIdentityOptions,
): string {
  return `${getArchestraMcpServerName(options)}${MCP_SERVER_TOOL_NAME_SEPARATOR}`;
}

function parseArchestraToolName(params: {
  toolName: string;
  options?: ArchestraMcpIdentityOptions & { includeDefaultPrefix?: boolean };
}): { serverName: string | null; toolName: string } {
  const { toolName, options } = params;
  const separatorIndex = toolName.lastIndexOf(MCP_SERVER_TOOL_NAME_SEPARATOR);
  if (separatorIndex <= 0) {
    return { serverName: null, toolName };
  }

  const serverName = toolName.slice(0, separatorIndex);
  const rawToolName = toolName.slice(
    separatorIndex + MCP_SERVER_TOOL_NAME_SEPARATOR.length,
  );
  const allowedServerNames = new Set<string>([
    getArchestraMcpServerName(options),
  ]);

  if (options?.includeDefaultPrefix !== false) {
    allowedServerNames.add(ARCHESTRA_MCP_SERVER_NAME);
  }

  if (!allowedServerNames.has(serverName)) {
    return { serverName: null, toolName: rawToolName };
  }

  return { serverName, toolName: rawToolName };
}
