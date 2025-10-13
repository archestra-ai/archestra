import { adminClient, organizationClient } from "better-auth/client/plugins";
import { nextCookies } from "better-auth/next-js";
import { createAuthClient } from "better-auth/react";
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:9000",
  plugins: [organizationClient(), nextCookies(), adminClient()],
  cookies: { secure: process.env.NODE_ENV === "production" },
  autoSignIn: true,
});
