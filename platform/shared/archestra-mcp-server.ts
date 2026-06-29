// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
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
// Turn the current chat into a project (moves the chat + its files into a new project).
export const TOOL_CREATE_PROJECT_FROM_CONVERSATION_SHORT_NAME =
  "create_project_from_conversation";
export const TOOL_SEARCH_TOOLS_SHORT_NAME = "search_tools";
export const TOOL_RUN_TOOL_SHORT_NAME = "run_tool";
export const TOOL_LIST_SKILLS_SHORT_NAME = "list_skills";
export const TOOL_LOAD_SKILL_SHORT_NAME = "load_skill";
export const TOOL_CREATE_SKILL_SHORT_NAME = "create_skill";
export const TOOL_UPDATE_SKILL_SHORT_NAME = "update_skill";
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
  TOOL_CREATE_PROJECT_FROM_CONVERSATION_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_LIST_SKILLS_SHORT_NAME,
  TOOL_LOAD_SKILL_SHORT_NAME,
  TOOL_CREATE_SKILL_SHORT_NAME,
  TOOL_UPDATE_SKILL_SHORT_NAME,
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
export const TOOL_ARTIFACT_WRITE_FULL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_ARTIFACT_WRITE_SHORT_NAME}` as const;
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
  TOOL_ARTIFACT_WRITE_FULL_NAME,
  TOOL_TODO_WRITE_FULL_NAME,
  TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
];

export const DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES = [
  TOOL_ARTIFACT_WRITE_SHORT_NAME,
  TOOL_TODO_WRITE_SHORT_NAME,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
] as const satisfies readonly ArchestraToolShortName[];

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
] as const satisfies readonly ArchestraToolShortName[];

/**
 * MCP App management tools — assigned to new agents by default when the apps
 * feature (`ARCHESTRA_APPS_ENABLED`) is on, so "build me an app" works
 * without per-agent setup. delete_app completes the lifecycle but stays
 * search-gated in `search_and_run_only` mode (see
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
 * runtime — so their exposure and dynamic-access participation are driven by the
 * Projects feature flag (`config.projects.enabled`), not the runtime flag (see
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

const PROJECTS_FILE_ARCHESTRA_TOOL_SHORT_NAME_SET: ReadonlySet<string> =
  new Set(PROJECTS_FILE_ARCHESTRA_TOOL_SHORT_NAMES);

export function isProjectsFileArchestraToolShortName(
  shortName: string,
): boolean {
  return PROJECTS_FILE_ARCHESTRA_TOOL_SHORT_NAME_SET.has(shortName);
}

/**
 * tools that stay top-level in `tools/list` regardless of an agent's
 * exposure mode. skills and sandbox runtime interaction are
 * progressive-disclosure mechanisms, so hiding their discover/activate/read/run
 * and file-transfer path behind `search_tools`/`run_tool` would make the common
 * runtime flow depend on deferred tool loading. App tools stay top-level
 * because "build me an app" intents compete with the model's default of
 * writing code in the reply — the model won't search for a capability it
 * doesn't know exists, so the scaffold/read/edit/render authoring surface stays
 * top-level. delete_app stays behind search (destructive, never
 * intent-time-critical); preview_app_tool, get_app_diagnostics, and
 * set_app_tools likewise — they are follow-up steps the scaffold/edit tool
 * descriptions and the authoring guidance name explicitly, so the model reaches
 * them via run_tool once it is already building.
 */
export const ALWAYS_EXPOSED_ARCHESTRA_TOOL_SHORT_NAMES = [
  TOOL_LIST_SKILLS_SHORT_NAME,
  TOOL_LOAD_SKILL_SHORT_NAME,
  // The full sandbox + persistent-files surface stays top-level. delete_file is
  // included too (unlike delete_app, which stays behind search/run): deleting a
  // persistent file is part of the everyday file-management flow, not a rare
  // destructive escape hatch.
  ...SANDBOX_ARCHESTRA_TOOL_SHORT_NAMES,
  TOOL_SCAFFOLD_APP_SHORT_NAME,
  TOOL_REFINE_APP_SHORT_NAME,
  TOOL_EDIT_APP_SHORT_NAME,
  TOOL_VALIDATE_APP_SHORT_NAME,
  TOOL_PUBLISH_APP_SHORT_NAME,
  TOOL_READ_APP_SHORT_NAME,
  TOOL_RENDER_APP_SHORT_NAME,
  TOOL_LIST_APPS_SHORT_NAME,
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
