"use client";

import { AuthUIProvider } from "@daveyplate/better-auth-ui";
import {
  EDITOR_ROLE_NAME,
  EMAIL_PLACEHOLDER,
  PASSWORD_PLACEHOLDER,
  type Permissions,
} from "@shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useMemo } from "react";
import { useHasPermissions } from "@/lib/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useCustomRoles } from "@/lib/role.query";

/**
 * Custom useHasPermission hook that bridges better-auth-ui's permission checks
 * to Archestra's permission system.
 *
 * better-auth-ui's OrganizationMembersCard uses this hook to check if the user
 * can invite members. The default implementation calls better-auth's
 * /organization/has-permission endpoint directly, which has issues in OSS mode.
 *
 * This custom hook uses Archestra's permission system (/api/user/permissions)
 * which works correctly in both OSS and enterprise modes.
 */
export function useArchestraHasPermission(params: {
  organizationId?: string;
  permissions?: Permissions;
  permission?: Permissions;
}) {
  // Handle both 'permissions' (plural) and 'permission' (singular) params
  // better-auth-ui inconsistently uses both in different components
  const permissionsToCheck = params.permissions || params.permission || {};

  const { data: hasPermission, isPending } =
    useHasPermissions(permissionsToCheck);

  // Return format expected by better-auth-ui: { data: { success: boolean, error: null }, isPending }
  return useMemo(
    () => ({
      data: { success: hasPermission, error: null },
      isPending,
    }),
    [hasPermission, isPending],
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { data: customRoles } = useCustomRoles();

  // Create custom hooks object to override better-auth-ui's default permission check
  const customHooks = useMemo(
    () => ({
      useHasPermission: useArchestraHasPermission,
    }),
    [],
  );

  return (
    <AuthUIProvider
      authClient={authClient}
      navigate={router.push}
      replace={router.replace}
      onSessionChange={() => {
        router.refresh();
      }}
      Link={Link}
      hooks={customHooks}
      organization={{
        logo: true,
        /**
         * NOTE: interesting.. this would allow us to tie an API key to the org, or a user, just
         * by setting this to true.. would need to test though..
         */
        // apiKey: true,
        customRoles: [
          { role: EDITOR_ROLE_NAME, label: "Editor" },
          ...(customRoles || []).map(({ role, name }) => ({
            role,
            label: name,
          })),
        ],
      }}
      localization={{
        EMAIL_PLACEHOLDER,
        PASSWORD_PLACEHOLDER,
      }}
      apiKey
      twoFactor={["totp"]}
      deleteUser
    >
      {children}
    </AuthUIProvider>
  );
}
