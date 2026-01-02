import type { IncomingHttpHeaders } from "node:http";
import type { Action, Permissions, Resource } from "@shared";
import { auth as betterAuth } from "@/auth/better-auth";
import logger from "@/logging";
import { UserModel } from "@/models";

export const hasPermission = async (
  permissions: Permissions,
  requestHeaders: IncomingHttpHeaders,
): Promise<{ success: boolean; error: Error | null }> => {
  const headers = new Headers(requestHeaders as HeadersInit);
  logger.debug(
    { permissionCount: Object.keys(permissions).length },
    "[hasPermission] Checking permissions",
  );

  try {
    const result = await betterAuth.api.hasPermission({
      headers,
      body: {
        permissions,
      },
    });
    logger.debug(
      { success: result.success },
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
      } catch (_apiKeyError) {
        // Not a valid API key, return original error
        logger.debug("[hasPermission] API key verification failed");
        return { success: false, error: new Error("Invalid API key") };
      }
    }
    logger.debug("[hasPermission] No valid API key provided");
    return { success: false, error: new Error("No API key provided") };
  }
};

/**
 * Check if a user has a specific permission based on their role
 * @param userId - The user's ID
 * @param organizationId - The organization ID
 * @param resource - The resource to check (e.g., "profile", "mcpServer")
 * @param action - The action to check (e.g., "admin", "read", "write")
 */
export const userHasPermission = async (
  userId: string,
  organizationId: string,
  resource: Resource,
  action: Action,
): Promise<boolean> => {
  const permissions = await UserModel.getUserPermissions(
    userId,
    organizationId,
  );
  return permissions[resource]?.includes(action) ?? false;
};
