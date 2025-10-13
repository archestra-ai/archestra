import { adminClient, organizationClient } from "better-auth/client/plugins";
import { nextCookies } from "better-auth/next-js";
import { createAuthClient } from "better-auth/react";
import config from "@/lib/config";

export const authClient = createAuthClient({
  baseURL: config.api.baseUrl,
  plugins: [organizationClient(), nextCookies(), adminClient()],
  cookies: { secure: !config.debug },
  autoSignIn: true,
});
