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

    it('should handle tools with standard naming (no prefix)', () => {
      // Mock tools with standard names
      sandboxedMcpServer.tools = {
        test_server__read_file: {
          description: 'Read a file',
          inputSchema: {},
        },
        test_server__write_file: {
          description: 'Write a file',
          inputSchema: {},
        },
      } as any;

      // Mock cached analysis for these tools
      sandboxedMcpServer['cachedToolAnalysis'].set('read_file', {
        is_read: true,
        is_write: false,
        analyzed_at: '2025-09-16T21:00:00.000Z',
      });
      sandboxedMcpServer['cachedToolAnalysis'].set('write_file', {
        is_read: false,
        is_write: true,
        analyzed_at: '2025-09-16T21:00:00.000Z',
      });

      const tools = sandboxedMcpServer.availableToolsList;

      expect(tools).toHaveLength(2);
      expect(tools[0]).toMatchObject({
        id: 'test_server__read_file',
        name: 'read_file',
        analysis: {
          status: 'completed',
          is_read: true,
          is_write: false,
        },
      });
      expect(tools[1]).toMatchObject({
        id: 'test_server__write_file',
        name: 'write_file',
        analysis: {
          status: 'completed',
          is_read: false,
          is_write: true,
        },
      });
    });

    it('should handle filesystem server tools with prefix (servers__src__filesystem__)', () => {
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
      sandboxedMcpServer['cachedToolAnalysis'].set('read_file', {
        is_read: true,
        is_write: false,
        analyzed_at: '2025-09-16T21:03:03.840Z',
      });
      sandboxedMcpServer['cachedToolAnalysis'].set('list_directory', {
        is_read: true,
        is_write: false,
        analyzed_at: '2025-09-16T21:03:22.314Z',
      });
      sandboxedMcpServer['cachedToolAnalysis'].set('write_file', {
        is_read: false,
        is_write: true,
        analyzed_at: '2025-09-16T21:03:14.610Z',
      });

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
      sandboxedMcpServer['cachedToolAnalysis'].set('neutral_tool', {
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

    it('should handle tools without analyzed_at (legacy cache entries)', () => {
      sandboxedMcpServer.tools = {
        test_server__legacy_tool: {
          description: 'Tool with legacy cache entry',
          inputSchema: {},
        },
      } as any;

      // Old cache entry without analyzed_at field
      sandboxedMcpServer['cachedToolAnalysis'].set('legacy_tool', {
        is_read: true,
        is_write: false,
        analyzed_at: null, // No analyzed_at
      });

      const tools = sandboxedMcpServer.availableToolsList;

      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        id: 'test_server__legacy_tool',
        name: 'legacy_tool',
        analysis: {
          status: 'awaiting_ollama_model', // Should be awaiting since no analyzed_at
          is_read: null,
          is_write: null,
        },
      });
    });

    it('should handle edge case with multiple double underscores in tool name', () => {
      sandboxedMcpServer.tools = {
        server__prefix__another__actual_tool__name: {
          description: 'Tool with complex naming',
          inputSchema: {},
        },
      } as any;

      // Cache should be keyed by the part after the LAST double underscore
      sandboxedMcpServer['cachedToolAnalysis'].set('name', {
        is_read: true,
        is_write: true,
        analyzed_at: '2025-09-16T21:00:00.000Z',
      });

      const tools = sandboxedMcpServer.availableToolsList;

      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        id: 'server__prefix__another__actual_tool__name',
        name: 'prefix__another__actual_tool__name', // After stripping server ID
        analysis: {
          status: 'completed',
          is_read: true,
          is_write: true,
        },
      });
    });

    it('should correctly extract cache key for real filesystem tools', () => {
      // Test with actual filesystem tool IDs from the logs
      const testCases = [
        {
          toolId: 'modelcontextprotocol__servers__src__filesystem__servers__src__filesystem__read_file',
          expectedCacheKey: 'read_file',
          expectedName: 'servers__src__filesystem__servers__src__filesystem__read_file', // Full name after stripping server ID
        },
        {
          toolId: 'modelcontextprotocol__servers__src__filesystem__servers__src__filesystem__list_allowed_directories',
          expectedCacheKey: 'list_allowed_directories',
          expectedName: 'servers__src__filesystem__servers__src__filesystem__list_allowed_directories', // Full name after stripping server ID
        },
      ];

      testCases.forEach(({ toolId, expectedCacheKey, expectedName }) => {
        sandboxedMcpServer.tools = {
          [toolId]: { description: 'Test tool', inputSchema: {} },
        } as any;

        // Add cache entry with the expected key
        sandboxedMcpServer['cachedToolAnalysis'].set(expectedCacheKey, {
          is_read: true,
          is_write: false,
          analyzed_at: '2025-09-16T21:00:00.000Z',
        });

        const tools = sandboxedMcpServer.availableToolsList;

        expect(tools).toHaveLength(1);
        expect(tools[0].name).toBe(expectedName);
        expect(tools[0].analysis.status).toBe('completed');
        expect(tools[0].analysis.is_read).toBe(true);
      });
    });

    it('should handle tools with no double underscores in name', () => {
      sandboxedMcpServer.tools = {
        simple_server__simpletool: {
          description: 'Simple tool with no complex prefix',
          inputSchema: {},
        },
      } as any;

      // Cache key should just be the tool name after server ID
      sandboxedMcpServer['cachedToolAnalysis'].set('simpletool', {
        is_read: false,
        is_write: true,
        analyzed_at: '2025-09-16T21:00:00.000Z',
      });

      const tools = sandboxedMcpServer.availableToolsList;

      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        id: 'simple_server__simpletool',
        name: 'simpletool',
        analysis: {
          status: 'completed',
          is_read: false,
          is_write: true,
        },
      });
    });
  });
});
