import { describe, expect, it } from 'vitest';

import { constructToolId, deconstructToolId } from './constants';

describe('Tool ID Functions', () => {
  describe('constructToolId', () => {
    it.each([
      ['server_name', 'tool_id', 'server_name__tool_id'],
      [
        'modelcontextprotocol__servers__src__filesystem__servers__src__filesystem',
        'read_file',
        'modelcontextprotocol__servers__src__filesystem__servers__src__filesystem__read_file',
      ],
    ])('serverName: %s, toolName: %s should be %s', (serverName, toolName, expected) => {
      const result = constructToolId(serverName, toolName);
      expect(result).toBe(expected);
    });
  });

  describe('deconstructToolId', () => {
    it.each([
      ['server_name__tool_id', 'server_name', 'tool_id'],
      [
        'modelcontextprotocol__servers__src__filesystem__servers__src__filesystem__read_file',
        'modelcontextprotocol__servers__src__filesystem__servers__src__filesystem',
        'read_file',
      ],
    ])('toolId: %s should be %s', (toolId, expectedServerName, expectedToolName) => {
      const result = deconstructToolId(toolId);
      expect(result).toEqual({
        serverName: expectedServerName,
        toolName: expectedToolName,
      });
    });
  });
});
