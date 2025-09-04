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
import ExternalMcpClientModel from '@backend/models/externalMcpClient';
import McpServerSandboxManager from '@backend/sandbox';
import log from '@backend/utils/logger';

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
  oauthProvider: z
    .string()
    .nullable()
    .optional()
    .describe('OAuth provider name (e.g., google, slack-browser, linkedin-browser)'),
  oauthAccessToken: z.string().optional(),
  oauthRefreshToken: z.string().optional(),
  oauthExpiryDate: z.string().nullable().optional(),
});

// Interface for catalog search parameters
interface CatalogSearchParams {
  q?: string;
  category?: string;
  limit?: number;
  offset?: number;
}

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
    oauthProvider,
    oauthAccessToken,
    oauthRefreshToken,
    oauthExpiryDate,
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

    // Handle OAuth tokens - add them to environment variables based on provider
    let finalServerConfig = serverConfig;
    if (oauthAccessToken && oauthProvider) {
      // Import the provider configuration to get token mapping
      const { getOAuthProvider, hasOAuthProvider } = await import('@backend/server/plugins/oauth');
      const { handleProviderTokens } = await import('@backend/server/plugins/oauth/utils/oauth-provider-helper');

      // Validate OAuth provider exists
      if (!hasOAuthProvider(oauthProvider)) {
        throw new Error(
          `Invalid OAuth provider: ${oauthProvider}. Available providers: ${Object.keys((await import('@backend/server/plugins/oauth')).oauthProviders).join(', ')}`
        );
      }

      if (hasOAuthProvider(oauthProvider)) {
        const provider = getOAuthProvider(oauthProvider);

        // Create token response in standard format
        const tokens = {
          access_token: oauthAccessToken,
          refresh_token: oauthRefreshToken || undefined,
          expires_in: oauthExpiryDate
            ? Math.floor((new Date(oauthExpiryDate).getTime() - Date.now()) / 1000)
            : undefined,
        };

        // Use the provider's token handler to get the correct env vars
        const tokenEnvVars = await handleProviderTokens(provider, tokens, id);

        // Merge OAuth env variables with existing ones (including those from server_docker)
        if (tokenEnvVars) {
          finalServerConfig = {
            ...serverConfig,
            env: {
              ...serverConfig.env, // Keep existing env vars
              ...tokenEnvVars, // Add/override with OAuth tokens
            },
          };
        }
      }
    }

    const now = new Date();
    const [server] = await db
      .insert(mcpServersTable)
      .values({
        id,
        name: displayName,
        serverConfig: finalServerConfig,
        userConfigValues: userConfigValues,
        oauthAccessToken: oauthAccessToken || null,
        oauthRefreshToken: oauthRefreshToken || null,
        oauthExpiryDate: oauthExpiryDate || null,
        createdAt: now.toISOString(),
      })
      .returning();

    await this.startServerAndSyncAllConnectedExternalMcpClients(server);

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

  /**
   * Search the MCP server catalog
   * This method acts as a proxy to the external catalog API
   */
  static async searchCatalog(params: CatalogSearchParams) {
    // Get the catalog URL from environment or use default
    const catalogUrl = process.env.ARCHESTRA_CATALOG_URL || 'https://www.archestra.ai/mcp-catalog/api';

    // Build query string
    const queryParams = new URLSearchParams();
    if (params.q) queryParams.append('q', params.q);
    if (params.category) queryParams.append('category', params.category);
    if (params.limit) queryParams.append('limit', params.limit.toString());
    if (params.offset) queryParams.append('offset', params.offset.toString());

    const url = `${catalogUrl}/search?${queryParams.toString()}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Archestra-Desktop/1.0',
        },
      });

      if (!response.ok) {
        throw new Error(`Catalog API returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      log.error('Failed to fetch from catalog API:', error);
      throw error;
    }
  }
}

export {
  type McpServer,
  type McpServerConfig,
  type McpServerUserConfigValues,
} from '@backend/database/schema/mcpServer';
export { McpServerSchema };
