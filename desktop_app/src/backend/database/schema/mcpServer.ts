import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';

import {
  type AuthorizationServerMetadata,
  AuthorizationServerMetadataSchema,
  type OAuthClientInformation,
  OAuthClientInformationSchema,
  type OAuthProtectedResourceMetadata,
  OAuthProtectedResourceMetadataSchema,
  type OAuthTokens,
  OAuthTokensSchema,
} from './oauth';

/**
 * MCP Server Status Enum
 */
export const McpServerStatusSchema = z.enum(['installing', 'oauth_pending', 'installed', 'failed']);
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;

/**
 * MCP Server Type Enum
 */
export const McpServerTypeSchema = z.enum(['local', 'remote']);
export type McpServerType = z.infer<typeof McpServerTypeSchema>;

export const LogMonitorSchema = z.object({
  type: z.enum(['log-monitor']),
  provider: z.enum(['whatsapp']),
});
export type LogMonitorProvider = z.infer<typeof LogMonitorSchema>['provider'];

/**
 * Borrowed from @anthropic-ai/dxt
 *
 * https://github.com/anthropics/dxt/blob/v0.2.6/src/schemas.ts#L3-L7
 */
export const McpServerConfigSchema = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    inject_file: z.record(z.string(), z.string()).optional(), // filename -> file content
    /** Mcp setup which is performed after server start. The only setup available now is adding a log monitor. */
    setup: z.array(LogMonitorSchema).optional(),
  })
  .passthrough();

export const McpServerUserConfigValuesSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])
);

export const mcpServersTable = sqliteTable('mcp_servers', {
  /**
   * Catalog "name" (unique identifier) or UUID for custom servers
   */
  id: text().primaryKey(),
  /**
   * Display name (from catalog or user-defined for custom)
   */
  name: text().notNull(),
  /**
   * https://orm.drizzle.team/docs/column-types/sqlite#blob
   */
  serverConfig: text({ mode: 'json' }).$type<z.infer<typeof McpServerConfigSchema>>().notNull(),
  /**
   * `userConfigValues` are user-provided/custom values for `DxtManifestMcpConfig`
   * (think API keys, etc)
   *
   * This is only used for mcp servers installed via the catalog, as it allows users to provide
   * dynamic configuration
   *
   * See https://github.com/anthropics/dxt/blob/main/MANIFEST.md#variable-substitution-in-user-configuration
   */
  userConfigValues: text({ mode: 'json' }).$type<z.infer<typeof McpServerUserConfigValuesSchema>>(),
  /**
   * OAuth tokens object - matches OAuthTokens interface from MCP SDK
   * Stores access_token, refresh_token, expires_in, token_type, scope, etc.
   */
  oauthTokens: text('oauth_tokens', { mode: 'json' }).$type<OAuthTokens>(),
  /**
   * OAuth client information - matches OAuthClientInformation interface from MCP SDK
   * Stores client_id, client_secret (for static registration or dynamic registration result)
   */
  oauthClientInfo: text('oauth_client_info', { mode: 'json' }).$type<OAuthClientInformation>(),
  /**
   * OAuth authorization server metadata - matches AuthorizationServerMetadata interface from MCP SDK
   * Stores OAuth discovery metadata per RFC 8414 (issuer, endpoints, scopes_supported, etc.)
   */
  oauthServerMetadata: text('oauth_server_metadata', { mode: 'json' }).$type<AuthorizationServerMetadata>(),
  /**
   * OAuth protected resource metadata - matches OAuthProtectedResourceMetadata interface from MCP SDK
   * Stores resource-specific OAuth metadata (resource identifier, required scopes, etc.)
   */
  oauthResourceMetadata: text('oauth_resource_metadata', { mode: 'json' }).$type<OAuthProtectedResourceMetadata>(),
  /**
   * OAuth server configuration from catalog (contains streamable_http_url, etc.)
   */
  oauthConfig: text('oauth_config', { mode: 'json' }),
  /**
   * Current status of the MCP server installation/OAuth flow
   */
  status: text().notNull().default('installing').$type<McpServerStatus>(),
  /**
   * Type of MCP server (local container or remote service)
   */
  serverType: text('server_type').notNull().default('local').$type<McpServerType>(),
  /**
   * Remote URL for remote MCP servers (null for local servers)
   */
  remoteUrl: text('remote_url'),
  createdAt: text()
    .notNull()
    .default(sql`(current_timestamp)`),
});

/**
 * Pure Zod schema for OpenAPI generation
 * This matches the structure of the database table but uses pure Zod types
 */
export const McpServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  serverConfig: McpServerConfigSchema,
  userConfigValues: McpServerUserConfigValuesSchema.nullable(),
  oauthTokens: OAuthTokensSchema.nullable(),
  oauthClientInfo: OAuthClientInformationSchema.nullable(),
  oauthServerMetadata: AuthorizationServerMetadataSchema.nullable(),
  oauthResourceMetadata: OAuthProtectedResourceMetadataSchema.nullable(),
  oauthConfig: z.unknown().nullable(), // JSON object containing OAuth config from catalog (parsed by Drizzle)
  status: McpServerStatusSchema,
  serverType: McpServerTypeSchema,
  remoteUrl: z.string().nullable(),
  createdAt: z.string(),
});

export type McpServer = z.infer<typeof McpServerSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpServerUserConfigValues = z.infer<typeof McpServerUserConfigValuesSchema>;
