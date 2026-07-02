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
  /**
   * DB-fresh caller identity (request.user.id / request.organizationId) when
   * the auth middleware already resolved it — skips re-deriving the identity
   * from the session.
   */
  userContext?: { userId: string; organizationId: string },
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

    // Authorization is evaluated against the database (member role + custom
    // roles), NOT via better-auth's session-resolved hasPermission: the
    // session cookie cache (see session.cookieCache in better-auth config)
    // can carry a stale activeOrganizationId snapshot — e.g. a session
    // created by sign-up-with-invitation caches `null` until the TTL lapses,
    // denying every org-scoped request for that window. The cookie is only
    // trusted for IDENTITY (user id, which sign-in/sign-up always rewrite);
    // role and organization come from the DB on every check, matching the
    // request.organizationId the route handler will execute under.
    if (userContext) {
      return await checkUserPermissions({ ...userContext, permissions });
    }

    const session = await betterAuth.api.getSession({ headers });
    if (!session?.user?.id) {
      throw new Error("No session");
    }
    const { organizationId } = await UserModel.getById(session.user.id);
    if (!organizationId) {
      return { success: false, error: new Error("Forbidden") };
    }
    const result = await checkUserPermissions({
      userId: session.user.id,
      organizationId,
      permissions,
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

  return checkUserPermissions({
    userId: apiKeyUserId,
    organizationId,
    permissions: params.permissions,
  });
}

async function checkUserPermissions(params: {
  userId: string;
  organizationId: string;
  permissions: Permissions;
}): Promise<{ success: boolean; error: Error | null }> {
  const userPermissions = await UserModel.getUserPermissions(
    params.userId,
    params.organizationId,
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
