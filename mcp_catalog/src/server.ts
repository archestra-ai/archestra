import fastify from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

import constants from '@constants';
import cors from '@fastify/cors';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUI from '@fastify/swagger-ui';

import apiV1Routes from './handlers/v1';

const {
  baseUrl,
  logLevel,
  server: { host, port },
} = constants;

async function start() {
  const app = fastify({
    logger: {
      level: logLevel,
    },
  });

  // Add schema validator and serializer
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Register Swagger (must be before routes)
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'MCP Catalog API',
        version: '1.0.0',
        description: 'API for searching and retrieving MCP server information',
      },
      servers: [
        {
          url: baseUrl,
          description: 'MCP Catalog API',
        },
      ],
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  // Register Swagger UI
  await app.register(fastifySwaggerUI, {
    routePrefix: '/api/v1/docs',
    uiConfig: {
      docExpansion: 'full',
      deepLinking: false,
    },
  });

  // Register CORS
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders: ['X-Total-Count'],
    maxAge: 3600,
  });

  // Register API v1 routes
  await app.register(apiV1Routes, { prefix: '/v1' });

  // Health check endpoint
  app.get('/health', async (_request, _reply) => ({ status: 'ok' }));

  // Start server
  try {
    await app.listen({ host, port });
    app.log.info(`Server running on http://${host}:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
