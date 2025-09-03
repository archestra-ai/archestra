import { isValidOAuthEndpoint, getSupportedProviders } from '../config/providers.js';

/**
 * Validate provider name to prevent environment variable injection attacks
 * @param {string} provider - The provider name to validate
 * @returns {string} - The validated, normalized provider name
 * @throws {Error} - If provider is not supported
 */
function validateProvider(provider) {
  if (!provider || typeof provider !== 'string') {
    throw new Error('Provider must be a valid string');
  }

  const supportedProviders = getSupportedProviders();
  const normalizedProvider = provider.toLowerCase();
  
  if (!supportedProviders.includes(normalizedProvider)) {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  
  return normalizedProvider;
}

export default async function tokenRoutes(fastify) {
  // Secure token exchange endpoint - validates endpoints against provider allowlist
  fastify.post('/oauth/token', {
    schema: {
      body: {
        type: 'object',
        required: ['grant_type', 'provider', 'token_endpoint'],
        properties: {
          grant_type: { 
            type: 'string',
            enum: ['authorization_code', 'refresh_token']
          },
          provider: { 
            type: 'string',
            enum: getSupportedProviders() // Only allow trusted providers
          },
          token_endpoint: {
            type: 'string',
            format: 'uri',
            maxLength: 2048,
          },
          
          // For authorization_code grant
          code: { 
            type: 'string',
            minLength: 1,
            maxLength: 2048,
          },
          redirect_uri: { 
            type: 'string',
            format: 'uri',
            maxLength: 2048,
          },
          code_verifier: { 
            type: 'string',
            minLength: 43,
            maxLength: 128,
            pattern: '^[A-Za-z0-9-._~]+$',
          },
          
          // For refresh_token grant  
          refresh_token: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            access_token: { type: 'string' },
            token_type: { type: 'string' },
            expires_in: { type: 'number' },
            refresh_token: { type: 'string' },
            scope: { type: 'string' },
          },
        },
        400: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            error_description: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { grant_type, provider, token_endpoint, ...params } = request.body;

    // SECURITY: Validate provider to prevent environment variable injection
    let validatedProvider;
    try {
      validatedProvider = validateProvider(provider);
    } catch (error) {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: error.message,
      });
    }

    // SECURITY: Validate that token endpoint is allowed for this provider
    if (!isValidOAuthEndpoint(token_endpoint, validatedProvider)) {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: `Token endpoint not allowed for provider ${validatedProvider}`,
      });
    }

    // Get client credentials from environment variables (using validated provider)
    const clientId = process.env[`${validatedProvider.toUpperCase()}_CLIENT_ID`];
    const clientSecret = process.env[`${validatedProvider.toUpperCase()}_CLIENT_SECRET`];
    
    if (!clientSecret) {
      return reply.code(400).send({
        error: 'invalid_client',
        error_description: `Client secret not configured for provider: ${validatedProvider}`,
      });
    }

    try {
      // Build request parameters - desktop app handles all provider-specific logic
      const requestParams = {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type,
        ...params, // Desktop app provides all other needed parameters
      };

      fastify.log.info(`Making secure token request to ${token_endpoint} for provider ${validatedProvider}`);

      // Make request to the validated endpoint only
      const response = await fetch(token_endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(requestParams),
        // Add timeout for security
        signal: AbortSignal.timeout(30000),
      });

      const responseData = await response.json();

      if (!response.ok) {
        fastify.log.error(`Token exchange failed with status ${response.status}:`, responseData);
        return reply.code(response.status).send(responseData);
      }

      fastify.log.info(`Token exchange successful for provider ${validatedProvider}`);
      return reply.send(responseData);
      
    } catch (error) {
      fastify.log.error('Token exchange error:', error);
      
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: 'Token exchange failed',
      });
    }
  });

  // Secure token revocation endpoint - validates endpoints against provider allowlist
  fastify.post('/oauth/revoke', {
    schema: {
      body: {
        type: 'object',
        required: ['token', 'provider'],
        properties: {
          token: { type: 'string' },
          provider: { 
            type: 'string',
            enum: getSupportedProviders() // Only allow trusted providers
          },
          revocation_endpoint: {
            type: 'string',
            format: 'uri',
            maxLength: 2048,
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { token, provider, revocation_endpoint } = request.body;

    // SECURITY: Validate provider to prevent environment variable injection
    let validatedProvider;
    try {
      validatedProvider = validateProvider(provider);
    } catch (error) {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: error.message,
      });
    }

    // Skip revocation if no endpoint provided (some providers don't support it)
    if (!revocation_endpoint) {
      fastify.log.info(`No revocation endpoint provided for provider ${validatedProvider}, skipping`);
      return reply.send({ success: true });
    }

    // SECURITY: Validate that revocation endpoint is allowed for this provider
    if (!isValidOAuthEndpoint(revocation_endpoint, validatedProvider)) {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: `Revocation endpoint not allowed for provider ${validatedProvider}`,
      });
    }

    // Get client credentials from environment variables (using validated provider)
    const clientId = process.env[`${validatedProvider.toUpperCase()}_CLIENT_ID`];
    const clientSecret = process.env[`${validatedProvider.toUpperCase()}_CLIENT_SECRET`];

    try {
      const requestParams = {
        client_id: clientId,
        client_secret: clientSecret,
        token,
      };

      fastify.log.info(`Revoking token at ${revocation_endpoint} for provider ${validatedProvider}`);

      const response = await fetch(revocation_endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(requestParams),
        // Add timeout for security
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        fastify.log.error(`Token revocation failed with status ${response.status}:`, errorData);
      }
      
      return reply.send({ success: true });
      
    } catch (error) {
      fastify.log.error('Token revocation error:', error);
      
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: error.message,
      });
    }
  });

  // Health check endpoint
  fastify.get('/health', async (request, reply) => {
    return {
      status: 'ok',
      service: 'OAuth Proxy - Secure Token Exchange Service',
      supportedProviders: getSupportedProviders(),
      security: 'Provider-based endpoint validation prevents SSRF attacks',
      timestamp: new Date().toISOString(),
    };
  });
}