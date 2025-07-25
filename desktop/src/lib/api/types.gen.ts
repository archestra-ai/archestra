// This file is auto-generated by @hey-api/openapi-ts

export type ConnectExternalMcpClientRequest = {
  client_name: string;
};

export type CreateMcpRequestLog = {
  client_info?: null | McpClientInfo;
  duration_ms?: number | null;
  error_message?: string | null;
  mcp_session_id?: string | null;
  method?: string | null;
  request_body?: string | null;
  request_headers?: {
    [key: string]: string;
  } | null;
  request_id: string;
  response_body?: string | null;
  response_headers?: {
    [key: string]: string;
  } | null;
  server_name: string;
  session_id?: string | null;
  status_code: number;
};

export type ExternalMcpClient = {
  client_name: string;
  created_at: string;
  updated_at: string;
};

export type InstallMcpServerRequest = {
  mcp_connector_id: string;
};

export type McpClientInfo = {
  client_name?: string | null;
  client_platform?: string | null;
  client_version?: string | null;
  user_agent?: string | null;
};

export type McpConnectorCatalogEntry = {
  author: string;
  category: string;
  description: string;
  homepage: string;
  id: string;
  image?: string | null;
  oauth?: null | McpConnectorCatalogEntryOAuth;
  repository: string;
  server_config: McpServerConfig;
  tags: Array<string>;
  title: string;
  version: string;
};

export type McpConnectorCatalogEntryOAuth = {
  provider: string;
  required: boolean;
};

export type McpoAuthResponse = {
  auth_url: string;
};

export type McpRequestLog = {
  client_info?: string | null;
  duration_ms?: number | null;
  error_message?: string | null;
  id: number;
  mcp_session_id?: string | null;
  method?: string | null;
  request_body?: string | null;
  request_headers?: string | null;
  request_id: string;
  response_body?: string | null;
  response_headers?: string | null;
  server_name: string;
  session_id?: string | null;
  status_code: number;
  timestamp: string;
};

export type McpRequestLogFilters = {
  end_time?: string | null;
  mcp_session_id?: string | null;
  method?: string | null;
  server_name?: string | null;
  session_id?: string | null;
  start_time?: string | null;
  status_code?: number | null;
};

export type McpRequestLogStats = {
  avg_duration_ms: number;
  error_count: number;
  requests_per_server: {
    [key: string]: number;
  };
  success_count: number;
  total_requests: number;
};

export type McpServer = {
  created_at: string;
  id: number;
  meta?: string | null;
  name: string;
  server_config: string;
};

export type McpServerConfig = {
  args: Array<string>;
  command: string;
  env: {
    [key: string]: string;
  };
  transport: string;
};

export type McpServerDefinition = {
  meta?: unknown;
  name: string;
  server_config: McpServerConfig;
};

export type PaginatedMcpRequestLogResponseMcpRequestLog = {
  data: Array<{
    client_info?: string | null;
    duration_ms?: number | null;
    error_message?: string | null;
    id: number;
    mcp_session_id?: string | null;
    method?: string | null;
    request_body?: string | null;
    request_headers?: string | null;
    request_id: string;
    response_body?: string | null;
    response_headers?: string | null;
    server_name: string;
    session_id?: string | null;
    status_code: number;
    timestamp: string;
  }>;
  page: number;
  page_size: number;
  total: number;
};

export type StartMcpServerOAuthRequest = {
  mcp_connector_id: string;
};

export type GetConnectedExternalMcpClientsData = {
  body?: never;
  path?: never;
  query?: never;
  url: '/api/external_mcp_client';
};

export type GetConnectedExternalMcpClientsErrors = {
  /**
   * Internal server error
   */
  500: unknown;
};

export type GetConnectedExternalMcpClientsResponses = {
  /**
   * List of connected external MCP clients
   */
  200: Array<ExternalMcpClient>;
};

export type GetConnectedExternalMcpClientsResponse =
  GetConnectedExternalMcpClientsResponses[keyof GetConnectedExternalMcpClientsResponses];

export type ConnectExternalMcpClientData = {
  body: ConnectExternalMcpClientRequest;
  path?: never;
  query?: never;
  url: '/api/external_mcp_client/connect';
};

export type ConnectExternalMcpClientErrors = {
  /**
   * Internal server error
   */
  500: unknown;
};

export type ConnectExternalMcpClientResponses = {
  /**
   * External MCP client connected successfully
   */
  200: unknown;
};

export type GetSupportedExternalMcpClientsData = {
  body?: never;
  path?: never;
  query?: never;
  url: '/api/external_mcp_client/supported';
};

export type GetSupportedExternalMcpClientsErrors = {
  /**
   * Internal server error
   */
  500: unknown;
};

export type GetSupportedExternalMcpClientsResponses = {
  /**
   * List of supported external MCP client names
   */
  200: Array<string>;
};

export type GetSupportedExternalMcpClientsResponse =
  GetSupportedExternalMcpClientsResponses[keyof GetSupportedExternalMcpClientsResponses];

export type DisconnectExternalMcpClientData = {
  body?: never;
  path: {
    /**
     * Name of the external MCP client to disconnect
     */
    client_name: string;
  };
  query?: never;
  url: '/api/external_mcp_client/{client_name}/disconnect';
};

export type DisconnectExternalMcpClientErrors = {
  /**
   * Internal server error
   */
  500: unknown;
};

export type DisconnectExternalMcpClientResponses = {
  /**
   * External MCP client disconnected successfully
   */
  200: unknown;
};

export type ClearMcpRequestLogsData = {
  body?: never;
  path?: never;
  query?: {
    clear_all?: boolean | null;
  };
  url: '/api/mcp_request_log';
};

export type ClearMcpRequestLogsErrors = {
  /**
   * Internal server error
   */
  500: unknown;
};

export type ClearMcpRequestLogsResponses = {
  /**
   * Number of deleted log entries
   */
  200: number;
};

export type ClearMcpRequestLogsResponse = ClearMcpRequestLogsResponses[keyof ClearMcpRequestLogsResponses];

export type GetMcpRequestLogsData = {
  body?: never;
  path?: never;
  query?: {
    server_name?: string | null;
    session_id?: string | null;
    mcp_session_id?: string | null;
    status_code?: number | null;
    method?: string | null;
    start_time?: string | null;
    end_time?: string | null;
    page?: number | null;
    page_size?: number | null;
  };
  url: '/api/mcp_request_log';
};

export type GetMcpRequestLogsErrors = {
  /**
   * Internal server error
   */
  500: unknown;
};

export type GetMcpRequestLogsResponses = {
  /**
   * Paginated list of MCP request logs
   */
  200: PaginatedMcpRequestLogResponseMcpRequestLog;
};

export type GetMcpRequestLogsResponse = GetMcpRequestLogsResponses[keyof GetMcpRequestLogsResponses];

export type GetMcpRequestLogStatsData = {
  body?: never;
  path?: never;
  query?: {
    server_name?: string | null;
    session_id?: string | null;
    mcp_session_id?: string | null;
    status_code?: number | null;
    method?: string | null;
    start_time?: string | null;
    end_time?: string | null;
    page?: number | null;
    page_size?: number | null;
  };
  url: '/api/mcp_request_log/stats';
};

export type GetMcpRequestLogStatsErrors = {
  /**
   * Internal server error
   */
  500: unknown;
};

export type GetMcpRequestLogStatsResponses = {
  /**
   * Request log statistics
   */
  200: McpRequestLogStats;
};

export type GetMcpRequestLogStatsResponse = GetMcpRequestLogStatsResponses[keyof GetMcpRequestLogStatsResponses];

export type GetMcpRequestLogByIdData = {
  body?: never;
  path: {
    /**
     * Request ID to fetch
     */
    request_id: string;
  };
  query?: never;
  url: '/api/mcp_request_log/{request_id}';
};

export type GetMcpRequestLogByIdErrors = {
  /**
   * Invalid request ID format
   */
  400: unknown;
  /**
   * Internal server error
   */
  500: unknown;
};

export type GetMcpRequestLogByIdResponses = {
  /**
   * MCP request log if found
   */
  200: null | McpRequestLog;
};

export type GetMcpRequestLogByIdResponse = GetMcpRequestLogByIdResponses[keyof GetMcpRequestLogByIdResponses];

export type GetInstalledMcpServersData = {
  body?: never;
  path?: never;
  query?: never;
  url: '/api/mcp_server';
};

export type GetInstalledMcpServersErrors = {
  /**
   * Internal server error
   */
  500: unknown;
};

export type GetInstalledMcpServersResponses = {
  /**
   * List of installed MCP servers
   */
  200: Array<McpServer>;
};

export type GetInstalledMcpServersResponse = GetInstalledMcpServersResponses[keyof GetInstalledMcpServersResponses];

export type GetMcpConnectorCatalogData = {
  body?: never;
  path?: never;
  query?: never;
  url: '/api/mcp_server/catalog';
};

export type GetMcpConnectorCatalogErrors = {
  /**
   * Internal server error
   */
  500: unknown;
};

export type GetMcpConnectorCatalogResponses = {
  /**
   * MCP connector catalog
   */
  200: Array<McpConnectorCatalogEntry>;
};

export type GetMcpConnectorCatalogResponse = GetMcpConnectorCatalogResponses[keyof GetMcpConnectorCatalogResponses];

export type InstallMcpServerFromCatalogData = {
  body: InstallMcpServerRequest;
  path?: never;
  query?: never;
  url: '/api/mcp_server/catalog/install';
};

export type InstallMcpServerFromCatalogErrors = {
  /**
   * Internal server error
   */
  500: unknown;
};

export type InstallMcpServerFromCatalogResponses = {
  /**
   * MCP server installed successfully
   */
  200: unknown;
};

export type StartMcpServerOauthData = {
  body: StartMcpServerOAuthRequest;
  path?: never;
  query?: never;
  url: '/api/mcp_server/start_oauth';
};

export type StartMcpServerOauthErrors = {
  /**
   * Internal server error
   */
  500: unknown;
};

export type StartMcpServerOauthResponses = {
  /**
   * OAuth authorization URL
   */
  200: McpoAuthResponse;
};

export type StartMcpServerOauthResponse = StartMcpServerOauthResponses[keyof StartMcpServerOauthResponses];

export type UninstallMcpServerData = {
  body?: never;
  path: {
    /**
     * Name of the MCP server to uninstall
     */
    mcp_server_name: string;
  };
  query?: never;
  url: '/api/mcp_server/{mcp_server_name}';
};

export type UninstallMcpServerErrors = {
  /**
   * Internal server error
   */
  500: unknown;
};

export type UninstallMcpServerResponses = {
  /**
   * MCP server uninstalled successfully
   */
  200: unknown;
};

export type ClientOptions = {
  baseUrl: `${string}://openapi.json` | (string & {});
};
