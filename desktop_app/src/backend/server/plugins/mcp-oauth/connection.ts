/**
 * MCP OAuth Connection Implementation
 *
 * Handles complete OAuth flow and MCP server connection
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { type OAuthServerConfig } from '@backend/schemas/oauth-config';
import log from '@backend/utils/logger';

import { performOAuth } from './oauth-flow';
import { McpOAuthProvider } from './provider';

/**
 * Complete OAuth + MCP connection function
 */
export async function connectMcpServer(
  config: OAuthServerConfig,
  serverId: string,
  remote_url?: string
): Promise<{ client: Client; accessToken: string }> {
  // Configuration is validated by Zod schema

  const provider = new McpOAuthProvider(config, serverId);
  await provider.init();

  try {
    // Perform OAuth authentication
    const accessToken = await performOAuth(provider, config);

    // Check if this is a remote server (has remote_url)
    const isRemoteServer = !!remote_url;

    if (!isRemoteServer) {
      log.info('🔌 Local server detected - skipping MCP connection test (container not started yet)');
      // For local servers, return a mock client since the container isn't running yet
      // The real MCP connection will be established when the container is started
      const mockClient = {
        close: async () => {
          /* no-op for mock client */
        },
        listTools: async () => ({ tools: [] }),
      } as unknown as Client;
      return { client: mockClient, accessToken };
    } else {
      // Test MCP connection for remote servers
      log.info('🔌 Testing MCP connection to remote server...');
      const mcpUrl = remote_url || (config as any).streamable_http_url || config.server_url;
      const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      });

      const client = new Client({ name: 'archestra-mcp-client', version: '1.0.0' }, { capabilities: { sampling: {} } });

      await client.connect(transport);
      log.info('✅ MCP connected!');

      const tools = await client.listTools();
      log.info(
        `🛠️  Found ${tools.tools.length} tools:`,
        tools.tools.map((t) => t.name)
      );

      return { client, accessToken };
    }
  } catch (error) {
    log.error('❌ OAuth/MCP connection error:', (error as Error).message);
    throw error;
  }
}

/**
 * Create authenticated MCP client transport
 */
export function createAuthenticatedTransport(serverUrl: string, accessToken: string): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
}

/**
 * Test OAuth connection without persisting
 */
export async function testOAuthConnection(config: OAuthServerConfig, serverId: string): Promise<boolean> {
  try {
    const { client } = await connectMcpServer(config, serverId);
    await client.close();
    return true;
  } catch (error) {
    log.error('OAuth connection test failed:', error);
    return false;
  }
}
