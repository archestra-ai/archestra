// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
import { DEFAULT_APP_NAME, MCP_SERVER_TOOL_NAME_SEPARATOR } from "./consts";
import { parseFullToolName, slugify } from "./utils";

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
export const TOOL_RELOAD_MCP_SERVER_TOOLS_SHORT_NAME =
  "reload_mcp_server_tools";
export const TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_SHORT_NAME =
  "create_mcp_server_installation_request";
export const TOOL_CREATE_TEAM_SHORT_NAME = "create_team";
export const TOOL_GET_TEAM_SHORT_NAME = "get_team";
export const TOOL_LIST_TEAMS_SHORT_NAME = "list_teams";
export const TOOL_EDIT_TEAM_SHORT_NAME = "edit_team";
export const TOOL_DELETE_TEAM_SHORT_NAME = "delete_team";
export const TOOL_LIST_TEAM_MEMBERS_SHORT_NAME = "list_team_members";
export const TOOL_ADD_TEAM_MEMBER_SHORT_NAME = "add_team_member";
export const TOOL_UPDATE_TEAM_MEMBER_ROLE_SHORT_NAME =
  "update_team_member_role";
export const TOOL_REMOVE_TEAM_MEMBER_SHORT_NAME = "remove_team_member";
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
export const TOOL_BULK_REMOVE_TOOLS_FROM_AGENTS_SHORT_NAME =
  "bulk_remove_tools_from_agents";
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
// Turn the current chat into a project (moves the chat + its files into a new project).
export const TOOL_CREATE_PROJECT_FROM_CONVERSATION_SHORT_NAME =
  "create_project_from_conversation";
export const TOOL_SEARCH_TOOLS_SHORT_NAME = "search_tools";
export const TOOL_RUN_TOOL_SHORT_NAME = "run_tool";
export const TOOL_LIST_SKILLS_SHORT_NAME = "list_skills";
export const TOOL_LOAD_SKILL_SHORT_NAME = "load_skill";
export const TOOL_CREATE_SKILL_SHORT_NAME = "create_skill";
export const TOOL_UPDATE_SKILL_SHORT_NAME = "update_skill";
export const TOOL_EDIT_SKILL_SHORT_NAME = "edit_skill";
// code execution sandbox — implicit per-conversation sandbox; the create step
// is hidden (lazy default).
export const TOOL_RUN_COMMAND_SHORT_NAME = "run_command";
export const TOOL_DOWNLOAD_FILE_SHORT_NAME = "download_file";
export const TOOL_UPLOAD_FILE_SHORT_NAME = "upload_file";
// persistent files: produced by agents, scoped to a conversation (or a project)
export const TOOL_SEARCH_FILES_SHORT_NAME = "search_files";
export const TOOL_READ_FILE_SHORT_NAME = "read_file";
export const TOOL_SAVE_FILE_SHORT_NAME = "save_file";
export const TOOL_EDIT_FILE_SHORT_NAME = "edit_file";
export const TOOL_DELETE_FILE_SHORT_NAME = "delete_file";
// MCP Apps — authoring/management (chat) + per-app data store (app runtime).
export const TOOL_SCAFFOLD_APP_SHORT_NAME = "scaffold_app";
export const TOOL_REFINE_APP_SHORT_NAME = "refine_app";
export const TOOL_LIST_APPS_SHORT_NAME = "list_apps";
export const TOOL_RENDER_APP_SHORT_NAME = "render_app";
export const TOOL_READ_APP_SHORT_NAME = "read_app";
export const TOOL_EDIT_APP_SHORT_NAME = "edit_app";
export const TOOL_SET_APP_TOOLS_SHORT_NAME = "set_app_tools";
export const TOOL_VALIDATE_APP_SHORT_NAME = "validate_app";
export const TOOL_PUBLISH_APP_SHORT_NAME = "publish_app";
export const TOOL_DELETE_APP_SHORT_NAME = "delete_app";
export const TOOL_PREVIEW_APP_TOOL_SHORT_NAME = "preview_app_tool";
export const TOOL_GET_APP_DIAGNOSTICS_SHORT_NAME = "get_app_diagnostics";
export const TOOL_APP_DATA_GET_SHORT_NAME = "app_data_get";
export const TOOL_APP_DATA_SET_SHORT_NAME = "app_data_set";
export const TOOL_APP_DATA_LIST_SHORT_NAME = "app_data_list";
export const TOOL_APP_DATA_DELETE_SHORT_NAME = "app_data_delete";
export const TOOL_APP_LLM_COMPLETE_SHORT_NAME = "llm_complete";

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
  TOOL_RELOAD_MCP_SERVER_TOOLS_SHORT_NAME,
  TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_SHORT_NAME,
  TOOL_CREATE_TEAM_SHORT_NAME,
  TOOL_GET_TEAM_SHORT_NAME,
  TOOL_LIST_TEAMS_SHORT_NAME,
  TOOL_EDIT_TEAM_SHORT_NAME,
  TOOL_DELETE_TEAM_SHORT_NAME,
  TOOL_LIST_TEAM_MEMBERS_SHORT_NAME,
  TOOL_ADD_TEAM_MEMBER_SHORT_NAME,
  TOOL_UPDATE_TEAM_MEMBER_ROLE_SHORT_NAME,
  TOOL_REMOVE_TEAM_MEMBER_SHORT_NAME,
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
  TOOL_BULK_REMOVE_TOOLS_FROM_AGENTS_SHORT_NAME,
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
  TOOL_CREATE_PROJECT_FROM_CONVERSATION_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_LIST_SKILLS_SHORT_NAME,
  TOOL_LOAD_SKILL_SHORT_NAME,
  TOOL_CREATE_SKILL_SHORT_NAME,
  TOOL_UPDATE_SKILL_SHORT_NAME,
  TOOL_EDIT_SKILL_SHORT_NAME,
  TOOL_RUN_COMMAND_SHORT_NAME,
  TOOL_DOWNLOAD_FILE_SHORT_NAME,
  TOOL_UPLOAD_FILE_SHORT_NAME,
  TOOL_SEARCH_FILES_SHORT_NAME,
  TOOL_READ_FILE_SHORT_NAME,
  TOOL_SAVE_FILE_SHORT_NAME,
  TOOL_EDIT_FILE_SHORT_NAME,
  TOOL_DELETE_FILE_SHORT_NAME,
  TOOL_SCAFFOLD_APP_SHORT_NAME,
  TOOL_REFINE_APP_SHORT_NAME,
  TOOL_LIST_APPS_SHORT_NAME,
  TOOL_RENDER_APP_SHORT_NAME,
  TOOL_READ_APP_SHORT_NAME,
  TOOL_EDIT_APP_SHORT_NAME,
  TOOL_SET_APP_TOOLS_SHORT_NAME,
  TOOL_VALIDATE_APP_SHORT_NAME,
  TOOL_PUBLISH_APP_SHORT_NAME,
  TOOL_DELETE_APP_SHORT_NAME,
  TOOL_PREVIEW_APP_TOOL_SHORT_NAME,
  TOOL_GET_APP_DIAGNOSTICS_SHORT_NAME,
  TOOL_APP_DATA_GET_SHORT_NAME,
  TOOL_APP_DATA_SET_SHORT_NAME,
  TOOL_APP_DATA_LIST_SHORT_NAME,
  TOOL_APP_DATA_DELETE_SHORT_NAME,
  TOOL_APP_LLM_COMPLETE_SHORT_NAME,
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
export const TOOL_SEARCH_TOOLS_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_SEARCH_TOOLS_SHORT_NAME}` as const;
export const TOOL_RUN_TOOL_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_RUN_TOOL_SHORT_NAME}` as const;
export const TOOL_LIST_SKILLS_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_LIST_SKILLS_SHORT_NAME}` as const;
export const TOOL_LOAD_SKILL_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_LOAD_SKILL_SHORT_NAME}` as const;
export const TOOL_CREATE_SKILL_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_CREATE_SKILL_SHORT_NAME}` as const;
export const TOOL_UPDATE_SKILL_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_UPDATE_SKILL_SHORT_NAME}` as const;
export const TOOL_EDIT_SKILL_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_EDIT_SKILL_SHORT_NAME}` as const;
export const TOOL_RUN_COMMAND_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_RUN_COMMAND_SHORT_NAME}` as const;
export const TOOL_DOWNLOAD_FILE_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_DOWNLOAD_FILE_SHORT_NAME}` as const;
export const TOOL_UPLOAD_FILE_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_UPLOAD_FILE_SHORT_NAME}` as const;
export const TOOL_SEARCH_FILES_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_SEARCH_FILES_SHORT_NAME}` as const;
export const TOOL_READ_FILE_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_READ_FILE_SHORT_NAME}` as const;
export const TOOL_SAVE_FILE_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_SAVE_FILE_SHORT_NAME}` as const;
export const TOOL_EDIT_FILE_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_EDIT_FILE_SHORT_NAME}` as const;
export const TOOL_DELETE_FILE_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_DELETE_FILE_SHORT_NAME}` as const;

export const DEFAULT_ARCHESTRA_TOOL_NAMES: readonly string[] = [
  TOOL_TODO_WRITE_FULL_NAME,
  TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
];

export const DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES = [
  TOOL_TODO_WRITE_SHORT_NAME,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
] as const satisfies readonly ArchestraToolShortName[];

/**
 * Built-in tools that do NOT bypass policy evaluation. Most built-ins are
 * auto-trusted, but these ingest external content (e.g. knowledge-base
 * documents) that can carry prompt injection, so their invocations and
 * results are evaluated by tool invocation and trusted data policies just
 * like external tools.
 */
export const POLICY_EVALUATED_ARCHESTRA_TOOL_SHORT_NAMES: ReadonlySet<ArchestraToolShortName> =
  new Set([TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME]);

/**
 * Agent Skill tools — only assigned to agents once an org admin opts in via
 * the "Enable and create a new skill" empty-state action on /skills
 * (sets `organization.skillToolsEnabled`).
 */
export const SKILL_ARCHESTRA_TOOL_SHORT_NAMES = [
  TOOL_LIST_SKILLS_SHORT_NAME,
  TOOL_LOAD_SKILL_SHORT_NAME,
  TOOL_CREATE_SKILL_SHORT_NAME,
  TOOL_UPDATE_SKILL_SHORT_NAME,
  TOOL_EDIT_SKILL_SHORT_NAME,
] as const satisfies readonly ArchestraToolShortName[];

const SKILL_RUNTIME_TOOL_SHORT_NAMES: ReadonlySet<string> = new Set(
  SKILL_ARCHESTRA_TOOL_SHORT_NAMES,
);

/**
 * True for an Archestra skill-runtime/plumbing tool (list, load, create,
 * update), regardless of its server prefix. Every skill-enabled agent carries
 * the whole set once its org opts in, so recommending them inside a generated
 * skill is circular noise. Matched by short name (prefix stripped) so
 * white-labeled tool prefixes are caught too.
 */
export function isSkillRuntimeTool(toolName: string): boolean {
  const { toolName: shortName } = parseFullToolName(toolName);
  return SKILL_RUNTIME_TOOL_SHORT_NAMES.has(shortName);
}

/**
 * MCP App management tools — assigned to new agents by default, so "build me
 * an app" works without per-agent setup. In `search_and_run_only` mode the
 * whole group is reached through `search_tools`/`run_tool` (see
 * ALWAYS_EXPOSED_ARCHESTRA_TOOL_SHORT_NAMES).
 */
export const APP_ARCHESTRA_TOOL_SHORT_NAMES = [
  TOOL_SCAFFOLD_APP_SHORT_NAME,
  TOOL_REFINE_APP_SHORT_NAME,
  TOOL_EDIT_APP_SHORT_NAME,
  TOOL_SET_APP_TOOLS_SHORT_NAME,
  TOOL_VALIDATE_APP_SHORT_NAME,
  TOOL_PUBLISH_APP_SHORT_NAME,
  TOOL_READ_APP_SHORT_NAME,
  TOOL_PREVIEW_APP_TOOL_SHORT_NAME,
  TOOL_GET_APP_DIAGNOSTICS_SHORT_NAME,
  TOOL_RENDER_APP_SHORT_NAME,
  TOOL_LIST_APPS_SHORT_NAME,
  TOOL_DELETE_APP_SHORT_NAME,
] as const satisfies readonly ArchestraToolShortName[];

/**
 * Code-execution runtime tools. Gated by `sandbox:execute` and only seeded when
 * the skills-sandbox runtime is on (`config.skillsSandbox.enabled`). They
 * materialize a Dagger container, so they genuinely need the runtime, and they
 * participate in the `search_tools`/`run_tool` dynamic tool access relaxation
 * (see `dynamic-tools.ts`) so a user with `sandbox:execute` can reach them
 * without a manual assignment.
 */
export const SANDBOX_RUNTIME_ARCHESTRA_TOOL_SHORT_NAMES = [
  TOOL_RUN_COMMAND_SHORT_NAME,
  TOOL_DOWNLOAD_FILE_SHORT_NAME,
  TOOL_UPLOAD_FILE_SHORT_NAME,
] as const satisfies readonly ArchestraToolShortName[];

/**
 * Persistent-files ("My Files" / Projects) tools. Also gated by `sandbox:execute`,
 * but they operate purely on persistent file storage and never touch the Dagger
 * runtime — their exposure and dynamic-access participation follow the sandbox
 * runtime flag (`config.skillsSandbox.enabled`), like the runtime tools (see
 * `dynamic-tools.ts` and the backend `index.ts` registration gate).
 */
export const PROJECTS_FILE_ARCHESTRA_TOOL_SHORT_NAMES = [
  TOOL_SEARCH_FILES_SHORT_NAME,
  TOOL_READ_FILE_SHORT_NAME,
  TOOL_SAVE_FILE_SHORT_NAME,
  TOOL_EDIT_FILE_SHORT_NAME,
  TOOL_DELETE_FILE_SHORT_NAME,
] as const satisfies readonly ArchestraToolShortName[];

/**
 * The full sandbox tool group (runtime + persistent-files). All share the
 * `sandbox:execute` RBAC permission and require the runtime to execute.
 */
const SANDBOX_ARCHESTRA_TOOL_SHORT_NAMES = [
  ...SANDBOX_RUNTIME_ARCHESTRA_TOOL_SHORT_NAMES,
  ...PROJECTS_FILE_ARCHESTRA_TOOL_SHORT_NAMES,
] as const satisfies readonly ArchestraToolShortName[];

const SANDBOX_ARCHESTRA_TOOL_SHORT_NAME_SET: ReadonlySet<string> = new Set(
  SANDBOX_ARCHESTRA_TOOL_SHORT_NAMES,
);

export function isSandboxArchestraToolShortName(shortName: string): boolean {
  return SANDBOX_ARCHESTRA_TOOL_SHORT_NAME_SET.has(shortName);
}

/**
 * The built-in tool set assigned to a new agent at creation, composed from
 * the deployment/org feature flags:
 * - the always-on defaults (todo_write, query_knowledge_sources),
 * - the MCP App management tools (the apps feature is always on),
 * - the skill tools when the org opted in (`organization.skillToolsEnabled`),
 * - the sandbox runtime + persistent-files tools when the skills-sandbox
 *   runtime is on (`config.skillsSandbox.enabled`) — mirroring
 *   `assignSandboxToolsToAgent`.
 *
 * Single source of truth for creation defaults: the backend assigns exactly
 * this set in `AgentModel.create`, and the frontend create form pre-selects
 * it, so the two cannot drift.
 */
export function getCreationDefaultArchestraToolShortNames(params: {
  skillsEnabled: boolean;
  sandboxEnabled: boolean;
}): ArchestraToolShortName[] {
  const { skillsEnabled, sandboxEnabled } = params;

  const shortNames: ArchestraToolShortName[] = [
    ...DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES,
  ];
  if (skillsEnabled) {
    shortNames.push(...SKILL_ARCHESTRA_TOOL_SHORT_NAMES);
  }
  shortNames.push(...APP_ARCHESTRA_TOOL_SHORT_NAMES);
  if (sandboxEnabled) {
    shortNames.push(...SANDBOX_RUNTIME_ARCHESTRA_TOOL_SHORT_NAMES);
    shortNames.push(...PROJECTS_FILE_ARCHESTRA_TOOL_SHORT_NAMES);
  }
  return shortNames;
}

/**
 * Built-in tools exempt from the "All tools" exclusion pre-fill. When an
 * agent is created in (or switched to) All-tools mode, every unassigned
 * built-in tool is pre-added to its exclusion list EXCEPT this set: the
 * search_tools/run_tool dispatch surface that All-tools mode runs on, the
 * sandbox runtime + persistent-files tools, the skill tools, and
 * query_knowledge_sources. Skill tools are part of the default agent surface
 * (every org gets the opt-in enabled at startup), so pre-disabling them for
 * All-tools agents would diverge from what a newly created agent gets.
 */
const PREFILL_EXEMPT_ARCHESTRA_TOOL_SHORT_NAMES = [
  TOOL_SEARCH_TOOLS_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
  ...SANDBOX_ARCHESTRA_TOOL_SHORT_NAMES,
  ...SKILL_ARCHESTRA_TOOL_SHORT_NAMES,
] as const satisfies readonly ArchestraToolShortName[];

const PREFILL_EXEMPT_ARCHESTRA_TOOL_SHORT_NAME_SET: ReadonlySet<string> =
  new Set(PREFILL_EXEMPT_ARCHESTRA_TOOL_SHORT_NAMES);

export function isPrefillExemptArchestraToolShortName(
  shortName: string,
): boolean {
  return PREFILL_EXEMPT_ARCHESTRA_TOOL_SHORT_NAME_SET.has(shortName);
}

/**
 * tools that stay top-level in `tools/list` regardless of an agent's
 * exposure mode. skills and sandbox runtime interaction are
 * progressive-disclosure mechanisms, so hiding their discover/activate/read/run
 * and file-transfer path behind `search_tools`/`run_tool` would make the common
 * runtime flow depend on deferred tool loading. App tools are deliberately
 * absent: apps are a secondary flow, reached through `search_tools`/`run_tool`
 * and steered by the `search_and_run_only` system-prompt section, which names
 * the authoring tools verbatim so `run_tool` can dispatch them without a
 * search round-trip. Inline chat rendering of app results is unaffected — chat
 * resolves a `run_tool` call to its target tool before the app-render check.
 */
export const ALWAYS_EXPOSED_ARCHESTRA_TOOL_SHORT_NAMES = [
  TOOL_LIST_SKILLS_SHORT_NAME,
  TOOL_LOAD_SKILL_SHORT_NAME,
  // The full sandbox + persistent-files surface stays top-level. delete_file is
  // included too (unlike delete_app, which stays behind search/run): deleting a
  // persistent file is part of the everyday file-management flow, not a rare
  // destructive escape hatch.
  ...SANDBOX_ARCHESTRA_TOOL_SHORT_NAMES,
] as const satisfies readonly ArchestraToolShortName[];

const ALWAYS_EXPOSED_ARCHESTRA_TOOL_SHORT_NAME_SET: ReadonlySet<string> =
  new Set(ALWAYS_EXPOSED_ARCHESTRA_TOOL_SHORT_NAMES);

export function isAlwaysExposedArchestraToolShortName(
  shortName: string,
): boolean {
  return ALWAYS_EXPOSED_ARCHESTRA_TOOL_SHORT_NAME_SET.has(shortName);
}

/**
 * App-management tools whose successful result identifies a single owned MCP
 * App (`structuredContent.id`). Chat mounts the app-bound runtime inline for
 * these, so their results must keep `structuredContent` through the chat
 * serialization path. `list_apps`/`delete_app`/`read_app` deliberately excluded
 * — they render nothing (`read_app` returns source, not a new head to show).
 *
 * `scaffold_app` is excluded too: it only seeds the boilerplate starter
 * template, which is noise inline — the first `edit_app` (the first real build)
 * is the earliest render worth showing.
 */
export const APP_RENDERING_ARCHESTRA_TOOL_SHORT_NAMES = [
  TOOL_EDIT_APP_SHORT_NAME,
  TOOL_RENDER_APP_SHORT_NAME,
] as const satisfies readonly ArchestraToolShortName[];

const APP_RENDERING_ARCHESTRA_TOOL_SHORT_NAME_SET: ReadonlySet<string> =
  new Set(APP_RENDERING_ARCHESTRA_TOOL_SHORT_NAMES);

export function isAppRenderingArchestraToolShortName(
  shortName: string,
): boolean {
  return APP_RENDERING_ARCHESTRA_TOOL_SHORT_NAME_SET.has(shortName);
}

/**
 * Synthetic resource URI for an owned app's HTML. The app-bound MCP server
 * ignores the requested URI and always serves the head version, but hosts
 * need a stable identifier for the runtime's resource fetch and re-keying.
 */
export function getArchestraAppResourceUri(appId: string): string {
  return `ui://archestra-app/${appId}`;
}

/**
 * Inverse of {@link getArchestraAppResourceUri}: the owned-app id if `uri` is an
 * `ui://archestra-app/<appId>` URI, else null. A chat host uses this to route an
 * owned app's render (e.g. its `__open` launch tool) to the app-bound endpoint
 * instead of treating it as a generic external MCP-UI render.
 */
export function parseArchestraAppResourceUri(uri: string): string | null {
  const prefix = getArchestraAppResourceUri("");
  if (!uri.startsWith(prefix)) return null;
  const appId = uri.slice(prefix.length);
  return appId.length > 0 && !appId.includes("/") ? appId : null;
}

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

/**
 * Looser sibling of {@link isArchestraMcpServerTool} for the LLM-proxy
 * auto-discovery filter ONLY — never for tool dispatch, RBAC, or policy
 * evaluation, which must stay strict (use {@link getArchestraToolShortName}).
 *
 * Real MCP clients decorate our gateway tool names with their own labels, e.g.
 * `archestra_staging__my_mcp_gateway_1234567__run_tool`, where the client
 * inserts its own MCP-server label between our server name and the tool's short
 * name. The strict parser splits on the LAST `__` and requires everything
 * before it to be exactly an allowed server name, so it misses these decorated
 * twins and they get re-recorded as "discovered" proxy tools — duplicates of
 * tools we already serve.
 *
 * This matcher returns true when, after splitting the full name on
 * {@link MCP_SERVER_TOOL_NAME_SEPARATOR}:
 *  1. the trailing segment(s) form a known Archestra tool short name, AND
 *  2. some earlier segment equals one of the allowed server names (the default
 *     `archestra` or the org's branded name).
 *
 * Bare short names (`run_tool` with no server segment) are intentionally NOT
 * matched — an unrelated external MCP server could legitimately expose a tool
 * with the same short name, and there is no server segment to disambiguate.
 */
export function isLikelyArchestraToolName(
  toolName: string,
  options?: ArchestraMcpIdentityOptions & { includeDefaultPrefix?: boolean },
): boolean {
  // The canonical `<server>__<short>` shape is already covered strictly.
  if (getArchestraToolShortName(toolName, options) !== null) {
    return true;
  }

  const segments = toolName.split(MCP_SERVER_TOOL_NAME_SEPARATOR);
  // Need at least a server segment plus a short-name segment.
  if (segments.length < 2) {
    return false;
  }

  // Try each trailing-segment span as a candidate short name (from the longest
  // tail down to the last segment alone), requiring an allowed server name in
  // the segments that precede it. `tailStart >= 1` guarantees at least one
  // preceding segment to carry the server name, which also excludes bare short
  // names. This is a membership test, not a disambiguation: any matching span
  // wins, so the iteration order does not affect the result.
  for (let tailStart = 1; tailStart < segments.length; tailStart++) {
    const candidateShortName = segments
      .slice(tailStart)
      .join(MCP_SERVER_TOOL_NAME_SEPARATOR);
    if (!isArchestraToolShortName(candidateShortName)) {
      continue;
    }
    const precedesShortName = segments
      .slice(0, tailStart)
      .some((segment) => isAllowedServerName(segment, options));
    if (precedesShortName) {
      return true;
    }
  }

  return false;
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
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  if (!options?.fullWhiteLabeling) {
    return DEFAULT_APP_NAME;
  }

  const trimmedAppName = options.appName?.trim();
  return trimmedAppName || DEFAULT_APP_NAME;
  // SPDX-SnippetEnd
}

export function getArchestraMcpServerName(
  options?: ArchestraMcpIdentityOptions,
): string {
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  if (!options?.fullWhiteLabeling) {
    return ARCHESTRA_MCP_SERVER_NAME;
  }

  const catalogName = getArchestraMcpCatalogName(options);
  const brandedServerName = slugify(catalogName);
  return brandedServerName || ARCHESTRA_MCP_SERVER_NAME;
  // SPDX-SnippetEnd
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

  if (!isAllowedServerName(serverName, options)) {
    return { serverName: null, toolName: rawToolName };
  }

  return { serverName, toolName: rawToolName };
}

/**
 * Whether `serverName` is accepted as "one of ours": the org's (possibly
 * branded) server name, or the default `archestra` unless the caller opts out
 * via `includeDefaultPrefix: false`. A direct comparison rather than a Set —
 * it runs on every tool-name parse, so it must not allocate.
 */
function isAllowedServerName(
  serverName: string,
  options?: ArchestraMcpIdentityOptions & { includeDefaultPrefix?: boolean },
): boolean {
  return (
    serverName === getArchestraMcpServerName(options) ||
    (options?.includeDefaultPrefix !== false &&
      serverName === ARCHESTRA_MCP_SERVER_NAME)
  );
}
