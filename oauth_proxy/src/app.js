import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { config } from './config/index.js';
import { initializeProviders, getAllProviders } from './providers/index.js';
import tokenRoutes from './routes/token.js';
import callbackRoutes from './routes/callback.js';
import providersRoute from './routes/providers.js';

export async function buildApp() {
  // Initialize providers
  initializeProviders();

  // Create Fastify instance
  const app = Fastify();

  // Register other plugins
  await app.register(cors, config.cors);
  await app.register(formbody);

  // Register routes
  await app.register(tokenRoutes);
  await app.register(callbackRoutes);
  await app.register(providersRoute);

  // Root endpoint - API documentation
  app.get('/', async (request, reply) => {
    const providers = getAllProviders();
    
    return "What are you doing here little fella? ;)";
  });

  return app;
}