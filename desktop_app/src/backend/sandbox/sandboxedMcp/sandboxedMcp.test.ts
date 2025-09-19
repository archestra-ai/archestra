import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpServer } from '@backend/models/mcpServer';

import SandboxedMcpServer from './index';

// Mock dependencies
vi.mock('@backend/models/tools');
vi.mock('@backend/utils/logger', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock('@backend/websocket', () => ({
  default: {
    broadcast: vi.fn(),
  },
}));

// Mock PodmanContainer to avoid initialization issues
vi.mock('@backend/sandbox/podman/container', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    default: vi.fn().mockImplementation(() => ({
      startOrCreateContainer: vi.fn(),
      stopContainer: vi.fn(),
      removeContainer: vi.fn(),
      getRecentLogs: vi.fn(),
      streamToContainer: vi.fn(),
      statusSummary: { state: 'running' },
      assignedHttpPort: undefined,
    })),
  };
});

describe('SandboxedMcpServer', () => {
  describe('availableToolsList', () => {
    let sandboxedMcpServer: SandboxedMcpServer;
    let mockMcpServer: McpServer;

    beforeEach(() => {
      // Clear all mocks between tests
      vi.clearAllMocks();

      mockMcpServer = {
        id: 'modelcontextprotocol__servers__src__filesystem',
        name: 'Filesystem',
        serverType: 'local',
        state: 'running',
        serverConfig: {
          command: 'node',
          args: ['server.js'],
        },
        userConfigValues: {},
        oauthTokens: null,
        oauthClientInfo: null,
        oauthServerMetadata: null,
        oauthResourceMetadata: null,
        oauthConfig: null,
        status: 'installed',
        remoteUrl: null,
        updatedAt: '2025-09-16T21:00:00.000Z',
        createdAt: '2025-09-16T21:00:00.000Z',
      } as McpServer;

      // Create instance with mock podman socket path
      sandboxedMcpServer = new SandboxedMcpServer(mockMcpServer, '/mock/socket/path');
    });

    it('should properly return tools from availableToolsList', () => {
      // Mock tools as they come from the filesystem MCP server
      sandboxedMcpServer.tools = {
        modelcontextprotocol__servers__src__filesystem__servers__src__filesystem__read_file: {
          description: 'Read file contents',
          inputSchema: {},
        },
        modelcontextprotocol__servers__src__filesystem__servers__src__filesystem__list_directory: {
          description: 'List directory contents',
          inputSchema: {},
        },
        modelcontextprotocol__servers__src__filesystem__servers__src__filesystem__write_file: {
          description: 'Write file contents',
          inputSchema: {},
        },
      } as any;

      // Mock cached analysis - stored with just the tool name
      sandboxedMcpServer['cachedToolAnalysis'].set(
        'modelcontextprotocol__servers__src__filesystem__servers__src__filesystem__read_file',
        {
          is_read: true,
          is_write: false,
          analyzed_at: '2025-09-16T21:03:03.840Z',
        }
      );
      sandboxedMcpServer['cachedToolAnalysis'].set(
        'modelcontextprotocol__servers__src__filesystem__servers__src__filesystem__list_directory',
        {
          is_read: true,
          is_write: false,
          analyzed_at: '2025-09-16T21:03:22.314Z',
        }
      );
      sandboxedMcpServer['cachedToolAnalysis'].set(
        'modelcontextprotocol__servers__src__filesystem__servers__src__filesystem__write_file',
        {
          is_read: false,
          is_write: true,
          analyzed_at: '2025-09-16T21:03:14.610Z',
        }
      );

      const tools = sandboxedMcpServer.availableToolsList;

      expect(tools).toHaveLength(3);

      // Check that read_file is correctly matched with cache
      const readFileTool = tools.find((t) => t.name.includes('read_file'));
      expect(readFileTool).toBeDefined();
      expect(readFileTool?.analysis).toMatchObject({
        status: 'completed',
        is_read: true,
        is_write: false,
      });

      // Check that list_directory is correctly matched with cache
      const listDirTool = tools.find((t) => t.name.includes('list_directory'));
      expect(listDirTool).toBeDefined();
      expect(listDirTool?.analysis).toMatchObject({
        status: 'completed',
        is_read: true,
        is_write: false,
      });

      // Check that write_file is correctly matched with cache
      const writeFileTool = tools.find((t) => t.name.includes('write_file'));
      expect(writeFileTool).toBeDefined();
      expect(writeFileTool?.analysis).toMatchObject({
        status: 'completed',
        is_read: false,
        is_write: true,
      });
    });

    it('should show awaiting_ollama_model status when tool is not analyzed', () => {
      sandboxedMcpServer.tools = {
        test_server__unanalyzed_tool: {
          description: 'Tool pending analysis',
          inputSchema: {},
        },
      } as any;

      // No cache entry for this tool
      const tools = sandboxedMcpServer.availableToolsList;

      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        id: 'test_server__unanalyzed_tool',
        name: 'unanalyzed_tool',
        analysis: {
          status: 'awaiting_ollama_model',
          is_read: null,
          is_write: null,
        },
      });
    });

    it('should handle tools with analysis but null values (neither read nor write)', () => {
      sandboxedMcpServer.tools = {
        test_server__neutral_tool: {
          description: 'Tool that is neither read nor write',
          inputSchema: {},
        },
      } as any;

      // Tool has been analyzed but determined to be neither read nor write
      sandboxedMcpServer['cachedToolAnalysis'].set('test_server__neutral_tool', {
        is_read: null,
        is_write: null,
        analyzed_at: '2025-09-16T21:00:00.000Z', // Has analyzed_at, so it's completed
      });

      const tools = sandboxedMcpServer.availableToolsList;

      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        id: 'test_server__neutral_tool',
        name: 'neutral_tool',
        analysis: {
          status: 'completed', // Should be completed, not awaiting
          is_read: null,
          is_write: null,
        },
      });
    });
  });
});
