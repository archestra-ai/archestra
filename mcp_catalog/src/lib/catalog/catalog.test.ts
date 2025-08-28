import * as fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ArchestraMcpServerManifest } from '@archestra/types';

import { loadServers } from './';

vi.mock('fs');

describe('loadServers security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should prevent path traversal attacks when loading specific server', () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    
    // Mock fs.existsSync to return false for safety
    vi.mocked(fs.existsSync).mockReturnValue(false);
    
    // Mock readFileSync to return empty array for mcp-servers.json
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      return JSON.stringify([]);
    });
    
    // Attempt path traversal
    const servers = loadServers('../../../etc/passwd');
    
    // Should warn about attempted path traversal
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Attempted path traversal or out-of-bounds access detected'),
      expect.any(String)
    );
    
    // Should return empty array
    expect(servers).toEqual([]);
    
    consoleWarnSpy.mockRestore();
  });

  it('should load valid server evaluation files', () => {
    const validName = 'test-org__test-repo';
    const mockEvaluation: ArchestraMcpServerManifest = {
      dxt_version: '0.1.0',
      version: '1.0.0',
      name: validName,
      display_name: 'Test Server',
      description: 'A test server',
      author: { name: 'Test', email: 'test@example.com' },
      server: { type: 'node' as const, entry_point: 'index.js', mcp_config: { command: 'node', args: [], env: {} } },
      category: 'AI Tools',
      programming_language: 'TypeScript',
      quality_score: 85,
      github_info: {
        owner: 'test-org',
        repo: 'test-repo',
        url: 'https://github.com/test-org/test-repo',
        name: 'test-repo',
        path: null,
        stars: 100,
        contributors: 5,
        issues: 10,
        releases: true,
        ci_cd: true,
        latest_commit_hash: 'abc123',
      },
      archestra_config: {
        client_config_permutations: { mcpServers: {} },
        oauth: { provider: null, required: false },
      },
      tools: [],
      prompts: [],
      readme: '',
      framework: 'express',
      dependencies: [],
      last_scraped_at: '2024-01-01',
      evaluation_model: 'claude-3',
      protocol_features: {
        implementing_tools: false,
        implementing_prompts: false,
        implementing_resources: false,
        implementing_sampling: false,
        implementing_roots: false,
        implementing_logging: false,
        implementing_stdio: false,
        implementing_streamable_http: false,
        implementing_oauth2: false,
      },
      raw_dependencies: null,
      long_description: '',
      $schema: '',
    };
    
    // Mock file system
    vi.mocked(fs.existsSync).mockImplementation((filePath) => {
      const pathStr = filePath.toString();
      // Return true for the evaluation file we're looking for
      if (pathStr.endsWith(`${validName}.json`) && pathStr.includes('mcp-evaluations')) {
        return true;
      }
      // Return true for evaluations directory
      if (pathStr.endsWith('mcp-evaluations')) {
        return true;
      }
      return false;
    });
    
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      const pathStr = filePath.toString();
      if (pathStr.endsWith('mcp-servers.json')) {
        // Return an array with a URL that matches our test server
        return JSON.stringify(['https://github.com/test-org/test-repo']);
      }
      if (pathStr.endsWith(`${validName}.json`)) {
        return JSON.stringify(mockEvaluation);
      }
      return '';
    });
    
    const servers = loadServers(validName);
    
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject(mockEvaluation);
  });
});