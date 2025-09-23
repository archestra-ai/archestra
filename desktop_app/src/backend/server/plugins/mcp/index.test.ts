import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { FastifyInstance } from 'fastify';

import ChatModel from '@backend/models/chat';
import toolService from '@backend/services/tool';
import { ARCHESTRA_MCP_TOOLS, constructToolId } from '@constants';

import { archestraMcpContext, createArchestraMcpServer } from './index';

// Store handlers registered by the MCP server
const registeredHandlers: Record<string, any> = {};

// Mock dependencies
vi.mock('@backend/models/chat');
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
    server: {}
  }))
}));

describe('ArchestraMcpServer - Tool Enable/Disable Flow', () => {
  const chatId = 123;
  
  // Mock tools - including one with a long server ID to test truncation
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
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear handlers from previous tests
    Object.keys(registeredHandlers).forEach(key => delete registeredHandlers[key]);
    
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
    expect(text).toMatch(/✗\s+very-long-__read_file/); // Truncated ID
    expect(text).toMatch(/✗\s+filesystem__write_file/);
    expect(text).toMatch(/✗\s+filesystem__delete_file/);

    // Step 2: Enable some tools (including the truncated one)
    (ChatModel.addSelectedTools as Mock).mockResolvedValue([
      'very-long-__read_file',
      'filesystem__write_file'
    ]);
    
    const enableHandler = registeredHandlers[ARCHESTRA_MCP_TOOLS.ENABLE_TOOLS];
    result = await enableHandler({ 
      toolIds: ['very-long-__read_file', 'filesystem__write_file'] 
    });
    
    expect(ChatModel.addSelectedTools).toHaveBeenCalledWith(chatId, [
      'very-long-__read_file',
      'filesystem__write_file'
    ]);
    expect(result.content[0].text).toContain('Successfully enabled 2 tool(s)');

    // Step 3: List tools again - should show updated status
    (ChatModel.getSelectedTools as Mock).mockResolvedValue([
      'very-long-__read_file',
      'filesystem__write_file'
    ]);
    
    result = await listHandler({ mcp_server: 'filesystem' });
    text = result.content[0].text;
    
    // Now 2 tools should be enabled
    expect(text).toContain('**filesystem** (2/3 tools enabled)');
    expect(text).toMatch(/✓\s+very-long-__read_file\s+\[R\]/); // Enabled with truncated ID
    expect(text).toMatch(/✓\s+filesystem__write_file\s+\[W\]/); // Enabled
    expect(text).toMatch(/✗\s+filesystem__delete_file\s+\[W\]/); // Still disabled
  });
});