import { describe, expect, it } from 'vitest';

import { GET } from './route';

describe('GET /mcp-catalog/api/docs', () => {
  it('should return a valid OpenAPI schema', async () => {
    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toHaveProperty('openapi');
    expect(data.openapi).toBe('3.0.0');
    expect(data).toHaveProperty('info');
    expect(data.info).toHaveProperty('title', 'MCP Catalog API');
    expect(data).toHaveProperty('paths');
  });
});
