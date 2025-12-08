import { ssoClient } from "@better-auth/sso/client";
import { ac, adminRole, editorRole, memberRole } from "@shared";
import {
  adminClient,
  apiKeyClient,
  inferOrgAdditionalFields,
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import config from "@/lib/config";

export const authClient = createAuthClient({
  baseURL: "", // Always use relative URLs (proxied through Next.js)
  plugins: [
    organizationClient({
      ac,
      dynamicAccessControl: {
        enabled: true, // Enable dynamic access control on client
      },
      roles: {
        admin: adminRole,
        editor: editorRole,
        member: memberRole,
      },
      schema: inferOrgAdditionalFields({
        organizationRole: {
          additionalFields: {
            name: {
              type: "string",
              required: true,
            },
          },
        },
      }),
    }),
    adminClient(),
    apiKeyClient(),
    twoFactorClient(),
    ssoClient(),
  ],
  fetchOptions: {
    credentials: "include",
  },
  cookies: { secure: !config.debug },
  autoSignIn: true,
});
