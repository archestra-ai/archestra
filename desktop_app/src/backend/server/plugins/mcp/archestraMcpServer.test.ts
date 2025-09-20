import { McpClient } from '@socotra/modelcontextprotocol-sdk/client/mcp.js';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import db from '@backend/database';
import { chatsTable } from '@backend/database/schema/chat';
import { memoryTable } from '@backend/database/schema/memory';
import { toolsTable } from '@backend/database/schema/tools';
import { userTable } from '@backend/database/schema/user';
import ChatModel from '@backend/models/chat';
import MemoryModel from '@backend/models/memory';
import toolService from '@backend/services/tool';
import websocketService from '@backend/websocket';
import { ARCHESTRA_MCP_TOOLS, constructToolId } from '@constants';

import { archestraMcpContext, createArchestraMcpServer } from './index';

vi.mock('@backend/websocket', () => ({
  default: {
    broadcast: vi.fn(),
  },
}));

vi.mock('@backend/services/tool', () => ({
  default: {
    getAllAvailableTools: vi.fn(),
  },
}));

describe('Archestra MCP Server', () => {
  let mcpClient: McpClient;
  let testUserId: number;
  let testChatId: number;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Clean up any existing test data
    await db.delete(memoryTable).where(sql`1=1`).run();
    await db.delete(toolsTable).where(sql`1=1`).run();
    await db.delete(chatsTable).where(sql`1=1`).run();
    await db.delete(userTable).where(sql`1=1`).run();

    // Create test user
    const user = await db
      .insert(userTable)
      .values({
        hasCompletedOnboarding: true,
      })
      .returning({ id: userTable.id })
      .get();
    testUserId = user.id;

    // Create test chat
    const chat = await db
      .insert(chatsTable)
      .values({
        title: 'Test Chat',
        userId: testUserId,
      })
      .returning({ id: chatsTable.id })
      .get();
    testChatId = chat.id;

    // Set up the MCP server
    const server = createArchestraMcpServer();
    mcpClient = new McpClient({
      name: 'test-client',
      version: '1.0.0',
    });

    // Connect client to server using in-memory transport
    const [clientTransport, serverTransport] = createInMemoryTransports();
    await mcpClient.connect(clientTransport);
    await server.connect(serverTransport);

    // Set the context for testing
    archestraMcpContext.setCurrentChatId(testChatId);
  });

  afterEach(async () => {
    archestraMcpContext.clear();
    await mcpClient?.disconnect();
  });

  describe('Memory Management Tools', () => {
    describe('list_memories', () => {
      it('should return empty message when no memories exist', async () => {
        const result = await mcpClient.callTool({
          name: ARCHESTRA_MCP_TOOLS.LIST_MEMORIES,
          arguments: {},
        });

        expect(result.content).toEqual([
          {
            type: 'text',
            text: 'No memories stored yet.',
          },
        ]);
      });

      it('should list all memories when they exist', async () => {
        // Create test memories
        await db
          .insert(memoryTable)
          .values([
            {
              userId: testUserId,
              name: 'favorite_color',
              value: 'blue',
            },
            {
              userId: testUserId,
              name: 'favorite_food',
              value: 'pizza',
            },
          ])
          .run();

        const result = await mcpClient.callTool({
          name: ARCHESTRA_MCP_TOOLS.LIST_MEMORIES,
          arguments: {},
        });

        expect(result.content).toEqual([
          {
            type: 'text',
            text: 'favorite_color: blue\nfavorite_food: pizza',
          },
        ]);
      });
    });

    describe('set_memory', () => {
      it('should create a new memory', async () => {
        const result = await mcpClient.callTool({
          name: ARCHESTRA_MCP_TOOLS.SET_MEMORY,
          arguments: {
            name: 'favorite_language',
            value: 'TypeScript',
          },
        });

        expect(result.content[0].text).toContain('Memory "favorite_language" has been created');
        expect(websocketService.broadcast).toHaveBeenCalledWith({
          type: 'memory-updated',
          payload: { memories: expect.any(Array) },
        });

        // Verify memory was created in database
        const memory = await MemoryModel.getMemory('favorite_language');
        expect(memory).toBeTruthy();
        expect(memory?.value).toBe('TypeScript');
      });

      it('should update an existing memory', async () => {
        // Create initial memory
        await db
          .insert(memoryTable)
          .values({
            userId: testUserId,
            name: 'favorite_color',
            value: 'red',
          })
          .run();

        const result = await mcpClient.callTool({
          name: ARCHESTRA_MCP_TOOLS.SET_MEMORY,
          arguments: {
            name: 'favorite_color',
            value: 'blue',
          },
        });

        expect(result.content[0].text).toContain('Memory "favorite_color" has been updated');
        expect(websocketService.broadcast).toHaveBeenCalledWith({
          type: 'memory-updated',
          payload: { memories: expect.any(Array) },
        });

        // Verify memory was updated
        const memory = await MemoryModel.getMemory('favorite_color');
        expect(memory?.value).toBe('blue');
      });

      it('should trim whitespace from memory name', async () => {
        const result = await mcpClient.callTool({
          name: ARCHESTRA_MCP_TOOLS.SET_MEMORY,
          arguments: {
            name: '  spaced_name  ',
            value: 'test value',
          },
        });

        expect(result.content[0].text).toContain('Memory "spaced_name" has been created');

        const memory = await MemoryModel.getMemory('spaced_name');
        expect(memory).toBeTruthy();
      });
    });

    describe('delete_memory', () => {
      it('should delete an existing memory', async () => {
        // Create memory to delete
        await db
          .insert(memoryTable)
          .values({
            userId: testUserId,
            name: 'to_delete',
            value: 'delete me',
          })
          .run();

        const result = await mcpClient.callTool({
          name: ARCHESTRA_MCP_TOOLS.DELETE_MEMORY,
          arguments: {
            name: 'to_delete',
          },
        });

        expect(result.content[0].text).toBe('Memory "to_delete" has been deleted.');
        expect(websocketService.broadcast).toHaveBeenCalledWith({
          type: 'memory-updated',
          payload: { memories: expect.any(Array) },
        });

        // Verify memory was deleted
        const memory = await MemoryModel.getMemory('to_delete');
        expect(memory).toBeNull();
      });

      it('should return not found message for non-existent memory', async () => {
        const result = await mcpClient.callTool({
          name: ARCHESTRA_MCP_TOOLS.DELETE_MEMORY,
          arguments: {
            name: 'non_existent',
          },
        });

        expect(result.content[0].text).toBe('Memory "non_existent" not found.');
      });
    });
  });

  describe('Tool Management Tools', () => {
    const mockTools = [
      {
        id: constructToolId('filesystem', 'read_file'),
        name: 'read_file',
        mcpServerName: 'filesystem',
        description: 'Read a file',
        analysis: { is_read: true, is_write: false },
      },
      {
        id: constructToolId('filesystem', 'write_file'),
        name: 'write_file',
        mcpServerName: 'filesystem',
        description: 'Write a file',
        analysis: { is_read: false, is_write: true },
      },
      {
        id: constructToolId('github', 'search_repos'),
        name: 'search_repos',
        mcpServerName: 'github',
        description: 'Search repositories',
        analysis: { is_read: true, is_write: false },
      },
    ];

    beforeEach(() => {
      vi.mocked(toolService.getAllAvailableTools).mockReturnValue(mockTools);
    });

    describe('list_available_tools', () => {
      it('should list all MCP servers when no server specified', async () => {
        const result = await mcpClient.callTool({
          name: ARCHESTRA_MCP_TOOLS.LIST_AVAILABLE_TOOLS,
          arguments: {},
        });

        expect(result.content[0].text).toContain('Available MCP Servers:');
        expect(result.content[0].text).toContain('**filesystem** (2/2 tools enabled)');
        expect(result.content[0].text).toContain('**github** (1/1 tools enabled)');
      });

      it('should list tools for specific server', async () => {
        const result = await mcpClient.callTool({
          name: ARCHESTRA_MCP_TOOLS.LIST_AVAILABLE_TOOLS,
          arguments: {
            mcp_server: 'filesystem',
          },
        });

        expect(result.content[0].text).toContain('**filesystem** (2/2 tools enabled)');
        expect(result.content[0].text).toContain(` ${constructToolId('filesystem', 'read_file')} [R]`);
        expect(result.content[0].text).toContain(` ${constructToolId('filesystem', 'write_file')} [W]`);
      });

      it('should show disabled tools when chat has selected tools', async () => {
        // Set some selected tools for the chat
        await ChatModel.setSelectedTools(testChatId, [constructToolId('filesystem', 'read_file')]);

        const result = await mcpClient.callTool({
          name: ARCHESTRA_MCP_TOOLS.LIST_AVAILABLE_TOOLS,
          arguments: {
            mcp_server: 'filesystem',
          },
        });

        expect(result.content[0].text).toContain('**filesystem** (1/2 tools enabled)');
        expect(result.content[0].text).toContain(` ${constructToolId('filesystem', 'read_file')}`);
        expect(result.content[0].text).toContain(` ${constructToolId('filesystem', 'write_file')}`);
      });

      it('should handle non-existent server', async () => {
        const result = await mcpClient.callTool({
          name: ARCHESTRA_MCP_TOOLS.LIST_AVAILABLE_TOOLS,
          arguments: {
            mcp_server: 'non_existent',
          },
        });

        expect(result.content[0].text).toContain('Server "non_existent" not found');
        expect(result.content[0].text).toContain('Available servers: filesystem, github');
      });

      it('should handle missing chat context', async () => {
        archestraMcpContext.clear();

        const result = await mcpClient.callTool({
          name: ARCHESTRA_MCP_TOOLS.LIST_AVAILABLE_TOOLS,
          arguments: {},
        });

        expect(result.content[0].text).toContain('Error: No active chat context found');
      });
    });

    describe('enable_tools', () => {
      beforeEach(async () => {
        // Start with only one tool enabled
        await ChatModel.setSelectedTools(testChatId, [constructToolId('filesystem', 'read_file')]);
      });

      it('should enable valid tools', async () => {
        const result = await mcpClient.callTool({
          name: ARCHESTRA_MCP_TOOLS.ENABLE_TOOLS,
          arguments: {
            toolIds: [constructToolId('filesystem', 'write_file'), constructToolId('github', 'search_repos')],
          },
        });

        expect(result.content[0].text).toContain('Successfully enabled 2 tool(s)');

        // Verify tools were enabled
        const selectedTools = await ChatModel.getSelectedTools(testChatId);
        expect(selectedTools).toContain(constructToolId('filesystem', 'write_file'));
        expect(selectedTools).toContain(constructToolId('github', 'search_repos'));
      });

      it('should handle non-existent tools', async () => {
        const result = await mcpClient.callTool({
          name: ARCHESTRA_MCP_TOOLS.ENABLE_TOOLS,
          arguments: {
            toolIds: ['non_existent_tool', constructToolId('filesystem', 'write_file')],
          },
        });

        expect(result.content[0].text).toContain("Tool 'non_existent_tool' does not exist");
      });

      it('should handle already enabled tools', async () => {
        const result = await mcpClient.callTool({
          name: ARCHESTRA_MCP_TOOLS.ENABLE_TOOLS,
          arguments: {
            toolIds: [constructToolId('filesystem', 'read_file')],
          },
        });

        expect(result.content[0].text).toContain(
          `Tool '${constructToolId('filesystem', 'read_file')}' is already enabled`
        );
      });

      it('should handle invalid toolIds parameter', async () => {
        const result = await mcpClient.callTool({
          name: ARCHESTRA_MCP_TOOLS.ENABLE_TOOLS,
          arguments: {
            toolIds: 'not_an_array',
          },
        });

        expect(result.content[0].text).toContain('Error: toolIds must be an array of tool IDs');
      });

      it('should handle missing chat context', async () => {
        archestraMcpContext.clear();

        const result = await mcpClient.callTool({
          name: ARCHESTRA_MCP_TOOLS.ENABLE_TOOLS,
          arguments: {
            toolIds: [constructToolId('filesystem', 'write_file')],
          },
        });

        expect(result.content[0].text).toContain('Error: No active chat context found');
      });
    });

    describe('disable_tools', () => {
      beforeEach(async () => {
        // Start with all mock tools enabled
        await ChatModel.setSelectedTools(
          testChatId,
          mockTools.map((t) => t.id)
        );
      });

      it('should disable valid tools', async () => {
        const result = await mcpClient.callTool({
          name: ARCHESTRA_MCP_TOOLS.DISABLE_TOOLS,
          arguments: {
            toolIds: [constructToolId('filesystem', 'write_file'), constructToolId('github', 'search_repos')],
          },
        });

        expect(result.content[0].text).toContain('Successfully disabled 2 tool(s)');

        // Verify tools were disabled
        const selectedTools = await ChatModel.getSelectedTools(testChatId);
        expect(selectedTools).not.toContain(constructToolId('filesystem', 'write_file'));
        expect(selectedTools).not.toContain(constructToolId('github', 'search_repos'));
        expect(selectedTools).toContain(constructToolId('filesystem', 'read_file'));
      });

      it('should handle non-existent tools', async () => {
        const result = await mcpClient.callTool({
          name: ARCHESTRA_MCP_TOOLS.DISABLE_TOOLS,
          arguments: {
            toolIds: ['non_existent_tool'],
          },
        });

        expect(result.content[0].text).toContain("Tool 'non_existent_tool' does not exist");
      });

      it('should handle already disabled tools', async () => {
        // First disable a tool
        await ChatModel.removeSelectedTools(testChatId, [constructToolId('filesystem', 'read_file')]);

        const result = await mcpClient.callTool({
          name: ARCHESTRA_MCP_TOOLS.DISABLE_TOOLS,
          arguments: {
            toolIds: [constructToolId('filesystem', 'read_file')],
          },
        });

        expect(result.content[0].text).toContain(
          `Tool '${constructToolId('filesystem', 'read_file')}' is already disabled`
        );
      });

      it('should handle invalid toolIds parameter', async () => {
        const result = await mcpClient.callTool({
          name: ARCHESTRA_MCP_TOOLS.DISABLE_TOOLS,
          arguments: {
            toolIds: null,
          },
        });

        expect(result.content[0].text).toContain('Error: toolIds must be an array of tool IDs');
      });

      it('should handle missing chat context', async () => {
        archestraMcpContext.clear();

        const result = await mcpClient.callTool({
          name: ARCHESTRA_MCP_TOOLS.DISABLE_TOOLS,
          arguments: {
            toolIds: [constructToolId('filesystem', 'write_file')],
          },
        });

        expect(result.content[0].text).toContain('Error: No active chat context found');
      });
    });
  });
});

/**
 * Create in-memory transport pair for testing MCP client-server communication
 */
function createInMemoryTransports() {
  const clientToServer: any[] = [];
  const serverToClient: any[] = [];

  const clientTransport = {
    async send(message: any) {
      clientToServer.push(message);
      // Simulate async processing
      await new Promise((resolve) => setImmediate(resolve));
      // Process message on server side
      if (serverTransport.onmessage) {
        serverTransport.onmessage(message);
      }
    },
    onmessage: null as any,
    async close() {},
  };

  const serverTransport = {
    async send(message: any) {
      serverToClient.push(message);
      // Simulate async processing
      await new Promise((resolve) => setImmediate(resolve));
      // Process message on client side
      if (clientTransport.onmessage) {
        clientTransport.onmessage(message);
      }
    },
    onmessage: null as any,
    async close() {},
  };

  return [clientTransport, serverTransport];
}