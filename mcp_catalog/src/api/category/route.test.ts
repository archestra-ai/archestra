import { describe, expect, it } from 'vitest';

import { GET } from './route';

describe('GET /mcp-catalog/api/category', () => {
  it('should return an array of categories', async () => {
    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toHaveProperty('categories');
    expect(Array.isArray(data.categories)).toBe(true);
    expect(data.categories.length).toBeGreaterThan(0);

    // Check that it includes some expected categories
    expect(data.categories).toContain('AI Tools');
    expect(data.categories).toContain('Development');
    expect(data.categories).toContain('Data');
  });
});
