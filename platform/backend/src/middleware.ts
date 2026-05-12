import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import config from "@/config";
import { IDENTITY_PROVIDERS_API_PREFIX } from "@/constants";
import { ApiError } from "@/types";

// Pattern to match team external groups routes: /api/teams/:id/external-groups
const TEAM_EXTERNAL_GROUPS_PATTERN = /^\/api\/teams\/[^/]+\/external-groups/;

const ENTERPRISE_CONTACT_MESSAGE =
  "Please contact sales@archestra.ai to enable it.";

/**
 * Check if a URL is an enterprise-only route that requires license activation.
 * @public — exported for testability
 */
export function isEnterpriseOnlyRoute(url: string): boolean {
  // Identity provider routes
  if (url.startsWith(IDENTITY_PROVIDERS_API_PREFIX)) {
    return true;
  }

  // Team external groups routes (SSO Team Sync feature)
  if (TEAM_EXTERNAL_GROUPS_PATTERN.test(url)) {
    return true;
  }

  return false;
}

/**
 * Middleware plugin to enforce enterprise license requirements on certain routes.
 *
 * This plugin adds a preHandler hook that checks if the enterprise license is activated
 * before allowing access to enterprise-only features like SSO and Team Sync.
 *
 * Uses fastify-plugin to avoid encapsulation so hooks apply to all routes.
 */
const enterpriseLicenseMiddlewarePlugin: FastifyPluginAsync = async (
  fastify,
) => {
  fastify.addHook("preHandler", async (request) => {
    if (isEnterpriseOnlyRoute(request.url)) {
      if (!config.enterpriseFeatures.core) {
        // Provide feature-specific error messages
        if (request.url.startsWith(IDENTITY_PROVIDERS_API_PREFIX)) {
          throw new ApiError(
            403,
            `SSO is an enterprise feature. ${ENTERPRISE_CONTACT_MESSAGE}`,
          );
        }
        if (TEAM_EXTERNAL_GROUPS_PATTERN.test(request.url)) {
          throw new ApiError(
            403,
            `Team Sync is an enterprise feature. ${ENTERPRISE_CONTACT_MESSAGE}`,
          );
        }
      }
    }
  });
};

export const enterpriseLicenseMiddleware = fp(
  enterpriseLicenseMiddlewarePlugin,
);

/**
 * Paths that should remain accessible during maintenance mode.
 */
const MAINTENANCE_MODE_ALLOWED_PATHS = new Set([
  "/api/health",
  "/health",
  "/metrics",
]);

/**
 * Check if a request should be allowed through during maintenance mode.
 * Healthcheck endpoints and metrics are always allowed.
 * @public — exported for testability
 */
export function isMaintenanceModeAllowedPath(url: string): boolean {
  // Strip query string for comparison
  const pathname = url.split("?")[0];
  return MAINTENANCE_MODE_ALLOWED_PATHS.has(pathname);
}

/**
 * Middleware plugin to block all requests when maintenance mode is enabled.
 *
 * Maintenance mode is activated by setting ARCHESTRA_MAINTENANCE_MODE_MESSAGE
 * to a non-empty string. When active, all requests receive a 503 response
 * except healthcheck and metrics endpoints.
 *
 * Uses fastify-plugin to avoid encapsulation so hooks apply to all routes.
 */
const maintenanceModeMiddlewarePlugin: FastifyPluginAsync = async (
  fastify,
) => {
  fastify.addHook("preHandler", async (request, reply) => {
    const message = config.maintenanceMode.message;
    if (!message) return;

    // Always allow healthcheck and metrics endpoints
    if (isMaintenanceModeAllowedPath(request.url)) return;

    reply.status(503).send({
      statusCode: 503,
      error: "Service Unavailable",
      message,
    });
  });
};

export const maintenanceModeMiddleware = fp(
  maintenanceModeMiddlewarePlugin,
);
