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

/** @public — consumed via dynamic import in src/auth/better-auth.ts */
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
        "[syncSsoRole] Invoking IdentityProviderModel.resolveSsoRole from SSO getRole callback",
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
        "[syncSsoRole] Role resolved successfully from SSO getRole callback",
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
 * @public — consumed via dynamic import in src/auth/better-auth.ts
 */
export async function syncSsoRole(
  userId: string,
  userEmail: string,
  providerIdHint?: string,
): Promise<void> {
  logger.info({ userId, userEmail }, "[syncSsoRole] Starting SSO role sync");

  const ssoAccount = await getRecentSsoAccount({
    userId,
    providerIdHint,
    requireIdToken: false,
  });

  if (!ssoAccount) {
    logger.debug(
      { userId, userEmail },
      "[syncSsoRole] No SSO account found for user, skipping role sync",
    );
    return;
  }

  const providerId = ssoAccount.providerId;

  // Get the SSO provider to find the organization ID and role mapping config
  const idpProvider = await IdentityProviderModel.findByProviderId(providerId);

  if (!idpProvider?.organizationId) {
    logger.debug(
      { providerId, userEmail },
      "[syncSsoRole] SSO provider not found or has no organization, skipping role sync",
    );
    return;
  }

  // Check if role mapping is configured
  const roleMapping = idpProvider.roleMapping;
  if (!roleMapping) {
    logger.debug(
      { providerId, userEmail },
      "[syncSsoRole] No role mapping configured, skipping role sync",
    );
    return;
  }

  // Check if skipRoleSync is enabled
  if (roleMapping.skipRoleSync) {
    logger.debug(
      { providerId, userEmail },
      "[syncSsoRole] skipRoleSync is enabled, skipping role sync for existing user",
    );
    return;
  }

  // Decode the idToken to get claims
  if (!ssoAccount.idToken) {
    logger.debug(
      { providerId, userEmail },
      "[syncSsoRole] No idToken in SSO account, skipping role sync",
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
      "[syncSsoRole] Decoded idToken claims for role sync",
    );
  } catch (error) {
    logger.warn(
      { err: error, providerId, userEmail },
      "[syncSsoRole] Failed to decode idToken for role sync",
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
  const extractedGroups = extractGroupsFromClaims(
    tokenClaims,
    idpProvider.teamSyncConfig,
  );

  logger.info(
    {
      providerId,
      userEmail,
      organizationId: idpProvider.organizationId,
      claimKeys: Object.keys(tokenClaims),
      extractedGroupCount: extractedGroups.length,
      roleMappingRuleCount: roleMapping.rules?.length ?? 0,
      matched: result.matched,
      resolvedRole: result.role,
    },
    "[syncSsoRole] Evaluated role mapping",
  );

  // Handle strict mode: Deny login if no rules matched and strict mode is enabled
  if (result.error) {
    logger.warn(
      { providerId, userEmail, error: result.error },
      "[syncSsoRole] SSO login denied for existing user due to strict mode - no role mapping rules matched",
    );
    throw new APIError("FORBIDDEN", {
      message: result.error,
    });
  }

  if (!result.role) {
    logger.debug(
      { providerId, userEmail },
      "[syncSsoRole] No role determined from mapping rules, skipping role sync",
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
      "[syncSsoRole] User has no membership in organization, skipping role sync",
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
      "[syncSsoRole] SSO role sync completed - role updated",
    );
  } else {
    logger.debug(
      {
        userId,
        userEmail,
        providerId,
        currentRole: existingMember.role,
      },
      "[syncSsoRole] SSO role sync completed - no change needed",
    );
  }
}

/**
 * Synchronize user's team memberships based on their SSO groups.
 * This is called after successful SSO login in the after hook.
 *
 * @param userId - The user's ID
 * @param userEmail - The user's email
 * @public — consumed via dynamic import in src/auth/better-auth.ts
 */
export async function syncSsoTeams(
  userId: string,
  userEmail: string,
  providerIdHint?: string,
): Promise<void> {
  logger.info({ userId, userEmail }, "[syncSsoTeams] Starting SSO team sync");

  // Only sync if enterprise license is activated
  if (!config.enterpriseFeatures.core) {
    logger.info(
      "[syncSsoTeams] Enterprise license not activated, skipping team sync",
    );
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
    "[syncSsoTeams] Found SSO account for user",
  );

  if (!ssoAccount) {
    logger.warn(
      { userId, userEmail },
      "[syncSsoTeams] No SSO account found for user, skipping team sync",
    );
    return;
  }

  const providerId = ssoAccount.providerId;

  // Get the SSO provider to find the organization ID and teamSyncConfig
  const idpProvider = await IdentityProviderModel.findByProviderId(providerId);

  if (!idpProvider?.organizationId) {
    logger.debug(
      { providerId, userEmail },
      "[syncSsoTeams] SSO provider not found or has no organization, skipping team sync",
    );
    return;
  }

  // Check if team sync is explicitly disabled
  if (idpProvider.teamSyncConfig?.enabled === false) {
    logger.debug(
      { providerId, userEmail },
      "[syncSsoTeams] Team sync is disabled for this SSO provider",
    );
    return;
  }

  let groups: string[] = [];
  let groupsSource: "callback-cache" | "account-id-token" = "account-id-token";
  let claimKeys: string[] = [];

  const cachedGroups = await retrieveIdpGroups(providerId, userEmail);
  if (cachedGroups?.groups.length) {
    groupsSource = "callback-cache";
    groups = cachedGroups.groups;
    logger.debug(
      {
        providerId,
        userEmail,
        groupCount: groups.length,
      },
      "[syncSsoTeams] Using cached IdP groups for team sync",
    );
  } else {
    // Fall back to the persisted idToken if the short-lived callback cache
    // is unavailable. better-auth stores the idToken in the account table,
    // but that write can lag the afterHook in CI.
    if (!ssoAccount.idToken) {
      logger.debug(
        { providerId, userEmail },
        "[syncSsoTeams] No cached groups or idToken in SSO account, skipping team sync",
      );
      return;
    }

    try {
      const idTokenClaims = jwtDecode<Record<string, unknown>>(
        ssoAccount.idToken,
      );
      claimKeys = Object.keys(idTokenClaims);
      groups = extractGroupsFromClaims(
        idTokenClaims,
        idpProvider.teamSyncConfig,
      );
      logger.debug(
        {
          providerId,
          userEmail,
          claimKeys,
          groupCount: groups.length,
        },
        "[syncSsoTeams] Decoded idToken claims for team sync",
      );
    } catch (error) {
      logger.warn(
        { err: error, providerId, userEmail },
        "[syncSsoTeams] Failed to decode idToken for team sync",
      );
      return;
    }
  }

  if (groups.length === 0) {
    logger.info(
      { providerId, userEmail, groupsSource, claimKeys },
      "[syncSsoTeams] No IdP groups found for SSO team sync",
    );
    return;
  }

  const organizationId = idpProvider.organizationId;

  try {
    const {
      added,
      removed,
      matchedExternalGroupCount,
      matchedTeamCount,
      unmappedGroupCount,
    } = await TeamModel.syncUserTeams(userId, organizationId, groups);

    logger.info(
      {
        userId,
        email: userEmail,
        providerId,
        organizationId,
        groupsSource,
        groupCount: groups.length,
        matchedExternalGroupCount,
        matchedTeamCount,
        unmappedGroupCount,
        teamsAdded: added.length,
        teamsRemoved: removed.length,
      },
      "[syncSsoTeams] Evaluated IdP groups for team sync",
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
        "[syncSsoTeams] SSO team sync completed - memberships changed",
      );
    } else {
      logger.debug(
        { userId, email: userEmail, providerId },
        "[syncSsoTeams] SSO team sync completed - no changes needed",
      );
    }
  } catch (error) {
    logger.error(
      { err: error, userId, email: userEmail, providerId },
      "[syncSsoTeams] Failed to sync SSO teams",
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
