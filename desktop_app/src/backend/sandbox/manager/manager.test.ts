import cors from '@fastify/cors';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import McpServerModel from '@backend/models/mcpServer';
import McpServerSandboxManager from '@backend/sandbox/manager';
import mcpServerRoutes from '@backend/server/plugins/mcpServer';

vi.mock('@backend/models/mcpServer');
vi.mock('@backend/sandbox/manager');
vi.mock('@backend/utils/logger');

const mockedMcpServerModel = vi.mocked(McpServerModel);
const mockedMcpServerSandboxManager = vi.mocked(McpServerSandboxManager);

async function buildTestApp() {
  const app = fastify({ logger: false });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, { origin: true });
  await app.register(mcpServerRoutes);

  return app;
}

describe('POST /api/mcp_server/:id/restart', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it('should restart server', async () => {
    const mockServer = {
      id: 'test-server-id',
      name: 'Test Server',
      serverConfig: { command: 'test', args: [], env: {} },
      userConfigValues: null,
      oauthTokens: null,
      oauthClientInfo: null,
      oauthServerMetadata: null,
      oauthResourceMetadata: null,
      oauthConfig: null,
      status: 'installed' as const,
      serverType: 'local' as const,
      remoteUrl: null,
      createdAt: new Date().toISOString(),
    };

    mockedMcpServerModel.getById.mockResolvedValue([mockServer]);
    mockedMcpServerSandboxManager.restartServer.mockResolvedValue(undefined);

    const response = await app.inject({
      method: 'POST',
      url: '/api/mcp_server/test-server-id/restart',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      message: 'MCP server test-server-id restarted successfully',
    });
  });

  it('should return 404 when server does not exist', async () => {
    mockedMcpServerSandboxManager.restartServer.mockRejectedValue(
      new Error('MCP server with ID nonexistent-id not found')
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/mcp_server/nonexistent-id/restart',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'MCP server with ID nonexistent-id not found',
    });
  });

  it('should return 500 when restart fails', async () => {
    mockedMcpServerSandboxManager.restartServer.mockRejectedValue(new Error('Container failed to start'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/mcp_server/test-server-id/restart',
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: 'Container failed to start',
    });
  });
});
