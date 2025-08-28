import fastify, { FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import categoryRoutes from './';

describe('GET /v1/category', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(categoryRoutes);
    await app.ready();
  });

  it('should return an array of categories', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/category',
    });

    expect(response.statusCode).toBe(200);

    const data = response.json();
    expect(data).toHaveProperty('categories');
    expect(Array.isArray(data.categories)).toBe(true);
    expect(data.categories.length).toBeGreaterThan(0);

    // Check that it includes some expected categories
    expect(data.categories).toContain('AI Tools');
    expect(data.categories).toContain('Development');
    expect(data.categories).toContain('Data');
  });
});
