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

  user: {
    deleteUser: {
      enabled: true,
    },
  },

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
