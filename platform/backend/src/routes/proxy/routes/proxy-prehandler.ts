import { Readable } from "node:stream";
import {
  errorCodes,
  type FastifyReply,
  type FastifyRequest,
  type HookHandlerDoneFunction,
} from "fastify";
import logger from "@/logging";
import { removeMarkersFromForwardedJson } from "../utils/gateway-tool-declarations";

const UUID_REGEX =
  /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/i;

/**
 * Creates a preHandler for fastify-http-proxy that:
 * 1. Rejects POST requests matching the custom-handled endpoint suffix with a 400
 * 2. Strips agent UUIDs from the URL path so the proxy forwards to the correct upstream
 * 3. Logs the rewrite or pass-through for debugging
 * 4. Takes the gateway's tool attestation markers out of a forwarded JSON body
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
      // OpenAI-compatible clients (e.g. VS Code Copilot BYOK) build this path
      // from a configured base URL, so a stray suffix like "/v1" or a bad
      // LLM proxy id lands here even though the endpoint itself is supported.
      // Echo the offending path and the expected base-URL shape so the
      // misconfiguration is visible in the client, not only in server logs.
      // Derived from the configured suffixes rather than hardcoded, so a
      // provider that gains a surface (e.g. Copilot's /responses) cannot end up
      // telling clients that surface is unsupported. Every caller that opts
      // into rejection also registers /models, which is a GET route and so
      // never appears in endpointSuffixes.
      const supportedEndpoints = [...endpointSuffixes, "/models"].join(", ");
      reply.code(400).send({
        error: {
          message:
            `${providerName} only supports the ${supportedEndpoints} endpoints; ` +
            `got ${request.method} ${urlPath}. The configured base URL must be exactly ` +
            `"${apiPrefix}" or "${apiPrefix}/<llm-proxy-id>" with no extra path segments ` +
            `(e.g. no trailing "/v1") — the client appends the endpoint path itself.`,
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

    removeForwardedAttestationMarkers(request).then(() => next(), next);
  };
}

/**
 * Takes the gateway's tool attestation markers out of a JSON body before a
 * catch-all proxy forwards it upstream, so they never reach a provider. The
 * dedicated routes strip them in handleLLMProxy, but clients also send their
 * tool list to endpoints only the catch-all serves: Anthropic's
 * `/v1/messages/count_tokens`, OpenAI's `/responses/input_tokens`, Gemini's
 * `:countTokens`.
 *
 * The catch-all hands its preHandler the raw body stream, so a JSON body is
 * read here, within the route's body limit, and put back: byte for byte when
 * it holds no marker, re-serialized when it did. Compressed and non-JSON
 * bodies are forwarded as they are.
 */
export async function removeForwardedAttestationMarkers(
  request: FastifyRequest,
): Promise<void> {
  const body = request.body;
  if (!(body instanceof Readable) || !isUncompressedJson(request.headers)) {
    return;
  }
  const raw = await readBody({
    stream: body,
    limit: request.routeOptions.bodyLimit,
    contentLength: request.headers["content-length"],
  });
  // @fastify/reply-from pipes a stream upstream as it is, and serializes an
  // object for an application/json request with a fresh content-length.
  request.body =
    removeMarkersFromForwardedJson(raw) ??
    Readable.from([raw], { objectMode: false });
}

// === Internal helpers ===

function isUncompressedJson(headers: FastifyRequest["headers"]): boolean {
  const mediaType = headers["content-type"]?.split(";")[0].trim().toLowerCase();
  const encoding = headers["content-encoding"]?.trim().toLowerCase();
  return (
    mediaType === "application/json" && (!encoding || encoding === "identity")
  );
}

/**
 * Buffers a request body, failing with Fastify's own 413 past `limit`. Stops
 * listening rather than destroying the stream, so the error reply still
 * reaches the client.
 */
function readBody(params: {
  stream: Readable;
  limit: number;
  contentLength: string | undefined;
}): Promise<Buffer> {
  const { stream, limit } = params;
  return new Promise((resolve, reject) => {
    if (Number(params.contentLength) > limit) {
      reject(new errorCodes.FST_ERR_CTP_BODY_TOO_LARGE());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const stop = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += bytes.length;
      if (size > limit) {
        stop();
        reject(new errorCodes.FST_ERR_CTP_BODY_TOO_LARGE());
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      stop();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error) => {
      stop();
      reject(error);
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}
