import { z } from 'zod';

/**
 * MCP SDK OAuth object schemas
 * These schemas match the interfaces from @modelcontextprotocol/sdk/shared/auth.js
 */

/**
 * OAuth tokens schema - matches OAuthTokens interface from MCP SDK
 */
export const OAuthTokensSchema = z
  .strictObject({
    /** The access token issued by the authorization server */
    access_token: z.string(),
    /** The refresh token (optional) */
    refresh_token: z.string().optional(),
    /** The lifetime in seconds of the access token (optional) */
    expires_in: z.number().optional(),
    /** The type of the token (optional) */
    token_type: z.string().optional(),
    /** The scope of the access token (optional) */
    scope: z.string().optional(),
    /** Additional provider-specific fields */
  })
  .passthrough(); // Allow additional fields for provider-specific data

/**
 * OAuth client information schema - matches OAuthClientInformation interface from MCP SDK
 */
export const OAuthClientInformationSchema = z
  .strictObject({
    /** The client identifier */
    client_id: z.string(),
    /** The client secret (optional for public clients) */
    client_secret: z.string().optional(),
    /** Additional client metadata */
  })
  .passthrough(); // Allow additional fields

/**
 * Authorization server metadata schema - matches AuthorizationServerMetadata interface from MCP SDK
 */
export const AuthorizationServerMetadataSchema = z
  .strictObject({
    /** The authorization server's issuer identifier */
    issuer: z.string().optional(),
    /** The authorization endpoint URL */
    authorization_endpoint: z.string().optional(),
    /** The token endpoint URL */
    token_endpoint: z.string().optional(),
    /** The token revocation endpoint URL (optional) */
    revocation_endpoint: z.string().optional(),
    /** The scopes supported by the authorization server (optional) */
    scopes_supported: z.array(z.string()).optional(),
    /** Additional discovery metadata */
  })
  .passthrough(); // Allow additional OAuth discovery fields

/**
 * OAuth protected resource metadata schema - matches OAuthProtectedResourceMetadata interface from MCP SDK
 */
export const OAuthProtectedResourceMetadataSchema = z
  .strictObject({
    /** The resource server's identifier (optional) */
    resource: z.string().optional(),
    /** The scopes required to access this resource (optional) */
    scopes_supported: z.array(z.string()).optional(),
    /** Additional resource-specific metadata */
  })
  .passthrough(); // Allow additional fields

// Type exports for TypeScript usage
export type OAuthTokens = z.infer<typeof OAuthTokensSchema>;
export type OAuthClientInformation = z.infer<typeof OAuthClientInformationSchema>;
export type AuthorizationServerMetadata = z.infer<typeof AuthorizationServerMetadataSchema>;
export type OAuthProtectedResourceMetadata = z.infer<typeof OAuthProtectedResourceMetadataSchema>;

// Register schemas in global registry for OpenAPI generation
z.globalRegistry.add(OAuthTokensSchema, { id: 'OAuthTokens' });
z.globalRegistry.add(OAuthClientInformationSchema, { id: 'OAuthClientInformation' });
z.globalRegistry.add(AuthorizationServerMetadataSchema, { id: 'AuthorizationServerMetadata' });
z.globalRegistry.add(OAuthProtectedResourceMetadataSchema, { id: 'OAuthProtectedResourceMetadata' });
