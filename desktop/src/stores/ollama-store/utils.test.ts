import { describe, expect, it } from 'vitest';

import type { MCPServerTools } from '../mcp-servers-store';
import {
  convertMCPServerToolsToOllamaTools,
  convertOllamaToolNameToServerAndToolName,
  convertServerAndToolNameToOllamaToolName,
} from './utils';

describe('Ollama Store Utility Functions', () => {
  describe('convertServerAndToolNameToOllamaToolName', () => {
    it('should combine server name and tool name with underscore', () => {
      expect(convertServerAndToolNameToOllamaToolName('Slack', 'channel_get_history')).toBe(
        'Slack_channel_get_history'
      );
    });
  });

  describe('convertOllamaToolNameToServerAndToolName', () => {
    it('should split on first underscore only', () => {
      expect(convertOllamaToolNameToServerAndToolName('Slack_channel_get_history')).toEqual([
        'Slack',
        'channel_get_history',
      ]);
    });

    it('should handle server names with underscores', () => {
      expect(convertOllamaToolNameToServerAndToolName('My_Server_tool_name')).toEqual(['My', 'Server_tool_name']);
      expect(convertOllamaToolNameToServerAndToolName('Test_Server_get_data')).toEqual(['Test', 'Server_get_data']);
    });

    it('should throw error for invalid format (no underscore)', () => {
      expect(() => convertOllamaToolNameToServerAndToolName('InvalidToolName')).toThrow(
        'Invalid tool name format: InvalidToolName. Expected format: serverName_toolName'
      );
    });
  });

  describe('convertMCPServerToolsToOllamaTools', () => {
    it('should convert MCP server tools to Ollama tools format', () => {
      const mockMCPServerTools: MCPServerTools = {
        Slack: [
          {
            name: 'channel_get_history',
            description: 'Get channel history',
            inputSchema: {
              type: 'object',
              properties: {
                channel: { type: 'string' },
                limit: { type: 'number' },
              },
            },
          },
          {
            name: 'send_message',
            description: 'Send a message to a channel',
            inputSchema: {
              type: 'object',
              properties: {
                channel: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        ],
        Gmail: [
          {
            name: 'send_email',
            description: 'Send an email',
            inputSchema: {
              type: 'object',
              properties: {
                to: { type: 'string' },
                subject: { type: 'string' },
                body: { type: 'string' },
              },
            },
          },
        ],
      };

      const result = convertMCPServerToolsToOllamaTools(mockMCPServerTools);

      expect(result).toHaveLength(3);
      expect(result).toEqual([
        {
          type: 'function',
          function: {
            name: 'Slack_channel_get_history',
            description: 'Get channel history',
            parameters: {
              type: 'object',
              properties: {
                channel: { type: 'string' },
                limit: { type: 'number' },
              },
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'Slack_send_message',
            description: 'Send a message to a channel',
            parameters: {
              type: 'object',
              properties: {
                channel: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'Gmail_send_email',
            description: 'Send an email',
            parameters: {
              type: 'object',
              properties: {
                to: { type: 'string' },
                subject: { type: 'string' },
                body: { type: 'string' },
              },
            },
          },
        },
      ]);
    });

    it('should handle tools without description', () => {
      const mockMCPServerTools: MCPServerTools = {
        TestServer: [
          {
            name: 'test_tool',
            description: undefined,
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
        ],
      };

      const result = convertMCPServerToolsToOllamaTools(mockMCPServerTools);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'function',
        function: {
          name: 'TestServer_test_tool',
          description: 'Tool from TestServer',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      });
    });

    it('should handle empty tools object', () => {
      const mockMCPServerTools: MCPServerTools = {};

      const result = convertMCPServerToolsToOllamaTools(mockMCPServerTools);

      expect(result).toHaveLength(0);
      expect(result).toEqual([]);
    });

    it('should handle server with no tools', () => {
      const mockMCPServerTools: MCPServerTools = {
        EmptyServer: [],
      };

      const result = convertMCPServerToolsToOllamaTools(mockMCPServerTools);

      expect(result).toHaveLength(0);
      expect(result).toEqual([]);
    });
  });
});
