import { z } from 'zod';

/**
 * OAuth Server Configuration Schema
 *
 * Based on the ServerConfig interface from mcp-oauth/configs.ts
 * This schema validates OAuth configurations passed from the frontend
 */
export const OAuthServerConfigSchema = z.object({
  name: z.string(),
  server_url: z.string().url(),
  auth_server_url: z.string().url().optional(), // Optional, defaults to server_url
  resource_metadata_url: z.string().url().optional(),
  client_id: z.string(),
  client_secret: z.string().optional(), // Optional for public clients, can contain env var references
  redirect_uris: z.array(z.string().url()),
  scopes: z.array(z.string()),
  description: z.string().optional(),
  well_known_url: z.string().url().optional(), // Optional specific well-known URL for this provider
  default_scopes: z.array(z.string()), // Fallback scopes when discovery fails
  supports_resource_metadata: z.boolean(), // Whether to attempt resource metadata discovery
  generic_oauth: z.boolean().optional(), // Use generic OAuth 2.0 flow instead of MCP SDK
  token_endpoint: z.string().url().optional(), // Token endpoint for generic OAuth
  access_token_env_var: z.string().optional(), // Environment variable name to store access token
});

export type OAuthServerConfig = z.infer<typeof OAuthServerConfigSchema>;

// Register the schema in the global registry for OpenAPI generation
z.globalRegistry.add(OAuthServerConfigSchema, { id: 'OAuthServerConfig' });
