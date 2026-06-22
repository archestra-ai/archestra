import { type RouteId, SupportedProviders } from "@archestra/shared";
import { requiredEndpointPermissionsMap } from "@archestra/shared/access-control";
import * as Sentry from "@sentry/node";
import type { FastifyReply, FastifyRequest } from "fastify";
import { betterAuth, hasPermission } from "@/auth";
import config from "@/config";
import logger from "@/logging";
import { ServiceAccountModel, UserModel } from "@/models";
import { MODEL_ROUTER_PREFIX } from "@/routes/proxy/common";
import { getPublicRequestOrigin } from "@/routes/request-origin";
import {
  ARCHESTRA_CATALOG_PROXY_PREFIX,
  CONNECTION_SETUP_SCRIPT_PREFIX,
  HEALTH_PATH,
  INCOMING_EMAIL_WEBHOOK_PREFIX,
  METRICS_PATH,
  ORGANIZATION_APPEARANCE_SETTINGS_PATH,
  PUBLIC_CONFIG_PATH,
  READY_PATH,
  SKILL_MARKETPLACE_PREFIX,
  WELL_KNOWN_ACME_PREFIX,
  WELL_KNOWN_OAUTH_PREFIX,
} from "@/routes/route-paths";
import {
  appIdFromConnectorPath,
  connectorWwwAuthenticate,
} from "@/services/apps/app-connector-resource";
import { ApiError } from "@/types";

export class Authnz {
  public handle = async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;

    // custom logic to skip auth check
    if (await this.shouldSkipAuthCheck(request)) {
      return;
    }

    // return 401 if unauthenticated
    if (!(await this.isAuthenticated(request))) {
      logger.trace(
        { requestId, url: request.url },
        "[Authnz] Authentication failed",
      );
      // A credential-less request to an MCP App connector gets the RFC 9728
      // challenge here (it has no Bearer header, so it was not skipped above and
      // never reaches the route); an invalid Bearer token is challenged in-route.
      this.maybeSetConnectorChallenge(request, reply);
      throw new ApiError(401, "Unauthenticated");
    }

    logger.trace(
      { requestId },
      "[Authnz] Authentication successful, populating user info",
    );

    // Populate request.user and request.organizationId after successful authentication
    await this.populateUserInfo(request);

    // Guard: if populateUserInfo silently failed, user info is missing
    if (!request.user || !request.organizationId) {
      logger.warn(
        { requestId, url: request.url },
        "[Authnz] Authentication succeeded but user info could not be populated",
      );
      throw new ApiError(401, "Unauthenticated");
    }

    // Set Sentry user context after successful authentication
    this.setSentryUserContext(request.user, request);

    logger.trace(
      {
        requestId,
        userId: request.user?.id,
        organizationId: request.organizationId,
      },
      "[Authnz] User info populated, checking authorization",
    );

    const { success } = await this.isAuthorized(request);
    if (success) {
      logger.trace(
        { requestId, userId: request.user?.id },
        "[Authnz] Authorization successful",
      );
      return;
    }

    // return 403 if unauthorized
    logger.trace(
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
    headers,
  }: FastifyRequest): Promise<boolean> => {
    // Skip CORS preflight and HEAD requests globally
    if (method === "OPTIONS" || method === "HEAD") {
      // marketplace and connection-setup URLs embed a raw token — omit from
      // trace to avoid leaking it
      const safeUrl =
        url.startsWith(`${SKILL_MARKETPLACE_PREFIX}/`) ||
        url.startsWith(`${CONNECTION_SETUP_SCRIPT_PREFIX}/`)
          ? undefined
          : url;
      logger.trace(
        { url: safeUrl, method },
        "[Authnz] Skipping auth for preflight/HEAD request",
      );
      return true;
    }
    // Check if URL matches any LLM proxy route (e.g., /v1/openai, /v1/anthropic, /v1/vllm)
    const isLlmProxyRoute = SupportedProviders.some((provider) =>
      url.startsWith(`/v1/${provider}`),
    );
    // Prefer route consts here instead of hardcoding paths; these checks must
    // stay in sync with route registration.
    const isModelRouterRoute = url.startsWith(MODEL_ROUTER_PREFIX);

    if (
      url.startsWith("/api/auth") ||
      url.startsWith("/api/invitation/") || // Allow invitation check without auth
      isLlmProxyRoute ||
      isModelRouterRoute ||
      url === "/openapi.json" ||
      url === HEALTH_PATH ||
      url === READY_PATH ||
      url === METRICS_PATH ||
      url === "/test" ||
      url.startsWith(config.mcpGateway.endpoint) ||
      // MCP App connector: a Bearer request (a personal token or the native
      // OAuth flow's audience-bound token) is validated in-route, so it stands
      // down here. A session request carries no Bearer and falls through to the
      // normal session auth below (unchanged); a credential-less request also
      // falls through and is answered with the RFC 9728 challenge in handle().
      (appIdFromConnectorPath(url) !== null &&
        typeof headers.authorization === "string" &&
        /^Bearer\s+/i.test(headers.authorization)) ||
      // Public skill marketplace git endpoint: token in URL, no session
      url === config.skillMarketplace.endpoint ||
      url.startsWith(`${config.skillMarketplace.endpoint}/`) ||
      // Public connection-setup script endpoint: one-time token in URL, no session
      (method === "GET" &&
        url.startsWith(`${CONNECTION_SETUP_SCRIPT_PREFIX}/`)) ||
      // A2A routes use token auth handled in route, similar to MCP Gateway
      url.startsWith(config.a2aGateway.endpoint) ||
      url.startsWith(config.a2aV2Gateway.endpoint) ||
      // Skip OAuth well-known discovery endpoints (RFC 8414 / RFC 9728)
      url.startsWith(WELL_KNOWN_OAUTH_PREFIX) ||
      // Skip OAuth consent page proxy (handled by frontend)
      url.startsWith("/oauth/") ||
      // Skip ACME challenge paths for SSL certificate domain validation
      url.startsWith(WELL_KNOWN_ACME_PREFIX) ||
      // Sandbox proxy HTML is a static file with no secrets — must load without
      // cookies because the iframe has an opaque origin and won't send them.
      url.startsWith("/_sandbox/") ||
      // Allow fetching public SSO providers list for login page (minimal info, no secrets)
      (method === "GET" && url === "/api/identity-providers/public") ||
      // Allow fetching public config for login and invitation UI
      (method === "GET" && url === PUBLIC_CONFIG_PATH) ||
      // Allow fetching public appearance settings for login page (theme, logo, font)
      (method === "GET" && url === ORGANIZATION_APPEARANCE_SETTINGS_PATH) ||
      // Incoming email webhooks - Microsoft Graph calls these directly
      // Only allow the exact webhook path (with optional query params), not sub-paths like /setup
      url === INCOMING_EMAIL_WEBHOOK_PREFIX ||
      url.startsWith(`${INCOMING_EMAIL_WEBHOOK_PREFIX}?`) ||
      // Public reverse proxy to the Archestra MCP catalog (upstream is public)
      url.startsWith(`${ARCHESTRA_CATALOG_PROXY_PREFIX}/`) ||
      // ChatOps webhooks - Bot Framework calls these directly
      // JWT validation is handled by the Bot Framework adapter
      url.startsWith("/api/webhooks/chatops/")
    ) {
      return true;
    }
    return false;
  };

  private maybeSetConnectorChallenge = (
    request: FastifyRequest,
    reply: FastifyReply,
  ): void => {
    // Dark when the feature is off: no OAuth challenge that would advertise the
    // connector mechanism exists.
    if (!config.apps.enabled) {
      return;
    }
    const appId = appIdFromConnectorPath(request.url);
    if (!appId) {
      return;
    }
    reply.header(
      "WWW-Authenticate",
      connectorWwwAuthenticate(getPublicRequestOrigin(request), appId),
    );
  };

  private isAuthenticated = async (request: FastifyRequest) => {
    const headers = new Headers(request.headers as HeadersInit);

    try {
      logger.trace("[Authnz] Attempting session-based authentication");
      const session = await betterAuth.api.getSession({
        headers,
        query: { disableCookieCache: true },
      });

      if (session) {
        logger.trace(
          { userId: session.user?.id, sessionId: session.session?.id },
          "[Authnz] Session authentication successful",
        );
        return true;
      }
      logger.trace("[Authnz] No session found");
    } catch (error) {
      logger.trace(
        { error: error instanceof Error ? error.message : "unknown" },
        "[Authnz] Session authentication failed, trying API key",
      );
    }

    const authHeader = headers.get("authorization");
    if (authHeader) {
      try {
        logger.trace("[Authnz] Attempting API key authentication");
        const { valid } = await betterAuth.api.verifyApiKey({
          body: { key: authHeader },
        });

        if (valid) {
          logger.trace({ valid }, "[Authnz] API key verification result");
          return true;
        }
      } catch (_apiKeyError) {
        logger.trace(
          "[Authnz] API key verification failed, trying service account token",
        );
      }

      const serviceAccountResult =
        await ServiceAccountModel.verifyToken(authHeader);
      if (serviceAccountResult) {
        request.serviceAccountAuthResult = serviceAccountResult;
        logger.trace("[Authnz] Service account token verification succeeded");
        return true;
      }
    }

    logger.trace("[Authnz] No valid authentication method found");
    return false;
  };

  private isAuthorized = async (
    request: FastifyRequest,
  ): Promise<{ success: boolean; error: Error | null }> => {
    const routeId = request.routeOptions.schema?.operationId as
      | RouteId
      | undefined;

    logger.trace({ routeId }, "[Authnz] Checking authorization for route");

    const requiredPermissions = routeId
      ? requiredEndpointPermissionsMap[routeId]
      : undefined;

    logger.trace(
      {
        routeId,
        requiredPermissions,
        hasPermissions: requiredPermissions !== undefined,
      },
      "[Authnz] Permissions lookup result",
    );

    if (requiredPermissions === undefined) {
      logger.trace(
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
      logger.trace(
        { routeId },
        "[Authnz] No specific permissions required, allowing access",
      );
      return { success: true, error: null };
    }

    logger.trace(
      {
        routeId,
        requiredPermissions,
        permissionCount: Object.keys(requiredPermissions).length,
      },
      "[Authnz] Checking required permissions",
    );
    const result = await hasPermission(
      requiredPermissions,
      request.headers,
      request.serviceAccount,
    );
    logger.trace({ routeId, result }, "[Authnz] hasPermission result");
    return result;
  };

  private populateUserInfo = async (request: FastifyRequest): Promise<void> => {
    try {
      const headers = new Headers(request.headers as HeadersInit);

      // Try session-based authentication first
      try {
        logger.trace("[Authnz] populateUserInfo: trying session-based lookup");
        const session = await betterAuth.api.getSession({
          headers,
          query: { disableCookieCache: true },
        });

        if (session?.user?.id) {
          logger.trace(
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
          request.authMethod = "session";
          logger.trace(
            { userId: user.id, organizationId },
            "[Authnz] populateUserInfo: populated from session",
          );
          return;
        }
      } catch (sessionError) {
        // Fall through to API key authentication
        logger.trace(
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
          logger.trace("[Authnz] populateUserInfo: trying API key lookup");
          const apiKeyResult = await betterAuth.api.verifyApiKey({
            body: { key: authHeader },
          });

          if (apiKeyResult?.valid && apiKeyResult.key?.referenceId) {
            logger.trace(
              "[Authnz] populateUserInfo: valid API key, fetching user data",
            );
            // User-owned API keys expose the owning user through `referenceId`.
            const { organizationId, ...user } = await UserModel.getById(
              apiKeyResult.key.referenceId,
            );

            // Populate the request decorators
            request.user = user;
            request.organizationId = organizationId;
            request.authMethod = "api_key";
            logger.trace(
              { userId: user.id, organizationId },
              "[Authnz] populateUserInfo: populated from API key",
            );
            return;
          }
        } catch (_apiKeyError) {
          logger.trace(
            "[Authnz] populateUserInfo: API key verification failed, trying service account token",
          );
        }

        const serviceAccountResult =
          request.serviceAccountAuthResult ??
          (await ServiceAccountModel.verifyToken(authHeader));
        if (serviceAccountResult) {
          request.serviceAccountAuthResult = serviceAccountResult;
          this.populateServiceAccountUserInfo(request, serviceAccountResult);
          return;
        }
      }
    } catch (error) {
      // If population fails, leave decorators unpopulated
      // The route handlers should handle missing user info gracefully
      logger.trace(
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

  private populateServiceAccountUserInfo = (
    request: FastifyRequest,
    serviceAccountResult: NonNullable<
      FastifyRequest["serviceAccountAuthResult"]
    >,
  ): void => {
    const serviceAccount = serviceAccountResult.serviceAccount;
    request.user = {
      id: `service-account:${serviceAccount.id}`,
      name: serviceAccount.name,
      email: `${serviceAccount.id}@service-account.local`,
      emailVerified: true,
      image: null,
      createdAt: serviceAccount.createdAt,
      updatedAt: serviceAccount.updatedAt,
      role: null,
      banned: false,
      banReason: null,
      banExpires: null,
      twoFactorEnabled: false,
    };
    request.organizationId = serviceAccount.organizationId;
    request.serviceAccount = serviceAccount;
    request.authMethod = "service_account";
    logger.trace(
      {
        serviceAccountId: serviceAccount.id,
        organizationId: serviceAccount.organizationId,
      },
      "[Authnz] populateUserInfo: populated from service account token",
    );
  };
}
