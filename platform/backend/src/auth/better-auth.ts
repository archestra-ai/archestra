import { ac, adminRole, allAvailableActions, memberRole } from "@shared";
import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { admin, apiKey, organization, twoFactor } from "better-auth/plugins";
import { z } from "zod";
import config from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";
import { InvitationModel, MemberModel, SessionModel } from "@/models";

const APP_NAME = "Archestra";
const {
  api: { apiKeyAuthorizationHeaderName },
  baseURL,
  production,
  auth: { secret, cookieDomain, trustedOrigins },
} = config;

const isHttps = () => {
  // if baseURL (coming from process.env.ARCHESTRA_FRONTEND_URL) is not set, use production (process.env.NODE_ENV=production)
  // to determine if we're using HTTPS
  if (!baseURL) {
    return production;
  }
  // otherwise, use baseURL to determine if we're using HTTPS
  // this is useful for envs where NODE_ENV=production but using HTTP localhost
  return baseURL.startsWith("https://");
};

export const auth = betterAuth({
  appName: APP_NAME,
  baseURL,
  secret,

  plugins: [
    organization({
      requireEmailVerificationOnInvitation: false,
      allowUserToCreateOrganization: false, // Disable organization creation by users
      ac,
      dynamicAccessControl: {
        enabled: true,
        maximumRolesPerOrganization: 50, // Configurable limit for custom roles
      },
      roles: {
        admin: adminRole,
        member: memberRole,
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
    },
  }),

  emailAndPassword: {
    enabled: true,
  },

  advanced: {
    cookiePrefix: "archestra",
    defaultCookieAttributes: {
      ...(cookieDomain ? { domain: cookieDomain } : {}),
      secure: isHttps(), // Use secure cookies when we're using HTTPS
      sameSite: isHttps() ? "none" : "strict", // "none" for HTTPS (allows cross-domain), "strict" for HTTP (Safari/WebKit compatibility)
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
          try {
            // Delete all sessions for this user
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

      // Ensure member is actually deleted from DB when removed from organization
      if (path === "/organization/remove-member" && method === "POST") {
        const { memberIdOrUserId, organizationId } = body;

        if (memberIdOrUserId) {
          try {
            const deleted = await MemberModel.deleteByMemberOrUserId(
              memberIdOrUserId,
              organizationId,
            );

            if (deleted) {
              const { id, organizationId } = deleted;
              logger.info(
                `✅ Member ${id} deleted from organization ${organizationId}`,
              );
            } else {
              logger.warn(
                `⚠️ Member ${memberIdOrUserId} not found for deletion`,
              );
            }
          } catch (error) {
            logger.error({ err: error }, "❌ Failed to delete member:");
          }
        }
      }

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
