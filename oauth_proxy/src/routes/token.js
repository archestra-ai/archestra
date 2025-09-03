export default async function tokenRoutes(fastify) {
  // Generic token exchange endpoint
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
          provider: { type: 'string' },
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

    // Get client credentials from environment variables
    const clientId = process.env[`${provider.toUpperCase()}_CLIENT_ID`];
    const clientSecret = process.env[`${provider.toUpperCase()}_CLIENT_SECRET`];
    
    if (!clientSecret) {
      return reply.code(400).send({
        error: 'invalid_client',
        error_description: `Client secret not configured for provider: ${provider}`,
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

      fastify.log.info(`Making token request to ${token_endpoint} for provider ${provider}`);

      // Make request to whatever endpoint the desktop app specified
      const response = await fetch(token_endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(requestParams),
      });

      const responseData = await response.json();

      if (!response.ok) {
        fastify.log.error(`Token exchange failed with status ${response.status}:`, responseData);
        return reply.code(response.status).send(responseData);
      }

      fastify.log.info(`Token exchange successful for provider ${provider}`);
      return reply.send(responseData);
      
    } catch (error) {
      fastify.log.error('Token exchange error:', error);
      
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: 'Token exchange failed',
      });
    }
  });

  // Generic token revocation endpoint
  fastify.post('/oauth/revoke', {
    schema: {
      body: {
        type: 'object',
        required: ['token', 'provider'],
        properties: {
          token: { type: 'string' },
          provider: { type: 'string' },
          revoke_endpoint: {
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
    const { token, provider, revoke_endpoint } = request.body;

    // Skip revocation if no endpoint provided (some providers don't support it)
    if (!revoke_endpoint) {
      return reply.send({ success: true });
    }

    // Get client credentials from environment variables
    const clientId = process.env[`${provider.toUpperCase()}_CLIENT_ID`];
    const clientSecret = process.env[`${provider.toUpperCase()}_CLIENT_SECRET`];

    try {
      const requestParams = {
        client_id: clientId,
        client_secret: clientSecret,
        token,
      };

      fastify.log.info(`Revoking token at ${revoke_endpoint} for provider ${provider}`);

      const response = await fetch(revoke_endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(requestParams),
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
      service: 'OAuth Proxy - Generic Token Exchange Service',
      timestamp: new Date().toISOString(),
    };
  });
}