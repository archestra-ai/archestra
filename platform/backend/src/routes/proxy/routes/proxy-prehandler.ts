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
 *
 * `rejectUnhandledPaths` (GitHub Copilot): every supported endpoint has its own
 * explicit route, so anything reaching this catch-all proxy is unsupported.
 * Forwarding it would relay the caller's raw GitHub OAuth token upstream (the
 * Copilot API only accepts the short-lived exchanged bearer), yielding a
 * confusing 401 — so reject with a clear 400 instead.
 */
export function createProxyPreHandler(params: {
  apiPrefix: string;
  endpointSuffix: string | string[];
  upstream: string;
  providerName: string;
  rewritePrefix?: string;
  skipErrorResponse?: Record<string, unknown>;
  rejectUnhandledPaths?: boolean;
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
    const endpointSuffixes = Array.isArray(endpointSuffix)
      ? endpointSuffix
      : [endpointSuffix];

    const matchedSuffix = endpointSuffixes.find((suffix) =>
      urlPath.endsWith(suffix),
    );

    if (request.method === "POST" && matchedSuffix) {
      logger.info(
        {
          method: request.method,
          url: request.url,
          action: "skip-proxy",
          reason: "handled-by-custom-handler",
        },
        `${providerName} proxy preHandler: skipping ${matchedSuffix} route`,
      );
      reply.code(400).send(skipErrorResponse);
      return;
    }

    if (params.rejectUnhandledPaths) {
      logger.info(
        { method: request.method, url: request.url, action: "reject" },
        `${providerName} proxy preHandler: rejecting unsupported endpoint`,
      );
      reply.code(400).send({
        error: {
          message: `${providerName} only supports the /chat/completions and /models endpoints`,
          type: "invalid_request_error",
        },
      });
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
