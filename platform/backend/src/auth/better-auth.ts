import { sso } from "@better-auth/sso";
import {
  ADMIN_ROLE_NAME,
  ac,
  adminRole,
  allAvailableActions,
  MEMBER_ROLE_NAME,
  memberRole,
  SSO_TRUSTED_PROVIDER_IDS,
} from "@shared";
import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { admin, apiKey, organization, twoFactor } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { z } from "zod";
import config from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";
import { InvitationModel, MemberModel, SessionModel } from "@/models";

const APP_NAME = "Archestra";
const {
  api: { apiKeyAuthorizationHeaderName },
  frontendBaseUrl,
  production,
  auth: { secret, cookieDomain, trustedOrigins },
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

export const auth = betterAuth({
  appName: APP_NAME,
  baseURL: frontendBaseUrl,
  secret,

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
    /**
     * TODO: add this plugin conditionally based on value of ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED
     */
    sso({
      organizationProvisioning: {
        disabled: false,
        defaultRole: MEMBER_ROLE_NAME,
        // TODO: allow configuration of these provisioning options dynamically..
        getRole: async (_data) => {
          // Custom role assignment logic based on user attributes
          // const { user, token, provider, userInfo } = data;

          // Look for admin indicators in user attributes
          // const isAdmin =
          //   userInfo.role === "admin" ||
          //   userInfo.groups?.includes("admin") ||
          //   userInfo.department === "IT" ||
          //   userInfo.title?.toLowerCase().includes("admin") ||
          //   userInfo.title?.toLowerCase().includes("manager");
          const isAdmin = false;

          return isAdmin ? ADMIN_ROLE_NAME : MEMBER_ROLE_NAME;
        },
      },
      defaultOverrideUserInfo: true,
      disableImplicitSignUp: false,
      providersLimit: 10,
      trustEmailVerified: true, // Trust email verification from SSO providers
    }),
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
      // Trust SSO providers for automatic account linking
      // This allows existing users to sign in with SSO without manual linking
      trustedProviders: SSO_TRUSTED_PROVIDER_IDS,
      allowDifferentEmails: true,
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
            const [membership] = await db
              .select()
              .from(schema.membersTable)
              .where(eq(schema.membersTable.userId, session.userId))
              .limit(1);

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
    before: createAuthMiddleware(async (ctx) => {
      const { path, method, body } = ctx;

      // Validate email format for invitations
      if (path === "/organization/invite-member" && method === "POST") {
        if (!z.email().safeParse(body.email).success) {
          throw new APIError("BAD_REQUEST", {
            message: "Invalid email format",
          });
        }

        return ctx;
      }

      // Block direct sign-up without invitation (invitation-only registration)
      if (path.startsWith("/sign-up/email") && method === "POST") {
        const invitationId = body.callbackURL
          ?.split("invitationId=")[1]
          ?.split("&")[0];

        if (!invitationId) {
          throw new APIError("FORBIDDEN", {
            message:
              "Direct sign-up is disabled. You need an invitation to create an account.",
          });
        }

        // Validate the invitation exists and is pending
        const invitation = await InvitationModel.getById(invitationId);

        if (!invitation) {
          throw new APIError("BAD_REQUEST", {
            message: "Invalid invitation ID",
          });
        }

        const { status, expiresAt } = invitation;

        if (status !== "pending") {
          throw new APIError("BAD_REQUEST", {
            message: `This invitation has already been ${status}`,
          });
        }

        // Check if invitation is expired
        if (expiresAt && expiresAt < new Date()) {
          throw new APIError("BAD_REQUEST", {
            message:
              "The invitation link has expired, please contact your admin for a new invitation",
          });
        }

        // Validate email matches invitation
        if (body.email && invitation.email !== body.email) {
          throw new APIError("BAD_REQUEST", {
            message:
              "Email address does not match the invitation. You must use the invited email address.",
          });
        }

        return ctx;
      }
    }),
    after: createAuthMiddleware(async ({ path, method, body, context }) => {
      // Delete invitation from DB when canceled (instead of marking as canceled)
      if (path === "/organization/cancel-invitation" && method === "POST") {
        const invitationId = body.invitationId;

        if (invitationId) {
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
        const userId = body.userId;

        if (userId) {
          // Delete all sessions for this user
          try {
            await SessionModel.deleteAllByUserId(userId);
            logger.info(`✅ All sessions for user ${userId} invalidated`);
          } catch (error) {
            logger.error(
              { err: error },
              "❌ Failed to invalidate user sessions:",
            );
          }
        }
      }

      // NOTE: User deletion on member removal is handled in routes/auth.ts
      // Better-auth handles member deletion, we just clean up orphaned users

      if (path.startsWith("/sign-up")) {
        const { newSession } = context;

        if (newSession) {
          const { user, session } = newSession;

          // Check if this is an invitation sign-up
          const invitationId = body.callbackURL
            ?.split("invitationId=")[1]
            ?.split("&")[0];

          // If there is no invitation ID, it means this is a direct sign-up which is not allowed
          if (!invitationId) {
            return;
          }

          return await InvitationModel.accept(session, user, invitationId);
        }
      }

      if (path.startsWith("/sign-in")) {
        const { newSession } = context;

        if (newSession?.user && newSession?.session) {
          const sessionId = newSession.session.id;
          const userId = newSession.user.id;
          const { user, session } = newSession;

          // Auto-accept any pending invitations for this user's email
          try {
            const pendingInvitations = await db
              .select()
              .from(schema.invitationsTable)
              .where(
                eq(schema.invitationsTable.email, user.email.toLowerCase()),
              );

            const pendingInvitation = pendingInvitations.find(
              (inv) => inv.status === "pending",
            );

            if (pendingInvitation) {
              logger.info(
                `🔗 Auto-accepting pending invitation ${pendingInvitation.id} for user ${user.email}`,
              );
              await InvitationModel.accept(session, user, pendingInvitation.id);
              return;
            }
          } catch (error) {
            logger.error(
              { err: error },
              "❌ Failed to auto-accept invitation:",
            );
          }

          try {
            if (!newSession.session.activeOrganizationId) {
              const userMembership = await MemberModel.getByUserId(userId);

              if (userMembership) {
                await SessionModel.patch(sessionId, {
                  activeOrganizationId: userMembership.organizationId,
                });

                logger.info(
                  `✅ Active organization set for user ${newSession.user.email}`,
                );
              }
            }
          } catch (error) {
            logger.error(
              { err: error },
              "❌ Failed to set active organization:",
            );
          }
        }
      }
    }),
  },
});
