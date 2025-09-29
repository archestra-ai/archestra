// inspired by https://github.com/badlogic/lemmy/blob/main/apps/claude-trace/src/interceptor.ts

import { IncomingMessage, request } from 'http';
import { logger } from './logger';

export interface ArchestraConfig {
  text2: string;
}

export class Archestra {
  constructor(private readonly config: ArchestraConfig) {
    this.instrumentAll();
  }

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

      logger.info(
        `Request Fetch - ${init.method} ${url} - ${init.body}`,
        'blue'
      );

      try {
        // Make the actual request
        const response = await originalFetch(input, init);

        // Check if this is a streaming response
        const contentType = response.headers.get('content-type') || '';
        const isStreaming =
          contentType.includes('text/event-stream') ||
          contentType.includes('application/x-ndjson') ||
          contentType.includes('text/plain') ||
          response.headers.get('transfer-encoding') === 'chunked';

        if (isStreaming && response.body) {
          // For streaming responses, intercept the stream
          const reader = response.body.getReader();
          const stream = new ReadableStream({
            start(controller) {
              function pump(): Promise<void> {
                return reader.read().then(({ done, value }) => {
                  if (done) {
                    controller.close();
                    return;
                  }

                  // Log each chunk as it arrives
                  const chunk = new TextDecoder().decode(value);
                  logger.info(
                    `Streaming Response Chunk - ${init.method} ${url} - ${response.status}: ${chunk}`,
                    'yellow'
                  );

                  controller.enqueue(value);
                  return pump();
                });
              }
              return pump();
            },
          });

          // Return a new response with the intercepted stream
          return new Response(stream, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } else {
          // For non-streaming responses, use the original approach
          const clonedResponse = await response.clone();
          const responseBodyData = await parseResponseBody(clonedResponse);

          logger.info(
            `Response Fetch - ${init.method} ${url} - ${response.status} ${
              response.statusText
            } - ${JSON.stringify(
              responseBodyData.body || responseBodyData.body_raw
            )}`,
            'yellow'
          );
        }

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

  let requestBody = '';

  // Create the request
  const req = originalRequest(options, (res: IncomingMessage) => {
    let responseBody = '';
    const contentType = res.headers['content-type'] || '';
    const isStreaming =
      contentType.includes('text/event-stream') ||
      contentType.includes('application/x-ndjson') ||
      contentType.includes('text/plain') ||
      res.headers['transfer-encoding'] === 'chunked';

    // Log request
    logger.info(
      `Request Node - ${options.method || 'GET'} ${url} - ${
        requestBody || '[no body]'
      }`,
      'blue'
    );

    // Capture response data
    res.on('data', (chunk: any) => {
      responseBody += chunk;

      if (isStreaming) {
        // For streaming responses, log each chunk immediately
        const chunkStr = chunk.toString();
        logger.info(
          `Streaming Response Chunk - ${options.method || 'GET'} ${url} - ${
            res.statusCode
          }: ${chunkStr}`,
          'yellow'
        );
      }
    });

    res.on('end', async () => {
      if (!isStreaming) {
        // For non-streaming responses, log the complete response
        logger.info(
          `Response Node - ${res.statusCode} ${res.statusMessage} - ${responseBody}`,
          'yellow'
        );
      } else {
        // For streaming responses, log completion
        logger.info(
          `Streaming Response Complete - ${options.method || 'GET'} ${url} - ${
            res.statusCode
          } (${responseBody.length} bytes total)`,
          'yellow'
        );
      }
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
