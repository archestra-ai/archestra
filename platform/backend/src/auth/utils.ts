import type { IncomingHttpHeaders } from "node:http";
import type { Action, Permissions, Resource } from "@shared";
import { auth as betterAuth } from "@/auth/better-auth";
import logger from "@/logging";
import { ServiceAccountModel, UserModel } from "@/models";
import type { SelectServiceAccount } from "@/types";

export const hasPermission = async (
  permissions: Permissions,
  requestHeaders: IncomingHttpHeaders,
  serviceAccount?: SelectServiceAccount,
): Promise<{ success: boolean; error: Error | null }> => {
  const headers = new Headers(requestHeaders as HeadersInit);
  logger.trace(
    { permissionCount: Object.keys(permissions).length },
    "[hasPermission] Checking permissions",
  );

  try {
    if (serviceAccount) {
      const serviceAccountPermissions =
        await ServiceAccountModel.getPermissions(serviceAccount);
      const hasAllPermissions = hasRequiredPermissions(
        serviceAccountPermissions,
        permissions,
      );

      return {
        success: hasAllPermissions,
        error: hasAllPermissions ? null : new Error("Forbidden"),
      };
    }

    const result = await betterAuth.api.hasPermission({
      headers,
      body: {
        permissions,
      },
    });
    logger.trace(
      { success: result.success },
      "[hasPermission] Session-based permission check result",
    );
    return result;
  } catch (error) {
    /**
     * Fall back to API key verification and check the key owner's current
     * RBAC permissions.
     */
    logger.trace(
      { error: error instanceof Error ? error.message : "unknown" },
      "[hasPermission] Session permission check failed, trying API key",
    );
    const authHeader = headers.get("authorization");

    if (authHeader) {
      try {
        // Verify if this is a valid API key
        logger.trace("[hasPermission] Verifying API key for permission check");
        const apiKeyResult = await betterAuth.api.verifyApiKey({
          body: { key: authHeader },
        });
        if (apiKeyResult?.valid && apiKeyResult.key?.referenceId) {
          const apiKeyUserId = apiKeyResult.key.referenceId;
          logger.trace(
            { apiKeyUserId },
            "[hasPermission] Valid API key found, checking owner permissions",
          );

          const apiKeyOwner = await UserModel.getById(apiKeyUserId);
          const organizationId = apiKeyOwner?.organizationId;
          if (!organizationId) {
            logger.trace(
              "[hasPermission] API key missing organization context",
            );
            return { success: false, error: new Error("Forbidden") };
          }

          const userPermissions = await UserModel.getUserPermissions(
            apiKeyUserId,
            organizationId,
          );
          const hasAllPermissions = hasRequiredPermissions(
            userPermissions,
            permissions,
          );

          return {
            success: hasAllPermissions,
            error: hasAllPermissions ? null : new Error("Forbidden"),
          };
        }
        logger.trace(
          "[hasPermission] API key verification returned invalid, trying service account token",
        );
        const serviceAccountResult =
          await ServiceAccountModel.verifyToken(authHeader);
        if (serviceAccountResult) {
          const serviceAccountPermissions =
            await ServiceAccountModel.getPermissions(
              serviceAccountResult.serviceAccount,
            );
          const hasAllPermissions = hasRequiredPermissions(
            serviceAccountPermissions,
            permissions,
          );

          return {
            success: hasAllPermissions,
            error: hasAllPermissions ? null : new Error("Forbidden"),
          };
        }
      } catch (_apiKeyError) {
        logger.trace(
          "[hasPermission] API key verification failed, trying service account token",
        );
        const serviceAccountResult =
          await ServiceAccountModel.verifyToken(authHeader);
        if (serviceAccountResult) {
          const serviceAccountPermissions =
            await ServiceAccountModel.getPermissions(
              serviceAccountResult.serviceAccount,
            );
          const hasAllPermissions = hasRequiredPermissions(
            serviceAccountPermissions,
            permissions,
          );

          return {
            success: hasAllPermissions,
            error: hasAllPermissions ? null : new Error("Forbidden"),
          };
        }

        return { success: false, error: new Error("Invalid API key") };
      }
    }
    logger.trace("[hasPermission] No valid API key provided");
    return { success: false, error: new Error("No API key provided") };
  }
};

/**
 * Check if a user has a specific permission based on their role
 * @param userId - The user's ID
 * @param organizationId - The organization ID
 * @param resource - The resource to check (e.g., "agent", "mcpServer")
 * @param action - The action to check (e.g., "admin", "read", "write")
 */
export const userHasPermission = async (
  userId: string,
  organizationId: string,
  resource: Resource,
  action: Action,
): Promise<boolean> => {
  const permissions = await getPermissionsForUserContext({
    userId,
    organizationId,
  });

  return permissions[resource]?.includes(action) ?? false;
};

export const getPermissionsForUserContext = async (params: {
  userId: string;
  organizationId: string;
}): Promise<Permissions> => {
  const serviceAccount = await getServiceAccountFromSyntheticUserId(params);
  if (serviceAccount) {
    return ServiceAccountModel.getPermissions(serviceAccount);
  }

  return UserModel.getUserPermissions(params.userId, params.organizationId);
};

function hasRequiredPermissions(
  userPermissions: Permissions,
  requiredPermissions: Permissions,
): boolean {
  for (const [resource, actions] of Object.entries(requiredPermissions)) {
    for (const action of actions) {
      if (!userPermissions[resource as Resource]?.includes(action as Action)) {
        return false;
      }
    }
  }

  return true;
}

async function getServiceAccountFromSyntheticUserId(params: {
  userId: string;
  organizationId: string;
}): Promise<SelectServiceAccount | null> {
  const prefix = "service-account:";
  if (!params.userId.startsWith(prefix)) return null;

  const serviceAccountId = params.userId.slice(prefix.length);
  const serviceAccount = await ServiceAccountModel.findById(
    serviceAccountId,
    params.organizationId,
  );

  if (serviceAccount?.disabled) return null;
  return serviceAccount;
}
