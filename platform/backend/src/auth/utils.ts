import type { IncomingHttpHeaders } from "node:http";
import type { Action, Permissions, Resource } from "@archestra/shared";
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
      return await checkServiceAccountPermissions({
        serviceAccount,
        permissions,
      });
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
    logger.trace(
      { error: error instanceof Error ? error.message : "unknown" },
      "[hasPermission] Session permission check failed, trying token auth fallback",
    );

    const authHeader = headers.get("authorization");
    if (!authHeader) {
      logger.trace("[hasPermission] No valid API key provided");
      return { success: false, error: new Error("No API key provided") };
    }

    const apiKeyPermissionResult = await checkApiKeyPermissions({
      apiKey: authHeader,
      permissions,
    });
    if (apiKeyPermissionResult) {
      return apiKeyPermissionResult;
    }

    /**
     * Session permission checks can throw when no session is present. At this
     * point the Authorization header may be either a personal API key or a
     * service account token, so the service-account fallback is intentional.
     */
    const serviceAccountPermissionResult =
      await checkServiceAccountTokenPermissions({
        token: authHeader,
        permissions,
      });
    if (serviceAccountPermissionResult) {
      return serviceAccountPermissionResult;
    }

    return { success: false, error: new Error("Invalid API key") };
  }
};

/**
 * Check if a user has a specific permission based on their role.
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

// === Internal helpers

async function checkApiKeyPermissions(params: {
  apiKey: string;
  permissions: Permissions;
}): Promise<{ success: boolean; error: Error | null } | null> {
  let apiKeyUserId: string | null = null;

  try {
    logger.trace("[hasPermission] Verifying API key for permission check");
    const apiKeyResult = await betterAuth.api.verifyApiKey({
      body: { key: params.apiKey },
    });
    apiKeyUserId =
      apiKeyResult?.valid && apiKeyResult.key?.referenceId
        ? apiKeyResult.key.referenceId
        : null;
  } catch (_apiKeyError) {
    logger.trace("[hasPermission] API key verification failed");
  }

  if (!apiKeyUserId) {
    logger.trace("[hasPermission] API key verification returned invalid");
    return null;
  }

  logger.trace(
    { apiKeyUserId },
    "[hasPermission] Valid API key found, checking owner permissions",
  );

  const apiKeyOwner = await UserModel.getById(apiKeyUserId);
  const organizationId = apiKeyOwner?.organizationId;
  if (!organizationId) {
    logger.trace("[hasPermission] API key missing organization context");
    return { success: false, error: new Error("Forbidden") };
  }

  const userPermissions = await UserModel.getUserPermissions(
    apiKeyUserId,
    organizationId,
  );
  const hasAllPermissions = hasRequiredPermissions(
    userPermissions,
    params.permissions,
  );

  return {
    success: hasAllPermissions,
    error: hasAllPermissions ? null : new Error("Forbidden"),
  };
}

async function checkServiceAccountTokenPermissions(params: {
  token: string;
  permissions: Permissions;
}): Promise<{ success: boolean; error: Error | null } | null> {
  const serviceAccountResult = await ServiceAccountModel.verifyToken(
    params.token,
  );
  if (!serviceAccountResult) {
    return null;
  }

  return checkServiceAccountPermissions({
    serviceAccount: serviceAccountResult.serviceAccount,
    permissions: params.permissions,
  });
}

async function checkServiceAccountPermissions(params: {
  serviceAccount: SelectServiceAccount;
  permissions: Permissions;
}): Promise<{ success: boolean; error: Error | null }> {
  const serviceAccountPermissions = await ServiceAccountModel.getPermissions(
    params.serviceAccount,
  );
  const hasAllPermissions = hasRequiredPermissions(
    serviceAccountPermissions,
    params.permissions,
  );

  return {
    success: hasAllPermissions,
    error: hasAllPermissions ? null : new Error("Forbidden"),
  };
}

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
