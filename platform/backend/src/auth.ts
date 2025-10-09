import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import db, { schema } from "@/database";
export const auth = betterAuth({
  plugins: [
    organization({
      requireEmailVerificationOnInvitation: true, // https://www.better-auth.com/docs/plugins/organization#email-verification-requirement
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
  pages: {
    signIn: "/auth/sign-in",
    signOut: "/auth/sign-out",
    signUp: "/auth/sign-up",
    afterSignIn: "/",
    afterSignOut: "/auth/sign-out",
  },
});
