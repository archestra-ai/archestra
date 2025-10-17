import { ac, adminRole, memberRole } from "@shared";
import { adminClient, organizationClient } from "better-auth/client/plugins";
import { nextCookies } from "better-auth/next-js";
import { createAuthClient } from "better-auth/react";
import config from "@/lib/config";

export const authClient = createAuthClient({
  baseURL: config.api.baseUrl,
  plugins: [
    organizationClient({
      ac,
      roles: {
        admin: adminRole,
        member: memberRole,
      },
    }),
    nextCookies(),
    adminClient(),
  ],
  cookies: { secure: !config.debug },
  autoSignIn: true,
});
