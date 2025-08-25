import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FastifyPluginAsync } from 'fastify';
import { streamableHttp } from 'fastify-mcp';
import { z } from 'zod';

import McpServerModel from '@backend/models/mcpServer';

export const createArchestraMcpServer = () => {
  const archestraMcpServer = new McpServer({
    name: 'archestra-server',
    version: '1.0.0',
  });

  archestraMcpServer.tool(
    'list_installed_mcp_servers',
    {
      title: 'List Installed MCP Servers',
      description: 'List all installed MCP servers',
      inputSchema: {},
    },
    async (args, extra) => {
      try {
        const servers = await McpServerModel.getInstalledMcpServers();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(servers, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify([], null, 2),
            },
          ],
        };
      }
    }
  );

  archestraMcpServer.tool(
    'install_mcp_server',
    {
      title: 'Install MCP Server',
      description: 'Install an MCP server',
      inputSchema: { id: z.string().describe('The id of the MCP server to install') },
    },
    async ({ id }, extra) => {
      try {
        const server = await McpServerModel.getById(id);
        if (!server) {
          return {
            content: [
              {
                type: 'text',
                text: `MCP server with id ${id} not found`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(server, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify([], null, 2),
            },
          ],
        };
      }
    }
  );

  archestraMcpServer.tool(
    'uninstall_mcp_server',
    {
      title: 'Uninstall MCP Server',
      description: 'Uninstall an MCP server',
      inputSchema: { id: z.string().describe('The id of the MCP server to uninstall') },
    },
    async ({ id }, extra) => {
      try {
        await McpServerModel.uninstallMcpServer(id);

        return {
          content: [
            {
              type: 'text',
              text: `MCP server with id ${id} uninstalled`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify([], null, 2),
            },
          ],
        };
      }
    }
  );

  return archestraMcpServer.server;
};

const archestraMcpServerPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(streamableHttp, {
    stateful: false,
    mcpEndpoint: '/mcp',
    createServer: createArchestraMcpServer,
  });

  fastify.log.info(`Archestra MCP server plugin registered`);
};

export default archestraMcpServerPlugin;
