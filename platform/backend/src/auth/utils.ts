import type { IncomingHttpHeaders } from "node:http";
import type { Permissions } from "@shared";
import logger from "@/logging";
import { auth as betterAuth } from "./better-auth";

export const hasPermission = async (
  permissions: Permissions,
  requestHeaders: IncomingHttpHeaders,
): Promise<{ success: boolean; error: Error | null }> => {
  const headers = new Headers(requestHeaders as HeadersInit);
  logger.debug({ permissions }, "[hasPermission] Checking permissions");

  try {
    const result = await betterAuth.api.hasPermission({
      headers,
      body: {
        permissions,
      },
    });
    logger.debug(
      { success: result.success, permissions },
      "[hasPermission] Session-based permission check result",
    );
    return result;
  } catch (error) {
    /**
     * Handle API key sessions that don't have organization context
     * API keys have all permissions by default (see auth config)
     */
    logger.debug(
      { error: error instanceof Error ? error.message : "unknown" },
      "[hasPermission] Session permission check failed, trying API key",
    );
    const authHeader = headers.get("authorization");

    if (authHeader) {
      try {
        // Verify if this is a valid API key
        logger.debug("[hasPermission] Verifying API key for permission check");
        const apiKeyResult = await betterAuth.api.verifyApiKey({
          body: { key: authHeader },
        });
        if (apiKeyResult?.valid) {
          // API keys have all permissions, so allow the request
          logger.debug(
            "[hasPermission] Valid API key found, granting all permissions",
          );
          return { success: true, error: null };
        }
        logger.debug("[hasPermission] API key verification returned invalid");
      } catch (apiKeyError) {
        // Not a valid API key, return original error
        logger.debug(
          {
            error:
              apiKeyError instanceof Error ? apiKeyError.message : "unknown",
          },
          "[hasPermission] API key verification failed",
        );
        return { success: false, error: new Error("Invalid API key") };
      }
    }
    logger.debug("[hasPermission] No valid API key provided");
    return { success: false, error: new Error("No API key provided") };
  }
};
