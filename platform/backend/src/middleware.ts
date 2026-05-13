import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import config from "@/config";
import { IDENTITY_PROVIDERS_API_PREFIX } from "@/constants";
import {
  HEALTH_PATH,
  METRICS_PATH,
  ORGANIZATION_APPEARANCE_SETTINGS_PATH,
  PUBLIC_CONFIG_PATH,
  READY_PATH,
} from "@/routes/route-paths";
import { ApiError } from "@/types";

// Pattern to match team external groups routes: /api/teams/:id/external-groups
const TEAM_EXTERNAL_GROUPS_PATTERN = /^\/api\/teams\/[^/]+\/external-groups/;
const AUTH_API_PREFIX = "/api/auth/";
const PUBLIC_IDENTITY_PROVIDERS_PATH = "/api/identity-providers/public";

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

export function isMaintenanceBypassRoute(params: {
  method: string;
  url: string;
}): boolean {
  const { method, url } = params;

  if (
    matchesExactPath(url, HEALTH_PATH) ||
    matchesExactPath(url, READY_PATH) ||
    matchesExactPath(url, METRICS_PATH)
  ) {
    return true;
  }

  if (url.startsWith(AUTH_API_PREFIX)) {
    return true;
  }

  if (method !== "GET") {
    return false;
  }

  return (
    matchesExactPath(url, PUBLIC_CONFIG_PATH) ||
    matchesExactPath(url, ORGANIZATION_APPEARANCE_SETTINGS_PATH) ||
    matchesExactPath(url, PUBLIC_IDENTITY_PROVIDERS_PATH)
  );
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

const maintenanceModeMiddlewarePlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", async (request) => {
    if (!config.maintenance.enabled) {
      return;
    }

    if (
      isMaintenanceBypassRoute({
        method: request.method,
        url: request.url,
      })
    ) {
      return;
    }

    throw new ApiError(
      503,
      config.maintenance.message ?? "Scheduled maintenance in progress",
    );
  });
};

export const maintenanceModeMiddleware = fp(maintenanceModeMiddlewarePlugin);

function matchesExactPath(url: string, path: string): boolean {
  return url === path || url.startsWith(`${path}?`);
}
