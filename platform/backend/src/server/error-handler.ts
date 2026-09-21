import * as Sentry from "@sentry/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from "fastify-type-provider-zod";
import config from "@/config";
import {
  getDbResourceExhaustionErrorCode,
  getTransientDbErrorCode,
  isDbStatementTimeoutError,
} from "@/database/retry";
import { ApiError } from "@/types";
import { captureServerException } from "./exception-capture";

export function handleServerError(
  this: FastifyInstance,
  error: ApiError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const requestContext = buildRequestErrorContext(request);

  // Handle response serialization errors (when response doesn't match schema)
  if (isResponseSerializationError(error)) {
    const issues = error.cause?.issues ?? [];
    const validationErrors = issues.map((issue) => ({
      path: issue.path?.join("."),
      code: issue.code,
      message: issue.message,
    }));

    this.log.error(
      {
        ...requestContext,
        statusCode: 500,
        method: error.method,
        url: error.url,
        validationErrors,
      },
      `Response serialization error on ${error.method} ${error.url}: ${JSON.stringify(validationErrors)}`,
    );

    // Preserve validation details in the exception report.
    Sentry.captureException(error, {
      extra: {
        method: error.method,
        url: error.url,
        validationErrors,
      },
      tags: {
        error_type: "response_serialization",
      },
    });

    captureServerException(request, error, {
      error_type: "response_serialization",
      validation_errors: validationErrors,
    });

    return reply.status(500).send({
      error: {
        message: "Response doesn't match the schema",
        type: "api_internal_server_error",
      },
    });
  }

  // Handle Zod validation errors (from fastify-type-provider-zod)
  if (hasZodFastifySchemaValidationErrors(error)) {
    const message = error.message || "Validation error";
    this.log.info(
      { ...requestContext, error: message, statusCode: 400 },
      "HTTP 400 validation error occurred",
    );

    return reply.status(400).send({
      error: {
        message,
        type: "api_validation_error",
      },
    });
  }

  // Handle Fastify "body too large" before the generic Error branch so it
  // returns 413 (not 500) with a message that names the limit and observed
  // size. The frontend chat-error mapper picks up `error.message`, so a
  // useful text here flows straight into the UI.
  if (isBodyTooLargeError(error)) {
    // Report the limit that actually applied. A route can raise its own
    // above the global default (the app-recording render route accepts
    // large recording bundles), so naming the global here would misstate
    // the ceiling the request hit.
    const routeLimit = request.routeOptions?.bodyLimit;
    const limit =
      typeof routeLimit === "number" ? routeLimit : config.api.bodyLimit;
    const contentLength = parseContentLength(request);
    const message = formatBodyTooLargeMessage({ limit, contentLength });

    this.log.warn(
      {
        ...requestContext,
        statusCode: 413,
        code: (error as { code?: string }).code ?? BODY_TOO_LARGE_CODE,
        bodyLimit: limit,
        contentLength,
      },
      "HTTP 413 request body too large",
    );

    return reply.status(413).send({
      error: {
        message,
        type: "api_payload_too_large_error",
      },
    });
  }

  // Fastify's own typed errors (unsupported media type, malformed
  // content-type, …) carry the intended 4xx status. Without this branch
  // they fall through to the generic handler below, which miscodes a
  // client mistake as a 500 and captures it as a server exception.
  const errorStatusCode = (error as { statusCode?: unknown }).statusCode;
  if (
    !(error instanceof ApiError) &&
    typeof errorStatusCode === "number" &&
    errorStatusCode >= 400 &&
    errorStatusCode < 500
  ) {
    const coerced = new ApiError(
      errorStatusCode,
      error.message || "Bad Request",
    );
    this.log.info(
      {
        ...requestContext,
        error: coerced.message,
        statusCode: coerced.statusCode,
      },
      "HTTP 40x request error occurred",
    );
    return reply.status(coerced.statusCode).send({
      error: { message: coerced.message, type: coerced.type },
    });
  }

  // Transient database connectivity failures (DNS lookup, connection
  // refused during a database restart, pool connect timeouts) that
  // survived the retry budget are availability incidents, not bugs in
  // whichever route happened to be in flight. Respond with a retryable
  // 503 instead of a 500, and group them in error tracking by root
  // cause rather than by the query text the ORM wraps them in.
  const transientDbErrorCode = getTransientDbErrorCode(error);
  if (transientDbErrorCode) {
    this.log.error(
      {
        ...requestContext,
        error: error.message,
        statusCode: 503,
        dbErrorCode: transientDbErrorCode,
      },
      "HTTP 503 database temporarily unavailable",
    );

    captureServerException(request, error, {
      error_type: "db_unavailable",
      db_error_code: transientDbErrorCode,
      status_code: 503,
    });

    return reply.status(503).send({
      error: {
        message:
          "Cannot reach the database. Retry shortly; if it continues, ask an administrator to check the database service and connection settings.",
        type: "api_service_unavailable_error",
      },
    });
  }

  const resourceExhaustionCode = getDbResourceExhaustionErrorCode(error);
  const isStatementTimeout = isDbStatementTimeoutError(error);
  if (resourceExhaustionCode || isStatementTimeout) {
    const message = resourceExhaustionCode
      ? resourceExhaustionCode === "disk_full"
        ? "Database storage is full. Ask an administrator to free or expand it."
        : resourceExhaustionCode === "too_many_connections"
          ? "Database connection limit reached. Ask an administrator to check database capacity."
          : "Database resources are exhausted. Ask an administrator to check database capacity."
      : "Database query timed out. Retry; if it continues, ask an administrator to check database load.";

    this.log.error(
      {
        ...requestContext,
        error: error.message,
        statusCode: 503,
        dbErrorCode: resourceExhaustionCode ?? "statement_timeout",
      },
      "HTTP 503 database unavailable",
    );
    captureServerException(request, error, {
      error_type: resourceExhaustionCode
        ? "db_resource_exhaustion"
        : "db_statement_timeout",
      db_error_code: resourceExhaustionCode ?? "57014",
      status_code: 503,
    });
    return reply.status(503).send({
      error: { message, type: "api_service_unavailable_error" },
    });
  }

  // The passthrough proxy can wrap a provider connect timeout in its
  // generic 500 error, losing the original network error code. Keep the
  // response retryable and point the caller at the configured upstream.
  if (
    request.url.startsWith("/v1/") &&
    (error as { code?: string }).code ===
      "FST_REPLY_FROM_INTERNAL_SERVER_ERROR" &&
    error.message === "Connect Timeout Error"
  ) {
    this.log.warn(
      { ...requestContext, statusCode: 503 },
      "HTTP 503 model provider connection timed out",
    );
    return reply.status(503).send({
      error: {
        message:
          "Could not connect to the model provider. Check its base URL and network access, then retry.",
        type: "api_service_unavailable_error",
      },
    });
  }

  // Handle ApiError objects
  if (error instanceof ApiError) {
    const { statusCode, message, type, internalCode } = error;
    const logPayload = {
      ...requestContext,
      error: message,
      statusCode,
      ...(internalCode && { internalCode }),
    };

    if (statusCode >= 500) {
      this.log.error(logPayload, "HTTP 50x request error occurred");
      // Capture is centrally filtered and grouped by
      // classifyErrorForTracking: 502/504 upstream failures are dropped as
      // noise, and a secrets-backend outage is grouped by root cause.
      captureServerException(request, error, {
        error_type: "api_error",
        status_code: statusCode,
        ...(internalCode && { internal_code: internalCode }),
      });
    } else if (statusCode >= 400) {
      this.log.info(logPayload, "HTTP 40x request error occurred");
    } else {
      this.log.error(logPayload, "HTTP request error occurred");
    }

    // A throttling error that knows when it clears says so, so clients wait
    // that long instead of guessing with their own escalating backoff.
    // Headers cannot be added once a streaming reply has committed them.
    const { retryAfterSeconds } = error;
    if (
      typeof retryAfterSeconds === "number" &&
      Number.isFinite(retryAfterSeconds) &&
      retryAfterSeconds > 0 &&
      !reply.raw.headersSent
    ) {
      reply.header("retry-after", String(Math.ceil(retryAfterSeconds)));
    }

    return reply.status(statusCode).send({
      error: {
        message,
        type,
        ...(internalCode && { internal_code: internalCode }),
      },
    });
  }

  // Handle standard Error objects
  const message = error.message || "Internal server error";
  const statusCode = 500;
  const errorCode = (error as { code?: string }).code;

  this.log.error(
    {
      ...requestContext,
      error: message,
      statusCode,
      ...(errorCode && { code: errorCode }),
      stack: error.stack,
    },
    "HTTP 50x request error occurred",
  );

  captureServerException(request, error, {
    error_type: "unhandled_error",
    status_code: statusCode,
    ...(errorCode && { code: errorCode }),
  });

  return reply.status(statusCode).send({
    error: {
      message,
      type: "api_internal_server_error",
    },
  });
}

/** Fastify code emitted when a request body exceeds the configured limit. */
const BODY_TOO_LARGE_CODE = "FST_ERR_CTP_BODY_TOO_LARGE";

/**
 * Extract the route, URL, method, and a sample of headers we want correlated
 * with every error log line. Without these, "HTTP 50x request error occurred"
 * is unactionable — you can't tell which endpoint failed or how big the payload
 * was.
 */
function buildRequestErrorContext(request: FastifyRequest) {
  return {
    method: request.method,
    url: request.url,
    route: request.routeOptions?.url,
    routeId:
      (request.routeOptions?.config as { operationId?: string } | undefined)
        ?.operationId ?? undefined,
    reqId: request.id,
    contentLength: parseContentLength(request),
    contentType: request.headers["content-type"],
  };
}

function parseContentLength(request: FastifyRequest): number | undefined {
  const raw = request.headers["content-length"];
  if (typeof raw !== "string") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

function isBodyTooLargeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  // A thrown ApiError(413) is a route speaking deliberately — its message
  // already names the limit in that route's own terms. This branch only
  // rescues Fastify's raw parser error, which arrives without a usable text.
  if (error instanceof ApiError) return false;
  const e = error as { code?: string; statusCode?: number };
  return e.code === BODY_TOO_LARGE_CODE || e.statusCode === 413;
}

function formatBodyTooLargeMessage(params: {
  limit: number;
  contentLength?: number;
}): string {
  const limitMb = (params.limit / (1024 * 1024)).toFixed(0);
  if (params.contentLength !== undefined) {
    const gotMb = (params.contentLength / (1024 * 1024)).toFixed(1);
    return `Request body too large: ${gotMb} MB (limit ${limitMb} MB). Use a smaller attachment, or raise ARCHESTRA_API_BODY_LIMIT.`;
  }
  return `Request body too large (limit ${limitMb} MB). Use a smaller attachment, or raise ARCHESTRA_API_BODY_LIMIT.`;
}
