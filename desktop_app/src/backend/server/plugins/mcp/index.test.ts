import type { FastifyInstance } from 'fastify';
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import ChatModel from '@backend/models/chat';
import toolService from '@backend/services/tool';
import { ARCHESTRA_MCP_TOOLS, constructToolId } from '@constants';

import { archestraMcpContext, createArchestraMcpServer } from './index';

// Store handlers registered by the MCP server
const registeredHandlers: Record<string, any> = {};

// Mock dependencies
vi.mock('@backend/models/chat', () => ({
  default: {
    getSelectedTools: vi.fn(),
    addSelectedTools: vi.fn(),
    removeSelectedTools: vi.fn(),
    getChatById: vi.fn(),
  },
}));
vi.mock('@backend/models/memory');
vi.mock('@backend/services/tool');
vi.mock('@backend/websocket', () => ({
  default: {
    broadcast: vi.fn(),
  },
}));
vi.mock('@backend/utils/logger', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock('fastify-mcp', () => ({
  streamableHttp: vi.fn((fastify: FastifyInstance, opts: any) => Promise.resolve()),
}));
vi.mock('@socotra/modelcontextprotocol-sdk/server/mcp.js', () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    registerTool: vi.fn((name: string, schema: any, handler: any) => {
      registeredHandlers[name] = handler;
    }),
    server: {},
  })),
}));

describe('ArchestraMcpServer - Tool Enable/Disable Flow', () => {
  const chatId = 123;

  // Mock tools - including one with a long server ID to test truncation and some Archestra tools
  const mockTools = [
    {
      id: constructToolId('very-long-server-name-exceeds-10-chars', 'read_file'), // Will be truncated to 'very-long-__read_file'
      name: 'read_file',
      description: 'Read file',
      mcpServerName: 'filesystem',
      analysis: { is_read: true, is_write: false },
    },
    {
      id: 'filesystem__write_file',
      name: 'write_file',
      description: 'Write file',
      mcpServerName: 'filesystem',
      analysis: { is_read: false, is_write: true },
    },
    {
      id: 'filesystem__delete_file',
      name: 'delete_file',
      description: 'Delete file',
      mcpServerName: 'filesystem',
      analysis: { is_read: false, is_write: true },
    },
    // Add Archestra tools to the available tools
    {
      id: 'archestra__list_memories',
      name: 'list_memories',
      description: 'List memories',
      mcpServerName: 'Archestra',
      analysis: { is_read: true, is_write: false },
    },
    {
      id: 'archestra__list_available_tools',
      name: 'list_available_tools',
      description: 'List available tools',
      mcpServerName: 'Archestra',
      analysis: { is_read: true, is_write: false },
    },
    {
      id: 'archestra__enable_tools',
      name: 'enable_tools',
      description: 'Enable tools',
      mcpServerName: 'Archestra',
      analysis: { is_read: false, is_write: true },
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear handlers from previous tests
    Object.keys(registeredHandlers).forEach((key) => delete registeredHandlers[key]);

    archestraMcpContext.clear();
    archestraMcpContext.setCurrentChatId(chatId);

    // Create the server which will register the handlers
    createArchestraMcpServer();

    // Setup default mock for available tools
    (toolService.getAllAvailableTools as Mock).mockReturnValue(mockTools);
  });

  it('should show all tools as disabled, then enable some, then verify status changed', async () => {
    // Step 1: List tools - all should be disabled initially
    (ChatModel.getSelectedTools as Mock).mockResolvedValue([]); // No tools enabled

    const listHandler = registeredHandlers[ARCHESTRA_MCP_TOOLS.LIST_AVAILABLE_TOOLS];
    let result = await listHandler({ mcp_server: 'filesystem' });

    expect(result.content[0].type).toBe('text');
    let text = result.content[0].text;

    // All tools should be disabled
    expect(text).toContain('**filesystem** (0/3 tools enabled)');
    expect(text).toContain('very-long-__read_file'); // Truncated ID, no (enabled) suffix
    expect(text).toContain('filesystem__write_file'); // No (enabled) suffix
    expect(text).toContain('filesystem__delete_file'); // No (enabled) suffix
    expect(text).not.toContain('(enabled)'); // None should be enabled

    // Step 2: Enable some tools (including the truncated one)
    // Mock that some Archestra tools are currently enabled
    (ChatModel.getSelectedTools as Mock).mockResolvedValue([
      'archestra__list_memories',
      'archestra__list_available_tools',
    ]);

    // Mock getChatById to return a chat with sessionId
    (ChatModel.getChatById as Mock).mockResolvedValue({
      id: chatId,
      sessionId: 'test-session-123',
    });

    (ChatModel.addSelectedTools as Mock).mockResolvedValue([
      'archestra__list_memories',
      'archestra__list_available_tools',
      'very-long-__read_file',
      'filesystem__write_file',
    ]);

    // Mock removeSelectedTools to simulate removing Archestra tools
    (ChatModel.removeSelectedTools as Mock).mockResolvedValue(['very-long-__read_file', 'filesystem__write_file']);

    const enableHandler = registeredHandlers[ARCHESTRA_MCP_TOOLS.ENABLE_TOOLS];
    result = await enableHandler({
      toolIds: ['very-long-__read_file', 'filesystem__write_file'],
    });

    expect(ChatModel.addSelectedTools).toHaveBeenCalledWith(chatId, [
      'very-long-__read_file',
      'filesystem__write_file',
    ]);

    // Should have automatically disabled Archestra tools
    expect(ChatModel.removeSelectedTools).toHaveBeenCalledWith(chatId, [
      'archestra__list_memories',
      'archestra__list_available_tools',
    ]);

    expect(result.content[0].text).toContain(
      "Successfully enabled 2 tool(s). Archestra tools have been automatically disabled. Don't proceed, stop immediately."
    );

    // Step 3: List tools again - should show updated status
    (ChatModel.getSelectedTools as Mock).mockResolvedValue(['very-long-__read_file', 'filesystem__write_file']);

    result = await listHandler({ mcp_server: 'filesystem' });
    text = result.content[0].text;

    // Now 2 tools should be enabled
    expect(text).toContain('**filesystem** (2/3 tools enabled)');
    expect(text).toContain('very-long-__read_file (enabled)'); // Enabled with truncated ID
    expect(text).toContain('filesystem__write_file (enabled)'); // Enabled
    expect(text).toContain('filesystem__delete_file'); // Still disabled
    expect(text).not.toContain('filesystem__delete_file (enabled)'); // This one should NOT be enabled
  });
});
