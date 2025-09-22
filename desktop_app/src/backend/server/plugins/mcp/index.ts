/**
 * NOTE: we are only using the @socotra/modelcontextprotocol-sdk forked package until
 * This PR is merged https://github.com/modelcontextprotocol/typescript-sdk/pull/869#issuecomment-3300474160
 *
 * (that PR adds zod v4 support to @modelcontextprotocol/sdk)
 */
import { McpServer } from '@socotra/modelcontextprotocol-sdk/server/mcp.js';
import { FastifyPluginAsync } from 'fastify';
import { streamableHttp } from 'fastify-mcp';
import { z } from 'zod';

import ChatModel from '@backend/models/chat';
import MemoryModel from '@backend/models/memory';
import toolService from '@backend/services/tool';
import log from '@backend/utils/logger';
import websocketService from '@backend/websocket';
import { ARCHESTRA_MCP_TOOLS, FULLY_QUALIFED_ARCHESTRA_MCP_TOOL_IDS, constructToolId } from '@constants';

/**
 * Context manager for Archestra MCP server
 * Stores the current chat context for MCP tool execution
 */
class ArchestraMcpContext {
  private currentChatId: number | null = null;

  /**
   * Set the current chat ID for MCP tool execution
   */
  setCurrentChatId(chatId: number | null) {
    this.currentChatId = chatId;
  }

  /**
   * Get the current chat ID
   */
  getCurrentChatId(): number | null {
    return this.currentChatId;
  }

  /**
   * Clear the current context
   */
  clear() {
    this.currentChatId = null;
  }
}

export const archestraMcpContext = new ArchestraMcpContext();

export const createArchestraMcpServer = () => {
  const archestraMcpServer = new McpServer({
    name: 'archestra-server',
    version: '1.0.0',
  });

  archestraMcpServer.registerTool(
    ARCHESTRA_MCP_TOOLS.LIST_MEMORIES,
    {
      title: 'List memories',
      description: 'List all stored memory entries with their names and values',
    },
    async () => {
      log.info('list_memories called');
      try {
        const memories = await MemoryModel.getAllMemories();
        if (memories.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No memories stored yet.',
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: memories.map((m) => `${m.name}: ${m.value}`).join('\n'),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error listing memories: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );

  archestraMcpServer.registerTool(
    ARCHESTRA_MCP_TOOLS.SET_MEMORY,
    {
      title: 'Set memory',
      description:
        'Set or update a memory entry with a specific name and value. Example: {"name": "favorite_color", "value": "blue"}',
      inputSchema: {
        name: z.string().describe('The name/key for the memory entry'),
        value: z.string().describe('The value/content to store'),
      },
    },
    async ({ name, value }) => {
      log.info('set_memory called with:', { name, value });

      try {
        const memory = await MemoryModel.setMemory(name.trim(), value);

        // Emit WebSocket event for memory update
        const memories = await MemoryModel.getAllMemories();
        websocketService.broadcast({
          type: 'memory-updated',
          payload: { memories },
        });

        return {
          content: [
            {
              type: 'text',
              text: `Memory "${memory.name}" has been ${memory.createdAt === memory.updatedAt ? 'created' : 'updated'}.`,
            },
          ],
        };
      } catch (error) {
        log.error('Error in set_memory tool:', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error setting memory: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );

  archestraMcpServer.registerTool(
    ARCHESTRA_MCP_TOOLS.DELETE_MEMORY,
    {
      title: 'Delete memory',
      description: 'Delete a specific memory entry by name',
      inputSchema: {
        name: z.string().describe('The name of the memory to delete'),
      },
    },
    async ({ name }) => {
      try {
        const deleted = await MemoryModel.deleteMemory(name);

        if (!deleted) {
          return {
            content: [
              {
                type: 'text',
                text: `Memory "${name}" not found.`,
              },
            ],
          };
        }

        // Emit WebSocket event for memory update
        const memories = await MemoryModel.getAllMemories();
        websocketService.broadcast({
          type: 'memory-updated',
          payload: { memories },
        });

        return {
          content: [
            {
              type: 'text',
              text: `Memory "${name}" has been deleted.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error deleting memory: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );

  // Tool management tools
  archestraMcpServer.registerTool(
    ARCHESTRA_MCP_TOOLS.LIST_AVAILABLE_TOOLS,
    {
      title: 'List available tools',
      description:
        'List available MCP servers or tools for a specific server. Without mcp_server parameter, lists all servers. With mcp_server, lists tools for that server.',
      inputSchema: {
        mcp_server: z.string().optional().describe('Optional: Name of the MCP server to list tools for'),
      },
    },
    async ({ mcp_server }) => {
      try {
        const chatId = archestraMcpContext.getCurrentChatId();
        if (!chatId) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: No active chat context found. Please send a message in a chat first.',
              },
            ],
          };
        }

        // Get all available tools
        const allTools = toolService.getAllAvailableTools();

        // Get selected tools for the chat
        const selectedTools = await ChatModel.getSelectedTools(chatId);

        // Create a set of selected tool IDs for quick lookup
        const selectedSet =
          selectedTools === null
            ? new Set(allTools.map((t) => t.id)) // null means all selected
            : new Set(selectedTools);

        // Group tools by MCP server
        const toolsByServer: Record<string, any[]> = {};

        for (const tool of allTools) {
          const serverName = tool.mcpServerName || 'Unknown Server';
          if (!toolsByServer[serverName]) {
            toolsByServer[serverName] = [];
          }

          toolsByServer[serverName].push({
            id: tool.id,
            name: tool.name,
            description: tool.description,
            selected: selectedSet.has(tool.id),
            analysis: tool.analysis,
          });
        }

        // If no mcp_server specified, list all servers with hint
        if (!mcp_server) {
          const serverList = Object.entries(toolsByServer)
            .map(([serverName, tools]) => {
              const enabledCount = tools.filter((t) => t.selected).length;
              return `• **${serverName}** (${enabledCount}/${tools.length} tools enabled)`;
            })
            .join('\n');

          const exampleServer = Object.keys(toolsByServer)[0] || 'filesystem';

          return {
            content: [
              {
                type: 'text',
                text: `Available MCP Servers:\n\n${serverList}\n\nTo see tools for a specific server, use:\n{"mcp_server": "${exampleServer}"}`,
              },
            ],
          };
        }

        // If mcp_server specified, show tools for that server
        const serverTools = toolsByServer[mcp_server];

        if (!serverTools) {
          const availableServers = Object.keys(toolsByServer).join(', ');
          return {
            content: [
              {
                type: 'text',
                text: `Server "${mcp_server}" not found.\n\nAvailable servers: ${availableServers}`,
              },
            ],
          };
        }

        const enabledCount = serverTools.filter((t) => t.selected).length;
        const toolList = serverTools
          .map((t) => {
            const status = t.selected ? '✓' : '✗';
            const analysisInfo =
              t.analysis?.is_read !== null
                ? ` [${t.analysis.is_read ? 'R' : ''}${t.analysis.is_write ? 'W' : ''}]`
                : '';
            return `  ${status} ${t.id}${analysisInfo}`;
          })
          .join('\n');

        return {
          content: [
            {
              type: 'text',
              text: `**${mcp_server}** (${enabledCount}/${serverTools.length} tools enabled)\n\n${toolList}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error listing tools: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );

  archestraMcpServer.registerTool(
    ARCHESTRA_MCP_TOOLS.ENABLE_TOOLS,
    {
      title: 'Enable tools',
      description: `Enable specific tools for use in the current chat. Use ${ARCHESTRA_MCP_TOOLS.LIST_AVAILABLE_TOOLS} to see tool IDs if you don\'t have them. Example: {"toolIds": ["${constructToolId('filesystem', 'read_file')}", "${constructToolId('filesystem', 'write_file')}", "${constructToolId('remote-mcp', 'search_repositories')}"]}`,
      inputSchema: {
        toolIds: z
          .array(z.string())
          .describe(
            `Array of tool IDs from ${ARCHESTRA_MCP_TOOLS.LIST_AVAILABLE_TOOLS} output. Example: ["${FULLY_QUALIFED_ARCHESTRA_MCP_TOOL_IDS.LIST_MEMORIES}", "${constructToolId('filesystem', 'read_file')}", "${constructToolId('remote-mcp', 'search_repositories')}"}`
          ),
      },
    },
    async ({ toolIds }) => {
      const chatId = archestraMcpContext.getCurrentChatId();

      try {
        if (!chatId) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: No active chat context found. Please send a message in a chat first.',
              },
            ],
          };
        }

        if (!toolIds || !Array.isArray(toolIds)) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: toolIds must be an array of tool IDs',
              },
            ],
          };
        }

        // Get all available tools to validate the tool IDs exist
        const allTools = toolService.getAllAvailableTools();
        const availableToolIds = new Set(allTools.map((t) => t.id));

        // Get currently selected tools for the chat
        const currentSelectedTools = await ChatModel.getSelectedTools(chatId);
        const currentEnabledSet =
          currentSelectedTools === null
            ? new Set(availableToolIds) // null means all tools are enabled
            : new Set(currentSelectedTools);

        // Validate each tool ID
        const errors: string[] = [];
        const validToolsToEnable: string[] = [];

        for (const toolId of toolIds) {
          if (!availableToolIds.has(toolId)) {
            errors.push(`Tool '${toolId}' does not exist`);
          } else if (currentEnabledSet.has(toolId)) {
            errors.push(`Tool '${toolId}' is already enabled`);
          } else {
            validToolsToEnable.push(toolId);
          }
        }

        // If there are any errors, return them
        if (errors.length > 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Error enabling tools:\n${errors.join('\n')}`,
              },
            ],
          };
        }

        // If no valid tools to enable, return message
        if (validToolsToEnable.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No tools to enable. All specified tools are either non-existent or already enabled.',
              },
            ],
          };
        }

        const updatedTools = await ChatModel.addSelectedTools(chatId, validToolsToEnable);

        return {
          content: [
            {
              type: 'text',
              text: `Successfully enabled ${validToolsToEnable.length} tool(s). Total enabled: ${updatedTools.length}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error enabling tools: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );

  archestraMcpServer.registerTool(
    ARCHESTRA_MCP_TOOLS.DISABLE_TOOLS,
    {
      title: 'Disable tools',
      description: 'Disable specific tools from the current chat',
      inputSchema: {
        toolIds: z.array(z.string()).describe('Array of tool IDs to disable'),
      },
    },
    async ({ toolIds }) => {
      const chatId = archestraMcpContext.getCurrentChatId();

      try {
        if (!chatId) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: No active chat context found. Please send a message in a chat first.',
              },
            ],
          };
        }

        if (!toolIds || !Array.isArray(toolIds)) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: toolIds must be an array of tool IDs',
              },
            ],
          };
        }

        // Get all available tools to validate the tool IDs exist
        const allTools = toolService.getAllAvailableTools();
        const availableToolIds = new Set(allTools.map((t) => t.id));

        // Get currently selected tools for the chat
        const currentSelectedTools = await ChatModel.getSelectedTools(chatId);
        const currentEnabledSet =
          currentSelectedTools === null
            ? new Set(availableToolIds) // null means all tools are enabled
            : new Set(currentSelectedTools);

        // Validate each tool ID
        const errors: string[] = [];
        const validToolsToDisable: string[] = [];

        for (const toolId of toolIds) {
          if (!availableToolIds.has(toolId)) {
            errors.push(`Tool '${toolId}' does not exist`);
          } else if (!currentEnabledSet.has(toolId)) {
            errors.push(`Tool '${toolId}' is already disabled`);
          } else {
            validToolsToDisable.push(toolId);
          }
        }

        // If there are any errors, return them
        if (errors.length > 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Error disabling tools:\n${errors.join('\n')}`,
              },
            ],
          };
        }

        // If no valid tools to disable, return message
        if (validToolsToDisable.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No tools to disable. All specified tools are either non-existent or already disabled.',
              },
            ],
          };
        }

        const updatedTools = await ChatModel.removeSelectedTools(chatId, validToolsToDisable);

        return {
          content: [
            {
              type: 'text',
              text: `Successfully disabled ${validToolsToDisable.length} tool(s). Remaining enabled: ${updatedTools.length}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error disabling tools: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );

  return archestraMcpServer.server;
};

const archestraMcpServerPlugin: FastifyPluginAsync = async (fastify) => {
  log.info('Registering Archestra MCP server plugin...');

  await fastify.register(streamableHttp, {
    stateful: false,
    mcpEndpoint: '/mcp',
    createServer: createArchestraMcpServer as any,
  });

  log.info('Archestra MCP server plugin registered successfully');
  fastify.log.info(`Archestra MCP server plugin registered`);
};

export default archestraMcpServerPlugin;
