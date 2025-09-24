import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

import db from '@backend/database';
import {
  McpServer,
  McpServerConfigSchema,
  McpServerSchema,
  McpServerUserConfigValuesSchema,
  mcpServersTable,
} from '@backend/database/schema/mcpServer';
import {
  AuthorizationServerMetadataSchema,
  OAuthClientInformationSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokensSchema,
} from '@backend/database/schema/oauth';
import ExternalMcpClientModel from '@backend/models/externalMcpClient';
import McpServerSandboxManager from '@backend/sandbox';
import { OAuthServerConfigSchema } from '@backend/schemas/oauth-config';
import { getBrowserAuthProvider, hasBrowserAuthProvider } from '@backend/server/plugins/browser-auth/provider-registry';
import log from '@backend/utils/logger';

// Define ArchestraConfig schema for proper validation
// Using z.any() but will validate structure when needed
const ArchestraConfigSchema = z.any().optional();

export const McpServerInstallSchema = z.object({
  id: z.string().optional(),
  displayName: z
    .string()
    /**
     * NOTE: they're certain naming restrictions/conventions that we should follow here
     * (this is because the name specified here ends up getting used as (part of) the MCP server's container name)
     *
     * See:
     * https://kubernetes.io/docs/concepts/overview/working-with-objects/names/#dns-subdomain-names
     */
    .regex(/^[A-Za-z0-9-\s]{1,63}$/, 'Name can only contain letters, numbers, spaces, and dashes (-)'),
  serverConfig: McpServerConfigSchema,
  userConfigValues: McpServerUserConfigValuesSchema.optional(),
  /** OAuth server configuration object from frontend */
  oauthConfig: OAuthServerConfigSchema.optional(),
  /** Complete OAuth tokens object from MCP SDK */
  oauthTokens: OAuthTokensSchema.optional(),
  /** OAuth client information from MCP SDK */
  oauthClientInfo: OAuthClientInformationSchema.optional(),
  /** OAuth server metadata from MCP SDK discovery */
  oauthServerMetadata: AuthorizationServerMetadataSchema.optional(),
  /** OAuth protected resource metadata from MCP SDK */
  oauthResourceMetadata: OAuthProtectedResourceMetadataSchema.optional(),
  /** Server installation status */
  status: z.enum(['installing', 'oauth_pending', 'installed', 'failed']).optional(),
  /** Server type (local container or remote service) */
  serverType: z.enum(['local', 'remote']).optional(),
  /** Remote URL for remote MCP servers */
  remote_url: z.string().optional(),
  /** Archestra configuration from catalog (includes browser_based config) */
  archestra_config: ArchestraConfigSchema.optional(),
});

export default class McpServerModel {
  static async create(data: typeof mcpServersTable.$inferInsert) {
    return db.insert(mcpServersTable).values(data).returning();
  }

  static async getAll() {
    return db.select().from(mcpServersTable);
  }

  static async getById(id: (typeof mcpServersTable.$inferSelect)['id']) {
    return db.select().from(mcpServersTable).where(eq(mcpServersTable.id, id));
  }

  static async update(
    id: (typeof mcpServersTable.$inferSelect)['id'],
    data: Partial<typeof mcpServersTable.$inferInsert>
  ) {
    return db.update(mcpServersTable).set(data).where(eq(mcpServersTable.id, id)).returning();
  }

  static async startServerAndSyncAllConnectedExternalMcpClients(mcpServer: McpServer) {
    await McpServerSandboxManager.startServer(mcpServer);
    await ExternalMcpClientModel.syncAllConnectedExternalMcpClients();
  }

  /**
   * Get installed MCP servers
   */
  static async getInstalledMcpServers() {
    return await this.getAll();
  }

  /**
   * Install an MCP server. Either from the catalog, or a customer server
   *
   * id here is "polymorphic"
   *
   * For mcp servers installed from the catalog, it will represent the "name" (unique identifier)
   * of an entry in the catalog. Example:
   *
   * modelcontextprotocol__servers__src__everything
   *
   * Otherwise, if this is not specified, it infers that this is a "custom" MCP server, and
   * a UUID will be generated for it
   *
   * Additionally, for custom MCP servers, there's no `userConfigValues` as users can simply input those values
   * directly in the `serverConfig` that they provider
   */
  static async installMcpServer({
    id,
    displayName,
    serverConfig,
    userConfigValues,
    oauthConfig,
    oauthTokens,
    oauthClientInfo,
    oauthServerMetadata,
    oauthResourceMetadata,
    status,
    serverType,
    remote_url,
    archestra_config,
  }: z.infer<typeof McpServerInstallSchema>) {
    /**
     * Check if an mcp server with this id already exists
     */
    if (!id) {
      id = uuidv4();
      log.info(`no id provided (custom mcp server installation), generating a new one: ${id}`);
    } else {
      log.info(`id provided (mcp server installation from catalog), using the provided one: ${id}`);
    }

    const existing = await db.select().from(mcpServersTable).where(eq(mcpServersTable.id, id));

    if (existing.length > 0) {
      throw new Error(`MCP server ${id} is already installed`);
    }

    // Handle browser authentication tokens and map them to environment variables
    let finalServerConfig = serverConfig;

    // Map browser auth tokens to environment variables
    const providerName = archestra_config?.browser_based?.provider;

    if (providerName && oauthTokens && hasBrowserAuthProvider(providerName)) {
      const provider = getBrowserAuthProvider(providerName);
      const tokenMapping = provider.browserAuthConfig?.tokenMapping;

      if (tokenMapping) {
        if (!finalServerConfig.env) {
          finalServerConfig.env = {};
        }

        if (tokenMapping.primary && oauthTokens.access_token) {
          finalServerConfig.env[tokenMapping.primary] = oauthTokens.access_token;
        }

        if (tokenMapping.secondary && oauthTokens.refresh_token) {
          finalServerConfig.env[tokenMapping.secondary] = oauthTokens.refresh_token;
        }

        log.info(`Browser auth tokens mapped for provider: ${providerName}`);
      }
    }

    // OAuth validation is now handled by the frontend-provided oauthConfig

    const now = new Date();
    const isRemoteServer = serverType === 'remote' || !!remote_url;
    const finalServerType = isRemoteServer ? 'remote' : serverType || 'local';

    // Remote URL is now stored as a separate column
    if (remote_url) {
      log.info(`Remote URL detected: ${remote_url}, setting serverType to 'remote'`);
    }

    const [server] = await db
      .insert(mcpServersTable)
      .values({
        id,
        name: displayName,
        serverConfig: finalServerConfig,
        userConfigValues: userConfigValues,
        serverType: finalServerType,
        remoteUrl: remote_url || null,
        status: status || 'installed', // Default to 'installed' for regular installs
        oauthTokens: oauthTokens || null,
        oauthClientInfo: oauthClientInfo || null,
        oauthServerMetadata: oauthServerMetadata || null,
        oauthResourceMetadata: oauthResourceMetadata || null,
        oauthConfig: oauthConfig ? (JSON.stringify(oauthConfig) as string) : null,
        createdAt: now.toISOString(),
      })
      .returning();

    // Only start container for local servers
    if (isRemoteServer) {
      log.info(`Remote server ${server.name} installed - skipping container startup`);
      // Just sync external clients for remote servers
      await ExternalMcpClientModel.syncAllConnectedExternalMcpClients();
    } else {
      // Start container for local servers
      await this.startServerAndSyncAllConnectedExternalMcpClients(server);
    }

    return server;
  }

  /**
   * Uninstall MCP server by id
   */
  static async uninstallMcpServer(id: (typeof mcpServersTable.$inferSelect)['id']) {
    await db.delete(mcpServersTable).where(eq(mcpServersTable.id, id));

    // Remove the container and clean up its resources
    await McpServerSandboxManager.removeMcpServer(id);

    // Sync all connected external MCP clients after uninstalling
    await ExternalMcpClientModel.syncAllConnectedExternalMcpClients();
  }
}

export {
  type McpServer,
  type McpServerConfig,
  type McpServerUserConfigValues,
} from '@backend/database/schema/mcpServer';
export { McpServerSchema };
