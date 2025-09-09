/**
 * MCP OAuth Connection Implementation
 *
 * Based on connectMcpServer from linear-mcp-oauth-minimal.ts
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
  serverId: string
): Promise<{ client: Client; accessToken: string }> {
  // Configuration is validated by Zod schema

  const provider = new McpOAuthProvider(config, serverId);
  await provider.init();

  try {
    // Perform OAuth authentication
    const accessToken = await performOAuth(provider, config);

    // Test MCP connection
    log.info('🔌 Testing MCP connection...');
    const transport = new StreamableHTTPClientTransport(new URL(config.server_url), {
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
