import { isValidOAuthEndpoint, getAllowedDestinations } from '../config/providers.js';

/**
 * Validate MCP server ID to prevent environment variable injection attacks
 * @param {string} mcpServerId - The MCP server ID to validate
 * @returns {string} - The validated MCP server ID
 * @throws {Error} - If MCP server ID is invalid
 */
function validateMcpServerId(mcpServerId) {
  if (!mcpServerId || typeof mcpServerId !== 'string') {
    throw new Error('MCP server ID must be a valid string');
  }

  // Basic validation - only allow alphanumeric, hyphens, underscores, and dots
  const validPattern = /^[a-zA-Z0-9_.-]+$/;
  if (!validPattern.test(mcpServerId)) {
    throw new Error(`Invalid MCP server ID format: ${mcpServerId}`);
  }
  
  return mcpServerId;
}

export default async function tokenRoutes(fastify) {
  // Secure token exchange endpoint - validates endpoints against provider allowlist
  fastify.post('/oauth/token', {
    schema: {
      body: {
        type: 'object',
        required: ['grant_type', 'mcp_server_id', 'token_endpoint'],
        properties: {
          grant_type: { 
            type: 'string',
            enum: ['authorization_code', 'refresh_token']
          },
          mcp_server_id: { 
            type: 'string',
            pattern: '^[a-zA-Z0-9_.-]+$', // Only allow safe characters
            maxLength: 200,
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
    const { grant_type, mcp_server_id, token_endpoint, ...params } = request.body;

    // SECURITY: Validate MCP server ID to prevent environment variable injection
    let validatedServerId;
    try {
      validatedServerId = validateMcpServerId(mcp_server_id);
    } catch (error) {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: error.message,
      });
    }

    // SECURITY: Validate that token endpoint hostname is in the allowlist
    if (!isValidOAuthEndpoint(token_endpoint)) {
      const hostname = new URL(token_endpoint).hostname;
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: `Token endpoint hostname not allowed: ${hostname}`,
      });
    }

    // Get client credentials from environment variables using MCP server ID
    const clientIdEnvVar = `${validatedServerId}_CLIENT_ID`;
    const clientSecretEnvVar = `${validatedServerId}_SECRET`;
    
    const clientId = process.env[clientIdEnvVar];
    const clientSecret = process.env[clientSecretEnvVar];
    
    if (!clientSecret) {
      fastify.log.warn(`Client secret not configured for MCP server: ${validatedServerId}`);
      return reply.code(400).send({
        error: 'invalid_client',
        error_description: `Client secret not configured for MCP server: ${validatedServerId}`,
      });
    }

    // Build request parameters - desktop app provides parameters, but we override client credentials
    const requestParams = {
      ...params, // Desktop app provides all other needed parameters
      client_id: clientId, // Override with real client ID from environment
      client_secret: clientSecret, // Override with real client secret from environment  
      grant_type,
    };

    try {
      fastify.log.info(`Making secure token request to ${token_endpoint} for MCP server ${validatedServerId}`);

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

      const responseText = await response.text();
      let responseData;
      
      try {
        responseData = JSON.parse(responseText);
      } catch (parseError) {
        responseData = { raw_response: responseText };
      }

      if (!response.ok) {
        fastify.log.error(`Token exchange failed with status ${response.status}:`);
        fastify.log.error(`Response headers: ${JSON.stringify(Object.fromEntries(response.headers))}`);
        fastify.log.error(`Response data: ${JSON.stringify(responseData)}`);
        fastify.log.error(`Raw response text: ${responseText}`);
        fastify.log.error(`Status text: ${response.statusText}`);
        return reply.code(response.status).send(responseData);
      }

      fastify.log.info(`Token exchange successful for MCP server ${validatedServerId}`);
      return reply.send(responseData);
      
    } catch (error) {
      fastify.log.error('Token exchange error:', error);
      fastify.log.error(`Request params keys: ${Object.keys(requestParams)}`);
      fastify.log.error(`Token endpoint: ${token_endpoint}`);
      fastify.log.error(`MCP server ID: ${validatedServerId}`);
      
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: 'Token exchange failed',
      });
    }
  });

  // Secure token revocation endpoint - validates endpoints against allowlist
  fastify.post('/oauth/revoke', {
    schema: {
      body: {
        type: 'object',
        required: ['token', 'mcp_server_id'],
        properties: {
          token: { type: 'string' },
          mcp_server_id: { 
            type: 'string',
            pattern: '^[a-zA-Z0-9_.-]+$', // Only allow safe characters
            maxLength: 200,
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
    const { token, mcp_server_id, revocation_endpoint } = request.body;

    // SECURITY: Validate MCP server ID to prevent environment variable injection
    let validatedServerId;
    try {
      validatedServerId = validateMcpServerId(mcp_server_id);
    } catch (error) {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: error.message,
      });
    }

    // Skip revocation if no endpoint provided (some providers don't support it)
    if (!revocation_endpoint) {
      fastify.log.info(`No revocation endpoint provided for MCP server ${validatedServerId}, skipping`);
      return reply.send({ success: true });
    }

    // SECURITY: Validate that revocation endpoint hostname is in the allowlist
    if (!isValidOAuthEndpoint(revocation_endpoint)) {
      const hostname = new URL(revocation_endpoint).hostname;
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: `Revocation endpoint hostname not allowed: ${hostname}`,
      });
    }

    // Get client credentials from environment variables using MCP server ID
    const clientId = process.env[`${validatedServerId}_CLIENT_ID`];
    const clientSecret = process.env[`${validatedServerId}_SECRET`];

    try {
      const requestParams = {
        client_id: clientId,
        client_secret: clientSecret,
        token,
      };

      fastify.log.info(`Revoking token at ${revocation_endpoint} for MCP server ${validatedServerId}`);

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
      allowedDestinations: getAllowedDestinations(),
      security: 'Hostname-based endpoint validation prevents SSRF attacks',
      timestamp: new Date().toISOString(),
    };
  });
}