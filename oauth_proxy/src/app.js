import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import { config, validateConfig } from './config/index.js';
import tokenRoutes from './routes/token.js';
import callbackRoutes from './routes/callback.js';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info'
    }
  });

  // Validate configuration
  validateConfig();

  // Register plugins
  await app.register(cors, config.cors);
  await app.register(formbody);

  // Register routes
  await app.register(tokenRoutes);
  await app.register(callbackRoutes);

  // Root endpoint
  app.get('/', async () => ({
    service: 'OAuth Proxy - Generic Token Exchange Service',
    version: '2.0.0',
    description: 'Generic OAuth proxy that injects client secrets for any provider endpoints specified by desktop app',
    endpoints: {
      'POST /oauth/token': 'Generic token exchange (requires token_endpoint from desktop app)',
      'POST /oauth/revoke': 'Generic token revocation (requires revoke_endpoint from desktop app)',
      'GET /callback/:provider': 'OAuth callback handler (redirects to desktop app via deep link)',
      'GET /health': 'Health check endpoint',
    }
  }));

  return app;
}