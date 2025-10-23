import { ac, adminRole, memberRole } from "@shared";
import {
  adminClient,
  apiKeyClient,
  organizationClient,
} from "better-auth/client/plugins";
import { nextCookies } from "better-auth/next-js";
import { createAuthClient } from "better-auth/react";
import config from "@/lib/config";

export const authClient = createAuthClient({
  baseURL: "", // Always use relative URLs (proxied through Next.js)
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
    apiKeyClient(),
  ],
  fetchOptions: {
    credentials: "include",
  },
  cookies: { secure: !config.debug },
  autoSignIn: true,
});
