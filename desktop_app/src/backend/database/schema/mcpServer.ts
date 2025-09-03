import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';

/**
 * Borrowed from @anthropic-ai/dxt
 *
 * https://github.com/anthropics/dxt/blob/v0.2.6/src/schemas.ts#L3-L7
 */
export const McpServerConfigSchema = z.strictObject({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

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
   * OAuth access token for servers that use OAuth authentication
   */
  oauthAccessToken: text('oauth_access_token'),
  /**
   * OAuth refresh token for servers that use OAuth authentication
   */
  oauthRefreshToken: text('oauth_refresh_token'),
  /**
   * OAuth token expiry date (as returned by provider, typically a timestamp or ISO date)
   */
  oauthExpiryDate: text('oauth_expiry_date'),
  /**
   * OAuth discovery metadata (JSON) - stores discovered OAuth server metadata per RFC 8414
   */
  oauthDiscoveryMetadata: text('oauth_discovery_metadata'),
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
  oauthAccessToken: z.string().nullable(),
  oauthRefreshToken: z.string().nullable(),
  oauthExpiryDate: z.string().nullable(),
  oauthDiscoveryMetadata: z.string().nullable(),
  createdAt: z.string(),
});

export type McpServer = z.infer<typeof McpServerSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpServerUserConfigValues = z.infer<typeof McpServerUserConfigValuesSchema>;
