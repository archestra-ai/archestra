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
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'warn' : 'info'),
      // Log security-relevant events in production
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url,
            ip: request.ip,
            headers: {
              'user-agent': request.headers['user-agent'],
              'x-forwarded-for': request.headers['x-forwarded-for'],
            },
          };
        },
      },
    },
  });

  // // Register security plugins
  // await app.register(helmet, {
  //   contentSecurityPolicy: {
  //     directives: {
  //       defaultSrc: ["'self'"],
  //       scriptSrc: ["'self'", "'unsafe-inline'"], // For inline redirect script
  //       styleSrc: ["'self'", "'unsafe-inline'"],
  //       imgSrc: ["'self'", 'data:', 'https:'],
  //       connectSrc: ["'self'"],
  //       fontSrc: ["'self'"],
  //       objectSrc: ["'none'"],
  //       mediaSrc: ["'self'"],
  //       frameSrc: ["'none'"],
  //     },
  //   },
  //   // HSTS disabled since we're using HTTP only (with ngrok handling HTTPS)
  //   hsts: false,
  // });

  // Rate limiting per IP
  await app.register(rateLimit, {
    max: 100, // Max 100 requests
    timeWindow: '15 minutes',
    skipFailedRequests: false,
    keyGenerator: (request) => {
      // Use X-Forwarded-For if behind proxy, otherwise use direct IP
      return request.headers['x-forwarded-for']?.split(',')[0] || request.ip;
    },
  });

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
    
    return {
      name: 'OAuth Proxy Server',
      version: '2.0.0',
      description: 'Secure OAuth proxy for PKCE-based token exchange',
      endpoints: {
        'GET /oauth/providers': 'List all configured and available providers',
        'GET /oauth/providers/:name': 'Get detailed information about a provider',
        'GET /oauth/providers/:name/status': 'Check if a provider is configured',
        'POST /oauth/token': {
          description: 'Exchange authorization code or refresh token',
          parameters: {
            grant_type: 'authorization_code | refresh_token',
            provider: providers.join(' | '),
            code: 'Authorization code (for authorization_code grant)',
            code_verifier: 'PKCE code verifier (optional)',
            redirect_uri: 'Redirect URI used in authorization',
            refresh_token: 'Refresh token (for refresh_token grant)',
          },
        },
        'POST /oauth/revoke': {
          description: 'Revoke an access or refresh token',
          parameters: {
            token: 'Token to revoke',
            provider: providers.join(' | '),
          },
        },
        'GET /health': 'Health check endpoint',
      },
      configured_providers: providers,
    };
  });

  return app;
}