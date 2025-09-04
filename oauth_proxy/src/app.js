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
  app.get('/', async () => {
    const { getSupportedProviders } = await import('./config/providers.js');
    
    return {
      service: 'OAuth Proxy - Secure Token Exchange Service',
      version: '2.1.0',
      description: 'Secure OAuth proxy with provider-based endpoint validation',
      security: {
        ssrfProtection: 'Provider-based endpoint validation prevents SSRF attacks',
        allowedProviders: getSupportedProviders(),
        endpointValidation: 'Only trusted OAuth provider endpoints are allowed',
      },
      endpoints: {
        'POST /oauth/token': 'Secure token exchange (validates endpoints against provider allowlist)',
        'POST /oauth/revoke': 'Secure token revocation (validates endpoints against provider allowlist)', 
        'GET /callback/:provider': 'OAuth callback handler (redirects to desktop app via deep link)',
        'GET /health': 'Health check and supported providers list',
      }
    };
  });

  return app;
}