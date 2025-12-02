import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import config from "@/config";
import { SSO_PROVIDERS_API_PREFIX } from "@/constants";
import { ApiError } from "@/types/api";

/**
 * Middleware plugin to enforce enterprise license requirements on certain routes.
 *
 * This plugin adds a preHandler hook that checks if the enterprise license is activated
 * before allowing access to enterprise-only features like SSO.
 *
 * Uses fastify-plugin to avoid encapsulation so hooks apply to all routes.
 */
const enterpriseLicenseMiddlewarePlugin: FastifyPluginAsync = async (
  fastify,
) => {
  fastify.addHook("preHandler", async (request) => {
    // Check if route is an enterprise-only SSO route
    if (request.url.startsWith(SSO_PROVIDERS_API_PREFIX)) {
      if (!config.enterpriseLicenseActivated) {
        throw new ApiError(
          403,
          "SSO is an enterprise feature. Please contact sales@archestra.ai to enable it.",
        );
      }
    }
  });
};

export const enterpriseLicenseMiddleware = fp(
  enterpriseLicenseMiddlewarePlugin,
);
