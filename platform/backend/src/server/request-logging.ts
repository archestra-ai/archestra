import type { FastifyInstance } from "fastify";
import {
  CONNECTION_SETUP_SCRIPT_PREFIX,
  HEALTH_PATH,
  MCP_GATEWAY_PREFIX,
  MS_TEAMS_SIGN_IN_PATH,
  READY_PATH,
  SKILL_MARKETPLACE_PREFIX,
} from "@/routes/route-paths";

// ===================================================================
// Public interface
// ===================================================================

/**
 * Per-request access logging.
 *
 * Every request is logged at `debug` when it arrives and when it completes.
 * A response with a 4xx or 5xx status is also logged at `info`, so failed
 * requests stay visible at the default level without one log line per
 * successful request.
 */
export function registerRequestLogging(fastify: FastifyInstance) {
  fastify.addHook("onRequest", (request, _reply, done) => {
    if (!shouldSkipRequestLogging(request.url, request.method)) {
      request.log.debug(
        { url: request.url, method: request.method },
        "incoming request",
      );
    }
    done();
  });

  fastify.addHook("onResponse", (request, reply, done) => {
    if (!shouldSkipRequestLogging(request.url, request.method)) {
      const fields = {
        url: request.url,
        method: request.method,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
      };
      if (reply.statusCode >= MIN_LOGGED_ERROR_STATUS) {
        request.log.info(fields, "request completed");
      } else {
        request.log.debug(fields, "request completed");
      }
    }
    done();
  });
}

// ===================================================================
// Internal helpers
// ===================================================================

const MIN_LOGGED_ERROR_STATUS = 400;

/**
 * Excludes noisy or sensitive endpoints from access logs:
 * - /health: Kubernetes liveness probe
 * - /ready: Kubernetes readiness probe (checks database connectivity)
 * - GET /v1/mcp/*: MCP Gateway SSE polling (happens every second)
 * - /skills/m/*: public marketplace git endpoint — URL contains raw share token
 */
function shouldSkipRequestLogging(url: string, method: string): boolean {
  if (url === HEALTH_PATH || url === READY_PATH) return true;
  // Skip MCP Gateway SSE polling (GET requests to /v1/mcp/*)
  if (method === "GET" && url.startsWith(`${MCP_GATEWAY_PREFIX}/`)) return true;
  // token is embedded in the URL path; never log it
  if (url.startsWith(`${SKILL_MARKETPLACE_PREFIX}/`)) return true;
  // one-time setup token is embedded in the URL path; never log it
  if (url.startsWith(`${CONNECTION_SETUP_SCRIPT_PREFIX}/`)) return true;
  // Teams sign-in key and OAuth code are in the query string; never log them
  if (url.startsWith(MS_TEAMS_SIGN_IN_PATH)) return true;
  return false;
}
