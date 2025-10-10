import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { admin, organization } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";

export const auth = betterAuth({
  plugins: [
    organization({
      requireEmailVerificationOnInvitation: false,
      allowUserToCreateOrganization: false, // Disable organization creation by users
      async onInvitationAccepted(_data: any) {
        // TODO : add invitation accepted logic (e.g., send welcome notification)
      },
    }),
    admin(),
  ],

  trustedOrigins: ["http://localhost:3000", "https://archestra.ai"],

  database: drizzleAdapter(db, {
    provider: "pg", // or "mysql", "sqlite"
    schema: {
      user: schema.user,
      session: schema.session,
      organization: schema.organization,
      member: schema.member,
      invitation: schema.invitation,
      account: schema.account,
    },
  }),
  emailAndPassword: {
    enabled: true,
  },
  advanced: {
    cookiePrefix: "archestra",
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/organization/invite-member" && ctx.method === "POST") {
        const body = ctx.body as any;

        // Validate email format
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
          throw new APIError("BAD_REQUEST", {
            message: "Invalid email format",
          });
        }

        return ctx;
        // todo : find a way to retrieve inviterUserId to add additionnal verification (can't retrieve in session yet)
        /*if (!inviterUserId) {
          throw new APIError("UNAUTHORIZED", {
            message: "Inviter not found",
          });
        }

        // Lookup inviter's member role
        const members = await db
          .select()
          .from(schema.member)
          .where(eq(schema.member.userId, inviterUserId))
          .limit(10);

        const memberRow = members.find((m: any) => m.organizationId === orgId);

        if (!memberRow) {
          throw new APIError("UNAUTHORIZED", {
            message: "Inviter is not a member of the organization",
          });
        }

        if (!(memberRow.role === "admin" || memberRow.role === "owner")) {
          throw new APIError("FORBIDDEN", {
            message: "Only organization admins or owners can invite members",
          });
        }

        // Check if user already exists as member
        const existingMemberQuery = await db
          .select()
          .from(schema.user)
          .where(eq(schema.user.email, body.email))
          .limit(1);

        if (existingMemberQuery.length > 0) {
          const userId = existingMemberQuery[0].id;

          const existingMember = await db
            .select()
            .from(schema.member)
            .where(
              and(
                eq(schema.member.userId, userId),
                eq(schema.member.organizationId, orgId),
              ),
            )
            .limit(1);

          if (existingMember.length > 0) {
            throw new APIError("BAD_REQUEST", {
              message: "User is already a member of this organization",
            });
          }
        }

        // Check for pending invitation
        const pendingInvite = await db
          .select()
          .from(schema.invitation)
          .where(
            and(
              eq(schema.invitation.email, body.email),
              eq(schema.invitation.organizationId, orgId),
              eq(schema.invitation.status, "pending"),
            ),
          )
          .limit(1);

        if (pendingInvite.length > 0) {
          throw new APIError("BAD_REQUEST", {
            message: "A pending invitation already exists for this email",
          });
        */
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path.startsWith("/sign-up")) {
        const newSession = ctx.context.newSession;

        if (newSession?.user && newSession?.session) {
          const user = newSession.user;
          const sessionId = newSession.session.id;

          try {
            const orgName = `${user.name || user.email.split("@")[0]}'s Organization`;
            const orgSlug = `org-${user.id.substring(0, 8)}`;

            const org = await db
              .insert(schema.organization)
              .values({
                id: crypto.randomUUID(),
                name: orgName,
                slug: orgSlug,
                createdAt: new Date(),
              })
              .returning();

            if (org[0]) {
              await db.insert(schema.member).values({
                id: crypto.randomUUID(),
                organizationId: org[0].id,
                userId: user.id,
                role: "owner",
                createdAt: new Date(),
              });

              await db
                .update(schema.session)
                .set({ activeOrganizationId: org[0].id })
                .where(eq(schema.session.id, sessionId));

              console.log(
                `✅ Default organization created and set as active for user ${user.email}:`,
                org[0].name,
              );
            }
          } catch (error) {
            console.error("❌ Failed to create default organization:", error);
          }
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
