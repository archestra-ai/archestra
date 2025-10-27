import { ac, adminRole, allAvailableActions, memberRole } from "@shared";
import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { admin, apiKey, organization } from "better-auth/plugins";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import config from "@/config";
import db, { schema } from "@/database";

const {
  api: { authHeaderName },
  baseURL,
  production,
  auth: { secret, cookieDomain, trustedOrigins },
} = config;

export const auth = betterAuth({
  baseURL,
  secret,

  plugins: [
    organization({
      requireEmailVerificationOnInvitation: false,
      allowUserToCreateOrganization: false, // Disable organization creation by users
      ac,
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
      // enableSessionForAPIKeys: true,
      apiKeyHeaders: [authHeaderName],
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
      apikey: schema.apikey,
      user: schema.usersTable,
      session: schema.session,
      organization: schema.organizationsTable,
      member: schema.member,
      invitation: schema.invitation,
      account: schema.account,
      team: schema.team,
      teamMember: schema.teamMember,
    },
  }),

  emailAndPassword: {
    enabled: true,
  },

  advanced: {
    cookiePrefix: "archestra",
    defaultCookieAttributes: {
      ...(cookieDomain ? { domain: cookieDomain } : {}),
      secure: production, // Only use secure cookies in production (HTTPS required)
      sameSite: production ? "none" : "lax", // "none" required for cross-domain in production with HTTPS
    },
  },

  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // Validate email format for invitations
      if (ctx.path === "/organization/invite-member" && ctx.method === "POST") {
        const body = ctx.body;
        const emailValidation = z.email().safeParse(body.email);
        if (!emailValidation.success) {
          throw new APIError("BAD_REQUEST", {
            message: "Invalid email format",
          });
        }

        return ctx;
      }

      // Block direct sign-up without invitation (invitation-only registration)
      if (ctx.path.startsWith("/sign-up/email") && ctx.method === "POST") {
        const body = ctx.body;
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
        const invitation = await db
          .select()
          .from(schema.invitation)
          .where(eq(schema.invitation.id, invitationId))
          .limit(1);

        if (!invitation[0]) {
          throw new APIError("BAD_REQUEST", {
            message: "Invalid invitation ID",
          });
        }

        if (invitation[0].status !== "pending") {
          throw new APIError("BAD_REQUEST", {
            message: `This invitation has already been ${invitation[0].status}`,
          });
        }

        // Check if invitation is expired
        if (invitation[0].expiresAt && invitation[0].expiresAt < new Date()) {
          throw new APIError("BAD_REQUEST", {
            message: "This invitation has expired",
          });
        }

        // Validate email matches invitation
        if (body.email && invitation[0].email !== body.email) {
          throw new APIError("BAD_REQUEST", {
            message:
              "Email address does not match the invitation. You must use the invited email address.",
          });
        }

        return ctx;
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      // Delete invitation from DB when canceled (instead of marking as canceled)
      if (
        ctx.path === "/organization/cancel-invitation" &&
        ctx.method === "POST"
      ) {
        const body = ctx.body;
        const invitationId = body.invitationId;

        if (invitationId) {
          try {
            await db
              .delete(schema.invitation)
              .where(eq(schema.invitation.id, invitationId));
            console.log(`✅ Invitation ${invitationId} deleted from database`);
          } catch (error) {
            console.error("❌ Failed to delete invitation:", error);
          }
        }
      }

      // Invalidate all sessions when user is deleted
      if (ctx.path === "/admin/remove-user" && ctx.method === "POST") {
        const body = ctx.body;
        const userId = body.userId;

        if (userId) {
          try {
            // Delete all sessions for this user
            await db
              .delete(schema.session)
              .where(eq(schema.session.userId, userId));
            console.log(`✅ All sessions for user ${userId} invalidated`);
          } catch (error) {
            console.error("❌ Failed to invalidate user sessions:", error);
          }
        }
      }

      // Ensure member is actually deleted from DB when removed from organization
      if (ctx.path === "/organization/remove-member" && ctx.method === "POST") {
        const body = ctx.body;
        const memberIdOrUserId = body.memberIdOrUserId;
        const organizationId = body.organizationId;

        if (memberIdOrUserId) {
          try {
            // Try to delete by member ID first
            let deleted = await db
              .delete(schema.member)
              .where(eq(schema.member.id, memberIdOrUserId))
              .returning();

            // If not found, try by user ID + organization ID
            if (!deleted[0] && organizationId) {
              deleted = await db
                .delete(schema.member)
                .where(
                  and(
                    eq(schema.member.userId, memberIdOrUserId),
                    eq(schema.member.organizationId, organizationId),
                  ),
                )
                .returning();
            }

            if (deleted[0]) {
              console.log(
                `✅ Member ${deleted[0].id} deleted from organization ${deleted[0].organizationId}`,
              );
            } else {
              console.warn(
                `⚠️ Member ${memberIdOrUserId} not found for deletion`,
              );
            }
          } catch (error) {
            console.error("❌ Failed to delete member:", error);
          }
        }
      }

      if (ctx.path.startsWith("/sign-up")) {
        const newSession = ctx.context.newSession;

        if (newSession?.user && newSession?.session) {
          const user = newSession.user;
          const sessionId = newSession.session.id;

          // Check if this is an invitation sign-up
          const body = ctx.body;
          const invitationId = body.callbackURL
            ?.split("invitationId=")[1]
            ?.split("&")[0];

          // If there is no invitation ID, it means this is a direct sign-up which is not allowed
          if (!invitationId) {
            return;
          }

          // Handle invitation sign-up: accept invitation and add user to organization
          console.log(
            `🔗 Processing invitation ${invitationId} for user ${user.email}`,
          );

          try {
            // Get the invitation from database
            const invitation = await db
              .select()
              .from(schema.invitation)
              .where(eq(schema.invitation.id, invitationId))
              .limit(1);

            if (!invitation[0]) {
              console.error(`❌ Invitation ${invitationId} not found`);
              return;
            }

            // Create member row linking user to organization
            await db.insert(schema.member).values({
              id: crypto.randomUUID(),
              organizationId: invitation[0].organizationId,
              userId: user.id,
              role: invitation[0].role || "member",
              createdAt: new Date(),
            });

            // Mark invitation as accepted
            await db
              .update(schema.invitation)
              .set({ status: "accepted" })
              .where(eq(schema.invitation.id, invitationId));

            // Set the organization as active in the session
            await db
              .update(schema.session)
              .set({ activeOrganizationId: invitation[0].organizationId })
              .where(eq(schema.session.id, sessionId));

            console.log(
              `✅ Invitation accepted: user ${user.email} added to organization ${invitation[0].organizationId} as ${invitation[0].role || "member"}`,
            );
          } catch (error) {
            console.error(
              `❌ Failed to accept invitation ${invitationId}:`,
              error,
            );
          }

          return;
        }
      }

      if (ctx.path.startsWith("/sign-in")) {
        const newSession = ctx.context.newSession;

        if (newSession?.user && newSession?.session) {
          const sessionId = newSession.session.id;
          const userId = newSession.user.id;

          try {
            if (!newSession.session.activeOrganizationId) {
              const userMembership = await db
                .select()
                .from(schema.member)
                .where(eq(schema.member.userId, userId))
                .limit(1);

              if (userMembership[0]) {
                await db
                  .update(schema.session)
                  .set({
                    activeOrganizationId: userMembership[0].organizationId,
                  })
                  .where(eq(schema.session.id, sessionId));

                console.log(
                  `✅ Active organization set for user ${newSession.user.email}`,
                );
              }
            }
          } catch (error) {
            console.error("❌ Failed to set active organization:", error);
          }
        }
      }
    }),
  },
});
