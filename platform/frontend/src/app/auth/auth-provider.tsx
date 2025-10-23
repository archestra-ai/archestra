"use client";

import { AuthUIProvider } from "@daveyplate/better-auth-ui";
import { EMAIL_PLACEHOLDER, PASSWORD_PLACEHOLDER } from "@shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { authClient } from "@/lib/clients/auth/auth-client";

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
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
