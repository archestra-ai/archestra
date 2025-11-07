import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { betterAuth } from "@/auth";
import config from "@/config";
import { UserModel } from "@/models";
import type { ErrorResponse, RouteId } from "@/types";
import { verifyInternalJwt } from "../internal-jwt";
import routePermissionsConfig from "../route-permissions";

const prepareErrorResponse = (
  error: ErrorResponse["error"],
): ErrorResponse => ({ error });

export class Authnz {
  public handle = async (request: FastifyRequest, reply: FastifyReply) => {
    // custom logic to skip auth check
    if (await this.shouldSkipAuthCheck(request)) return;

    // return 401 if unauthenticated
    if (await this.isUnauthenticated(request)) {
      return reply.status(401).send(
        prepareErrorResponse({
          message: "Unauthenticated",
          type: "unauthenticated",
        }),
      );
    }

    // Populate request.user and request.organizationId after successful authentication
    await this.populateUserInfo(request);

    // check if authorized
    const { success, error } = await this.requiredPermissionsStatus(request);
    if (success) {
      return;
    }

    // return 403 if unauthorized
    return reply.status(403).send(
      prepareErrorResponse({
        message: error?.message ?? "Forbidden",
        type: "forbidden",
      }),
    );
  };

  private shouldSkipAuthCheck = async ({
    url,
    method,
    headers,
  }: FastifyRequest): Promise<boolean> => {
    // Skip CORS preflight and HEAD requests globally
    if (method === "OPTIONS" || method === "HEAD") {
      return true;
    }

    // For /mcp_proxy endpoints, verify internal JWT token
    if (url.startsWith("/mcp_proxy/")) {
      const authHeader = headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.slice(7);
        const payload = await verifyInternalJwt(token);
        if (payload) {
          return true; // Valid internal JWT, skip normal auth
        }
      }
    }

    if (
      url.startsWith("/api/auth") ||
      url.startsWith("/v1/openai") ||
      url.startsWith("/v1/anthropic") ||
      url.startsWith("/v1/gemini") ||
      url === "/openapi.json" ||
      url === "/health" ||
      url === "/api/features" ||
      url.startsWith(config.mcpGateway.endpoint) ||
      // Skip ACME challenge paths for SSL certificate domain validation
      url.startsWith("/.well-known/acme-challenge/")
    )
      return true;
    return false;
  };

  private isUnauthenticated = async (request: FastifyRequest) => {
    const headers = new Headers(request.headers as HeadersInit);

    try {
      const session = await betterAuth.api.getSession({
        headers,
        query: { disableCookieCache: true },
      });

      if (session) return false;
    } catch (_error) {
      /**
       * If getSession fails (e.g., "No active organization"), try API key verification
       */
      const authHeader = headers.get("authorization");
      if (authHeader) {
        try {
          const { valid } = await betterAuth.api.verifyApiKey({
            body: { key: authHeader },
          });

          return !valid;
        } catch (_apiKeyError) {
          // API key verification failed, return unauthenticated
          return true;
        }
      }
    }

    return true;
  };

  private requiredPermissionsStatus = async (
    request: FastifyRequest,
  ): Promise<{ success: boolean; error: Error | null }> => {
    const routeId = request.routeOptions.schema?.operationId as
      | RouteId
      | undefined;
    if (!routeId) {
      return {
        success: false,
        error: new Error("Forbidden, routeId not found"),
      };
    }

    try {
      return await betterAuth.api.hasPermission({
        headers: new Headers(request.headers as HeadersInit),
        body: {
          permissions: routePermissionsConfig[routeId] ?? {},
        },
      });
    } catch (_error) {
      /**
       * Handle API key sessions that don't have organization context
       * API keys have all permissions by default (see auth config)
       */
      const headers = new Headers(request.headers as HeadersInit);
      const authHeader = headers.get("authorization");

      if (authHeader) {
        try {
          // Verify if this is a valid API key
          const apiKeyResult = await betterAuth.api.verifyApiKey({
            body: { key: authHeader },
          });
          if (apiKeyResult?.valid) {
            // API keys have all permissions, so allow the request
            return { success: true, error: null };
          }
        } catch (_apiKeyError) {
          // Not a valid API key, return original error
          return { success: false, error: new Error("Invalid API key") };
        }
      }
      return { success: false, error: new Error("No API key provided") };
    }
  };

  private populateUserInfo = async (request: FastifyRequest): Promise<void> => {
    try {
      const session = await betterAuth.api.getSession({
        headers: new Headers(request.headers as HeadersInit),
        query: { disableCookieCache: true },
      });

      if (!session?.user?.id) {
        return; // Should not happen since we already checked authentication
      }

      // Get the full user object from database
      const user = await UserModel.getUserById(session.user.id);
      if (!user) {
        return; // Should not happen for valid sessions
      }

      // Get organization ID
      let organizationId = session.session?.activeOrganizationId;
      if (!organizationId) {
        // For API key requests, get from member table
        organizationId = await UserModel.getOrganizationId(session.user.id);
      }

      if (!organizationId) {
        return; // Should not happen for valid sessions
      }

      // Populate the request decorators
      request.user = user;
      request.organizationId = organizationId;
    } catch (_error) {
      // If population fails, leave decorators unpopulated
      // The route handlers should handle missing user info gracefully
    }
  };
}
