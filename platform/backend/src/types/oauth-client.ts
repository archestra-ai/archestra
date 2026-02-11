/**
 * CIMD metadata document — the wire format defined by the MCP spec.
 * Field names use snake_case to match the specification.
 *
 * See: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#client-id-metadata-documents
 */
export interface CimdMetadata {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  scope?: string;
  contacts?: string[];
  logo_uri?: string;
  client_uri?: string;
  policy_uri?: string;
  tos_uri?: string;
  software_id?: string;
  software_version?: string;
}

/**
 * Data shape for upserting an OAuth client from a CIMD document.
 * Field names use camelCase to match the database schema.
 */
export interface CimdUpsertData {
  id: string;
  clientId: string;
  name: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  isPublic: boolean;
  metadata: Record<string, unknown>;
  contacts?: string[];
  uri?: string;
  policy?: string;
  tos?: string;
  softwareId?: string;
  softwareVersion?: string;
}
