"use client";

import { AuthUIProvider } from "@daveyplate/better-auth-ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { authClient } from "@/lib/clients/auth/auth-client";
import { EMAIL_PLACEHOLDER, PASSWORD_PLACEHOLDER } from "@archestra/shared/consts";

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  return (
    <AuthUIProvider
      authClient={authClient}
      redirectTo="/test-agent"
      navigate={router.push}
      replace={router.replace}
      onSessionChange={() => {
        router.refresh();
      }}
      Link={Link}
      organization={{
        logo: true,
      }}
      localization={{
        EMAIL_PLACEHOLDER,
        PASSWORD_PLACEHOLDER,
      }}
    >
      {children}
    </AuthUIProvider>
  );
}
