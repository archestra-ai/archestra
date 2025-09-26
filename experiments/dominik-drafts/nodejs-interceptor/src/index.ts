// inspired by https://github.com/badlogic/lemmy/blob/main/apps/claude-trace/src/interceptor.ts

import { IncomingHttpHeaders, IncomingMessage, request } from 'http';
import { logger } from './logger';

export interface InterceptorConfig {
  text: string;
}

export class ArchestraNodejsInterceptor {
  constructor(private readonly config: InterceptorConfig) {}

  public instrumentAll(): void {
    this.instrumentFetch();
    this.instrumentNodeHTTP();
  }

  public instrumentFetch(): void {
    if (!global.fetch) {
      // Silent - fetch not available
      return;
    }

    // Check if already instrumented by checking for our marker
    if ((global.fetch as any).__archestraTraceInstrumented) {
      return;
    }

    const originalFetch = global.fetch;

    global.fetch = async function (
      input: RequestInfo | URL,
      init: RequestInit = {}
    ): Promise<Response> {
      // Convert input to URL for consistency
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
          ? input.toString()
          : input.url;
      const requestTimestamp = Date.now();

      // Capture request details
      const requestData = {
        timestamp: requestTimestamp / 1000, // Convert to seconds (like Python version)
        method: init.method || 'GET',
        url: url,
        headers: redactSensitiveHeaders(
          Object.fromEntries(new Headers(init.headers || {}).entries())
        ),
        body: await parseRequestBody(init.body),
      };

      logger.info(`Request: ${JSON.stringify(requestData)}`);

      try {
        // Make the actual request
        const response = await originalFetch(input, init);
        const responseTimestamp = Date.now();

        // Clone response to avoid consuming the body
        const clonedResponse = await response.clone();

        // Parse response body
        const responseBodyData = await parseResponseBody(clonedResponse);

        // Create response data
        const responseData = {
          timestamp: responseTimestamp / 1000,
          status_code: response.status,
          headers: redactSensitiveHeaders(
            Object.fromEntries(response.headers.entries())
          ),
          ...responseBodyData,
        };

        return response;
      } catch (error) {
        throw error;
      }
    };

    // Mark fetch as instrumented
    (global.fetch as any).__archestraTraceInstrumented = true;

    // Silent initialization
  }

  public instrumentNodeHTTP(): void {
    try {
      const http = require('http');
      const https = require('https');

      // Instrument http.request
      if (http.request && !(http.request as any).__archestraTraceInstrumented) {
        const originalHttpRequest = http.request;
        http.request = function (options: any, callback?: any) {
          return interceptNodeRequest(
            originalHttpRequest,
            options,
            callback,
            false
          );
        };
        (http.request as any).__archestraTraceInstrumented = true;
      }

      // Instrument http.get
      if (http.get && !(http.get as any).__archestraTraceInstrumented) {
        const originalHttpGet = http.get;
        http.get = function (options: any, callback?: any) {
          return interceptNodeRequest(
            originalHttpGet,
            options,
            callback,
            false
          );
        };
        (http.get as any).__archestraTraceInstrumented = true;
      }

      // Instrument https.request
      if (
        https.request &&
        !(https.request as any).__archestraTraceInstrumented
      ) {
        const originalHttpsRequest = https.request;
        https.request = function (options: any, callback?: any) {
          return interceptNodeRequest(
            originalHttpsRequest,
            options,
            callback,
            true
          );
        };
        (https.request as any).__archestraTraceInstrumented = true;
      }

      // Instrument https.get
      if (https.get && !(https.get as any).__archestraTraceInstrumented) {
        const originalHttpsGet = https.get;
        https.get = function (options: any, callback?: any) {
          return interceptNodeRequest(
            originalHttpsGet,
            options,
            callback,
            true
          );
        };
        (https.get as any).__archestraTraceInstrumented = true;
      }
    } catch (error) {
      // Silent error handling
    }
  }
}

// utils
function redactSensitiveHeaders(
  headers: IncomingHttpHeaders
): IncomingHttpHeaders {
  const redactedHeaders = { ...headers };
  const sensitiveKeys = [
    'authorization',
    'x-api-key',
    'x-auth-token',
    'cookie',
    'set-cookie',
    'x-session-token',
    'x-access-token',
    'bearer',
    'proxy-authorization',
  ];

  for (const key of Object.keys(redactedHeaders)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some((sensitive) => lowerKey.includes(sensitive))) {
      // Keep first 10 chars and last 4 chars, redact middle
      const value =
        typeof redactedHeaders[key] === 'string'
          ? redactedHeaders[key]
          : redactedHeaders[key]?.[0];
      if (value && value.length > 14) {
        redactedHeaders[key] = `${value.substring(0, 10)}...${value.slice(-4)}`;
      } else if (value && value.length > 4) {
        redactedHeaders[key] = `${value.substring(0, 2)}...${value.slice(-2)}`;
      } else {
        redactedHeaders[key] = '[REDACTED]';
      }
    }
  }

  return redactedHeaders;
}

async function parseRequestBody(body: any): Promise<any> {
  if (!body) return null;

  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }

  if (body instanceof FormData) {
    const formObject: Record<string, any> = {};
    for (const [key, value] of body.entries()) {
      formObject[key] = value;
    }
    return formObject;
  }

  return body;
}

async function parseResponseBody(
  response: Response
): Promise<{ body?: any; body_raw?: string }> {
  const contentType = response.headers.get('content-type') || '';

  try {
    if (contentType.includes('application/json')) {
      const body = await response.json();
      return { body };
    } else if (contentType.includes('text/event-stream')) {
      const body_raw = await response.text();
      return { body_raw };
    } else if (contentType.includes('text/')) {
      const body_raw = await response.text();
      return { body_raw };
    } else {
      // For other types, try to read as text
      const body_raw = await response.text();
      return { body_raw };
    }
  } catch (error) {
    // Silent error handling during runtime
    return {};
  }
}

function parseNodeRequestURL(options: any, isHttps: boolean): string {
  if (typeof options === 'string') {
    return options;
  }

  const protocol = isHttps ? 'https:' : 'http:';
  const hostname = options.hostname || options.host || 'localhost';
  const port = options.port ? `:${options.port}` : '';
  const path = options.path || '/';

  return `${protocol}//${hostname}${port}${path}`;
}

function parseResponseBodyFromString(
  body: string,
  contentType?: string
): { body?: any; body_raw?: string } {
  try {
    if (contentType && contentType.includes('application/json')) {
      return { body: JSON.parse(body) };
    } else if (contentType && contentType.includes('text/event-stream')) {
      return { body_raw: body };
    } else {
      return { body_raw: body };
    }
  } catch (error) {
    return { body_raw: body };
  }
}

function interceptNodeRequest(
  originalRequest: typeof request,
  options: any,
  callback: any,
  isHttps: boolean
) {
  // Parse URL from options
  const url = parseNodeRequestURL(options, isHttps);

  const requestTimestamp = Date.now();
  let requestBody = '';

  // Create the request
  const req = originalRequest(options, (res: IncomingMessage) => {
    const responseTimestamp = Date.now();
    let responseBody = '';

    // Capture response data
    res.on('data', (chunk: any) => {
      responseBody += chunk;
    });

    res.on('end', async () => {
      // Process the captured request/response
      const requestData = {
        timestamp: requestTimestamp / 1000,
        method: options.method || 'GET',
        url: url,
        headers: redactSensitiveHeaders(options.headers || {}),
        body: requestBody ? await parseRequestBody(requestBody) : null,
      };

      const responseData = {
        timestamp: responseTimestamp / 1000,
        status_code: res.statusCode,
        headers: redactSensitiveHeaders(res.headers || {}),
        ...parseResponseBodyFromString(
          responseBody,
          res.headers['content-type']
        ),
      };
      logger.info(`Request: ${JSON.stringify(requestData)}`);
      logger.info(`Response: ${JSON.stringify(responseData)}`);
    });

    // Call original callback if provided
    if (callback) {
      callback(res);
    }
  });

  // Capture request body
  const originalWrite = req.write;
  req.write = function (chunk: any) {
    if (chunk) {
      requestBody += chunk;
    }
    return originalWrite(chunk);
  };

  return req;
}
