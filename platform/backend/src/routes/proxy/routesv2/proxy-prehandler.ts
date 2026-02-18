import type {
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from "fastify";
import logger from "@/logging";

const UUID_REGEX =
  /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/i;

/**
 * Creates a preHandler for fastify-http-proxy that:
 * 1. Rejects POST requests matching the custom-handled endpoint suffix with a 400
 * 2. Strips agent UUIDs from the URL path so the proxy forwards to the correct upstream
 * 3. Logs the rewrite or pass-through for debugging
 */
export function createProxyPreHandler(params: {
  apiPrefix: string;
  endpointSuffix: string;
  upstream: string;
  providerName: string;
  rewritePrefix?: string;
  skipErrorResponse?: Record<string, unknown>;
}) {
  const { apiPrefix, endpointSuffix, upstream, providerName } = params;
  const rewritePrefix = params.rewritePrefix ?? "";
  const skipErrorResponse = params.skipErrorResponse ?? {
    error: {
      message: "Chat completions requests should use the dedicated endpoint",
      type: "invalid_request_error",
    },
  };

  return (
    request: FastifyRequest,
    reply: FastifyReply,
    next: HookHandlerDoneFunction,
  ) => {
    const urlPath = request.url.split("?")[0];
    if (request.method === "POST" && urlPath.endsWith(endpointSuffix)) {
      logger.info(
        {
          method: request.method,
          url: request.url,
          action: "skip-proxy",
          reason: "handled-by-custom-handler",
        },
        `${providerName} proxy preHandler: skipping ${endpointSuffix} route`,
      );
      reply.code(400).send(skipErrorResponse);
      return;
    }

    const pathAfterPrefix = request.url.replace(apiPrefix, "");
    const uuidMatch = pathAfterPrefix.match(UUID_REGEX);

    if (uuidMatch) {
      const remainingPath = uuidMatch[2] || "";
      const originalUrl = request.raw.url;
      request.raw.url = `${apiPrefix}${remainingPath}`;

      logger.info(
        {
          method: request.method,
          originalUrl,
          rewrittenUrl: request.raw.url,
          upstream,
          finalProxyUrl: `${upstream}${rewritePrefix}${remainingPath}`,
        },
        `${providerName} proxy preHandler: URL rewritten (UUID stripped)`,
      );
    } else {
      logger.info(
        {
          method: request.method,
          url: request.url,
          upstream,
          finalProxyUrl: `${upstream}${rewritePrefix}${pathAfterPrefix}`,
        },
        `${providerName} proxy preHandler: proxying request`,
      );
    }

    next();
  };
}
