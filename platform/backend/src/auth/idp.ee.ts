import { MEMBER_ROLE_NAME } from "@shared";
import { APIError } from "better-auth";
import { jwtDecode } from "jwt-decode";
import {
  extractGroupsFromClaims,
  retrieveIdpGroups,
} from "@/auth/idp-team-sync-cache.ee";
import config from "@/config";
import logger from "@/logging";
// Direct imports to avoid circular dependencies when importing from barrel files
import AccountModel from "@/models/account";
import IdentityProviderModel, {
  type IdpGetRoleData,
} from "@/models/identity-provider.ee";
import MemberModel from "@/models/member";
import TeamModel from "@/models/team";

export const ssoConfig = {
  organizationProvisioning: {
    disabled: false,
    defaultRole: MEMBER_ROLE_NAME as "member",
    // IMPORTANT: This callback is ONLY invoked when creating NEW organization memberships
    // (i.e., first-time SSO logins for a user). For existing users who already have memberships,
    // this callback is NOT called. To sync roles on every SSO login, we use the `syncSsoRole`
    // function in `handleAfterHook` which runs on every `/sso/callback/*` request.
    getRole: async (data: IdpGetRoleData) => {
      logger.debug(
        {
          providerId: data.provider?.providerId,
          userId: data.user?.id,
          userEmail: data.user?.email,
        },
        "SSO getRole callback: Invoking IdentityProviderModel.resolveSsoRole",
      );

      // Cast to the expected union type (better-auth expects "member" | "admin")
      const resolvedRole = (await IdentityProviderModel.resolveSsoRole(data)) as
        | "member"
        | "admin";

      logger.debug(
        {
          providerId: data.provider?.providerId,
          userId: data.user?.id,
          resolvedRole,
        },
        "SSO getRole callback: Role resolved successfully",
      );

      return resolvedRole;
    },
  },
  defaultOverrideUserInfo: true,
  disableImplicitSignUp: false,
  providersLimit: 10,
  trustEmailVerified: true, // Trust email verification from SSO providers
  // Enable domain verification to allow SAML account linking for non-trusted providers
  // When enabled, providers with domainVerified: true can link accounts by email domain
  domainVerification: {
    enabled: true,
  },
};

/**
 * Synchronize user's organization role based on SSO claims.
 * This is called after successful SSO login in the after hook.
 *
 * Note: Better-auth's getRole callback is only invoked when creating NEW memberships.
 * For existing users, we need to manually sync their role on every SSO login.
 *
 * @param userId - The user's ID
 * @param userEmail - The user's email
 */
export async function syncSsoRole(
  userId: string,
  userEmail: string,
  providerIdHint?: string,
): Promise<void> {
  logger.info({ userId, userEmail }, "🔄 syncSsoRole called");

  const ssoAccount = await getRecentSsoAccount({
    userId,
    providerIdHint,
    requireIdToken: false,
  });

  if (!ssoAccount) {
    logger.debug(
      { userId, userEmail },
      "No SSO account found for user, skipping role sync",
    );
    return;
  }

  const providerId = ssoAccount.providerId;

  // Get the SSO provider to find the organization ID and role mapping config
  const idpProvider = await IdentityProviderModel.findByProviderId(providerId);

  if (!idpProvider?.organizationId) {
    logger.debug(
      { providerId, userEmail },
      "SSO provider not found or has no organization, skipping role sync",
    );
    return;
  }

  // Check if role mapping is configured
  const roleMapping = idpProvider.roleMapping;
  if (!roleMapping?.rules?.length) {
    logger.debug(
      { providerId, userEmail },
      "No role mapping rules configured, skipping role sync",
    );
    return;
  }

  // Check if skipRoleSync is enabled
  if (roleMapping.skipRoleSync) {
    logger.debug(
      { providerId, userEmail },
      "skipRoleSync is enabled, skipping role sync for existing user",
    );
    return;
  }

  // Decode the idToken to get claims
  if (!ssoAccount.idToken) {
    logger.debug(
      { providerId, userEmail },
      "No idToken in SSO account, skipping role sync",
    );
    return;
  }

  let tokenClaims: Record<string, unknown> = {};
  try {
    tokenClaims = jwtDecode<Record<string, unknown>>(ssoAccount.idToken);
    logger.debug(
      {
        providerId,
        userEmail,
        tokenClaimsKeys: Object.keys(tokenClaims),
      },
      "Decoded idToken claims for role sync",
    );
  } catch (error) {
    logger.warn(
      { err: error, providerId, userEmail },
      "Failed to decode idToken for role sync",
    );
    return;
  }

  // Evaluate role mapping rules
  const result = IdentityProviderModel.evaluateRoleMapping(
    roleMapping,
    {
      token: tokenClaims,
      provider: {
        id: idpProvider.id,
        providerId: idpProvider.providerId,
      },
    },
    "member",
  );

  logger.debug(
    {
      providerId,
      userEmail,
      result,
    },
    "Role mapping evaluation result for role sync",
  );

  // Handle strict mode: Deny login if no rules matched and strict mode is enabled
  if (result.error) {
    logger.warn(
      { providerId, userEmail, error: result.error },
      "SSO login denied for existing user due to strict mode - no role mapping rules matched",
    );
    throw new APIError("FORBIDDEN", {
      message: result.error,
    });
  }

  if (!result.role) {
    logger.debug(
      { providerId, userEmail },
      "No role determined from mapping rules, skipping role sync",
    );
    return;
  }

  // Get the user's current membership
  const existingMember = await MemberModel.getByUserId(
    userId,
    idpProvider.organizationId,
  );

  if (!existingMember) {
    logger.debug(
      { providerId, userEmail, organizationId: idpProvider.organizationId },
      "User has no membership in organization, skipping role sync (will be handled by organizationProvisioning)",
    );
    return;
  }

  // Update role if it changed
  if (existingMember.role !== result.role) {
    await MemberModel.updateRole(
      userId,
      idpProvider.organizationId,
      result.role,
    );
    logger.info(
      {
        userId,
        userEmail,
        providerId,
        organizationId: idpProvider.organizationId,
        previousRole: existingMember.role,
        newRole: result.role,
        matched: result.matched,
      },
      "✅ SSO role sync completed - role updated",
    );
  } else {
    logger.debug(
      {
        userId,
        userEmail,
        providerId,
        currentRole: existingMember.role,
      },
      "SSO role sync - no change needed",
    );
  }
}

/**
 * Synchronize user's team memberships based on their SSO groups.
 * This is called after successful SSO login in the after hook.
 *
 * @param userId - The user's ID
 * @param userEmail - The user's email
 */
export async function syncSsoTeams(
  userId: string,
  userEmail: string,
  providerIdHint?: string,
): Promise<void> {
  logger.info({ userId, userEmail }, "🔄 syncSsoTeams called");

  // Only sync if enterprise license is activated
  if (!config.enterpriseFeatures.core) {
    logger.info("🔄 Enterprise license not activated, skipping team sync");
    return;
  }

  const ssoAccount = await getRecentSsoAccount({
    userId,
    providerIdHint,
    requireIdToken: false,
  });

  logger.info(
    {
      ssoAccountFound: !!ssoAccount,
      providerId: ssoAccount?.providerId,
      providerIdHint,
    },
    "🔄 Found accounts for user",
  );

  if (!ssoAccount) {
    logger.warn(
      { userId, userEmail },
      "🔄 No SSO account found for user, skipping team sync",
    );
    return;
  }

  const providerId = ssoAccount.providerId;

  // Get the SSO provider to find the organization ID and teamSyncConfig
  const idpProvider = await IdentityProviderModel.findByProviderId(providerId);

  if (!idpProvider?.organizationId) {
    logger.debug(
      { providerId, userEmail },
      "SSO provider not found or has no organization, skipping team sync",
    );
    return;
  }

  // Check if team sync is explicitly disabled
  if (idpProvider.teamSyncConfig?.enabled === false) {
    logger.debug(
      { providerId, userEmail },
      "Team sync is disabled for this SSO provider",
    );
    return;
  }

  let groups: string[] = [];

  const cachedGroups = await retrieveIdpGroups(providerId, userEmail);
  if (cachedGroups?.groups.length) {
    groups = cachedGroups.groups;
    logger.debug(
      {
        providerId,
        userEmail,
        groups,
        hasGroups: groups.length > 0,
      },
      "Using cached IdP groups for team sync",
    );
  } else {
    // Fall back to the persisted idToken if the short-lived callback cache
    // is unavailable. better-auth stores the idToken in the account table,
    // but that write can lag the afterHook in CI.
    if (!ssoAccount.idToken) {
      logger.debug(
        { providerId, userEmail },
        "No cached groups or idToken in SSO account, skipping team sync",
      );
      return;
    }

    try {
      const idTokenClaims = jwtDecode<Record<string, unknown>>(
        ssoAccount.idToken,
      );
      groups = extractGroupsFromClaims(
        idTokenClaims,
        idpProvider.teamSyncConfig,
      );
      logger.debug(
        {
          providerId,
          userEmail,
          groups,
          hasGroups: groups.length > 0,
        },
        "Decoded idToken claims for team sync",
      );
    } catch (error) {
      logger.warn(
        { err: error, providerId, userEmail },
        "Failed to decode idToken for team sync",
      );
      return;
    }
  }

  if (groups.length === 0) {
    logger.debug(
      { providerId, userEmail },
      "No groups found in idToken, skipping team sync",
    );
    return;
  }

  const organizationId = idpProvider.organizationId;

  try {
    const { added, removed } = await TeamModel.syncUserTeams(
      userId,
      organizationId,
      groups,
    );

    if (added.length > 0 || removed.length > 0) {
      logger.info(
        {
          userId,
          email: userEmail,
          providerId,
          organizationId,
          groupCount: groups.length,
          teamsAdded: added.length,
          teamsRemoved: removed.length,
        },
        "✅ SSO team sync completed",
      );
    } else {
      logger.debug(
        { userId, email: userEmail, providerId },
        "SSO team sync - no changes needed",
      );
    }
  } catch (error) {
    logger.error(
      { err: error, userId, email: userEmail, providerId },
      "❌ Failed to sync SSO teams",
    );
  }
}

// === Internal helpers ===

async function getRecentSsoAccount(params: {
  userId: string;
  providerIdHint?: string;
  requireIdToken: boolean;
}) {
  const allAccounts = await AccountModel.getAllByUserId(params.userId);

  const matchingAccounts = allAccounts.filter((account) => {
    if (account.providerId === "credential") {
      return false;
    }

    if (params.providerIdHint) {
      return account.providerId === params.providerIdHint;
    }

    return true;
  });

  const accountWithIdToken = matchingAccounts.find(
    (account) => account.idToken,
  );
  const fallbackAccount = matchingAccounts[0];

  if (params.requireIdToken) {
    return accountWithIdToken ?? null;
  }

  return accountWithIdToken ?? fallbackAccount ?? null;
}
