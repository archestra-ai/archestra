import type { HookEndpointContext } from "@better-auth/core";
import { sso } from "@better-auth/sso";
import { SSO_TRUSTED_PROVIDER_IDS } from "@shared";
import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { admin, apiKey, organization, twoFactor } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { z } from "zod";
import config from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";
// Import directly from files to avoid circular dependency through barrel export
import InvitationModel from "@/models/invitation";
import MemberModel from "@/models/member";
import SessionModel from "@/models/session";

const { ssoConfig, syncSsoRole, syncSsoTeams } =
  config.enterpriseLicenseActivated
    ? // biome-ignore lint/style/noRestrictedImports: EE-only SSO config
      await import("./sso.ee")
    : {
        ssoConfig: undefined,
        syncSsoRole: () => {},
        syncSsoTeams: () => {},
      };

const APP_NAME = "Archestra";
const {
  api: { apiKeyAuthorizationHeaderName },
  frontendBaseUrl,
  production,
  auth: {
    secret,
    cookieDomain,
    trustedOrigins,
    additionalTrustedSsoProviderIds,
  },
} = config;

const isHttps = () => {
  // if baseURL (coming from process.env.ARCHESTRA_FRONTEND_URL) is not set, use production (process.env.NODE_ENV=production)
  // to determine if we're using HTTPS
  if (!frontendBaseUrl) {
    return production;
  }
  // otherwise, use frontendBaseUrl to determine if we're using HTTPS
  // this is useful for envs where NODE_ENV=production but using HTTP localhost like docker run
  return frontendBaseUrl.startsWith("https://");
};

const { allAvailableActions, editorPermissions, memberPermissions } =
  config.enterpriseLicenseActivated
    ? // biome-ignore lint/style/noRestrictedImports: EE-only permissions
      await import("@shared/access-control.ee")
    : await import("@shared/access-control");
const ac = createAccessControl(allAvailableActions);

const adminRole = ac.newRole(allAvailableActions);
const editorRole = ac.newRole(editorPermissions);
const memberRole = ac.newRole(memberPermissions);

// biome-ignore lint/suspicious/noExplicitAny: better-auth bs https://github.com/better-auth/better-auth/issues/5666
export const auth: any = betterAuth({
  appName: APP_NAME,
  baseURL: frontendBaseUrl,
  secret,
  ...(config.authRateLimitDisabled ? { rateLimit: { enabled: false } } : {}),
  plugins: [
    organization({
      requireEmailVerificationOnInvitation: false,
      allowUserToCreateOrganization: false, // Disable organization creation by users
      ac,
      dynamicAccessControl: {
        enabled: true,
        maximumRolesPerOrganization: 50, // Configurable limit for custom roles
        validateRoleName: async (roleName: string) => {
          // Role names must be lowercase alphanumeric with underscores
          if (!/^[a-z0-9_]+$/.test(roleName)) {
            throw new Error(
              "Role name must be lowercase letters, numbers, and underscores only",
            );
          }
          if (roleName.length < 2) {
            throw new Error("Role name must be at least 2 characters");
          }
          if (roleName.length > 50) {
            throw new Error("Role name must be less than 50 characters");
          }
        },
      },
      roles: {
        admin: adminRole,
        editor: editorRole,
        member: memberRole,
      },
      schema: {
        organizationRole: {
          additionalFields: {
            name: {
              type: "string",
              required: true,
            },
          },
        },
      },
      features: {
        team: {
          enabled: true,
          ac,
          roles: {
            admin: adminRole,
            editor: editorRole,
            member: memberRole,
          },
        },
      },
    }),
    admin(),
    apiKey({
      enableSessionForAPIKeys: true,
      apiKeyHeaders: [apiKeyAuthorizationHeaderName],
      defaultPrefix: "archestra_",
      rateLimit: {
        enabled: false,
      },
      permissions: {
        /**
         * NOTE: for now we will just grant all permissions to all API keys
         *
         * If we'd like to allow granting "scopes" to API keys, we will need to implement a more complex API-key
         * permissions system/UI
         */
        defaultPermissions: allAvailableActions,
      },
    }),
    twoFactor({
      issuer: APP_NAME,
    }),
    ...(ssoConfig ? [sso(ssoConfig)] : []),
  ],

  user: {
    deleteUser: {
      enabled: true,
    },
  },

  trustedOrigins,

  database: drizzleAdapter(db, {
    provider: "pg", // or "mysql", "sqlite"
    schema: {
      apikey: schema.apikeysTable,
      user: schema.usersTable,
      session: schema.sessionsTable,
      organization: schema.organizationsTable,
      organizationRole: schema.organizationRolesTable,
      member: schema.membersTable,
      invitation: schema.invitationsTable,
      account: schema.accountsTable,
      team: schema.teamsTable,
      teamMember: schema.teamMembersTable,
      twoFactor: schema.twoFactorsTable,
      verification: schema.verificationsTable,
      ssoProvider: schema.ssoProvidersTable,
    },
  }),

  emailAndPassword: {
    enabled: true,
  },

  account: {
    /**
     * See better-auth docs here for more information on this:
     * https://www.better-auth.com/docs/reference/options#accountlinking
     */
    accountLinking: {
      enabled: true,
      /**
       * Trust SSO providers for automatic account linking
       * This allows existing users to sign in with SSO without manual linking
       *
       * Combines default trusted providers from @shared with additional ones
       * configured via ARCHESTRA_AUTH_TRUSTED_SSO_PROVIDER_IDS env var
       */
      trustedProviders: [
        ...SSO_TRUSTED_PROVIDER_IDS,
        ...additionalTrustedSsoProviderIds,
      ],
      /**
       * Don't allow linking accounts with different emails. From the better-auth typescript
       * annotations they mention for this attribute:
       *
       * ⚠️ Warning: enabling allowDifferentEmails might lead to account takeovers
       */
      allowDifferentEmails: false,
      allowUnlinkingAll: true,
    },
  },

  advanced: {
    cookiePrefix: "archestra",
    defaultCookieAttributes: {
      ...(cookieDomain ? { domain: cookieDomain } : {}),
      secure: isHttps(), // Use secure cookies when we're using HTTPS
      // "lax" is required for OAuth/SSO flows because the callback is a cross-site top-level navigation
      // "strict" would prevent the state cookie from being sent with the callback request
      sameSite: isHttps() ? "none" : "lax",
    },
  },

  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          // If activeOrganizationId is not set, find the user's first organization
          if (!session.activeOrganizationId) {
            const membership = await MemberModel.getFirstMembershipForUser(
              session.userId,
            );

            if (membership) {
              logger.info(
                {
                  userId: session.userId,
                  organizationId: membership.organizationId,
                },
                "Auto-setting active organization for new session",
              );
              return {
                data: {
                  ...session,
                  activeOrganizationId: membership.organizationId,
                },
              };
            }
          }
          return { data: session };
        },
      },
    },
  },

  hooks: {
    before: createAuthMiddleware(async (ctx) => handleBeforeHook(ctx)),
    after: createAuthMiddleware(async (ctx) => handleAfterHook(ctx)),
  },
});

export type BetterAuth = typeof auth;

/**
 * Validates requests before they are processed by better-auth.
 *
 * Handles:
 * - Blocking invitations when disabled via environment variable
 * - Email validation for invitation requests
 * - Invitation-only sign-up enforcement
 */
export async function handleBeforeHook(ctx: HookEndpointContext) {
  const { path, method, body } = ctx;

  logger.debug({ path, method }, "[auth:beforeHook] Processing auth request");

  // Block invitation creation when invitations are disabled
  if (path === "/organization/invite-member" && method === "POST") {
    logger.debug(
      { email: body.email, disableInvitations: config.auth.disableInvitations },
      "[auth:beforeHook] Processing invitation request",
    );
    if (config.auth.disableInvitations) {
      logger.debug(
        "[auth:beforeHook] Invitations are disabled, blocking request",
      );
      throw new APIError("FORBIDDEN", {
        message: "User invitations are disabled",
      });
    }

    if (!z.email().safeParse(body.email).success) {
      logger.debug(
        { email: body.email },
        "[auth:beforeHook] Invalid email format",
      );
      throw new APIError("BAD_REQUEST", {
        message: "Invalid email format",
      });
    }

    return ctx;
  }

  // Block invitation cancellation when invitations are disabled
  if (path === "/organization/cancel-invitation" && method === "POST") {
    logger.debug(
      {
        invitationId: body.invitationId,
        disableInvitations: config.auth.disableInvitations,
      },
      "[auth:beforeHook] Processing invitation cancellation",
    );
    if (config.auth.disableInvitations) {
      logger.debug(
        "[auth:beforeHook] Invitations are disabled, blocking cancellation",
      );
      throw new APIError("FORBIDDEN", {
        message: "User invitations are disabled",
      });
    }
  }

  // Block direct sign-up without invitation (invitation-only registration)
  if (path.startsWith("/sign-up/email") && method === "POST") {
    const callbackURL = body.callbackURL as string | undefined;
    const invitationId = callbackURL?.split("invitationId=")[1]?.split("&")[0];

    logger.debug(
      { email: body.email, hasInvitationId: !!invitationId },
      "[auth:beforeHook] Processing sign-up request",
    );

    if (!invitationId) {
      logger.debug("[auth:beforeHook] Sign-up without invitation ID blocked");
      throw new APIError("FORBIDDEN", {
        message:
          "Direct sign-up is disabled. You need an invitation to create an account.",
      });
    }

    // Validate the invitation exists and is pending
    const invitation = await InvitationModel.getById(invitationId);

    if (!invitation) {
      logger.debug({ invitationId }, "[auth:beforeHook] Invitation not found");
      throw new APIError("BAD_REQUEST", {
        message: "Invalid invitation ID",
      });
    }

    const { status, expiresAt } = invitation;
    logger.debug(
      { invitationId, status, expiresAt },
      "[auth:beforeHook] Invitation found, validating",
    );

    if (status !== "pending") {
      logger.debug(
        { invitationId, status },
        "[auth:beforeHook] Invitation not pending",
      );
      throw new APIError("BAD_REQUEST", {
        message: `This invitation has already been ${status}`,
      });
    }

    // Check if invitation is expired
    if (expiresAt && expiresAt < new Date()) {
      logger.debug(
        { invitationId, expiresAt },
        "[auth:beforeHook] Invitation expired",
      );
      throw new APIError("BAD_REQUEST", {
        message:
          "The invitation link has expired, please contact your admin for a new invitation",
      });
    }

    // Validate email matches invitation
    if (body.email && invitation.email !== body.email) {
      logger.debug(
        { invitationEmail: invitation.email, bodyEmail: body.email },
        "[auth:beforeHook] Email mismatch",
      );
      throw new APIError("BAD_REQUEST", {
        message:
          "Email address does not match the invitation. You must use the invited email address.",
      });
    }

    logger.debug(
      { invitationId },
      "[auth:beforeHook] Invitation validated successfully",
    );
    return ctx;
  }

  return ctx;
}

/**
 * Handles post-processing after better-auth operations.
 *
 * Handles:
 * - Deleting canceled invitations
 * - Invalidating sessions when users are deleted
 * - Accepting invitations after sign-up
 * - Auto-accepting pending invitations on sign-in
 * - Setting active organization for new sessions
 */
export async function handleAfterHook(ctx: HookEndpointContext) {
  const { path, method, body, context } = ctx;

  logger.debug({ path, method }, "[auth:afterHook] Processing post-auth hook");

  // Delete invitation from DB when canceled (instead of marking as canceled)
  if (path === "/organization/cancel-invitation" && method === "POST") {
    const invitationId = body.invitationId as string | undefined;

    if (invitationId) {
      logger.debug(
        { invitationId },
        "[auth:afterHook] Deleting canceled invitation",
      );
      try {
        await InvitationModel.delete(invitationId);
        logger.info(`✅ Invitation ${invitationId} deleted from database`);
      } catch (error) {
        logger.error({ err: error }, "❌ Failed to delete invitation:");
      }
    }
  }

  // Invalidate all sessions when user is deleted
  if (path === "/admin/remove-user" && method === "POST") {
    const userId = body.userId as string | undefined;

    if (userId) {
      // Delete all sessions for this user
      logger.debug(
        { userId },
        "[auth:afterHook] Invalidating all sessions for removed user",
      );
      try {
        await SessionModel.deleteAllByUserId(userId);
        logger.info(`✅ All sessions for user ${userId} invalidated`);
      } catch (error) {
        logger.error({ err: error }, "❌ Failed to invalidate user sessions:");
      }
    }
  }

  // NOTE: User deletion on member removal is handled in routes/auth.ts
  // Better-auth handles member deletion, we just clean up orphaned users

  if (path.startsWith("/sign-up")) {
    const newSession = context?.newSession;

    if (newSession) {
      const { user, session } = newSession;

      logger.debug(
        { userId: user.id, email: user.email },
        "[auth:afterHook] Processing sign-up completion",
      );

      // Check if this is an invitation sign-up
      const callbackURL = body.callbackURL as string | undefined;
      const invitationId = callbackURL
        ?.split("invitationId=")[1]
        ?.split("&")[0];

      // If there is no invitation ID, it means this is a direct sign-up which is not allowed
      if (!invitationId) {
        logger.debug(
          "[auth:afterHook] Sign-up without invitation ID, skipping",
        );
        return;
      }

      logger.debug(
        { invitationId, userId: user.id },
        "[auth:afterHook] Accepting invitation after sign-up",
      );
      return await InvitationModel.accept(session, user, invitationId);
    }
  }

  // Handle both regular sign-in and SSO callback
  if (path.startsWith("/sign-in") || path.startsWith("/sso/callback")) {
    const newSession = context?.newSession;

    if (newSession?.user && newSession?.session) {
      const sessionId = newSession.session.id;
      const userId = newSession.user.id;
      const { user, session } = newSession;

      logger.debug(
        { userId, email: user.email, path },
        "[auth:afterHook] Processing sign-in/SSO callback",
      );

      // Auto-accept any pending invitations for this user's email
      try {
        const pendingInvitation = await InvitationModel.findPendingByEmail(
          user.email,
        );

        if (pendingInvitation) {
          logger.info(
            `🔗 Auto-accepting pending invitation ${pendingInvitation.id} for user ${user.email}`,
          );
          await InvitationModel.accept(session, user, pendingInvitation.id);
          return;
        }
        logger.debug(
          { email: user.email },
          "[auth:afterHook] No pending invitation found for user",
        );
      } catch (error) {
        logger.error({ err: error }, "❌ Failed to auto-accept invitation:");
      }

      try {
        if (!newSession.session.activeOrganizationId) {
          logger.debug(
            { userId },
            "[auth:afterHook] No active organization, looking up first membership",
          );
          const userMembership =
            await MemberModel.getFirstMembershipForUser(userId);

          if (userMembership) {
            logger.debug(
              { userId, organizationId: userMembership.organizationId },
              "[auth:afterHook] Setting active organization from membership",
            );
            await SessionModel.patch(sessionId, {
              activeOrganizationId: userMembership.organizationId,
            });

            logger.info(
              `✅ Active organization set for user ${newSession.user.email}`,
            );
          } else {
            logger.debug(
              { userId },
              "[auth:afterHook] No membership found for user",
            );
          }
        }
      } catch (error) {
        logger.error({ err: error }, "❌ Failed to set active organization:");
      }

      // SSO Role & Team Sync: Synchronize role and team memberships based on SSO claims
      // Only applies to SSO logins (not regular email/password logins)
      if (path.startsWith("/sso/callback")) {
        logger.debug(
          { userId, email: user.email },
          "[auth:afterHook] Processing SSO role and team sync",
        );

        // Sync role first (based on role mapping rules)
        await syncSsoRole(userId, user.email);

        // Then sync teams (based on SSO groups)
        await syncSsoTeams(userId, user.email);
      }
    }
  }
}
