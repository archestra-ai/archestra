"use client";

import { AuthUIProvider } from "@daveyplate/better-auth-ui";
import { EMAIL_PLACEHOLDER, PASSWORD_PLACEHOLDER } from "@shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useCustomRoles } from "@/lib/role.query";

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { data: customRoles } = useCustomRoles();

  return (
    <AuthUIProvider
      authClient={authClient}
      navigate={router.push}
      replace={router.replace}
      onSessionChange={() => {
        router.refresh();
      }}
      Link={Link}
      organization={{
        logo: true,
        /**
         * NOTE: interesting.. this would allow us to tie an API key to the org, or a user, just
         * by setting this to true.. would need to test though..
         */
        // apiKey: true,
        customRoles: (customRoles || []).map(({ role, name }) => ({
          role,
          label: name,
        })),
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
