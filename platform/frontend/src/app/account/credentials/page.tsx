"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAccountCredentialsAccess } from "@/app/account/_components/use-account-credentials-access";
import { RuntimeCredentialsSection } from "@/components/settings/runtime-credentials-section";

export default function AccountCredentialsPage() {
  const router = useRouter();
  const { canReadCredentials, hasTab, redirectTo } =
    useAccountCredentialsAccess();

  useEffect(() => {
    if (!redirectTo) return;
    // Keep the query string: GitHub connect returns and old
    // `/account#credentials` links carry their state in it.
    router.replace(
      redirectTo === "/settings/credentials"
        ? `${redirectTo}${window.location.search}${window.location.hash}`
        : redirectTo,
    );
  }, [redirectTo, router]);

  if (!hasTab || !canReadCredentials) return null;
  return <RuntimeCredentialsSection mode="personal" />;
}
