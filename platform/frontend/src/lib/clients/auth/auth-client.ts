import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { ssoClient } from "@better-auth/sso/client";
import {
  allAvailableActions,
  editorPermissions,
  memberPermissions,
} from "@shared/access-control";
import {
  adminClient,
  inferOrgAdditionalFields,
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { createAuthClient } from "better-auth/react";
import config from "@/lib/config/config";

const ac = createAccessControl(allAvailableActions);

const adminRole = ac.newRole(allAvailableActions);
const editorRole = ac.newRole(editorPermissions);
const memberRole = ac.newRole(memberPermissions);

/**
 * Low-level Better Auth client.
 *
 * Do not call `authClient.useSession()` directly. It maintains session state
 * outside the app's TanStack Query cache, which can create duplicate session
 * fetches on pages with many auth-aware components. Use `useSession()` from
 * `@/lib/auth/auth.query` instead so session reads share one query key,
 * stale-time, and invalidation path.
 */
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
            description: {
              type: "string",
              required: false,
            },
          },
        },
      }),
    }),
    adminClient(),
    twoFactorClient(),
    ssoClient(),
    oauthProviderClient(),
  ],
  fetchOptions: {
    credentials: "include",
  },
  cookies: { secure: !config.debug },
  autoSignIn: true,
});
