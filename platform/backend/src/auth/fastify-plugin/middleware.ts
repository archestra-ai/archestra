import * as Sentry from "@sentry/node";
import { type RouteId, SupportedProviders } from "@shared";
import { requiredEndpointPermissionsMap } from "@shared/access-control";
import type { FastifyReply, FastifyRequest } from "fastify";
import { betterAuth, hasPermission } from "@/auth";
import config from "@/config";
import logger from "@/logging";
import { UserModel } from "@/models";
import { ApiError } from "@/types";

export class Authnz {
  public handle = async (request: FastifyRequest, _reply: FastifyReply) => {
    const requestId = request.id;

    // custom logic to skip auth check
    if (await this.shouldSkipAuthCheck(request)) {
      return;
    }

    // return 401 if unauthenticated
    if (!(await this.isAuthenticated(request))) {
      logger.debug(
        { requestId, url: request.url },
        "[Authnz] Authentication failed",
      );
      throw new ApiError(401, "Unauthenticated");
    }

    logger.debug(
      { requestId },
      "[Authnz] Authentication successful, populating user info",
    );

    // Populate request.user and request.organizationId after successful authentication
    await this.populateUserInfo(request);

    // Set Sentry user context after successful authentication
    if (request.user) {
      this.setSentryUserContext(request.user, request);
    }

    logger.debug(
      {
        requestId,
        userId: request.user?.id,
        organizationId: request.organizationId,
      },
      "[Authnz] User info populated, checking authorization",
    );

    const { success } = await this.isAuthorized(request);
    if (success) {
      logger.debug(
        { requestId, userId: request.user?.id },
        "[Authnz] Authorization successful",
      );
      return;
    }

    // return 403 if unauthorized
    logger.debug(
      {
        requestId,
        userId: request.user?.id,
        routeId: request.routeOptions.schema?.operationId,
      },
      "[Authnz] Authorization failed",
    );
    throw new ApiError(403, "Forbidden");
  };

  private shouldSkipAuthCheck = async ({
    url,
    method,
  }: FastifyRequest): Promise<boolean> => {
    // Skip CORS preflight and HEAD requests globally
    if (method === "OPTIONS" || method === "HEAD") {
      logger.debug(
        { url, method },
        "[Authnz] Skipping auth for preflight/HEAD request",
      );
      return true;
    }
    // Check if URL matches any LLM proxy route (e.g., /v1/openai, /v1/anthropic, /v1/vllm)
    const isLlmProxyRoute = SupportedProviders.some((provider) =>
      url.startsWith(`/v1/${provider}`),
    );

    if (
      url.startsWith("/api/auth") ||
      url.startsWith("/api/invitation/") || // Allow invitation check without auth
      isLlmProxyRoute ||
      url === "/openapi.json" ||
      url === "/health" ||
      url === "/ready" ||
      url === "/api/features" ||
      url.startsWith(config.mcpGateway.endpoint) ||
      // A2A routes use token auth handled in route, similar to MCP Gateway
      url.startsWith(config.a2aGateway.endpoint) ||
      // Skip ACME challenge paths for SSL certificate domain validation
      url.startsWith("/.well-known/acme-challenge/") ||
      // Allow fetching public SSO providers list for login page (minimal info, no secrets)
      (method === "GET" && url === "/api/sso-providers/public") ||
      // Allow fetching public appearance settings for login page (theme, logo, font)
      (method === "GET" && url === "/api/organization/appearance") ||
      // Incoming email webhooks - Microsoft Graph calls these directly
      // Only allow the exact webhook path (with optional query params), not sub-paths like /setup
      url === "/api/webhooks/incoming-email" ||
      url.startsWith("/api/webhooks/incoming-email?") ||
      // ChatOps webhooks - Bot Framework calls these directly
      // JWT validation is handled by the Bot Framework adapter
      url.startsWith("/api/webhooks/chatops/")
    ) {
      return true;
    }
    return false;
  };

  private isAuthenticated = async (request: FastifyRequest) => {
    const headers = new Headers(request.headers as HeadersInit);

    try {
      logger.debug("[Authnz] Attempting session-based authentication");
      const session = await betterAuth.api.getSession({
        headers,
        query: { disableCookieCache: true },
      });

      if (session) {
        logger.debug(
          { userId: session.user?.id, sessionId: session.session?.id },
          "[Authnz] Session authentication successful",
        );
        return true;
      }
      logger.debug("[Authnz] No session found");
    } catch (error) {
      /**
       * If getSession fails (e.g., "No active organization"), try API key verification
       */
      logger.debug(
        { error: error instanceof Error ? error.message : "unknown" },
        "[Authnz] Session authentication failed, trying API key",
      );
      const authHeader = headers.get("authorization");
      if (authHeader) {
        try {
          logger.debug("[Authnz] Attempting API key authentication");
          const { valid } = await betterAuth.api.verifyApiKey({
            body: { key: authHeader },
          });

          logger.debug({ valid }, "[Authnz] API key verification result");
          return valid;
        } catch (_apiKeyError) {
          // API key verification failed, return unauthenticated
          logger.debug("[Authnz] API key verification failed");
          return false;
        }
      }
    }

    logger.debug("[Authnz] No valid authentication method found");
    return false;
  };

  private isAuthorized = async (
    request: FastifyRequest,
  ): Promise<{ success: boolean; error: Error | null }> => {
    const routeId = request.routeOptions.schema?.operationId as
      | RouteId
      | undefined;

    logger.debug({ routeId }, "[Authnz] Checking authorization for route");

    const requiredPermissions = routeId
      ? requiredEndpointPermissionsMap[routeId]
      : undefined;

    if (requiredPermissions === undefined) {
      logger.debug(
        { routeId },
        "[Authnz] Route not configured in permissions map, denying by default",
      );
      return {
        success: false,
        error: new Error(
          "Forbidden, the route is not configured in auth middleware and is protected by default",
        ),
      };
    }

    // If no specific permissions are required (empty object), allow any authenticated user
    if (Object.keys(requiredPermissions).length === 0) {
      logger.debug(
        { routeId },
        "[Authnz] No specific permissions required, allowing access",
      );
      return { success: true, error: null };
    }

    logger.debug(
      { routeId, permissionCount: Object.keys(requiredPermissions).length },
      "[Authnz] Checking required permissions",
    );
    return await hasPermission(requiredPermissions, request.headers);
  };

  private populateUserInfo = async (request: FastifyRequest): Promise<void> => {
    try {
      const headers = new Headers(request.headers as HeadersInit);

      // Try session-based authentication first
      try {
        logger.debug("[Authnz] populateUserInfo: trying session-based lookup");
        const session = await betterAuth.api.getSession({
          headers,
          query: { disableCookieCache: true },
        });

        if (session?.user?.id) {
          logger.debug(
            { userId: session.user.id },
            "[Authnz] populateUserInfo: found session user, fetching full user data",
          );
          // Get the full user object from database
          const { organizationId, ...user } = await UserModel.getById(
            session.user.id,
          );

          // Populate the request decorators
          request.user = user;
          request.organizationId = organizationId;
          logger.debug(
            { userId: user.id, organizationId },
            "[Authnz] populateUserInfo: populated from session",
          );
          return;
        }
      } catch (sessionError) {
        // Fall through to API key authentication
        logger.debug(
          {
            error:
              sessionError instanceof Error ? sessionError.message : "unknown",
          },
          "[Authnz] populateUserInfo: session lookup failed, trying API key",
        );
      }

      // Try API key authentication
      const authHeader = headers.get("authorization");
      if (authHeader) {
        try {
          logger.debug("[Authnz] populateUserInfo: trying API key lookup");
          const apiKeyResult = await betterAuth.api.verifyApiKey({
            body: { key: authHeader },
          });

          if (apiKeyResult?.valid && apiKeyResult.key?.userId) {
            logger.debug(
              "[Authnz] populateUserInfo: valid API key, fetching user data",
            );
            // Get the full user object from database using the userId from the API key
            const { organizationId, ...user } = await UserModel.getById(
              apiKeyResult.key.userId,
            );

            // Populate the request decorators
            request.user = user;
            request.organizationId = organizationId;
            logger.debug(
              { userId: user.id, organizationId },
              "[Authnz] populateUserInfo: populated from API key",
            );
            return;
          }
        } catch (_apiKeyError) {
          // API key verification failed
          logger.debug(
            "[Authnz] populateUserInfo: API key verification failed",
          );
        }
      }
    } catch (error) {
      // If population fails, leave decorators unpopulated
      // The route handlers should handle missing user info gracefully
      logger.debug(
        { error: error instanceof Error ? error.message : "unknown" },
        "[Authnz] populateUserInfo: failed to populate user info",
      );
    }
  };

  /**
   * Sets the Sentry user context for better error tracking and attribution
   */
  public setSentryUserContext = (
    user: { id: string; email?: string; name?: string },
    request: FastifyRequest,
  ): void => {
    try {
      // Extract IP address from request headers
      const ipAddress =
        (request.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
        (request.headers["x-real-ip"] as string) ||
        request.ip;

      Sentry.setUser({
        id: user.id,
        email: user.email,
        username: user.name || user.email,
        ip_address: ipAddress,
      });
    } catch (_error) {
      // Silently fail if Sentry is not configured or there's an error
      // We don't want authentication to fail due to Sentry issues
    }
  };
}
