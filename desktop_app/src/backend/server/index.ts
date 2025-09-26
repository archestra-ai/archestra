import cors from '@fastify/cors';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import config from '@backend/config';
import browserAuthRoutes from '@backend/server/plugins/browser-auth';
import chatRoutes from '@backend/server/plugins/chat';
import cloudProviderRoutes from '@backend/server/plugins/cloudProviders';
import externalMcpClientRoutes from '@backend/server/plugins/externalMcpClient';
import genericOAuthRoutes from '@backend/server/plugins/generic-oauth';
import llmRoutes from '@backend/server/plugins/llm';
import archestraMcpServerPlugin from '@backend/server/plugins/mcp';
import mcpRequestLogRoutes from '@backend/server/plugins/mcpRequestLog';
import mcpServerRoutes from '@backend/server/plugins/mcpServer';
import memoryRoutes from '@backend/server/plugins/memory';
import ollamaRoutes from '@backend/server/plugins/ollama';
import ollamaProxyRoutes from '@backend/server/plugins/ollama/proxy';
import sandboxRoutes from '@backend/server/plugins/sandbox';
import systemRoutes from '@backend/server/plugins/system';
import userRoutes from '@backend/server/plugins/user';
import { electronLogStream } from '@backend/utils/fastify-logger-stream';
import log from '@backend/utils/logger';

let app: ReturnType<typeof fastify> | null = null;

export const startFastifyServer = async () => {
  app = fastify({
    logger: {
      level: config.logLevel,
      stream: electronLogStream,
    },
  });

  /**
   * Add schema validator and serializer
   * https://github.com/turkerdev/fastify-type-provider-zod?tab=readme-ov-file#how-to-use
   */
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, {
    // Allow all origins in development
    origin: true,
    credentials: true,
    // Ensure all methods are allowed
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    // Allow common headers
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    // Expose headers that might be needed
    exposedHeaders: ['X-Total-Count'],
    // Cache preflight response for 1 hour
    maxAge: 3600,
  });
  await app.register(chatRoutes);
  await app.register(cloudProviderRoutes);
  await app.register(externalMcpClientRoutes);
  await app.register(genericOAuthRoutes);
  await app.register(llmRoutes);
  await app.register(mcpRequestLogRoutes);
  await app.register(mcpServerRoutes);
  await app.register(memoryRoutes);
  await app.register(browserAuthRoutes);
  await app.register(ollamaRoutes);
  await app.register(ollamaProxyRoutes);
  await app.register(sandboxRoutes);
  await app.register(systemRoutes);
  await app.register(userRoutes);

  await app.register(archestraMcpServerPlugin);

  const { http } = config.server;

  log.info(`Fastify server starting on port ${http.port}`);

  // Start the Fastify server
  try {
    await app.listen({ port: http.port, host: http.host });
    app.log.info(`Fastify server running on port ${http.port}`);
  } catch (err) {
    app.log.error(err);
    // Exit with error code to signal failure to parent process
    process.exit(1);
  }
};

export const stopFastifyServer = async () => {
  if (app) {
    log.info('Stopping Fastify server...');
    try {
      await app.close();
      app = null;
      log.info('Fastify server stopped successfully');
    } catch (error) {
      log.error('Error stopping Fastify server:', error);
      throw error;
    }
  }
};
