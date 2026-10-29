import {
  allAvailableActions,
  editorPermissions,
  memberPermissions,
  platformAdminPermissions,
} from "@archestra/shared/access-control";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { ssoClient } from "@better-auth/sso/client";
import {
  inferAdditionalFields,
  inferOrgAdditionalFields,
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { createAuthClient } from "better-auth/react";
import config from "@/lib/config/config";

const ac = createAccessControl(allAvailableActions);

/**
 * The session and user fields the server's admin plugin adds. The browser
 * uses only impersonation from that plugin and calls its two endpoints by
 * path, so the plugin's client (access-control setup and error strings)
 * stays out of the bundle.
 */
const adminFields = inferAdditionalFields({
  user: {
    role: { type: "string", required: false },
    banned: { type: "boolean", required: false },
  },
  session: { impersonatedBy: { type: "string", required: false } },
});

const adminRole = ac.newRole(allAvailableActions);
const platformAdminRole = ac.newRole(platformAdminPermissions);
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
        platform_admin: platformAdminRole,
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
    adminFields,
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
