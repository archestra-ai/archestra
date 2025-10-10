import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { admin, organization } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";

export const auth = betterAuth({
  plugins: [
    organization({
      requireEmailVerificationOnInvitation: true, // https://www.better-auth.com/docs/plugins/organization#email-verification-requirement
      allowUserToCreateOrganization: false, // Disable organization creation by users
      creatorRole: "admin", // Only admins can create orgs (if enabled)
      async sendInvitationEmail(_data) {
        const _inviteLink = `https://example.com/accept-invitation/${_data.id}`;
        // TODO : add send invitation logic
        /*sendOrganizationInvitation({
          email: _data.email,
          invitedByUsername: _data.inviter.user.name,
          invitedByEmail: _data.inviter.user.email,
          teamName: _data.organization.name,
          inviteLink,
        });*/
      },
      async onInvitationAccepted(_data: any) {
        // TODO : add invitation accepted logic
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
