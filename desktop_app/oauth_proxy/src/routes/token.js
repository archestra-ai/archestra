import { isValidOAuthEndpoint, getAllowedDestinations } from '../config/providers.js';
import { exchangeAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';

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

  // MCP SDK token exchange proxy - forwards MCP SDK requests with proper client credentials
  fastify.post('/mcp/token/:mcp_server_id', {
    schema: {
      params: {
        type: 'object',
        required: ['mcp_server_id'],
        properties: {
          mcp_server_id: {
            type: 'string',
            pattern: '^[a-zA-Z0-9_.-]+$',
            maxLength: 200,
          },
        },
      },
      body: {
        type: 'object',
        // Accept any body - forward as-is to the target endpoint
        additionalProperties: true,
      },
      response: {
        200: {
          type: 'object',
          additionalProperties: true,
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
    const { mcp_server_id } = request.params;
    const body = request.body;

    // SECURITY: Validate MCP server ID
    let validatedServerId;
    try {
      validatedServerId = validateMcpServerId(mcp_server_id);
    } catch (error) {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: error.message,
      });
    }

    // Get client credentials from environment variables
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

    // Determine target endpoint from request headers or use default
    const targetEndpoint = request.headers['x-target-endpoint'] || `https://api.githubcopilot.com/mcp/oauth/token`;

    // SECURITY: Validate target endpoint
    if (!isValidOAuthEndpoint(targetEndpoint)) {
      const hostname = new URL(targetEndpoint).hostname;
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: `Target endpoint hostname not allowed: ${hostname}`,
      });
    }

    // Use exact MCP SDK logic for client authentication
    // MCP SDK selectClientAuthMethod (line 27-28): defaults to client_secret_post when no supportedMethods
    // BUT GitHub clearly needs Authorization header, so simulate server supporting basic auth
    const supportedMethods = ['client_secret_basic']; // Simulate GitHub supporting basic auth
    const hasClientSecret = !!clientSecret;
    
    // MCP SDK selectClientAuthMethod logic (lines 24-42)
    let authMethod;
    if (supportedMethods.length === 0) {
      authMethod = hasClientSecret ? 'client_secret_post' : 'none';
    } else if (hasClientSecret && supportedMethods.includes('client_secret_basic')) {
      authMethod = 'client_secret_basic';
    } else if (hasClientSecret && supportedMethods.includes('client_secret_post')) {
      authMethod = 'client_secret_post';
    } else if (supportedMethods.includes('none')) {
      authMethod = 'none';
    } else {
      authMethod = hasClientSecret ? 'client_secret_post' : 'none';
    }
    
    let authHeader = request.headers.authorization;
    
    // MCP SDK applyClientAuthentication logic (lines 57-72)
    if (authMethod === 'client_secret_basic' && !authHeader) {
      // MCP SDK applyBasicAuth (lines 76-81)
      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      authHeader = `Basic ${credentials}`;
      fastify.log.info('Applied MCP SDK client_secret_basic authentication');
    }
    
    fastify.log.info(`MCP SDK auth method: ${authMethod}, has auth header: ${!!authHeader}`);

    // Build clean request body with only OAuth parameters (remove proxy-specific params)
    const cleanBody = { ...body };
    delete cleanBody.mcp_server_id; // Remove proxy-specific parameter
    delete cleanBody.token_endpoint; // Remove proxy-specific parameter
    delete cleanBody.client_secret; // Remove since it goes in Authorization header for Basic auth
    
    // MCP SDK applyClientAuthentication for request body (lines 86-96)
    const requestBody = { ...cleanBody };
    
    if (authMethod === 'client_secret_basic') {
      // MCP SDK applyBasicAuth: credentials go in Authorization header only
      requestBody.client_id = clientId;
      // client_secret NOT in body for basic auth
    } else if (authMethod === 'client_secret_post') {
      // MCP SDK applyPostAuth: credentials go in request body
      requestBody.client_id = clientId;
      if (clientSecret) {
        requestBody.client_secret = clientSecret;
      }
    } else if (authMethod === 'none') {
      // MCP SDK applyPublicAuth: only client_id in body
      requestBody.client_id = clientId;
    }
    
    fastify.log.info(`Request body will include client_id: ${!!requestBody.client_id}, client_secret: ${!!requestBody.client_secret}`);

    try {
      fastify.log.info(`Proxying MCP token request to ${targetEndpoint} for server ${validatedServerId}`);
      fastify.log.info(`Original request body keys: ${Object.keys(body)}`);
      fastify.log.info(`Clean request body keys: ${Object.keys(requestBody)}`);
      fastify.log.info(`Incoming Authorization header: ${request.headers.authorization || 'none'}`);
      fastify.log.info(`All incoming headers: ${JSON.stringify(request.headers)}`);
      
      fastify.log.info(`Auth method: ${authMethod}, Authorization header: ${authHeader ? authHeader.substring(0, 20) + '...' : 'none'}`);
      
      // Forward all headers from the original request, but override Authorization and Content-Type
      const forwardedHeaders = {
        ...request.headers,
        // Override with target host
        'host': new URL(targetEndpoint).hostname,
        // Force form encoding for OAuth token requests (matches MCP SDK)
        'content-type': 'application/x-www-form-urlencoded',
      };

      // Always set Authorization header if we have one (GitHub requires it)
      if (authHeader) {
        forwardedHeaders['authorization'] = authHeader;
        fastify.log.info(`Setting Authorization header for method ${authMethod}: ${authHeader.substring(0, 20)}...`);
      } else {
        // Remove any existing authorization header if we don't have one
        delete forwardedHeaders['authorization'];
        fastify.log.info('No Authorization header to set');
      }
      
      // Remove proxy-specific headers that shouldn't be forwarded
      delete forwardedHeaders['x-target-endpoint'];
      delete forwardedHeaders['x-forwarded-for'];
      delete forwardedHeaders['x-forwarded-proto'];
      delete forwardedHeaders['x-forwarded-host'];
      delete forwardedHeaders['content-length']; // Let Node.js calculate correct length for cleaned body
      
      fastify.log.info(`Forwarded headers: ${JSON.stringify(forwardedHeaders)}`);
      
      fastify.log.info(`Final request body being sent: ${JSON.stringify(requestBody)}`);
      fastify.log.info(`URLSearchParams body: ${new URLSearchParams(requestBody).toString()}`);
      
      let response;
      try {
        response = await fetch(targetEndpoint, {
          method: 'POST',
          headers: forwardedHeaders,
          body: new URLSearchParams(requestBody), // Use cleaned requestBody
          signal: AbortSignal.timeout(30000),
        });

        const responseText = await response.text();
        let responseData;
        
        try {
          responseData = JSON.parse(responseText);
        } catch (parseError) {
          responseData = { raw_response: responseText };
        }

        fastify.log.info(`GitHub response status: ${response.status}`);
        fastify.log.info(`GitHub response headers: ${JSON.stringify(Object.fromEntries(response.headers))}`);
        fastify.log.info(`GitHub response text: ${responseText}`);
        fastify.log.info(`GitHub response data: ${JSON.stringify(responseData)}`);

        if (!response.ok) {
          fastify.log.error(`MCP token exchange failed with status ${response.status}:`);
          fastify.log.error(`Response headers: ${JSON.stringify(Object.fromEntries(response.headers))}`);
          fastify.log.error(`Response data: ${JSON.stringify(responseData)}`);
          fastify.log.error(`Raw response text: ${responseText}`);
          return reply.code(response.status).send(responseData);
        }

        fastify.log.info(`MCP token exchange successful for server ${validatedServerId}`);
        return reply.send(responseData);
        
      } catch (fetchError) {
        fastify.log.error('Fetch error details:');
        fastify.log.error(`Fetch error message: ${fetchError.message}`);
        fastify.log.error(`Fetch error name: ${fetchError.name}`);
        fastify.log.error(`Fetch error cause: ${JSON.stringify(fetchError.cause)}`);
        fastify.log.error(`Fetch error code: ${fetchError.code}`);
        fastify.log.error(`Fetch error errno: ${fetchError.errno}`);
        fastify.log.error(`Fetch error syscall: ${fetchError.syscall}`);
        fastify.log.error(`Full fetch error: ${JSON.stringify(fetchError, Object.getOwnPropertyNames(fetchError))}`);
        throw fetchError; // Re-throw to be caught by outer catch
      }

    } catch (error) {
      fastify.log.error('MCP token exchange error:', error);
      fastify.log.error(`Target endpoint: ${targetEndpoint}`);
      fastify.log.error(`MCP server ID: ${validatedServerId}`);
      fastify.log.error(`Error message: ${error.message}`);
      fastify.log.error(`Error stack: ${error.stack}`);
      
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: 'MCP token exchange failed',
      });
    }
  });

  // MCP SDK-based token exchange - uses actual MCP SDK functions
  fastify.post('/mcp/sdk-token/:mcp_server_id', {
    schema: {
      params: {
        type: 'object',
        required: ['mcp_server_id'],
        properties: {
          mcp_server_id: {
            type: 'string',
            pattern: '^[a-zA-Z0-9_.-]+$',
            maxLength: 200,
          },
        },
      },
      body: {
        type: 'object',
        required: ['authorization_code', 'code_verifier', 'redirect_uri'],
        properties: {
          authorization_code: { type: 'string' },
          code_verifier: { type: 'string' },
          redirect_uri: { type: 'string' },
          resource: { type: 'string' },
          authorization_server_url: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { mcp_server_id } = request.params;
    const { authorization_code, code_verifier, redirect_uri, resource, authorization_server_url } = request.body;

    // SECURITY: Validate MCP server ID
    let validatedServerId;
    try {
      validatedServerId = validateMcpServerId(mcp_server_id);
    } catch (error) {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: error.message,
      });
    }

    // Get client credentials from environment variables
    const clientIdEnvVar = `${validatedServerId}_CLIENT_ID`;
    const clientSecretEnvVar = `${validatedServerId}_SECRET`;
    
    const clientId = process.env[clientIdEnvVar];
    const clientSecret = process.env[clientSecretEnvVar];
    
    if (!clientId || !clientSecret) {
      fastify.log.warn(`Client credentials not configured for MCP server: ${validatedServerId}`);
      return reply.code(400).send({
        error: 'invalid_client',
        error_description: `Client credentials not configured for MCP server: ${validatedServerId}`,
      });
    }

    try {
      fastify.log.info(`Using MCP SDK exchangeAuthorization for server ${validatedServerId}`);
      fastify.log.info(`Client credentials: clientId=${clientId ? 'PRESENT' : 'MISSING'}, clientSecret=${clientSecret ? 'PRESENT' : 'MISSING'}`);
      
      // Follow the MCP SDK's discovery pattern: start from MCP server URL, discover authorization servers
      // This mimics the exact flow used in the linear script
      let metadata = undefined;
      let authorizationServerUrl = authorization_server_url;
      
      try {
        // Step 1: Discover protected resource metadata from the MCP server
        if (authorization_server_url) {
          fastify.log.info(`Discovering OAuth metadata starting from server URL: ${authorization_server_url}`);
          
          const { discoverOAuthProtectedResourceMetadata, discoverAuthorizationServerMetadata } = 
            await import('@modelcontextprotocol/sdk/client/auth.js');
          
          // Try to get resource metadata from the MCP server
          try {
            const resourceMetadata = await discoverOAuthProtectedResourceMetadata(authorization_server_url);
            
            if (resourceMetadata?.authorization_servers && resourceMetadata.authorization_servers.length > 0) {
              // Use the first authorization server found
              authorizationServerUrl = resourceMetadata.authorization_servers[0];
              fastify.log.info(`Found authorization server from resource metadata: ${authorizationServerUrl}`);
            }
          } catch (resourceError) {
            fastify.log.warn(`Protected resource metadata discovery failed: ${resourceError.message}`);
          }
          
          // Step 2: Discover authorization server metadata
          if (authorizationServerUrl) {
            try {
              metadata = await discoverAuthorizationServerMetadata(authorizationServerUrl);
              
              if (metadata) {
                fastify.log.info(`Discovered OAuth metadata:`, {
                  issuer: metadata.issuer,
                  authorization_endpoint: metadata.authorization_endpoint,
                  token_endpoint: metadata.token_endpoint,
                  token_endpoint_auth_methods_supported: metadata.token_endpoint_auth_methods_supported,
                });
              }
            } catch (metadataError) {
              fastify.log.warn(`Authorization server metadata discovery failed: ${metadataError.message}`);
            }
          }
        }
      } catch (discoveryError) {
        fastify.log.warn(`OAuth discovery failed: ${discoveryError.message}`);
        fastify.log.info('Will let MCP SDK handle discovery during token exchange');
      }
      
      fastify.log.info(`Authorization server URL: ${authorizationServerUrl}`);
      fastify.log.info(`Token endpoint: ${metadata.token_endpoint}`);

      // Custom fetch function to log all requests
      const loggedFetch = async (url, options) => {
        fastify.log.info(`MCP SDK making request to: ${url}`);
        if (options?.method) {
          fastify.log.info(`Request method: ${options.method}`);
        }
        if (options?.headers) {
          // Convert headers to object if it's a Headers instance
          const headersObj = options.headers instanceof Headers 
            ? Object.fromEntries(options.headers.entries())
            : options.headers;
          fastify.log.info(`Request headers: ${JSON.stringify(headersObj)}`);
        }
        if (options?.body) {
          fastify.log.info(`Request body: ${options.body}`);
        }
        const response = await fetch(url, options);
        fastify.log.info(`Response status: ${response.status} ${response.statusText}`);
        return response;
      };

      const tokens = await exchangeAuthorization(authorizationServerUrl, {
        metadata,
        clientInformation: {
          client_id: clientId,
          client_secret: clientSecret,
        },
        authorizationCode: authorization_code,
        codeVerifier: code_verifier,
        redirectUri: redirect_uri,
        resource: resource ? new URL(resource) : undefined,
        // Don't pass addClientAuthentication - let MCP SDK use default authentication
        fetchFn: loggedFetch,
      });

      fastify.log.info(`MCP SDK token exchange successful for server ${validatedServerId}`);
      return reply.send(tokens);

    } catch (error) {
      fastify.log.error('MCP SDK token exchange error:', error);
      fastify.log.error(`Error message: ${error.message}`);
      
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: `MCP SDK token exchange failed: ${error.message}`,
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