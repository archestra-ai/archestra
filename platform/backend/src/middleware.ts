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
      if (!config.enterpriseLicenseActivated) {
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
