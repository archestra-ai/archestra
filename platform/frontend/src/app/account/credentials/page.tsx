"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { ClaudeCodeSubscription } from "@/app/account/_components/claude-code-subscription";
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

  if (!hasTab) return null;
  if (canReadCredentials) return <RuntimeCredentialsSection mode="personal" />;
  // Without credential:read there is no credentials list to show, only the
  // reader's Claude Code sign-in.
  return <ClaudeCodeSubscription />;
}
