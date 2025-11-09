import { type RouteId, requiredEndpointPermissionsMap } from "@shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { betterAuth, hasPermission } from "@/auth";
import config from "@/config";
import { UserModel } from "@/models";
import type { ErrorResponse } from "@/types";
import { verifyInternalJwt } from "../internal-jwt";

const prepareErrorResponse = (
  error: ErrorResponse["error"],
): ErrorResponse => ({ error });

export class Authnz {
  public handle = async (request: FastifyRequest, reply: FastifyReply) => {
    // custom logic to skip auth check
    if (await this.shouldSkipAuthCheck(request)) return;

    // return 401 if unauthenticated
    if (!(await this.isAuthenticated(request))) {
      return reply.status(401).send(
        prepareErrorResponse({
          message: "Unauthenticated",
          type: "unauthenticated",
        }),
      );
    }

    // Populate request.user and request.organizationId after successful authentication
    await this.populateUserInfo(request);

    const { success, error } = await this.isAuthorized(request);
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

  private isAuthenticated = async (request: FastifyRequest) => {
    const headers = new Headers(request.headers as HeadersInit);

    try {
      const session = await betterAuth.api.getSession({
        headers,
        query: { disableCookieCache: true },
      });

      if (session) return true;
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

          return valid;
        } catch (_apiKeyError) {
          // API key verification failed, return unauthenticated
          return false;
        }
      }
    }

    return false;
  };

  private isAuthorized = async (
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

    const requiredPermissions = requiredEndpointPermissionsMap[routeId] ?? {};

    // If no specific permissions are required (empty object), allow any authenticated user
    if (Object.keys(requiredPermissions).length === 0) {
      return { success: true, error: null };
    }

    return await hasPermission(requiredPermissions, request.headers);
  };

  private populateUserInfo = async (request: FastifyRequest): Promise<void> => {
    try {
      const headers = new Headers(request.headers as HeadersInit);

      // Try session-based authentication first
      try {
        const session = await betterAuth.api.getSession({
          headers,
          query: { disableCookieCache: true },
        });

        if (session?.user?.id) {
          // Get the full user object from database
          const { organizationId, ...user } = await UserModel.getById(
            session.user.id,
          );

          // Populate the request decorators
          request.user = user;
          request.organizationId = organizationId;
          return;
        }
      } catch (_sessionError) {
        // Fall through to API key authentication
      }

      // Try API key authentication
      const authHeader = headers.get("authorization");
      if (authHeader) {
        try {
          const apiKeyResult = await betterAuth.api.verifyApiKey({
            body: { key: authHeader },
          });

          if (apiKeyResult?.valid && apiKeyResult.key?.userId) {
            // Get the full user object from database using the userId from the API key
            const { organizationId, ...user } = await UserModel.getById(
              apiKeyResult.key.userId,
            );

            // Populate the request decorators
            request.user = user;
            request.organizationId = organizationId;
            return;
          }
        } catch (_apiKeyError) {
          // API key verification failed
        }
      }
    } catch (_error) {
      // If population fails, leave decorators unpopulated
      // The route handlers should handle missing user info gracefully
    }
  };
}
